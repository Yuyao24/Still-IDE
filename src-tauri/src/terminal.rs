//! Pseudo-terminals for local shells and SSH sessions. Several sessions can
//! run at once; each is addressed by an id chosen by the frontend.

use crate::{
    config::Store,
    process::shell,
    ssh,
    workspace::{err, root, Result},
};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter, Manager, State};

struct Session {
    writer: Box<dyn Write + Send>,
    resize: Box<dyn Fn(u16, u16) -> Result<()> + Send>,
    kill: Box<dyn FnMut() + Send>,
}

#[derive(Default, Clone)]
pub struct TerminalState(Arc<Mutex<HashMap<String, Session>>>);

#[derive(Clone, Serialize)]
pub struct TerminalData {
    pub id: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Serialize)]
pub struct TerminalExit {
    pub id: String,
    pub code: Option<u32>,
}

fn dimensions(cols: u16, rows: u16) -> PtySize {
    PtySize { cols: cols.max(2), rows: rows.max(2), pixel_width: 0, pixel_height: 0 }
}

impl TerminalState {
    pub fn stop(&self, id: Option<&str>) -> Result<()> {
        let mut sessions = self.0.lock().map_err(err)?;
        let ids: Vec<String> = match id {
            Some(id) => vec![id.to_owned()],
            None => sessions.keys().cloned().collect(),
        };
        for id in ids {
            if let Some(mut session) = sessions.remove(&id) {
                (session.kill)();
            }
        }
        Ok(())
    }

    /// Drops a session that has already ended (its relay reported the exit).
    pub fn forget(&self, id: &str) {
        if let Ok(mut sessions) = self.0.lock() {
            sessions.remove(id);
        }
    }
}

#[derive(Serialize)]
pub struct ShellOption {
    name: String,
    path: String,
}

/// Shells installed on this computer, for the terminal settings.
#[tauri::command]
pub fn detect_shells() -> Vec<ShellOption> {
    let mut found = Vec::new();
    let mut add = |name: &str, path: PathBuf| {
        if path.is_file() && !found.iter().any(|item: &ShellOption| item.path == path.to_string_lossy()) {
            found.push(ShellOption { name: name.into(), path: path.to_string_lossy().into_owned() });
        }
    };
    if cfg!(windows) {
        let system = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let programs = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        add("PowerShell 7", programs.join(r"PowerShell\7\pwsh.exe"));
        add("Windows PowerShell", system.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"));
        add("Command Prompt", system.join(r"System32\cmd.exe"));
        add("Git Bash", programs.join(r"Git\bin\bash.exe"));
        add("WSL", system.join(r"System32\wsl.exe"));
    } else {
        let listed = std::fs::read_to_string("/etc/shells").unwrap_or_default();
        for line in listed.lines().map(str::trim).filter(|line| line.starts_with('/')) {
            let path = PathBuf::from(line);
            let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
            if ["zsh", "bash", "fish", "sh", "nu", "pwsh", "tcsh", "ksh"].contains(&name.as_str()) {
                add(&name, path);
            }
        }
    }
    found
}

fn local_shell(preferred: Option<String>) -> CommandBuilder {
    let program = preferred.filter(|path| !path.trim().is_empty() && PathBuf::from(path).is_file()).map(Into::into).unwrap_or_else(shell);
    let name = PathBuf::from(&program).file_stem().map(|name| name.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut cmd = CommandBuilder::new(&program);
    if name.contains("powershell") || name == "pwsh" {
        cmd.arg("-NoLogo");
    } else if cfg!(target_os = "macos") && ["zsh", "bash", "fish"].contains(&name.as_str()) {
        // macOS terminals start login shells so the user's profile loads.
        cmd.arg("-l");
    }
    cmd
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn terminal_start(
    app: AppHandle,
    state: State<'_, TerminalState>,
    store: State<'_, Store>,
    root_path: Option<String>,
    id: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    ssh_host: Option<String>,
    remote_path: Option<String>,
    container: Option<bool>,
) -> Result<()> {
    let state = state.inner().clone();
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = match root_path.filter(|path| !path.is_empty()) {
            Some(path) => root(&path)?,
            None => app.path().home_dir().map_err(err)?,
        };
        if state.0.lock().map_err(err)?.contains_key(&id) {
            return Err("This terminal session is already open.".into());
        }
        let mut cmd = match ssh_host {
            Some(host) => {
                // Prefer the connection that is already signed in (no second password or code).
                match ssh::relay_terminal(&app, &store, &host, &id, cols, rows, remote_path.as_deref()) {
                    Ok(relay) => {
                        let mut close = relay.close;
                        state.0.lock().map_err(err)?.insert(id.clone(), Session { writer: Box::new(relay.writer), resize: relay.resize, kill: Box::new(move || close()) });
                        ssh::touch(&store, &host);
                        return Ok(());
                    }
                    // A refused or cancelled login is final; don't ask again in a second window.
                    Err(message) if message != "NORELAY" && !message.starts_with("WORKER") && (message.contains("login") || message.contains("Login") || message.contains("accept")) => return Err(message),
                    Err(_) => {}
                }
                let host = ssh::find_host(&store, &host)?;
                let mut cmd = CommandBuilder::new(ssh::program());
                cmd.args(ssh::session_args(&app, &host, remote_path.as_deref())?);
                for (key, value) in ssh::prompt_env(&app, &host) {
                    cmd.env(key, value);
                }
                ssh::touch(&store, &host.id);
                cmd
            }
            // A shell inside the project's dev container.
            None if container.unwrap_or(false) => {
                let (docker, args) = crate::container::terminal_command(&cwd)?;
                let mut cmd = CommandBuilder::new(docker);
                cmd.args(args);
                cmd
            }
            None => local_shell(shell),
        };
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Still");

        let pty = native_pty_system().openpty(dimensions(cols, rows)).map_err(err)?;
        let mut reader = pty.master.try_clone_reader().map_err(err)?;
        let writer = pty.master.take_writer().map_err(err)?;
        let mut child = pty.slave.spawn_command(cmd).map_err(err)?;
        drop(pty.slave);
        let mut killer = child.clone_killer();
        let master = pty.master;
        state.0.lock().map_err(err)?.insert(id.clone(), Session {
            writer,
            resize: Box::new(move |cols, rows| master.resize(dimensions(cols, rows)).map_err(err)),
            kill: Box::new(move || { let _ = killer.kill(); }),
        });

        let data_app = app.clone();
        let data_id = id.clone();
        let reader = thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(size) = reader.read(&mut buffer) {
                if size == 0 {
                    break;
                }
                let _ = data_app.emit("terminal-data", TerminalData { id: data_id.clone(), bytes: buffer[..size].to_vec() });
            }
        });
        thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            if let Ok(mut sessions) = state.0.lock() {
                sessions.remove(&id);
            }
            let _ = reader.join();
            let _ = app.emit("terminal-exit", TerminalExit { id, code });
        });
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn terminal_write(state: State<'_, TerminalState>, id: String, data: String) -> Result<()> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(session) = state.0.lock().map_err(err)?.get_mut(&id) {
            session.writer.write_all(data.as_bytes()).and_then(|_| session.writer.flush()).map_err(err)?;
        }
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn terminal_resize(state: State<TerminalState>, id: String, cols: u16, rows: u16) -> Result<()> {
    if let Some(session) = state.0.lock().map_err(err)?.get(&id) {
        (session.resize)(cols, rows)?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_stop(state: State<TerminalState>, id: String) -> Result<()> {
    state.stop(Some(&id))
}
