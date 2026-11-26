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
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Mutex,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

/// Passwords typed this session, by host id. Memory only.
#[derive(Default)]
pub struct Passwords(Mutex<HashMap<String, String>>);

// ---- Login prompts --------------------------------------------------------------
//
// OpenSSH runs Still itself as its SSH_ASKPASS helper. The helper doesn't know any
// secrets: it sends each prompt the server shows ("Password:", "Verification code:",
// "Enter passphrase for key …") to the running app over a local socket, and prints
// whatever comes back. The app answers a password prompt with the password typed
// earlier this session; anything else (one-time codes, a password that was refused)
// is shown to the person, with the server's own wording.

const PORT_ENV: &str = "STILL_ASKPASS_PORT";
const TOKEN_ENV: &str = "STILL_ASKPASS_TOKEN";
const ATTEMPT_ENV: &str = "STILL_ASKPASS_ATTEMPT";
const HOST_ENV: &str = "STILL_ASKPASS_HOST";
const LABEL_ENV: &str = "STILL_ASKPASS_LABEL";

#[derive(Serialize, Deserialize)]
struct PromptRequest {
    token: String,
    attempt: String,
    host: String,
    label: String,
    prompt: String,
}

#[derive(Serialize, Deserialize)]
struct PromptReply {
    answer: Option<String>,
}

/// When OpenSSH runs Still as its askpass helper, relay the prompt to the app, print the
/// answer and exit before any window is created. Returns true if this process was an askpass call.
pub fn askpass_mode() -> bool {
    let Ok(port) = std::env::var(PORT_ENV) else { return false };
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let request = PromptRequest {
        token: std::env::var(TOKEN_ENV).unwrap_or_default(),
        attempt: std::env::var(ATTEMPT_ENV).unwrap_or_default(),
        host: std::env::var(HOST_ENV).unwrap_or_default(),
        label: std::env::var(LABEL_ENV).unwrap_or_default(),
        prompt,
    };
    let answer = (|| -> Option<String> {
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port.parse::<u16>().ok()?)).ok()?;
        let mut line = serde_json::to_string(&request).ok()?;
        line.push('\n');
        stream.write_all(line.as_bytes()).ok()?;
        let mut reply = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(stream), &mut reply).ok()?;
        serde_json::from_str::<PromptReply>(&reply).ok()?.answer
    })();
    match answer {
        Some(answer) => {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{answer}");
            let _ = out.flush();
            true
        }
        None => std::process::exit(1),
    }
}

#[derive(Default)]
struct Attempt {
    /// Prompts already answered automatically with the saved password; seeing one again means it was refused.
    answered: Vec<String>,
    cancelled: bool,
    asked_at: Option<Instant>,
}

#[derive(Default)]
pub struct Prompts {
    bridge: Mutex<Option<(u16, String)>>,
    waiting: Mutex<HashMap<u64, std::sync::mpsc::Sender<Option<String>>>>,
    attempts: Mutex<HashMap<String, Attempt>>,
    next: std::sync::atomic::AtomicU64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PromptEvent {
    request: u64,
    host: String,
    prompt: String,
    kind: &'static str,
    retry: bool,
}

fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut text = String::new();
    for salt in 0..2u64 {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(salt ^ std::process::id() as u64);
        hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or_default());
        text.push_str(&format!("{:016x}", hasher.finish()));
    }
    text
}

/// Starts the local prompt relay on first use. Returns its port and the secret token.
fn bridge(app: &AppHandle) -> Option<(u16, String)> {
    let prompts = app.try_state::<Prompts>()?;
    let mut bridge = prompts.bridge.lock().ok()?;
    if let Some(found) = bridge.clone() {
        return Some(found);
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
    let port = listener.local_addr().ok()?.port();
    let token = random_token();
    let handle = app.clone();
    let expected = token.clone();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let handle = handle.clone();
            let expected = expected.clone();
            thread::spawn(move || answer_prompt(&handle, stream, &expected));
        }
    });
    *bridge = Some((port, token.clone()));
    Some((port, token))
}

fn answer_prompt(app: &AppHandle, stream: std::net::TcpStream, token: &str) {
    use std::io::BufRead;
    let Ok(mut writer) = stream.try_clone() else { return };
    let mut line = String::new();
    if std::io::BufReader::new(stream).read_line(&mut line).is_err() {
        return;
    }
    let reply = |writer: &mut std::net::TcpStream, answer: Option<String>| {
        let text = serde_json::to_string(&PromptReply { answer }).unwrap_or_else(|_| "{}".into());
        let _ = writer.write_all(format!("{text}\n").as_bytes());
    };
    let Ok(request) = serde_json::from_str::<PromptRequest>(&line) else { return reply(&mut writer, None) };
    let Some(prompts) = app.try_state::<Prompts>() else { return reply(&mut writer, None) };
    if request.token != token {
        return reply(&mut writer, None);
    }
    let text = request.prompt.trim().to_owned();
    let lower = text.to_lowercase();
    // New host keys are accepted by StrictHostKeyChecking=accept-new; a *changed* key must be
    // looked at in a terminal, never waved through from a dialog.
    if lower.contains("yes/no") || lower.contains("fingerprint") {
        return reply(&mut writer, None);
    }
    let one_time = ["verification", "code", "otp", "token", "passcode", "authenticator", "2fa", "duo", "pin"].iter().any(|word| lower.contains(word));
    let secret_kind = if one_time { "code" } else if lower.contains("passphrase") { "passphrase" } else if lower.contains("password") { "password" } else { "other" };
    let retry;
    {
        let Ok(mut attempts) = prompts.attempts.lock() else { return reply(&mut writer, None) };
        let attempt = attempts.entry(request.attempt.clone()).or_default();
        if attempt.cancelled {
            return reply(&mut writer, None);
        }
        // A password prompt straight after itself means the password was refused. After a code
        // prompt, the server is just starting over (the code was wrong), so the password is fine.
        retry = if secret_kind == "password" { attempt.answered.last() == Some(&text) } else { attempt.answered.contains(&text) };
        if secret_kind == "password" && !retry {
            if let Some(saved) = password_for(app, &request.host) {
                attempt.answered.push(text.clone());
                return reply(&mut writer, Some(saved));
            }
        }
        attempt.asked_at = Some(Instant::now());
    }
    // Ask the person and wait for their answer.
    let id = prompts.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let (sender, receiver) = std::sync::mpsc::channel();
    if let Ok(mut waiting) = prompts.waiting.lock() {
        waiting.insert(id, sender);
    }
    let _ = tauri::Emitter::emit(app, "ssh-prompt", PromptEvent { request: id, host: request.label.clone(), prompt: text.clone(), kind: secret_kind, retry });
    let answer = receiver.recv_timeout(Duration::from_secs(300)).ok().flatten();
    if let Ok(mut waiting) = prompts.waiting.lock() {
        waiting.remove(&id);
    }
    if let Ok(mut attempts) = prompts.attempts.lock() {
        let attempt = attempts.entry(request.attempt.clone()).or_default();
        attempt.asked_at = Some(Instant::now());
        match &answer {
            None => attempt.cancelled = true,
            Some(_) if secret_kind != "password" => attempt.answered.push(text.clone()),
            Some(value) => {
                attempt.answered.push(text.clone());
                if let Some(passwords) = app.try_state::<Passwords>() {
                    if let Ok(mut map) = passwords.0.lock() {
                        map.insert(request.host.clone(), value.clone());
                    }
                }
            }
        }
    }
    reply(&mut writer, answer)
}

