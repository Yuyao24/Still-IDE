//! Local history: a copy of a file each time it's saved, kept for a week, so an earlier
//! version can be restored even without Git. Stored in Still's own data folder, never in
//! the project. Also the Git history pieces the editor shows: blame and a file's commits.
use crate::{
    process::command,
    workspace::{err, relative, root, Result},
};
use serde::Serialize;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const KEEP_DAYS: u64 = 7;
const KEEP_PER_FILE: usize = 100;

fn folder(app: &AppHandle, root_path: &str, path: &str) -> Result<PathBuf> {
    relative(path)?;
    let mut hasher = DefaultHasher::new();
    root_path.hash(&mut hasher);
    let file: String = path.chars().map(|char| if char.is_ascii_alphanumeric() || char == '.' || char == '-' || char == '_' { char } else { '~' }).collect();
    Ok(app.path().app_data_dir().map_err(err)?.join("history").join(format!("{:016x}", hasher.finish())).join(file))
}

fn now_ms() -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_millis()).unwrap_or_default() }

#[derive(Serialize)]
pub struct Version {
    id: String,
    time: u64,
    size: u64,
}

fn versions(dir: &PathBuf) -> Vec<(u128, PathBuf)> {
    let mut list: Vec<(u128, PathBuf)> = fs::read_dir(dir).into_iter().flatten().flatten()
        .filter_map(|entry| entry.path().file_stem()?.to_str()?.parse::<u128>().ok().map(|stamp| (stamp, entry.path())))
        .collect();
    list.sort_by(|a, b| b.0.cmp(&a.0));
    list
}

/// Keeps a copy of what was just saved (skipped when it equals the newest copy).
#[tauri::command]
pub fn history_save(app: AppHandle, root_path: String, path: String, contents: String) -> Result<()> {
    if contents.len() > 2 * 1024 * 1024 {
        return Ok(());
    }
    let dir = folder(&app, &root_path, &path)?;
    fs::create_dir_all(&dir).map_err(err)?;
    let existing = versions(&dir);
    if let Some((_, newest)) = existing.first() {
        if fs::read_to_string(newest).is_ok_and(|text| text == contents) {
            return Ok(());
        }
    }
    fs::write(dir.join(format!("{}.txt", now_ms())), contents).map_err(err)?;
    let cutoff = now_ms().saturating_sub(Duration::from_secs(KEEP_DAYS * 86_400).as_millis());
    for (index, (stamp, file)) in versions(&dir).into_iter().enumerate() {
        if index >= KEEP_PER_FILE || stamp < cutoff {
            let _ = fs::remove_file(file);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn history_list(app: AppHandle, root_path: String, path: String) -> Result<Vec<Version>> {
    let dir = folder(&app, &root_path, &path)?;
    Ok(versions(&dir).into_iter().map(|(stamp, file)| Version {
        id: stamp.to_string(), time: stamp as u64, size: fs::metadata(&file).map(|meta| meta.len()).unwrap_or(0),
    }).collect())
}

#[tauri::command]
pub fn history_read(app: AppHandle, root_path: String, path: String, id: String) -> Result<String> {
    if !id.chars().all(|char| char.is_ascii_digit()) {
        return Err("Unknown version.".into());
    }
    fs::read_to_string(folder(&app, &root_path, &path)?.join(format!("{id}.txt"))).map_err(err)
}

// ---- Git: blame and a file's commits ----

#[derive(Serialize)]
pub struct BlameLine {
    line: u32,
    hash: String,
    author: String,
    time: u64,
    summary: String,
}

/// Who last changed each line, and when (uncommitted lines have an all-zero hash).
#[tauri::command]
pub async fn git_blame(root_path: String, path: String, contents: Option<String>) -> Result<Vec<BlameLine>> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        relative(&path)?;
        let mut cmd = command("git", &cwd);
        cmd.args(["blame", "--porcelain"]);
        // Blame the text in the editor (unsaved edits show as not committed yet).
        if contents.is_some() { cmd.args(["--contents", "-"]); }
        cmd.args(["--", &path]);
        let output = if let Some(text) = contents {
            use std::io::Write;
            let mut child = cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().map_err(err)?;
            if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(text.as_bytes()); }
            child.wait_with_output().map_err(err)?
        } else {
            cmd.output().map_err(err)?
        };
        if !output.status.success() {
            return Ok(Vec::new());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let mut commits: std::collections::HashMap<String, (String, u64, String)> = Default::default();
        let mut lines = Vec::new();
        let mut current: Option<(String, u32)> = None;
        for line in text.lines() {
            if let Some(code) = line.strip_prefix('\t') {
                let _ = code;
                if let Some((hash, number)) = current.take() {
                    let (author, time, summary) = commits.get(&hash).cloned().unwrap_or_default();
                    lines.push(BlameLine { line: number, hash, author, time, summary });
                }
                continue;
            }
            let mut parts = line.splitn(2, ' ');
            let first = parts.next().unwrap_or("");
            let rest = parts.next().unwrap_or("");
            if first.len() == 40 && first.chars().all(|char| char.is_ascii_hexdigit()) {
                let number = rest.split(' ').nth(1).and_then(|value| value.parse().ok()).unwrap_or(0);
                commits.entry(first.to_owned()).or_default();
                current = Some((first.to_owned(), number));
            } else if let Some((hash, _)) = &current {
                let entry = commits.entry(hash.clone()).or_default();
                match first {
                    "author" => entry.0 = rest.to_owned(),
                    "author-time" => entry.1 = rest.parse().unwrap_or(0),
                    "summary" => entry.2 = rest.to_owned(),
                    _ => {}
                }
            }
        }
        Ok(lines)
    })
    .await
    .map_err(err)?
}

