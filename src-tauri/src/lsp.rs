//! Language servers. Still starts one per project and language when a matching server is
//! installed (Pyright for Python, jdtls for Java, typescript-language-server for JavaScript and
//! TypeScript, rust-analyzer, gopls, clangd) and passes LSP messages between it and the editor.
//! The protocol itself (initialize, completion, hover, rename…) is handled in the frontend.
use crate::{
    process::command,
    tools::find,
    workspace::{err, root, Result},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, State};

struct Server {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Child,
    name: String,
}

#[derive(Default)]
pub struct Servers(Mutex<HashMap<String, Server>>);

impl Servers {
    pub fn stop_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            for (_, mut server) in map.drain() {
                kill(&mut server.child);
            }
        }
    }
}

fn kill(child: &mut Child) {
    // Servers started through a .cmd wrapper run node underneath; stop the whole tree.
    #[cfg(windows)]
    {
        let _ = command("taskkill", Path::new(".")).args(["/T", "/F", "/PID", &child.id().to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(Serialize)]
pub struct Started {
    id: String,
    name: String,
}

#[derive(Serialize, Clone)]
struct Message {
    id: String,
    message: String,
}

#[derive(Serialize, Clone)]
struct Exited {
    id: String,
    log: String,
}

/// The servers Still knows for a language, best first: (command, arguments, display name).
fn candidates(app: &AppHandle, language: &str, cwd: &Path) -> Vec<(&'static str, Vec<String>, &'static str)> {
    let stdio = || vec!["--stdio".to_owned()];
    match language {
        "python" => vec![
            ("basedpyright-langserver", stdio(), "basedpyright"),
            ("pyright-langserver", stdio(), "Pyright"),
            ("pylsp", vec![], "python-lsp-server"),
            ("jedi-language-server", vec![], "Jedi"),
        ],
        "java" => {
            // jdtls keeps its index in a data folder per project, outside the project.
            let data = app.path().app_cache_dir().map(|dir| dir.join("jdtls").join(format!("{:016x}", hash(&cwd.to_string_lossy())))).unwrap_or_else(|_| std::env::temp_dir().join("still-jdtls"));
            vec![("jdtls", vec!["-data".to_owned(), data.to_string_lossy().into_owned()], "Eclipse JDT")]
        }
        "javascript" | "typescript" => vec![("typescript-language-server", stdio(), "TypeScript")],
        "rust" => vec![("rust-analyzer", vec![], "rust-analyzer")],
        "go" => vec![("gopls", vec![], "gopls")],
        "cpp" | "c" => vec![("clangd", vec![], "clangd")],
        _ => vec![],
    }
}

fn hash(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// Which server would run for a language in this project, if any is installed.
#[tauri::command]
pub fn lsp_available(app: AppHandle, root_path: String, language: String) -> Result<Option<String>> {
    let cwd = root(&root_path)?;
    Ok(candidates(&app, &language, &cwd).into_iter().find(|(program, _, _)| find(&cwd, program).is_some()).map(|(_, _, name)| name.to_owned()))
}

/// Starts the language server for a project and language (or returns the running one).
/// `None` means no server for that language is installed.
#[tauri::command]
pub fn lsp_start(app: AppHandle, servers: State<Servers>, root_path: String, language: String) -> Result<Option<Started>> {
    let cwd = root(&root_path)?;
    let id = format!("{language}:{}", cwd.to_string_lossy());
    {
        let mut map = servers.0.lock().map_err(err)?;
        if let Some(server) = map.get_mut(&id) {
            if matches!(server.child.try_wait(), Ok(None)) {
                return Ok(Some(Started { id, name: server.name.clone() }));
            }
            map.remove(&id);
        }
    }
    let Some((program, args, name)) = candidates(&app, &language, &cwd).into_iter().find_map(|(program, args, name)| find(&cwd, program).map(|path| (path, args, name))) else {
        return Ok(None);
    };
    let mut cmd = command(&program, &cwd);
    cmd.args(&args);
    spawn(&app, &servers, id, name, cmd).map(Some)
}

/// Is a server with this id still running? (Then it is reused.)
pub fn running(servers: &Servers, id: &str) -> Option<Started> {
    let mut map = servers.0.lock().ok()?;
    let server = map.get_mut(id)?;
    if matches!(server.child.try_wait(), Ok(None)) { return Some(Started { id: id.to_owned(), name: server.name.clone() }) }
    map.remove(id);
    None
}

/// Starts a server process (local, or `ssh … server` for a project on a server) and relays its messages.
pub fn spawn(app: &AppHandle, servers: &Servers, id: String, name: &str, mut cmd: std::process::Command) -> Result<Started> {
    let app = app.clone();
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(err)?;
    let stdout = child.stdout.take().ok_or("The language server has no output.")?;
    let stderr = child.stderr.take();
    let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("The language server takes no input.")?));
    let log = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = stderr {
        let log = log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(|line| line.ok()) {
                if let Ok(mut text) = log.lock() {
                    text.push_str(&line);
                    text.push('\n');
                    if text.len() > 16_000 { let cut = text.len() - 8_000; *text = text[cut..].to_owned(); }
                }
            }
        });
    }
    let events = app.clone();
    let reader_id = id.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            // Headers, then a blank line, then exactly Content-Length bytes of JSON.
            let mut length: Option<usize> = None;
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => { length = None; break; }
                    Ok(_) => {}
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    if length.is_some() { break } else { continue }
                }
                if let Some((key, value)) = trimmed.split_once(':') {
                    if key.eq_ignore_ascii_case("content-length") { length = value.trim().parse().ok(); }
                }
            }
            let Some(length) = length else { break };
            let mut body = vec![0u8; length];
            if reader.read_exact(&mut body).is_err() { break }
            let _ = events.emit("lsp-message", Message { id: reader_id.clone(), message: String::from_utf8_lossy(&body).into_owned() });
        }
        let text = log.lock().map(|text| text.clone()).unwrap_or_default();
        let _ = events.emit("lsp-exit", Exited { id: reader_id.clone(), log: text.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n") });
        if let Ok(mut map) = events.state::<Servers>().0.lock() {
            if map.get_mut(&reader_id).is_some_and(|server| !matches!(server.child.try_wait(), Ok(None))) { map.remove(&reader_id); }
        }
    });
    servers.0.lock().map_err(err)?.insert(id.clone(), Server { stdin, child, name: name.to_owned() });
    Ok(Started { id, name: name.to_owned() })
}

#[tauri::command]
pub fn lsp_send(servers: State<Servers>, id: String, message: String) -> Result<()> {
    let stdin = servers.0.lock().map_err(err)?.get(&id).map(|server| server.stdin.clone()).ok_or("The language server is not running.")?;
    let mut pipe = stdin.lock().map_err(err)?;
    pipe.write_all(format!("Content-Length: {}\r\n\r\n", message.len()).as_bytes()).map_err(err)?;
    pipe.write_all(message.as_bytes()).map_err(err)?;
    pipe.flush().map_err(err)
}

#[tauri::command]
pub fn lsp_stop(servers: State<Servers>, id: String) -> Result<()> {
    if let Some(mut server) = servers.0.lock().map_err(err)?.remove(&id) {
        // Ask politely first; the frontend has already sent shutdown/exit when it could.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(600));
            if matches!(server.child.try_wait(), Ok(None)) { kill(&mut server.child); }
        });
    }
    Ok(())
}