/// The person answered (or cancelled) a login prompt.
#[tauri::command]
pub fn ssh_prompt_answer(app: AppHandle, request: u64, answer: Option<String>) -> Result<()> {
    let prompts = app.state::<Prompts>();
    if let Some(sender) = prompts.waiting.lock().map_err(err)?.remove(&request) {
        let _ = sender.send(answer);
    }
    Ok(())
}

fn password_for(app: &AppHandle, id: &str) -> Option<String> {
    app.try_state::<Passwords>()?.0.lock().ok()?.get(id).cloned()
}

/// Route `cmd`'s login prompts through the app. Returns the attempt id, to check afterwards
/// whether the person cancelled or is still typing.
fn use_prompts(app: &AppHandle, cmd: &mut Command, host: &SshHost) -> Option<String> {
    let (port, token) = bridge(app)?;
    let exe = std::env::current_exe().ok()?;
    let attempt = random_token();
    cmd.env("SSH_ASKPASS", exe)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env(PORT_ENV, port.to_string())
        .env(TOKEN_ENV, token)
        .env(ATTEMPT_ENV, &attempt)
        .env(HOST_ENV, &host.id)
        .env(LABEL_ENV, &host.name);
    if std::env::var_os("DISPLAY").is_none() {
        cmd.env("DISPLAY", "still:0");
    }
    Some(attempt)
}

/// True while someone is answering a prompt for this attempt (or did so in the last few minutes).
fn prompting(app: &AppHandle, attempt: &Option<String>) -> bool {
    let Some(attempt) = attempt else { return false };
    let Some(prompts) = app.try_state::<Prompts>() else { return false };
    let Ok(attempts) = prompts.attempts.lock() else { return false };
    attempts.get(attempt).and_then(|item| item.asked_at).is_some_and(|time| time.elapsed() < Duration::from_secs(300))
        || prompts.waiting.lock().map(|waiting| !waiting.is_empty()).unwrap_or(false)
}

