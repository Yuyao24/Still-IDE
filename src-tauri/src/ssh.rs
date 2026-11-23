//! SSH support built on the system OpenSSH client, so ~/.ssh/config, keys,
//! agents, jump hosts and known_hosts all behave exactly as in a terminal.
//!
//! Interactive sessions run `ssh` inside a PTY. Remote file browsing and
//! editing run short non-interactive `ssh` commands against a POSIX shell. On
//! macOS and Linux those reuse one connection (ControlMaster).
//!
//! Servers that need a password: Still asks for it once, keeps it in memory for
//! as long as the app runs (never on disk), and hands it to OpenSSH through
//! SSH_ASKPASS, with the Still executable itself acting as the askpass helper.

use crate::{
    config::{now, SshHost, Store},
    process::{command, parse_args, Jobs},
    workspace::{err, Result},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::Mutex,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};

/// Passwords typed this session, by host id. Memory only.
#[derive(Default)]
pub struct Passwords(Mutex<HashMap<String, String>>);

const ASKPASS_ENV: &str = "STILL_ASKPASS_SECRET";

/// When OpenSSH runs Still as its askpass helper, print the password and exit
/// before any window is created. Returns true if this process was an askpass call.
pub fn askpass_mode() -> bool {
    let Ok(secret) = std::env::var(ASKPASS_ENV) else { return false };
    let prompt = std::env::args().nth(1).unwrap_or_default().to_lowercase();
    // Host key questions are answered by StrictHostKeyChecking, never with the password.
    if prompt.contains("yes/no") || prompt.contains("fingerprint") {
        std::process::exit(1);
    }
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{secret}");
    let _ = out.flush();
    true
}

fn password_for(app: &AppHandle, id: &str) -> Option<String> {
    app.try_state::<Passwords>()?.0.lock().ok()?.get(id).cloned()
}

/// Let `cmd` answer password prompts with `password`, without a terminal.
fn use_password(cmd: &mut Command, password: &str) {
    if let Ok(exe) = std::env::current_exe() {
        cmd.env("SSH_ASKPASS", exe).env("SSH_ASKPASS_REQUIRE", "force").env(ASKPASS_ENV, password);
        if std::env::var_os("DISPLAY").is_none() {
            cmd.env("DISPLAY", "still:0");
        }
    }
}

#[tauri::command]
pub fn ssh_set_password(app: AppHandle, id: String, password: Option<String>) -> Result<()> {
    drop_worker(&app, &id);
    let state = app.state::<Passwords>();
    let mut map = state.0.lock().map_err(err)?;
    match password {
        Some(value) if !value.is_empty() => { map.insert(id, value); }
        _ => { map.remove(&id); }
    }
    Ok(())
}

pub fn program() -> String {
    format!("ssh{}", std::env::consts::EXE_SUFFIX)
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn plain(value: &str, label: &str) -> Result<()> {
    if value.is_empty() || value.starts_with('-') || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("Enter a valid {label}."));
    }
    Ok(())
}

fn validate(host: &SshHost) -> Result<()> {
    plain(&host.host, "host name")?;
    if let Some(user) = &host.user {
        plain(user, "user name")?;
    }
    if let Some(jump) = &host.jump {
        plain(jump, "jump host")?;
    }
    for forward in &host.forwards {
        if forward.is_empty() || forward.starts_with('-') || !forward.chars().all(|c| c.is_ascii_alphanumeric() || ".:[]-_".contains(c)) {
            return Err("Port forwards look like 8080:localhost:80.".into());
        }
    }
    Ok(())
}

fn home(app: &AppHandle) -> Option<PathBuf> {
    app.path().home_dir().ok()
}

/// Concrete Host entries from ~/.ssh/config (wildcard patterns are skipped).
fn config_hosts(app: &AppHandle) -> Vec<SshHost> {
    let Some(path) = home(app).map(|home| home.join(".ssh").join("config")) else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    let mut hosts: Vec<SshHost> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((key, value)) => (key.to_lowercase(), value.trim().trim_start_matches('=').trim().trim_matches('"').to_owned()),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                current.clear();
                for alias in value.split_whitespace() {
                    if alias.contains(['*', '?', '!']) || hosts.iter().any(|host| host.host == alias) {
                        continue;
                    }
                    current.push(hosts.len());
                    hosts.push(SshHost {
                        id: format!("config:{alias}"),
                        name: alias.into(),
                        host: alias.into(),
                        source: "config".into(),
                        ..Default::default()
                    });
                }
            }
            "match" => current.clear(),
            // Details are display-only: ssh reads the config itself.
            "hostname" | "user" | "port" => {
                for index in &current {
                    let host = &mut hosts[*index];
                    match key.as_str() {
                        "hostname" => host.address = Some(value.clone()),
                        "user" => host.user = Some(value.clone()),
                        _ => host.port = value.parse().ok(),
                    }
                }
            }
            _ => {}
        }
    }
    hosts
}