#[derive(Serialize)]
pub struct FileCommit {
    hash: String,
    subject: String,
    author: String,
    time: u64,
    path: String,
}

/// The commits that changed one file, newest first (following renames).
#[tauri::command]
pub async fn git_file_log(root_path: String, path: String) -> Result<Vec<FileCommit>> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        relative(&path)?;
        let output = command("git", &cwd).args(["log", "--follow", "-n", "300", "--name-only", "--format=%x1e%H%x1f%s%x1f%an%x1f%at", "--", &path]).output().map_err(err)?;
        if !output.status.success() {
            return Ok(Vec::new());
        }
        let prefix = command("git", &cwd).args(["rev-parse", "--show-prefix"]).output().ok().map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned()).unwrap_or_default();
        Ok(String::from_utf8_lossy(&output.stdout).split('\u{1e}').filter(|chunk| !chunk.trim().is_empty()).filter_map(|chunk| {
            let mut lines = chunk.trim().lines();
            let mut fields = lines.next()?.split('\u{1f}');
            let (hash, subject, author, time) = (fields.next()?.to_owned(), fields.next()?.to_owned(), fields.next()?.to_owned(), fields.next()?.parse().unwrap_or(0));
            // The file's name in that commit (it may have been renamed since).
            let named = lines.find(|line| !line.trim().is_empty()).map(|line| line.trim().strip_prefix(&prefix).unwrap_or(line.trim()).to_owned()).unwrap_or_else(|| path.clone());
            Some(FileCommit { hash, subject, author, time, path: named })
        }).collect())
    })
    .await
    .map_err(err)?
}

/// The file as it was at a commit (empty when it didn't exist there).
#[tauri::command]
pub async fn git_show_at(root_path: String, rev: String, path: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        relative(&path)?;
        if rev.starts_with('-') || rev.chars().any(char::is_whitespace) {
            return Err("Unknown commit.".into());
        }
        let prefix = command("git", &cwd).args(["rev-parse", "--show-prefix"]).output().ok().map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned()).unwrap_or_default();
        let output = command("git", &cwd).args(["show", &format!("{rev}:{prefix}{path}")]).output().map_err(err)?;
        Ok(if output.status.success() { String::from_utf8_lossy(&output.stdout).replace("\r\n", "\n") } else { String::new() })
    })
    .await
    .map_err(err)?
}
