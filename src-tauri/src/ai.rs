//! Support for the AI chat: the API key lives in the operating system's keychain
//! (Windows Credential Manager, macOS Keychain, Linux kernel keyring), and agent
//! commands run in the project folder with a time limit and captured output.

use crate::{
    process::command,
    workspace::{err, Result},
};
use serde::Serialize;
use std::{
    io::Read,
    path::Path,
    process::Stdio,
    thread,
    time::{Duration, Instant},
};

const SERVICE: &str = "dev.still.editor";

fn entry(provider: &str) -> Result<keyring::Entry> {
    if !matches!(provider, "anthropic") {
        return Err("Unknown AI provider.".into());
    }
    keyring::Entry::new(SERVICE, &format!("{provider}-api-key")).map_err(err)
}

/// Whether a key is saved, without returning it.
#[tauri::command]
pub fn ai_key_status(provider: String) -> Result<bool> {
    match entry(&provider)?.get_password() {
        Ok(value) => Ok(!value.is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(err(error)),
    }
}

/// The saved key, for the chat to send with its requests.
#[tauri::command]
pub fn ai_key_get(provider: String) -> Result<Option<String>> {
    match entry(&provider)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(err(error)),
    }
}

#[tauri::command]
pub fn ai_key_set(provider: String, key: Option<String>) -> Result<()> {
    let entry = entry(&provider)?;
    match key.map(|value| value.trim().to_owned()).filter(|value| !value.is_empty()) {
        Some(value) => entry.set_password(&value).map_err(err),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(err(error)),
        },
    }
}

#[derive(Serialize)]
pub struct CommandResult {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

fn tail(text: String, limit: usize) -> String {
    if text.len() <= limit {
        return text;
    }
    let mut start = text.len() - limit;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…(earlier output cut)…\n{}", &text[start..])
}

/// Runs a shell command in the project folder (only after the person approved it in the chat).
#[tauri::command]
pub async fn ai_run_command(root_path: String, command_line: String, timeout_secs: Option<u64>) -> Result<CommandResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&root_path);
        if !root.is_dir() {
            return Err("The project folder is missing.".to_string());
        }
        let mut cmd = if cfg!(windows) {
            let mut cmd = command("powershell", root);
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", &command_line]);
            cmd
        } else {
            let mut cmd = command("sh", root);
            cmd.args(["-c", &command_line]);
            cmd
        };
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(err)?;
        let mut out = child.stdout.take().unwrap();
        let mut errs = child.stderr.take().unwrap();
        let reader = thread::spawn(move || { let mut bytes = Vec::new(); let _ = out.read_to_end(&mut bytes); bytes });
        let error_reader = thread::spawn(move || { let mut bytes = Vec::new(); let _ = errs.read_to_end(&mut bytes); bytes });
        let deadline = Instant::now() + Duration::from_secs(timeout_secs.unwrap_or(120).clamp(5, 900));
        let mut timed_out = false;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(err)? {
                break Some(status);
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                break None;
            }
            thread::sleep(Duration::from_millis(20));
        };
        Ok(CommandResult {
            code: status.and_then(|status| status.code()),
            stdout: tail(String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned(), 30000),
            stderr: tail(String::from_utf8_lossy(&error_reader.join().unwrap_or_default()).into_owned(), 12000),
            timed_out,
        })
    })
    .await
    .map_err(err)?
}