pub fn find_host(store: &Store, id: &str) -> Result<SshHost> {
    if let Some(alias) = id.strip_prefix("config:") {
        plain(alias, "host alias")?;
        return Ok(SshHost { id: id.into(), name: alias.into(), host: alias.into(), source: "config".into(), ..Default::default() });
    }
    store.read(|config| config.ssh_hosts.iter().find(|host| host.id == id).cloned())?.ok_or_else(|| "This server is no longer saved.".into())
}

pub fn touch(store: &Store, id: &str) {
    let _ = store.update(|config| {
        if let Some(host) = config.ssh_hosts.iter_mut().find(|host| host.id == id) {
            host.last_used = Some(now());
        }
        Ok(())
    });
}

/// Where connection-sharing sockets live (Unix only). Unix socket paths are
/// limited to about 104 bytes, so fall back to /tmp for long cache paths.
fn control_dir(app: &AppHandle) -> Option<PathBuf> {
    if cfg!(windows) {
        return None;
    }
    let preferred = app.path().app_cache_dir().ok()?.join("ssh");
    let dir = if preferred.to_string_lossy().len() + 42 < 100 {
        preferred
    } else {
        let user = std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).unwrap_or_else(|_| "user".into());
        PathBuf::from(format!("/tmp/still-ssh-{user}"))
    };
    std::fs::create_dir_all(&dir).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Some(dir)
}

fn base_args(app: &AppHandle, host: &SshHost, batch: bool) -> Result<Vec<String>> {
    validate(host)?;
    let mut args = Vec::new();
    let password = batch && password_for(app, &host.id).is_some();
    if let Some(dir) = control_dir(app) {
        args.extend([
            "-o".into(),
            "ControlMaster=auto".into(),
            "-o".into(),
            format!("ControlPath={}/%C", dir.to_string_lossy()),
            "-o".into(),
            "ControlPersist=300".into(),
        ]);
    }
    // Keep idle connections alive through routers and firewalls, and notice dead ones quickly.
    args.extend(["-o".into(), "ServerAliveInterval=15".into(), "-o".into(), "ServerAliveCountMax=4".into(), "-o".into(), "TCPKeepAlive=yes".into()]);
    if password {
        // The password is answered by askpass; new host keys are trusted on first use, as a terminal would ask.
        args.extend(["-o".into(), "NumberOfPasswordPrompts=1".into(), "-o".into(), "StrictHostKeyChecking=accept-new".into(), "-o".into(), "ConnectTimeout=12".into()]);
    } else if batch {
        args.extend(["-o".into(), "BatchMode=yes".into(), "-o".into(), "ConnectTimeout=12".into()]);
    }
    if host.source != "config" {
        if let Some(port) = host.port {
            args.extend(["-p".into(), port.to_string()]);
        }
        if let Some(identity) = host.identity_file.as_deref().filter(|value| !value.trim().is_empty()) {
            args.extend(["-i".into(), identity.trim().into()]);
        }
        if let Some(jump) = &host.jump {
            args.extend(["-J".into(), jump.clone()]);
        }
    }
    Ok(args)
}

fn destination(host: &SshHost) -> String {
    match (&host.user, host.source.as_str()) {
        (Some(user), "saved") => format!("{user}@{}", host.host),
        _ => host.host.clone(),
    }
}

pub fn session_args(app: &AppHandle, host: &SshHost, remote_path: Option<&str>) -> Result<Vec<String>> {
    let mut args = base_args(app, host, false)?;
    for forward in &host.forwards {
        args.extend(["-L".into(), forward.clone()]);
    }
    let start = remote_path.or(host.remote_path.as_deref()).filter(|path| !path.trim().is_empty());
    if start.is_some() {
        args.push("-t".into());
    }
    args.push("--".into());
    args.push(destination(host));
    if let Some(path) = start {
        args.push(format!("cd {} 2>/dev/null; exec \"${{SHELL:-/bin/sh}}\" -l", cd_target(path)));
    }
    Ok(args)
}

