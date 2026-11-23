use crate::{
    process::shell,
    workspace::{err, root, Result},
};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter, State};

struct Session {
    id: String,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default, Clone)]
pub struct TerminalState(Arc<Mutex<Option<Session>>>);

#[derive(Clone, Serialize)]
struct TerminalData {
    id: String,
    bytes: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct TerminalExit {
    id: String,
    code: Option<u32>,
}

fn dimensions(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.max(2),
        rows: rows.max(2),
        pixel_width: 0,
        pixel_height: 0,
    }
}

impl TerminalState {
    pub fn stop(&self, id: Option<&str>) -> Result<()> {
        let mut active = self.0.lock().map_err(err)?;
        if active
            .as_ref()
            .is_some_and(|session| id.is_none() || Some(session.id.as_str()) == id)
        {
            if let Some(mut session) = active.take() {
                let _ = session.killer.kill();
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn terminal_start(
    app: AppHandle,
    state: State<'_, TerminalState>,
    root_path: String,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        let mut active = state.0.lock().map_err(err)?;
        if active.is_some() {
            return Err("A terminal session is already open.".into());
        }

        let pty = native_pty_system()
            .openpty(dimensions(cols, rows))
            .map_err(err)?;
        let mut cmd = CommandBuilder::new(shell());
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let mut reader = pty.master.try_clone_reader().map_err(err)?;
        let writer = pty.master.take_writer().map_err(err)?;
        let mut child = pty.slave.spawn_command(cmd).map_err(err)?;
        drop(pty.slave);
        let killer = child.clone_killer();
        *active = Some(Session {
            id: id.clone(),
            writer,
            master: pty.master,
            killer,
        });
        drop(active);

        let data_app = app.clone();
        let data_id = id.clone();
        let reader = thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            while let Ok(size) = reader.read(&mut buffer) {
                if size == 0 {
                    break;
                }
                let _ = data_app.emit(
                    "terminal-data",
                    TerminalData {
                        id: data_id.clone(),
                        bytes: buffer[..size].to_vec(),
                    },
                );
            }
        });
        thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            if let Ok(mut active) = state.0.lock() {
                if active.as_ref().is_some_and(|session| session.id == id) {
                    active.take();
                }
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
pub async fn terminal_write(
    state: State<'_, TerminalState>,
    id: String,
    data: String,
) -> Result<()> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(session) = state
            .0
            .lock()
            .map_err(err)?
            .as_mut()
            .filter(|session| session.id == id)
        {
            session
                .writer
                .write_all(data.as_bytes())
                .and_then(|_| session.writer.flush())
                .map_err(err)?;
        }
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn terminal_resize(
    state: State<TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    if let Some(session) = state
        .0
        .lock()
        .map_err(err)?
        .as_ref()
        .filter(|session| session.id == id)
    {
        session.master.resize(dimensions(cols, rows)).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_stop(state: State<TerminalState>, id: String) -> Result<()> {
    state.stop(Some(&id))
}
