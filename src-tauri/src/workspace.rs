use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use regex::RegexBuilder;

pub type Result<T> = std::result::Result<T, String>;

const SKIP: &[&str] = &[
    ".git",
    ".venv",
    "node_modules",
    "target",
    "__pycache__",
    "bin",
    ".gradle",
];
const FILE_LIMIT: u64 = 4 * 1024 * 1024;
static SAVE_ID: AtomicU64 = AtomicU64::new(0);

pub fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub fn root(path: &str) -> Result<PathBuf> {
    let path = Path::new(path).canonicalize().map_err(err)?;
    if path.is_dir() {
        Ok(path)
    } else {
        Err("Select a workspace folder.".into())
    }
}

pub fn relative(path: &str) -> Result<&Path> {
    let path = Path::new(path);
    if !path.as_os_str().is_empty()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        Ok(path)
    } else {
        Err("Expected a path inside the workspace.".into())
    }
}

pub fn resolve(root: &Path, path: &str) -> Result<PathBuf> {
    let full = root.join(relative(path)?).canonicalize().map_err(err)?;
    if full.starts_with(root) {
        Ok(full)
    } else {
        Err("The path points outside the workspace.".into())
    }
}

#[derive(Serialize)]
pub struct WorkspaceInfo {
    pub root: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    directory: bool,
}