fn cd_target(path: &str) -> String {
    let path = path.trim();
    if path.is_empty() || path == "~" {
        "\"$HOME\"".into()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("\"$HOME\"/{}", quote(rest))
    } else {
        format!("-- {}", quote(path))
    }
}

fn friendly(stderr: &str) -> String {
    let message = stderr.lines().rfind(|line| !line.trim().is_empty()).unwrap_or("The SSH command failed.").trim().to_owned();
    if stderr.contains("Host key verification failed") {
        "Confirm this server's host key first: open a terminal to it once, then try again.".into()
    } else if stderr.contains("Permission denied") {
        // The front end recognises this prefix and asks for the password.
        "PASSWORD: The server asked for a password.".into()
    } else if stderr.contains("Could not resolve hostname") {
        "Could not find that server. Check the host name.".into()
    } else if stderr.contains("Connection refused") || stderr.contains("timed out") {
        format!("Could not reach the server: {message}")
    } else {
        message
    }
}

// ---- One connection per server --------------------------------------------------
//
// Starting ssh for every file operation means a full handshake (and, without connection
// sharing on Windows, a fresh login) each time. Instead Still keeps one ssh process per
// server running a tiny shell loop: each request is a script (plus optional stdin), each
// reply carries the exit code, stdout and stderr, all base64 so any bytes pass through.
// If that connection drops, the next request starts a new one; if it can't, Still falls
// back to a one-off ssh command.

const WORKER_LOOP: &str = r#"d=$(mktemp -d 2>/dev/null || echo /tmp/still.$$); mkdir -p "$d"; trap 'rm -rf "$d"' EXIT
b64d() { if command -v base64 >/dev/null 2>&1; then base64 -d 2>/dev/null || base64 -D; else openssl base64 -d -A; fi; }
b64e() { if command -v base64 >/dev/null 2>&1; then base64 | tr -d '\n'; else openssl base64 -A; fi; }
echo "STILL READY"
while IFS= read -r id && IFS= read -r body && IFS= read -r input; do
  printf '%s' "$body" | b64d > "$d/s"
  if [ -n "$input" ]; then printf '%s' "$input" | b64d > "$d/i"; else : > "$d/i"; fi
  sh "$d/s" < "$d/i" > "$d/o" 2> "$d/e"; c=$?
  printf 'STILL %s %s %s %s
' "$id" "$c" "$(b64e < "$d/o")" "$(b64e < "$d/e")"
done"#;

struct Worker {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    replies: std::sync::mpsc::Receiver<String>,
    next: u64,
}

#[derive(Default)]
pub struct Workers(Mutex<HashMap<String, std::sync::Arc<Mutex<Option<Worker>>>>>);

fn worker_slot(app: &AppHandle, id: &str) -> Option<std::sync::Arc<Mutex<Option<Worker>>>> {
    let state = app.try_state::<Workers>()?;
    let mut map = state.0.lock().ok()?;
    Some(map.entry(id.to_owned()).or_default().clone())
}

fn start_worker(app: &AppHandle, host: &SshHost) -> Result<Worker> {
    let mut cmd: Command = command(program(), &std::env::temp_dir());
    cmd.args(base_args(app, host, true)?).arg("-T").arg("--").arg(destination(host)).arg(format!("sh -c {}", quote(WORKER_LOOP)));
    if let Some(password) = password_for(app, &host.id) {
        use_password(&mut cmd, &password);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => "The ssh command was not found. Install OpenSSH and try again.".to_string(),
        _ => err(error),
    })?;
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let (sender, replies) = std::sync::mpsc::channel::<String>();
    thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            // Anything a login script prints is ignored; only protocol lines count.
            if line.starts_with("STILL ") && sender.send(line).is_err() {
                break;
            }
        }
    });
    let errors = std::sync::Arc::new(Mutex::new(String::new()));
    let sink = errors.clone();
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        while let Ok(count) = stderr.read(&mut buffer) {
            if count == 0 { break }
            if let Ok(mut text) = sink.lock() {
                text.push_str(&String::from_utf8_lossy(&buffer[..count]));
                if text.len() > 16000 { let cut = text.len() - 8000; text.drain(..cut); }
            }
        }
    });
    match replies.recv_timeout(Duration::from_secs(30)) {
        Ok(line) if line == "STILL READY" => Ok(Worker { child, stdin, replies, next: 1 }),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            let stderr = errors.lock().map(|text| text.clone()).unwrap_or_default();
            if password_for(app, &host.id).is_some() && stderr.contains("Permission denied") {
                Err("PASSWORD: That password didn't work.".into())
            } else if stderr.trim().is_empty() {
                Err("WORKER: no reply".into())
            } else {
                Err(friendly(&stderr))
            }
        }
    }
}