fn cancelled(app: &AppHandle, attempt: &Option<String>) -> bool {
    let Some(attempt) = attempt else { return false };
    app.try_state::<Prompts>().and_then(|prompts| prompts.attempts.lock().ok().map(|attempts| attempts.get(attempt).is_some_and(|item| item.cancelled))).unwrap_or(false)
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
    if batch {
        // No terminal here: login prompts go through Still (see Prompts above). New host keys are
        // trusted on first use, as a terminal would ask; a changed key is refused.
        args.extend(["-o".into(), "NumberOfPasswordPrompts=3".into(), "-o".into(), "StrictHostKeyChecking=accept-new".into(), "-o".into(), "ConnectTimeout=12".into()]);
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
        "The server didn't accept the login. Check the user name and password (or key), then try again.".into()
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

// When the server has python3 (most do), the connection runs this relay instead of the
// shell loop: it answers the same requests and also carries terminals (a pty per
// session), so a terminal reuses the connection you already signed in on — no second
// password or verification code. Standard library only; works with Python 3.5+.
const RELAY_PY: &str = r#"
import os, sys, pty, select, struct, fcntl, termios, signal, base64, threading, subprocess, tempfile
out_lock = threading.Lock()
def send(line):
    with out_lock:
        sys.stdout.buffer.write((line + '\n').encode()); sys.stdout.buffer.flush()
b64 = lambda data: base64.b64encode(data).decode()
work = tempfile.mkdtemp(prefix='still.')
def run(rid, body, data):
    path = os.path.join(work, 's' + rid)
    with open(path, 'wb') as handle: handle.write(body)
    try:
        done = subprocess.run(['sh', path], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        send('STILL %s %d %s %s' % (rid, done.returncode, b64(done.stdout), b64(done.stderr)))
    except Exception as error:
        send('STILL %s 127 %s %s' % (rid, '', b64(str(error).encode())))
    finally:
        try: os.unlink(path)
        except OSError: pass
terms = {}
def size(fd, cols, rows):
    try: fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    except OSError: pass
def opened(sid, cols, rows, cwd):
    pid, fd = pty.fork()
    if pid == 0:
        try: os.chdir(os.path.expanduser(cwd) if cwd else os.path.expanduser('~'))
        except OSError: os.chdir(os.path.expanduser('~'))
        env = dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor', TERM_PROGRAM='Still')
        shell = env.get('SHELL') or '/bin/sh'
        try: os.execvpe(shell, [shell, '-l'], env)
        except OSError: os.execvpe('/bin/sh', ['/bin/sh', '-l'], env)
    size(fd, cols, rows)
    terms[sid] = (pid, fd)
def finish(sid):
    pid, fd = terms.pop(sid)
    try: os.close(fd)
    except OSError: pass
    code = 0
    try:
        _, status = os.waitpid(pid, 0)
        code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
    except OSError: pass
    send('STILLT exit %s %d' % (sid, code))
buffer = b''
pending = []
send('STILL READY relay')
while True:
    fds = [0] + [fd for _, fd in terms.values()]
    try: ready, _, _ = select.select(fds, [], [], 30)
    except InterruptedError: continue
    for fd in ready:
        if fd == 0:
            chunk = os.read(0, 65536)
            if not chunk:
                for sid in list(terms): os.kill(terms[sid][0], signal.SIGHUP)
                sys.exit(0)
            buffer += chunk
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                text = line.decode('utf-8', 'replace')
                if pending or not text.startswith('T '):
                    pending.append(text)
                    if len(pending) == 3:
                        rid, body, data = pending; pending = []
                        threading.Thread(target=run, args=(rid, base64.b64decode(body), base64.b64decode(data) if data else b''), daemon=True).start()
                    continue
                parts = text.split(' ')
                kind, sid = parts[1], parts[2] if len(parts) > 2 else ''
                try:
                    if kind == 'open': opened(sid, int(parts[3]), int(parts[4]), base64.b64decode(parts[5]).decode() if len(parts) > 5 else '')
                    elif kind == 'in' and sid in terms: os.write(terms[sid][1], base64.b64decode(parts[3]))
                    elif kind == 'resize' and sid in terms: size(terms[sid][1], int(parts[3]), int(parts[4]))
                    elif kind == 'close' and sid in terms: os.kill(terms[sid][0], signal.SIGHUP)
                except Exception as error:
                    if kind == 'open': send('STILLT exit %s 127' % sid)
        else:
            sid = next((key for key, value in terms.items() if value[1] == fd), None)
            if sid is None: continue
            try: data = os.read(fd, 65536)
            except OSError: data = b''
            if data: send('STILLT data %s %s' % (sid, b64(data)))
            else: finish(sid)
"#;

/// Terminals carried over a server's relay connection, by host id.
#[derive(Default)]
pub struct Relays(Mutex<HashMap<String, Relay>>);
#[derive(Clone)]
struct Relay {
    stdin: std::sync::Arc<Mutex<std::process::ChildStdin>>,
    sessions: std::sync::Arc<Mutex<std::collections::HashSet<String>>>,
}

struct Worker {
    child: std::process::Child,
    stdin: std::sync::Arc<Mutex<std::process::ChildStdin>>,
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
    let launch = format!("if command -v python3 >/dev/null 2>&1; then exec python3 -u -c {}; else exec sh -c {}; fi", quote(RELAY_PY), quote(WORKER_LOOP));
    cmd.args(base_args(app, host, true)?).arg("-T").arg("--").arg(destination(host)).arg(format!("sh -c {}", quote(&launch)));
    let attempt = use_prompts(app, &mut cmd, host);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => "The ssh command was not found. Install OpenSSH and try again.".to_string(),
        _ => err(error),
    })?;
    let stdin = std::sync::Arc::new(Mutex::new(child.stdin.take().unwrap()));
    let stdout = child.stdout.take().unwrap();
    let sessions: std::sync::Arc<Mutex<std::collections::HashSet<String>>> = Default::default();
    let terminal_app = app.clone();
    let open_sessions = sessions.clone();
    let mut stderr = child.stderr.take().unwrap();
    let (sender, replies) = std::sync::mpsc::channel::<String>();
    thread::spawn(move || {
        use base64::Engine;
        use std::io::BufRead;
        use tauri::Emitter;
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            // Terminal traffic from the relay goes straight to the terminal in the window.
            if let Some(rest) = line.strip_prefix("STILLT ") {
                let mut parts = rest.splitn(3, ' ');
                let (kind, id, value) = (parts.next().unwrap_or(""), parts.next().unwrap_or("").to_owned(), parts.next().unwrap_or(""));
                if kind == "data" {
                    let bytes = base64::engine::general_purpose::STANDARD.decode(value.trim()).unwrap_or_default();
                    let _ = terminal_app.emit("terminal-data", crate::terminal::TerminalData { id, bytes });
                } else if kind == "exit" {
                    if let Ok(mut open) = open_sessions.lock() { open.remove(&id); }
                    terminal_app.state::<crate::terminal::TerminalState>().forget(&id);
                    let _ = terminal_app.emit("terminal-exit", crate::terminal::TerminalExit { id, code: value.trim().parse().ok() });
                }
                continue;
            }
            // Anything a login script prints is ignored; only protocol lines count.
            if line.starts_with("STILL ") && sender.send(line).is_err() {
                break;
            }
        }
        // The connection ended: close the terminals that were riding on it.
        let ids: Vec<String> = open_sessions.lock().map(|open| open.iter().cloned().collect()).unwrap_or_default();
        for id in ids {
            terminal_app.state::<crate::terminal::TerminalState>().forget(&id);
            let _ = terminal_app.emit("terminal-exit", crate::terminal::TerminalExit { id, code: None });
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
    // Wait for the shell loop to start. While someone is typing a password or code, keep waiting.
    let started = Instant::now();
    let mut relay = false;
    let ready = loop {
        match replies.recv_timeout(Duration::from_millis(400)) {
            Ok(line) if line == "STILL READY" => break true,
            Ok(line) if line == "STILL READY relay" => { relay = true; break true }
            Ok(_) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break false,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if matches!(child.try_wait(), Ok(Some(_))) || (started.elapsed() > Duration::from_secs(30) && !prompting(app, &attempt)) || started.elapsed() > Duration::from_secs(330) {
                    break false;
                }
            }
        }
    };
    if ready {
        if let Some(relays) = app.try_state::<Relays>() {
            if let Ok(mut map) = relays.0.lock() {
                if relay { map.insert(host.id.clone(), Relay { stdin: stdin.clone(), sessions }); } else { map.remove(&host.id); }
            }
        }
        return Ok(Worker { child, stdin, replies, next: 1 });
    }
    let _ = child.kill();
    let _ = child.wait();
    let stderr = errors.lock().map(|text| text.clone()).unwrap_or_default();
    if cancelled(app, &attempt) {
        Err("LOGIN: Login cancelled.".into())
    } else if stderr.trim().is_empty() {
        Err("WORKER: no reply".into())
    } else {
        Err(format!("LOGIN: {}", friendly(&stderr)))
    }
}

fn ask_worker(worker: &mut Worker, script: &str, input: Option<&[u8]>, timeout: u64) -> std::result::Result<std::result::Result<Vec<u8>, String>, String> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;
    let id = worker.next;
    worker.next += 1;
    let request = format!("{id}\n{}\n{}\n", engine.encode(script), input.map(|bytes| engine.encode(bytes)).unwrap_or_default());
    {
        let mut stdin = worker.stdin.lock().map_err(|error| error.to_string())?;
        stdin.write_all(request.as_bytes()).and_then(|_| stdin.flush()).map_err(|error| error.to_string())?;
    }
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
                    // A refused or cancelled login: don't try again behind the person's back.
                    Err(message) if message.starts_with("LOGIN: ") => return Err(message["LOGIN: ".len()..].to_owned()),
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
    if let Some(relays) = app.try_state::<Relays>() {
        if let Ok(mut map) = relays.0.lock() { map.remove(id); }
    }
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
    let attempt = use_prompts(app, &mut cmd, host);
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
        if Instant::now() > deadline && !prompting(app, &attempt) {
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
        Some(255) if cancelled(app, &attempt) => Err("Login cancelled.".into()),
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
pub struct RemoteListing {
    path: String,
    home: String,
    entries: Vec<RemoteEntry>,
}

/// Connects (if needed) and lists one folder on the server, for picking a folder to open.
/// `~` and `~/…` are expanded on the server; `..` is allowed so the user can walk up.
#[tauri::command]
pub async fn ssh_browse(app: AppHandle, store: State<'_, Store>, id: String, path: String) -> Result<RemoteListing> {
    let host = find_host(&store, &id)?;
    touch(&store, &id);
    blocking(move || {
        let script = format!(
            "cd {} 2>/dev/null || {{ echo 'STILL-NO-DIR' >&2; exit 3; }}; printf '%s\\n%s\\n' \"$(pwd)\" \"$HOME\"; LC_ALL=C ls -1Ap 2>/dev/null",
            cd_target(&path)
        );
        let out = exec(&app, &host, &script, None, 25).map_err(|error| {
            if error.contains("STILL-NO-DIR") { format!("{path} is not a folder you can open.") } else { error }
        })?;
        let text = String::from_utf8_lossy(&out);
        let mut lines = text.lines();
        let path = lines.next().unwrap_or("").trim().to_owned();
        let home = lines.next().unwrap_or("").trim().to_owned();
        if !path.starts_with('/') {
            return Err("Remote folders need a POSIX shell (Linux, macOS, or BSD) on the server.".into());
        }
        let mut entries: Vec<RemoteEntry> = lines
            .filter(|line| !line.is_empty() && *line != "./" && *line != "../")
            .map(|line| {
                let directory = line.ends_with('/');
                let name = line.trim_end_matches('/').to_owned();
                let full = if path == "/" { format!("/{name}") } else { format!("{path}/{name}") };
                RemoteEntry { name, path: full, directory }
            })
            .collect();
        entries.sort_by_cached_key(|entry| (!entry.directory, entry.name.starts_with('.'), entry.name.to_lowercase()));
        Ok(RemoteListing { path, home, entries })
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
    env: Option<String>,
    dotenv: Option<bool>,
) -> Result<()> {
    let host = find_host(&store, &host_id)?;
    let full = remote_path(&root, &path)?;
    let args = parse_args(args)?;
    let prefix = env_prefix(env.as_deref(), dotenv.unwrap_or(false));
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
    ssh_args.push(format!("cd -- {} && {prefix}{runner} {}{quoted_args}", quote(&root), quote(&full)));
    let label = format!("$ ssh {} {runner} {path}{}\n", host.name, quoted_args);
    let prompts_app = app.clone();
    jobs.start(app, id, true, move |job| {
        job.emit("command", label);
        let mut cmd = command(program(), &std::env::temp_dir());
        cmd.args(&ssh_args);
        use_prompts(&prompts_app, &mut cmd, &host);
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


// ---- Terminals over the relay -------------------------------------------------------

fn relay_send(relay: &Relay, line: &str) -> Result<()> {
    let mut stdin = relay.stdin.lock().map_err(err)?;
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.write_all(b"\n")).and_then(|_| stdin.flush()).map_err(err)
}

/// Keystrokes for one relay terminal.
pub struct RelayWriter { relay: Relay, id: String }
impl Write for RelayWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        use base64::Engine;
        relay_send(&self.relay, &format!("T in {} {}", self.id, base64::engine::general_purpose::STANDARD.encode(buffer))).map_err(std::io::Error::other)?;
        Ok(buffer.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

pub struct RelayTerminal {
    pub writer: RelayWriter,
    pub resize: Box<dyn Fn(u16, u16) -> Result<()> + Send>,
    pub close: Box<dyn FnMut() + Send>,
}

/// Opens a terminal on the server over the connection that is already signed in (starting it,
/// and signing in, if needed). Errors with "NORELAY" when the server has no python3.
pub fn relay_terminal(app: &AppHandle, store: &Store, host_id: &str, id: &str, cols: u16, rows: u16, path: Option<&str>) -> Result<RelayTerminal> {
    use base64::Engine;
    let host = find_host(store, host_id)?;
    let existing = || app.try_state::<Relays>().and_then(|relays| relays.0.lock().ok().and_then(|map| map.get(host_id).cloned()));
    let relay = match existing() {
        Some(relay) => relay,
        None => {
            // Start (and sign in to) the connection with a harmless request.
            exec(app, &host, "true", None, 30)?;
            existing().ok_or("NORELAY")?
        }
    };
    relay.sessions.lock().map_err(err)?.insert(id.to_owned());
    let start = path.or(host.remote_path.as_deref()).unwrap_or("");
    relay_send(&relay, &format!("T open {id} {} {} {}", cols.max(2), rows.max(2), base64::engine::general_purpose::STANDARD.encode(start)))?;
    let (resize_relay, close_relay) = (relay.clone(), relay.clone());
    let (resize_id, close_id) = (id.to_owned(), id.to_owned());
    Ok(RelayTerminal {
        writer: RelayWriter { relay, id: id.to_owned() },
        resize: Box::new(move |cols, rows| relay_send(&resize_relay, &format!("T resize {resize_id} {} {}", cols.max(2), rows.max(2)))),
        close: Box::new(move || { let _ = relay_send(&close_relay, &format!("T close {close_id}")); }),
    })
}

/// Login prompts for an interactive ssh in a terminal go through the app too, so a saved
/// password is filled in for you.
pub fn prompt_env(app: &AppHandle, host: &SshHost) -> Vec<(String, String)> {
    let mut probe = Command::new("ssh");
    if use_prompts(app, &mut probe, host).is_none() {
        return Vec::new();
    }
    probe.get_envs().filter_map(|(key, value)| Some((key.to_string_lossy().into_owned(), value?.to_string_lossy().into_owned()))).collect()
}

// ---- Debugging Python on the server --------------------------------------------------

/// Runs a Python file on the server under Still's debugger. The driver is the same one used
/// locally; over SSH its messages travel as marked lines on stderr and its commands as marked
/// lines on stdin, so no port needs forwarding.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn ssh_debug_start(
    app: AppHandle,
    store: State<Store>,
    jobs: State<Jobs>,
    id: String,
    host_id: String,
    root: String,
    path: String,
    breakpoints: Vec<serde_json::Value>,
    watches: Vec<String>,
    stop_on_entry: bool,
    args: Option<String>,
    pause_on: Option<String>,
    env: Option<String>,
    dotenv: Option<bool>,
) -> Result<()> {
    use base64::Engine;
    if !path.ends_with(".py") && !path.ends_with(".java") {
        return Err("Debugging on a server works with Python and Java files.".into());
    }
    let host = find_host(&store, &host_id)?;
    let full = remote_path(&root, &path)?;
    let args = parse_args(args)?;
    let prefix = env_prefix(env.as_deref(), dotenv.unwrap_or(false));
    if path.ends_with(".java") {
        let setup = serde_json::json!({ "breakpoints": breakpoints, "watches": watches, "stopOnEntry": stop_on_entry, "pauseOn": pause_on.unwrap_or_else(|| "uncaught".into()) });
        let (sender, commands) = std::sync::mpsc::channel::<serde_json::Value>();
        app.state::<crate::debug::Debuggers>().0.lock().map_err(err)?.insert(id.clone(), sender);
        let events = app.clone();
        let session_id = id.clone();
        return jobs.start(app, id, true, move |job| {
            let result = java_debug(job, &events, &host, &root, &path, &args, &prefix, setup, commands, session_id.clone());
            if let Ok(mut map) = events.state::<crate::debug::Debuggers>().0.lock() { map.remove(&session_id); }
            result
        });
    }
    let driver = base64::engine::general_purpose::STANDARD.encode(crate::debug::DRIVER);
    let quoted_args: String = args.iter().map(|arg| format!(" {}", quote(arg))).collect();
    let mut ssh_args = base_args(&app, &host, true)?;
    ssh_args.push("--".into());
    ssh_args.push(destination(&host));
    ssh_args.push(format!(
        "cd -- {root} && {prefix}STILL_DEBUG_STDIO=1 STILL_DEBUG_ROOT={root} PYTHONIOENCODING=utf-8 python3 -u -c {code} {file}{quoted_args}",
        root = quote(&root),
        code = quote(&format!("import base64;exec(compile(base64.b64decode('{driver}'),'<still-debug>','exec'))")),
        file = quote(&full),
    ));
    let setup = serde_json::json!({ "breakpoints": breakpoints, "watches": watches, "stopOnEntry": stop_on_entry, "pauseOn": pause_on.unwrap_or_else(|| "uncaught".into()) });
    let (sender, commands) = std::sync::mpsc::channel::<serde_json::Value>();
    app.state::<crate::debug::Debuggers>().0.lock().map_err(err)?.insert(id.clone(), sender);
    let label = format!("$ ssh {} debug {path}{}\n", host.name, quoted_args);
    let events = app.clone();
    let prompts_app = app.clone();
    let session_id = id.clone();
    jobs.start(app, id, true, move |job| {
        job.emit("command", label);
        let mut cmd = command(program(), &std::env::temp_dir());
        cmd.args(&ssh_args);
        use_prompts(&prompts_app, &mut cmd, &host);
        let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(err)?;
        let slot = job.input_slot();
        if let Ok(mut input) = slot.lock() { *input = child.stdin.take(); }
        let send = |slot: &crate::process::Input, line: String| {
            if let Ok(mut input) = slot.lock() {
                if let Some(stdin) = input.as_mut() { let _ = stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()); }
            }
        };
        send(&slot, format!("\x1eSTILL {setup}\n"));
        let forward = slot.clone();
        thread::spawn(move || { for command in commands { send(&forward, format!("\x1eSTILL {command}\n")); } });
        let stdout = child.stdout.take().ok_or("no output")?;
        let mut stderr = child.stderr.take().ok_or("no output")?;
        let code = thread::scope(|scope| {
            scope.spawn(|| crate::process::stream(stdout, job, "stdout", false));
            scope.spawn(|| {
                let mut buffer = [0u8; 8192];
                let mut pending = String::new();
                let mut bytes = Vec::new();
                let marker = "\x1eSTILL-DEBUG ";
                loop {
                    let size = match stderr.read(&mut buffer) { Ok(0) | Err(_) => break, Ok(size) => size };
                    bytes.extend_from_slice(&buffer[..size]);
                    let end = match std::str::from_utf8(&bytes) { Err(error) if error.error_len().is_none() => error.valid_up_to(), _ => bytes.len() };
                    pending.push_str(&String::from_utf8_lossy(&bytes[..end]));
                    bytes.drain(..end);
                    while let Some(at) = pending.find('\n') {
                        let line: String = pending.drain(..=at).collect();
                        match line.find(marker) {
                            Some(start) => {
                                if start > 0 { job.emit("stderr", line[..start].to_owned()); }
                                if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(line[start + marker.len()..].trim()) {
                                    value["id"] = serde_json::Value::String(session_id.clone());
                                    let _ = events.emit("debug-event", value);
                                }
                            }
                            None => job.emit("stderr", line),
                        }
                    }
                    // Show a prompt without a newline right away, unless it may be the start of a marker.
                    if !pending.is_empty() && !pending.contains('\x1e') { job.emit("stderr", std::mem::take(&mut pending)); }
                }
                if !pending.is_empty() { job.emit("stderr", pending); }
            });
            loop {
                if job.is_cancelled() { let _ = child.kill(); let _ = child.wait(); break 130 }
                if let Ok(Some(status)) = child.try_wait() { break status.code().unwrap_or(1) }
                thread::sleep(Duration::from_millis(25));
            }
        });
        if let Ok(mut input) = slot.lock() { input.take(); }
        if let Ok(mut map) = events.state::<crate::debug::Debuggers>().0.lock() { map.remove(&session_id); }
        let _ = events.emit("debug-event", serde_json::json!({ "id": session_id, "event": "ended" }));
        Ok((code, Vec::new()))
    })
}

/// Shell lines that set a run's environment on the server: the project's .env file (optional) and
/// the run configuration's NAME=value lines.
fn env_prefix(env: Option<&str>, dotenv: bool) -> String {
    let mut prefix = String::new();
    if dotenv { prefix.push_str("if [ -f .env ]; then set -a; . ./.env; set +a; fi; "); }
    let pairs: Vec<String> = env.unwrap_or("").lines().filter_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { return None }
        let (name, value) = line.split_once('=')?;
        let name = name.trim().trim_start_matches("export ").trim();
        let valid = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !name.starts_with(|c: char| c.is_ascii_digit());
        let value = value.trim();
        let value = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')).or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\''))).unwrap_or(value);
        valid.then(|| format!("{name}={}", quote(value)))
    }).collect();
    if !pairs.is_empty() { prefix.push_str(&format!("export {}; ", pairs.join(" "))); }
    prefix
}

/// Debugs a Java file on the server: compile it there with -g, then drive jdb over SSH with the
/// same code that drives it locally.
#[allow(clippy::too_many_arguments)]
fn java_debug(job: &crate::process::Job, app: &AppHandle, host: &SshHost, root: &str, path: &str, args: &[String], prefix: &str, setup: serde_json::Value, commands: std::sync::mpsc::Receiver<serde_json::Value>, id: String) -> Result<(i32, Vec<crate::process::Diagnostic>)> {
    let full = remote_path(root, path)?;
    let source = String::from_utf8_lossy(&exec(app, host, &format!("cat -- {}", quote(&full)), None, 30)?).into_owned();
    let uncommented = regex::Regex::new(r"(?s)/\*.*?\*/|//[^\r\n]*").unwrap().replace_all(&source, "").into_owned();
    let package = regex::Regex::new(r"(?m)^\s*package\s+([\w$.]+)\s*;").unwrap().captures(&uncommented).map(|found| found[1].to_owned());
    let stem = path.rsplit('/').next().unwrap_or(path).trim_end_matches(".java").to_owned();
    let class = package.as_ref().map_or(stem.clone(), |package| format!("{package}.{stem}"));
    // The source root: the file's folder, up one level per package part.
    let mut folders: Vec<&str> = path.split('/').collect();
    folders.pop();
    for _ in package.as_deref().into_iter().flat_map(|name| name.split('.')) { folders.pop(); }
    let source_root = if folders.is_empty() { ".".to_owned() } else { folders.join("/") };
    let source_path = format!("{source_root}:src:src/main/java:.");
    job.emit("command", format!("$ ssh {} javac -g -d bin {path}\n", host.name));
    let script = format!(
        "cd -- {root} && {prefix}mkdir -p bin && javac -J-Duser.language=en -encoding UTF-8 -g -d bin -classpath bin -sourcepath {sp} {file} 2>&1; echo \"STILL-EXIT $?\"",
        root = quote(root), sp = quote(&source_path), file = quote(path),
    );
    let output = String::from_utf8_lossy(&exec(app, host, &script, None, 300)?).into_owned();
    let (text, code) = match output.trim_end().rsplit_once("STILL-EXIT ") {
        Some((text, code)) => (text.to_owned(), code.trim().parse().unwrap_or(1)),
        None => (output.clone(), 1),
    };
    if !text.trim().is_empty() { job.emit("stderr", text.clone()); }
    let diagnostics = crate::process::java_diagnostics(&text, std::path::Path::new(root), path);
    if code != 0 {
        if text.contains("javac: command not found") || text.contains("javac: not found") { job.emit("stderr", "javac was not found on the server. Install a JDK there (for example openjdk-17-jdk).\n".to_owned()); }
        let _ = app.emit("debug-event", serde_json::json!({ "id": id, "event": "ended" }));
        return Ok((code, diagnostics));
    }
    // The project's Java files, for turning classes back into files.
    let listing = exec(app, host, &format!("cd -- {} && find . -name '*.java' -not -path '*/.*' -not -path './bin/*' -not -path './target/*' -not -path './build/*' -not -path '*/node_modules/*' 2>/dev/null | head -n 20000", quote(root)), None, 60)?;
    let sources = String::from_utf8_lossy(&listing).lines().map(|line| line.trim().trim_start_matches("./").to_owned()).filter(|line| !line.is_empty()).collect();
    let cache = std::sync::Mutex::new(std::collections::HashMap::<String, String>::new());
    let (read_app, read_host, read_root) = (app.clone(), host.clone(), root.to_owned());
    let read = move |file: &str| -> String {
        if let Some(text) = cache.lock().ok().and_then(|map| map.get(file).cloned()) { return text }
        let text = remote_path(&read_root, file).ok().and_then(|full| exec(&read_app, &read_host, &format!("cat -- {}", quote(&full)), None, 30).ok()).map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default();
        if let Ok(mut map) = cache.lock() { map.insert(file.to_owned(), text.clone()); }
        text
    };
    let quoted_args: String = args.iter().map(|arg| format!(" {}", quote(arg))).collect();
    job.emit("command", format!("$ ssh {} jdb {class}{quoted_args}\n", host.name));
    let mut ssh_args = base_args(app, host, true)?;
    ssh_args.push("--".into());
    ssh_args.push(destination(host));
    ssh_args.push(format!(
        "cd -- {root} && {prefix}command -v jdb >/dev/null 2>&1 || {{ echo 'jdb was not found on the server. It comes with the JDK.' >&2; exit 127; }}; exec jdb -J-Dfile.encoding=UTF-8 -J-Duser.language=en -classpath bin -sourcepath {sp} {class}{quoted_args}",
        root = quote(root), sp = quote(&source_path), class = quote(&class),
    ));
    let mut cmd = command(program(), &std::env::temp_dir());
    cmd.args(&ssh_args);
    use_prompts(app, &mut cmd, host);
    let child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(err)?;
    crate::jdebug::follow(job, app.clone(), id, crate::jdebug::Launch { child, class, sources, read: Box::new(read), diagnostics }, setup, commands)
}

/// A binary file on the server (a PDF or an image), as base64.
#[tauri::command]
pub async fn ssh_read_binary(app: AppHandle, store: State<'_, Store>, id: String, root: String, path: String) -> Result<String> {
    let host = find_host(&store, &id)?;
    blocking(move || {
        let full = remote_path(&root, &path)?;
        let script = format!("f={}; s=$(wc -c < \"$f\") || exit 1; if [ \"$s\" -gt 67108864 ]; then echo 'Still shows files up to 64 MB.' >&2; exit 3; fi; base64 < \"$f\" | tr -d '\\n\\r'", quote(&full));
        let out = exec(&app, &host, &script, None, 120)?;
        Ok(String::from_utf8_lossy(&out).trim().to_owned())
    })
    .await
}

// ---- Port forwarding: a port on the server, reachable on this computer ----

struct Forward {
    child: std::process::Child,
    host_id: String,
    host_name: String,
    remote_port: u16,
    local_port: u16,
}

#[derive(Default)]
pub struct Forwards(std::sync::Mutex<HashMap<String, Forward>>);

impl Forwards {
    pub fn stop_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            for (_, mut forward) in map.drain() { let _ = forward.child.kill(); let _ = forward.child.wait(); }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    id: String,
    host_id: String,
    host_name: String,
    remote_port: u16,
    local_port: u16,
}

fn forward_info(id: &str, forward: &Forward) -> ForwardInfo {
    ForwardInfo { id: id.to_owned(), host_id: forward.host_id.clone(), host_name: forward.host_name.clone(), remote_port: forward.remote_port, local_port: forward.local_port }
}

/// The wanted local port if it's free, otherwise any free one.
fn free_port(wanted: u16) -> Result<u16> {
    if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", wanted)) { drop(listener); return Ok(wanted) }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(err)?;
    Ok(listener.local_addr().map_err(err)?.port())
}

/// Forwards a port on the server to localhost here (`ssh -L`), on its own connection so it can be
/// stopped on its own. Returns the local port, which is the same number when that one is free.
#[tauri::command]
pub async fn ssh_forward_start(app: AppHandle, store: State<'_, Store>, host_id: String, remote_port: u16, local_port: Option<u16>) -> Result<ForwardInfo> {
    let host = find_host(&store, &host_id)?;
    blocking(move || {
        let forwards = app.state::<Forwards>();
        {
            let mut map = forwards.0.lock().map_err(err)?;
            map.retain(|_, forward| matches!(forward.child.try_wait(), Ok(None)));
            if let Some((id, forward)) = map.iter().find(|(_, forward)| forward.host_id == host_id && forward.remote_port == remote_port) {
                return Ok(forward_info(id, forward));
            }
        }
        let local = free_port(local_port.unwrap_or(remote_port))?;
        // A connection of its own: drop the shared-connection options.
        let mut args = Vec::new();
        let mut base = base_args(&app, &host, true)?.into_iter();
        while let Some(arg) = base.next() {
            if arg == "-o" {
                if let Some(value) = base.next() {
                    if !value.starts_with("ControlMaster=") && !value.starts_with("ControlPath=") && !value.starts_with("ControlPersist=") { args.push(arg); args.push(value); }
                }
            } else { args.push(arg) }
        }
        let mut cmd = command(program(), &std::env::temp_dir());
        cmd.args(&args).args(["-N", "-o", "ExitOnForwardFailure=yes", "-L", &format!("127.0.0.1:{local}:127.0.0.1:{remote_port}"), "--"]).arg(destination(&host));
        use_prompts(&app, &mut cmd, &host);
        let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(err)?;
        // Ready once the local end accepts connections (the login may ask for a password first).
        let started = std::time::Instant::now();
        loop {
            if let Ok(Some(_)) = child.try_wait() {
                let mut text = String::new();
                if let Some(mut stderr) = child.stderr.take() { let _ = stderr.read_to_string(&mut text); }
                let reason = text.lines().filter(|line| !line.trim().is_empty()).last().unwrap_or("the connection closed").trim().to_owned();
                return Err(format!("Could not forward port {remote_port}: {reason}"));
            }
            if std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], local)), Duration::from_millis(200)).is_ok() { break }
            if started.elapsed() > Duration::from_secs(90) { let _ = child.kill(); let _ = child.wait(); return Err("The server took too long to answer.".into()) }
            thread::sleep(Duration::from_millis(150));
        }
        let id = format!("{}:{remote_port}", host.id);
        let forward = Forward { child, host_id: host.id.clone(), host_name: host.name.clone(), remote_port, local_port: local };
        let info = forward_info(&id, &forward);
        forwards.0.lock().map_err(err)?.insert(id, forward);
        Ok(info)
    })
    .await
}