fn list(base: &Path, folder: &Path) -> Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for item in fs::read_dir(folder).map_err(err)? {
        let Ok(item) = item else { continue };
        let Ok(kind) = item.file_type() else { continue };
        let name = item.file_name().to_string_lossy().into_owned();
        if name == ".still-initialized"
            || (!kind.is_file() && !kind.is_dir())
            || (kind.is_dir() && SKIP.contains(&name.as_str()))
        {
            continue;
        }
        let path = item.path();
        let path = path
            .strip_prefix(base)
            .map_err(err)?
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        entries.push(Entry {
            name,
            path,
            directory: kind.is_dir(),
        });
    }
    entries.sort_by_cached_key(|entry| (!entry.directory, entry.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
pub fn workspace_info(path: String) -> Result<WorkspaceInfo> {
    let path = root(&path)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    Ok(WorkspaceInfo {
        name: name.unwrap_or_else(|| path.display().to_string()),
        root: crate::projects::canonical(&path),
    })
}

#[tauri::command]
pub fn list_directory(root_path: String, path: String) -> Result<Vec<Entry>> {
    let base = root(&root_path)?;
    let folder = if path.is_empty() {
        base.clone()
    } else {
        resolve(&base, &path)?
    };
    list(&base, &folder)
}

#[tauri::command]
pub async fn list_files(root_path: String) -> Result<Vec<Entry>> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = root(&root_path)?;
        let mut pending = vec![base.clone()];
        let mut files = Vec::new();
        let mut visited = 0;
        while let Some(folder) = pending.pop() {
            let Ok(entries) = list(&base, &folder) else {
                continue;
            };
            for entry in entries {
                if entry.directory {
                    pending.push(base.join(&entry.path));
                } else {
                    files.push(entry);
                }
                visited += 1;
                if visited >= 4000 {
                    return Ok(files);
                }
            }
        }
        Ok(files)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn read_file(root_path: String, path: String) -> Result<String> {
    let path = resolve(&root(&root_path)?, &path)?;
    let metadata = path.metadata().map_err(err)?;
    if !metadata.is_file() || metadata.len() > FILE_LIMIT {
        return Err("The editor opens text files up to 4 MB.".into());
    }
    let contents = fs::read_to_string(path).map_err(err)?;
    if contents.contains('\0') {
        return Err("This file contains binary data.".into());
    }
    Ok(contents)
}

#[tauri::command]
pub fn save_file(
    root_path: String,
    path: String,
    contents: String,
    previous: String,
) -> Result<()> {
    let full = resolve(&root(&root_path)?, &path)?;
    let on_disk = fs::read_to_string(&full).map_err(err)?;
    if on_disk.replace("\r\n", "\n").replace('\r', "\n") != previous {
        return Err("The file changed on disk. Reopen it before saving.".into());
    }
    let metadata = full.metadata().map_err(err)?;
    let contents = if on_disk.contains("\r\n") {
        contents.replace('\n', "\r\n")
    } else {
        contents
    };
    let mut temporary = full.clone();
    temporary.set_file_name(format!(
        ".still-save-{}-{}",
        std::process::id(),
        SAVE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(err)?;
    let written = file
        .write_all(contents.as_bytes())
        .and_then(|_| file.sync_all());
    drop(file);
    let saved = written
        .and_then(|_| fs::set_permissions(&temporary, metadata.permissions()))
        .and_then(|_| fs::rename(&temporary, full));
    if saved.is_err() {
        let _ = fs::remove_file(temporary);
    }
    saved.map_err(err)
}

#[tauri::command]
pub fn create_file(root_path: String, path: String) -> Result<()> {
    let base = root(&root_path)?;
    let path = relative(&path)?;
    let parent = path.parent().ok_or("Enter a file name.")?;
    let parent = base.join(parent).canonicalize().map_err(err)?;
    if !parent.starts_with(&base) {
        return Err("The folder points outside the workspace.".into());
    }
    let name = path.file_name().ok_or("Enter a file name.")?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(parent.join(name))
        .map_err(err)?;
    Ok(())
}

fn inside(base: &Path, path: &str) -> Result<PathBuf> {
    let path = relative(path)?;
    let parent = path.parent().unwrap_or(Path::new(""));
    let parent = base.join(parent).canonicalize().map_err(err)?;
    if !parent.starts_with(base) {
        return Err("The folder points outside the workspace.".into());
    }
    Ok(parent.join(path.file_name().ok_or("Enter a name.")?))
}

#[tauri::command]
pub fn create_folder(root_path: String, path: String) -> Result<()> {
    let base = root(&root_path)?;
    let target = inside(&base, &path)?;
    if target.exists() {
        return Err("Something with this name already exists.".into());
    }
    fs::create_dir_all(target).map_err(err)
}

#[tauri::command]
pub fn rename_path(root_path: String, from: String, to: String) -> Result<()> {
    let base = root(&root_path)?;
    let source = resolve(&base, &from)?;
    if source == base {
        return Err("The workspace folder itself cannot be renamed here.".into());
    }
    let target = inside(&base, &to)?;
    if target.exists() {
        return Err("Something with this name already exists.".into());
    }
    fs::rename(source, target).map_err(err)
}

/// Deleting moves the item to the system trash, so it can be restored.
#[tauri::command]
pub async fn delete_path(root_path: String, path: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = root(&root_path)?;
        let target = resolve(&base, &path)?;
        if target == base {
            return Err("The workspace folder itself cannot be deleted here.".into());
        }
        trash::delete(target).map_err(err)
    })
    .await
    .map_err(err)?
}

#[derive(Serialize)]
pub struct Match {
    path: String,
    line: usize,
    column: usize,
    preview: String,
}

#[derive(Serialize)]
pub struct SearchResult {
    matches: Vec<Match>,
    files: usize,
    truncated: bool,
}

#[tauri::command]
pub async fn search_workspace(
    root_path: String,
    query: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<SearchResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = root(&root_path)?;
        if query.is_empty() {
            return Ok(SearchResult { matches: Vec::new(), files: 0, truncated: false });
        }
        let mut pattern = if regex { query.clone() } else { regex::escape(&query) };
        if whole_word {
            pattern = format!(r"\b(?:{pattern})\b");
        }
        let matcher = RegexBuilder::new(&pattern)
            .case_insensitive(!case_sensitive)
            .size_limit(1 << 20)
            .build()
            .map_err(|_| "This regular expression is not valid.".to_string())?;
        let mut pending = vec![base.clone()];
        let mut matches = Vec::new();
        let mut files = 0;
        let mut scanned = 0;
        while let Some(folder) = pending.pop() {
            let Ok(entries) = list(&base, &folder) else { continue };
            for entry in entries {
                if entry.directory {
                    pending.push(base.join(&entry.path));
                    continue;
                }
                scanned += 1;
                if scanned > 20000 {
                    return Ok(SearchResult { matches, files, truncated: true });
                }
                let full = base.join(&entry.path);
                if full.metadata().map(|meta| meta.len() > 1024 * 1024).unwrap_or(true) {
                    continue;
                }
                let Ok(text) = fs::read_to_string(&full) else { continue };
                if text.contains('\0') {
                    continue;
                }
                let mut found = false;
                for (index, line) in text.lines().enumerate() {
                    if let Some(hit) = matcher.find(line) {
                        found = true;
                        let start = line[..hit.start()].chars().count();
                        let preview: String = line.trim_end().chars().take(240).collect();
                        matches.push(Match { path: entry.path.clone(), line: index + 1, column: start + 1, preview });
                        if matches.len() >= 2000 {
                            return Ok(SearchResult { matches, files: files + 1, truncated: true });
                        }
                    }
                }
                if found {
                    files += 1;
                }
            }
        }
        Ok(SearchResult { matches, files, truncated: false })
    })
    .await
    .map_err(err)?
}