fn ask_worker(worker: &mut Worker, script: &str, input: Option<&[u8]>, timeout: u64) -> std::result::Result<std::result::Result<Vec<u8>, String>, String> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;
    let id = worker.next;
    worker.next += 1;
    let request = format!("{id}\n{}\n{}\n", engine.encode(script), input.map(|bytes| engine.encode(bytes)).unwrap_or_default());
    worker.stdin.write_all(request.as_bytes()).and_then(|_| worker.stdin.flush()).map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(timeout);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("timeout".into());
        }
        let line = worker.replies.recv_timeout(left).map_err(|error| error.to_string())?;
        let mut parts = line.splitn(5, ' ');
        let (_, got, code, out, errs) = (parts.next(), parts.next(), parts.next(), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        if got != Some(&id.to_string()) {
            continue; // a late reply to a request that already timed out
        }
        let out = engine.decode(out.trim()).unwrap_or_default();
        let errs = String::from_utf8_lossy(&engine.decode(errs.trim()).unwrap_or_default()).into_owned();
        return Ok(if code == Some("0") {
            Ok(out)
        } else {
            Err(errs.lines().rfind(|line| !line.trim().is_empty()).unwrap_or("The remote command failed.").trim().to_owned())
        });
    }
}

/// Run a short script on the server and return its standard output.
fn exec(app: &AppHandle, host: &SshHost, script: &str, input: Option<Vec<u8>>, timeout: u64) -> Result<Vec<u8>> {
    if let Some(slot) = worker_slot(app, &host.id) {
        let mut guard = slot.lock().map_err(err)?;
        for attempt in 0..2 {
            if guard.is_none() {
                match start_worker(app, host) {
                    Ok(worker) => *guard = Some(worker),
                    Err(message) if message.starts_with("PASSWORD:") => return Err(message),
                    Err(message) if message.starts_with("WORKER:") => break,
                    Err(message) if attempt == 1 => return Err(message),
                    Err(_) => continue,
                }
            }
            let worker = guard.as_mut().unwrap();
            match ask_worker(worker, script, input.as_deref(), timeout) {
                Ok(result) => return result,
                Err(reason) => {
                    // The connection broke (or hung): drop it and try once more on a new one.
                    if let Some(mut dead) = guard.take() {
                        let _ = dead.child.kill();
                        let _ = dead.child.wait();
                    }
                    if reason == "timeout" {
                        return Err("The server took too long to answer.".into());
                    }
                }
            }
        }
    }
    exec_once(app, host, script, input, timeout)
}

/// Forget a server's connection (after a password change or when it is removed).
pub fn drop_worker(app: &AppHandle, id: &str) {
    if let Some(slot) = worker_slot(app, id) {
        if let Ok(mut guard) = slot.lock() {
            if let Some(mut worker) = guard.take() {
                let _ = worker.child.kill();
                let _ = worker.child.wait();
            }
        }
    }
}