#[tauri::command]
pub fn ssh_forward_stop(forwards: State<Forwards>, id: String) -> Result<()> {
    if let Some(mut forward) = forwards.0.lock().map_err(err)?.remove(&id) { let _ = forward.child.kill(); let _ = forward.child.wait(); }
    Ok(())
}

#[tauri::command]
pub fn ssh_forward_list(forwards: State<Forwards>) -> Result<Vec<ForwardInfo>> {
    let mut map = forwards.0.lock().map_err(err)?;
    map.retain(|_, forward| matches!(forward.child.try_wait(), Ok(None)));
    let mut list: Vec<ForwardInfo> = map.iter().map(|(id, forward)| forward_info(id, forward)).collect();
    list.sort_by_key(|item| item.remote_port);
    Ok(list)
}

#[derive(Serialize)]
pub struct ListeningPort {
    port: u16,
    process: String,
}

/// TCP ports something listens on, on the server (to offer forwarding a dev server's port).
#[tauri::command]
pub async fn ssh_listening_ports(app: AppHandle, store: State<'_, Store>, id: String) -> Result<Vec<ListeningPort>> {
    let host = find_host(&store, &id)?;
    blocking(move || {
        // ss on most Linux servers, netstat on older ones, lsof on macOS; /proc/net/tcp when none is installed.
        let out = exec(&app, &host, "(ss -ltnpH 2>/dev/null || netstat -ltnp 2>/dev/null || lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null) | head -n 300; echo STILL-PROC; cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | head -n 2000; exit 0", None, 20)?;
        let all = String::from_utf8_lossy(&out).into_owned();
        let (text, proc_net) = all.split_once("STILL-PROC").unwrap_or((all.as_str(), ""));
        let port = regex::Regex::new(r"(?:\d+\.\d+\.\d+\.\d+|\*|\[[^\]]*\]|::|0\.0\.0\.0|127\.0\.0\.1|localhost):(\d+)\s").unwrap();
        let name = regex::Regex::new(r#"\(\("([^"]+)"|\d+/([\w.\-]+)"#).unwrap();
        let mut found: Vec<ListeningPort> = Vec::new();
        for line in text.lines() {
            let Some(number) = port.captures(line).and_then(|found| found[1].parse::<u16>().ok()) else { continue };
            // SSH itself, and system ports, are not what people forward.
            if number == 22 || number < 1024 && number != 80 { continue }
            if found.iter().any(|item| item.port == number) { continue }
            let process = name.captures(line).and_then(|found| found.get(1).or(found.get(2))).map(|found| found.as_str().to_owned())
                .or_else(|| line.contains("(LISTEN)").then(|| line.split_whitespace().next().unwrap_or("").to_owned()))
                .unwrap_or_default();
            found.push(ListeningPort { port: number, process });
        }
        // /proc/net/tcp: "sl local_address rem_address st …", state 0A is LISTEN, the port is hex.
        for line in proc_net.lines() {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 4 || fields[3] != "0A" { continue }
            let Some(number) = fields[1].rsplit(':').next().and_then(|hex| u16::from_str_radix(hex, 16).ok()) else { continue };
            if number == 22 || number < 1024 && number != 80 || found.iter().any(|item| item.port == number) { continue }
            found.push(ListeningPort { port: number, process: String::new() });
        }
        found.sort_by_key(|item| item.port);
        Ok(found)
    })
    .await
}

// ---- Language servers and tests for projects on a server ----

/// Starts the language server for a language on the server, over SSH; it reads and writes LSP
/// on stdin/stdout like a local one. If none is installed there, it exits at once with NOSERVER.
#[tauri::command]
pub fn ssh_lsp_start(app: AppHandle, store: State<Store>, servers: State<crate::lsp::Servers>, id: String, root: String, language: String) -> Result<crate::lsp::Started> {
    let host = find_host(&store, &id)?;
    let key = format!("{language}:{}:{root}", host.id);
    if let Some(started) = crate::lsp::running(&servers, &key) { return Ok(started) }
    let choices = match language.as_str() {
        "python" => "basedpyright-langserver:--stdio pyright-langserver:--stdio pylsp: jedi-language-server:",
        "java" => "jdtls:",
        "typescript" => "typescript-language-server:--stdio",
        "rust" => "rust-analyzer:",
        "go" => "gopls:",
        "cpp" => "clangd:",
        _ => return Err("No language server for that language.".into()),
    };
    let script = format!(
        "cd -- {root} && PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/go/bin:$HOME/.cargo/bin:$PATH\"; for choice in {choices}; do program=${{choice%%:*}}; option=${{choice#*:}}; if command -v \"$program\" >/dev/null 2>&1; then exec \"$program\" $option; fi; done; echo NOSERVER >&2; exit 3",
        root = quote(&root), choices = choices,
    );
    let mut ssh_args = base_args(&app, &host, true)?;
    ssh_args.push("--".into());
    ssh_args.push(destination(&host));
    ssh_args.push(script);
    let mut cmd = command(program(), &std::env::temp_dir());
    cmd.args(&ssh_args);
    use_prompts(&app, &mut cmd, &host);
    crate::lsp::spawn(&app, &servers, key, &format!("{language} server on {}", host.name), cmd)
}

/// Runs pytest on the server; its output streams to the Output pane and the JUnit report comes
/// back after a marker line, to fill the Tests panel.
#[tauri::command]
pub fn ssh_tests_run(app: AppHandle, store: State<Store>, jobs: State<Jobs>, id: String, host_id: String, root: String, target: Option<String>) -> Result<()> {
    let host = find_host(&store, &host_id)?;
    let target = target.filter(|value| !value.trim().is_empty());
    if target.as_deref().is_some_and(|value| value.starts_with('-')) { return Err("Unknown test.".into()) }
    let report = format!("/tmp/still-junit-{}.xml", std::process::id());
    let script = format!(
        "cd -- {root} && python3 -m pytest -q --tb=short -o junit_family=xunit1 -p no:cacheprovider --junitxml={report}{target}; code=$?; printf '\\036STILL-JUNIT\\n'; cat {report} 2>/dev/null; rm -f {report}; exit $code",
        root = quote(&root), report = quote(&report),
        target = target.as_deref().map(|value| value.split_whitespace().map(|part| format!(" {}", quote(part))).collect::<String>()).unwrap_or_default(),
    );
    let mut ssh_args = base_args(&app, &host, true)?;
    ssh_args.push("--".into());
    ssh_args.push(destination(&host));
    ssh_args.push(script);
    let events = app.clone();
    let prompts_app = app.clone();
    let label = format!("$ ssh {} python3 -m pytest{}\n", host.name, target.as_deref().map(|value| format!(" {value}")).unwrap_or_default());
    let report_id = id.clone();
    jobs.start(app, id, true, move |job| {
        job.emit("command", label);
        let mut cmd = command(program(), &std::env::temp_dir());
        cmd.args(&ssh_args);
        use_prompts(&prompts_app, &mut cmd, &host);
        let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(err)?;
        let mut stdout = child.stdout.take().ok_or("no output")?;
        let stderr = child.stderr.take().ok_or("no output")?;
        let marker = "\u{1e}STILL-JUNIT\n";
        let (code, xml) = thread::scope(|scope| {
            scope.spawn(|| crate::process::stream(stderr, job, "stderr", false));
            let reader = scope.spawn(|| {
                let mut buffer = [0u8; 8192];
                let mut seen = String::new();
                let mut xml = String::new();
                let mut after = false;
                loop {
                    let size = match stdout.read(&mut buffer) { Ok(0) | Err(_) => break, Ok(size) => size };
                    let chunk = String::from_utf8_lossy(&buffer[..size]).into_owned();
                    if after { xml.push_str(&chunk); continue }
                    seen.push_str(&chunk);
                    if let Some(at) = seen.find(marker) {
                        if at > 0 { job.emit("stdout", seen[..at].to_owned()); }
                        xml.push_str(&seen[at + marker.len()..]);
                        after = true;
                    } else if !seen.contains('\u{1e}') || seen.len() > 64 * 1024 {
                        job.emit("stdout", std::mem::take(&mut seen));
                    }
                }
                if !after && !seen.is_empty() { job.emit("stdout", seen); }
                xml
            });
            let code = loop {
                if job.is_cancelled() { let _ = child.kill(); let _ = child.wait(); break 130 }
                if let Ok(Some(status)) = child.try_wait() { break status.code().unwrap_or(1) }
                thread::sleep(Duration::from_millis(25));
            };
            (code, reader.join().unwrap_or_default())
        });
        let mut results = Vec::new();
        crate::tests::parse_junit(&xml, &mut results);
        crate::tests::emit_report(&events, report_id, "pytest".into(), results);
        Ok((code, Vec::new()))
    })
}
