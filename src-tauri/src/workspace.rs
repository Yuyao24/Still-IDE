use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Manager};

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
    root: String,
    name: String,
    sample: bool,
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
        root: path.to_string_lossy().into_owned(),
        sample: false,
    })
}

#[tauri::command]
pub fn sample_workspace(app: AppHandle) -> Result<WorkspaceInfo> {
    let folder = app
        .path()
        .app_local_data_dir()
        .map_err(err)?
        .join("orbit-lab");
    fs::create_dir_all(&folder).map_err(err)?;
    let marker = folder.join(".still-initialized");
    if !marker.exists() {
        let samples = [
            ("src/app.py", include_str!("../sample/app.py")),
            ("src/Main.java", include_str!("../sample/Main.java")),
            (
                "tests/test_orbit.py",
                include_str!("../sample/test_orbit.py"),
            ),
            ("README.md", include_str!("../sample/README.md")),
            (
                "requirements.txt",
                include_str!("../sample/requirements.txt"),
            ),
            (".gitignore", include_str!("../sample/gitignore.txt")),
        ];
        for (path, value) in samples {
            let path = folder.join(path);
            fs::create_dir_all(path.parent().unwrap()).map_err(err)?;
            if !path.exists() {
                fs::write(path, value).map_err(err)?;
            }
        }
        fs::write(marker, "").map_err(err)?;
        crate::git::initialize_sample(&folder);
    }
    let mut info = workspace_info(folder.to_string_lossy().into_owned())?;
    info.sample = true;
    Ok(info)
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