/// Run a short script on the server with a one-off ssh command.
fn exec_once(app: &AppHandle, host: &SshHost, script: &str, input: Option<Vec<u8>>, timeout: u64) -> Result<Vec<u8>> {
    let mut cmd: Command = command(program(), &std::env::temp_dir());
    cmd.args(base_args(app, host, true)?).arg("--").arg(destination(host)).arg(script);
    let password = password_for(app, &host.id);
    if let Some(password) = &password {
        use_password(&mut cmd, password);
    }
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => "The ssh command was not found. Install OpenSSH and try again.".to_string(),
        _ => err(error),
    })?;
    if let (Some(mut stdin), Some(bytes)) = (child.stdin.take(), input) {
        thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        });
    }
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let errors = thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(err)? {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("The server took too long to answer.".into());
        }
        thread::sleep(Duration::from_millis(15));
    };
    let bytes = out.join().unwrap_or_default();
    let stderr = errors.join().unwrap_or_default();
    match status.code() {
        Some(0) => Ok(bytes),
        Some(255) if password.is_some() && stderr.contains("Permission denied") => Err("PASSWORD: That password didn't work.".into()),
        Some(255) => Err(friendly(&stderr)),
        _ => Err(stderr.lines().rfind(|line| !line.trim().is_empty()).unwrap_or("The remote command failed.").trim().to_owned()),
    }
}

fn remote_path(root: &str, path: &str) -> Result<String> {
    if path.is_empty() {
        return Ok(root.to_owned());
    }
    if path.starts_with('/') || path.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err("Expected a path inside the remote folder.".into());
    }
    Ok(if root == "/" { format!("/{path}") } else { format!("{}/{path}", root.trim_end_matches('/')) })
}

async fn blocking<T: Send + 'static>(task: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(task).await.map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshOverview {
    saved: Vec<SshHost>,
    imported: Vec<SshHost>,
    client: Option<String>,
}

#[tauri::command]
pub async fn ssh_hosts(app: AppHandle, store: State<'_, Store>) -> Result<SshOverview> {
    let store = store.inner().clone();
    blocking(move || {
        let mut saved = store.read(|config| config.ssh_hosts.clone())?;
        saved.sort_by(|a, b| b.last_used.cmp(&a.last_used).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        let client = command(program(), &std::env::temp_dir())
            .arg("-V")
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr }).trim().to_owned());
        Ok(SshOverview { saved, imported: config_hosts(&app), client })
    })
    .await
}

#[tauri::command]
pub fn ssh_save_host(store: State<Store>, host: SshHost) -> Result<SshHost> {
    let mut host = host;
    host.source = "saved".into();
    host.host = host.host.trim().to_owned();
    host.name = if host.name.trim().is_empty() { host.host.clone() } else { host.name.trim().to_owned() };
    host.user = host.user.map(|user| user.trim().to_owned()).filter(|user| !user.is_empty());
    host.jump = host.jump.map(|jump| jump.trim().to_owned()).filter(|jump| !jump.is_empty());
    host.identity_file = host.identity_file.map(|path| path.trim().to_owned()).filter(|path| !path.is_empty());
    host.remote_path = host.remote_path.map(|path| path.trim().to_owned()).filter(|path| !path.is_empty());
    host.forwards = host.forwards.into_iter().map(|item| item.trim().to_owned()).filter(|item| !item.is_empty()).collect();
    validate(&host)?;
    if host.id.is_empty() || host.id.starts_with("config:") {
        host.id = format!("host-{}", now());
    }
    let saved = host.clone();
    store.update(|config| {
        match config.ssh_hosts.iter_mut().find(|item| item.id == host.id) {
            Some(existing) => *existing = host,
            None => config.ssh_hosts.push(host),
        }
        Ok(())
    })?;
    Ok(saved)
}

#[tauri::command]
pub fn ssh_delete_host(store: State<Store>, id: String) -> Result<()> {
    store.update(|config| {
        config.ssh_hosts.retain(|host| host.id != id);
        Ok(())
    })
}

#[tauri::command]
pub async fn ssh_test(app: AppHandle, store: State<'_, Store>, id: String) -> Result<String> {
    let host = find_host(&store, &id)?;
    blocking(move || {
        let out = exec(&app, &host, "printf '%s@%s · ' \"$(id -un 2>/dev/null || whoami)\" \"$(hostname)\"; uname -sr 2>/dev/null || echo connected", None, 20)?;
        Ok(String::from_utf8_lossy(&out).trim().to_owned())
    })
    .await
}

#[tauri::command]
pub async fn ssh_resolve(app: AppHandle, store: State<'_, Store>, id: String, path: String) -> Result<String> {
    let host = find_host(&store, &id)?;
    touch(&store, &id);
    blocking(move || {
        let out = exec(&app, &host, &format!("cd {} && pwd", cd_target(&path)), None, 25)?;
        let resolved = String::from_utf8_lossy(&out).lines().last().unwrap_or("").trim().to_owned();
        if !resolved.starts_with('/') {
            return Err("Remote folders need a POSIX shell (Linux, macOS, or BSD) on the server.".into());
        }
        Ok(resolved)
    })
    .await
}

#[derive(Serialize)]
pub struct RemoteEntry {
    name: String,
    path: String,
    directory: bool,
}

#[tauri::command]
pub async fn ssh_list(app: AppHandle, store: State<'_, Store>, id: String, root: String, path: String) -> Result<Vec<RemoteEntry>> {
    let host = find_host(&store, &id)?;
    blocking(move || {
        let full = remote_path(&root, &path)?;
        let out = exec(&app, &host, &format!("cd -- {} && LC_ALL=C ls -1Ap", quote(&full)), None, 25)?;
        let mut entries: Vec<RemoteEntry> = String::from_utf8_lossy(&out)
            .lines()
            .filter(|line| !line.is_empty() && *line != "./" && *line != "../" && *line != ".git/")
            .map(|line| {
                let directory = line.ends_with('/');
                let name = line.trim_end_matches('/').to_owned();
                let path = if path.is_empty() { name.clone() } else { format!("{path}/{name}") };
                RemoteEntry { name, path, directory }
            })
            .collect();
        entries.sort_by_cached_key(|entry| (!entry.directory, entry.name.to_lowercase()));
        Ok(entries)
    })
    .await
}

#[tauri::command]
pub async fn ssh_files(app: AppHandle, store: State<'_, Store>, id: String, root: String) -> Result<Vec<RemoteEntry>> {
    let host = find_host(&store, &id)?;
    blocking(move || {
        let script = format!(
            "cd -- {} && find . -maxdepth 8 \\( -name .git -o -name node_modules -o -name .venv -o -name __pycache__ -o -name target \\) -prune -o -type f -print 2>/dev/null | head -n 4000",
            quote(&root)
        );
        let out = exec(&app, &host, &script, None, 40)?;
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|line| line.strip_prefix("./"))
            .map(|path| RemoteEntry { name: path.rsplit('/').next().unwrap_or(path).into(), path: path.into(), directory: false })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn ssh_read(app: AppHandle, store: State<'_, Store>, id: String, root: String, path: String) -> Result<String> {
    let host = find_host(&store, &id)?;
    blocking(move || {
        let full = remote_path(&root, &path)?;
        let script = format!(
            "f={}; s=$(wc -c < \"$f\") || exit 1; if [ \"$s\" -gt 4194304 ]; then echo 'The editor opens text files up to 4 MB.' >&2; exit 3; fi; cat -- \"$f\"",
            quote(&full)
        );
        let out = exec(&app, &host, &script, None, 40)?;
        if out.contains(&0) {
            return Err("This file contains binary data.".into());
        }
        String::from_utf8(out).map_err(|_| "This file is not UTF-8 text.".into())
    })
    .await
}

#[tauri::command]
pub async fn ssh_write(app: AppHandle, store: State<'_, Store>, id: String, root: String, path: String, contents: String) -> Result<()> {
    let host = find_host(&store, &id)?;
    blocking(move || {
        let full = remote_path(&root, &path)?;
        // Upload to a temporary file first so a dropped connection never truncates the original.
        let script = format!("f={}; t=\"$f.still-$$\"; cat > \"$t\" && cat \"$t\" > \"$f\"; s=$?; rm -f \"$t\"; exit $s", quote(&full));
        exec(&app, &host, &script, Some(contents.into_bytes()), 60)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn ssh_fs(
    app: AppHandle,
    store: State<'_, Store>,
    id: String,
    root: String,
    op: String,
    path: String,
    target: Option<String>,
) -> Result<()> {
    let host = find_host(&store, &id)?;
    blocking(move || {
        if path.is_empty() {
            return Err("Expected a path inside the remote folder.".into());
        }
        let full = quote(&remote_path(&root, &path)?);
        let exists = "echo 'Something with this name already exists.' >&2; exit 1";
        let script = match op.as_str() {
            "mkdir" => format!("[ -e {full} ] && {{ {exists}; }}; mkdir -p -- {full}"),
            "touch" => format!("[ -e {full} ] && {{ {exists}; }}; : > {full}"),
            "rename" => {
                let to = quote(&remote_path(&root, target.as_deref().unwrap_or_default())?);
                format!("[ -e {to} ] && {{ {exists}; }}; mv -- {full} {to}")
            }
            "delete" => format!("rm -rf -- {full}"),
            _ => return Err("Unknown remote file operation.".into()),
        };
        exec(&app, &host, &script, None, 30)?;
        Ok(())
    })
    .await
}

#[derive(Serialize)]
pub struct RemoteMatch {
    path: String,
    line: usize,
    column: usize,
    preview: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_search(
    app: AppHandle,
    store: State<'_, Store>,
    id: String,
    root: String,
    query: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<serde_json::Value> {
    let host = find_host(&store, &id)?;
    blocking(move || {
        let mut flags = String::from(if regex { "-E" } else { "-F" });
        if !case_sensitive {
            flags.push_str(" -i");
        }
        if whole_word {
            flags.push_str(" -w");
        }
        let script = format!(
            "cd -- {} && grep -rnI {flags} --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=__pycache__ -e {} . 2>/dev/null | head -n 2001; exit 0",
            quote(&root),
            quote(&query)
        );
        let out = exec(&app, &host, &script, None, 60)?;
        let text = String::from_utf8_lossy(&out);
        let mut matches = Vec::new();
        for line in text.lines() {
            let Some(rest) = line.strip_prefix("./") else { continue };
            let mut parts = rest.splitn(3, ':');
            let (Some(path), Some(number), Some(preview)) = (parts.next(), parts.next(), parts.next()) else { continue };
            let Ok(number) = number.parse() else { continue };
            let column = if case_sensitive { preview.find(&query) } else { preview.to_lowercase().find(&query.to_lowercase()) }.map(|at| preview[..at].chars().count() + 1).unwrap_or(1);
            matches.push(RemoteMatch { path: path.into(), line: number, column, preview: preview.chars().take(240).collect() });
        }
        let truncated = matches.len() > 2000;
        matches.truncate(2000);
        let files = matches.iter().map(|item| item.path.as_str()).collect::<std::collections::HashSet<_>>().len();
        Ok(serde_json::json!({ "matches": matches, "files": files, "truncated": truncated }))
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn ssh_run(
    app: AppHandle,
    store: State<Store>,
    jobs: State<Jobs>,
    id: String,
    host_id: String,
    root: String,
    path: String,
    args: Option<String>,
) -> Result<()> {
    let host = find_host(&store, &host_id)?;
    let full = remote_path(&root, &path)?;
    let args = parse_args(args)?;
    let extension = path.rsplit_once('.').map(|(_, ext)| ext.to_lowercase()).unwrap_or_default();
    let runner = match extension.as_str() {
        "py" => "python3 -u",
        "js" | "mjs" | "cjs" => "node",
        "sh" | "bash" => "bash",
        "java" => "java",
        "go" => "go run",
        "rb" => "ruby",
        _ => return Err("Remote run supports Python, JavaScript, shell, Java, Go, and Ruby files.".into()),
    };
    let mut ssh_args = base_args(&app, &host, true)?;
    ssh_args.push("--".into());
    ssh_args.push(destination(&host));
    let quoted_args: String = args.iter().map(|arg| format!(" {}", quote(arg))).collect();
    ssh_args.push(format!("cd -- {} && {runner} {}{quoted_args}", quote(&root), quote(&full)));
    let label = format!("$ ssh {} {runner} {path}{}\n", host.name, quoted_args);
    let password = password_for(&app, &host.id);
    jobs.start(app, id, true, move |job| {
        job.emit("command", label);
        let mut cmd = command(program(), &std::env::temp_dir());
        cmd.args(&ssh_args);
        if let Some(password) = &password {
            use_password(&mut cmd, password);
        }
        let (code, _) = job.run(&mut cmd, false)?;
        Ok((code, Vec::new()))
    })
}

/// Runs a shell command in the remote project folder (only after the person approved it in the chat).
#[tauri::command]
pub async fn ssh_command(app: AppHandle, store: State<'_, Store>, id: String, root: String, command_line: String) -> Result<String> {
    let host = find_host(&store, &id)?;
    blocking(move || {
        let script = format!("cd -- {} && {{ {}\n}} 2>&1; echo \"[exit $?]\"", quote(&root), command_line);
        let out = exec(&app, &host, &script, None, 300)?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    })
    .await
}
