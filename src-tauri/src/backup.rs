//! Things kept outside projects: unsaved edits (so closing Still, or a crash, loses nothing), the
//! folder or file Still was started with (`still .`), settings files, and the `still` command.
use crate::workspace::{err, Result};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State};

fn backup_file(app: &AppHandle, key: &str) -> Result<PathBuf> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut hasher);
    let dir = app.path().app_data_dir().map_err(err)?.join("backups");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join(format!("{:016x}.json", hasher.finish())))
}

/// Replaces the unsaved edits kept for a project (a JSON list); an empty list removes them.
#[tauri::command]
pub fn backup_write(app: AppHandle, key: String, entries: String) -> Result<()> {
    let file = backup_file(&app, &key)?;
    if entries.trim().is_empty() || entries.trim() == "[]" {
        if file.exists() { std::fs::remove_file(&file).map_err(err)?; }
        return Ok(());
    }
    // Write beside it, then move into place, so a crash mid-write never leaves half a file.
    let partial = file.with_extension("json.partial");
    std::fs::write(&partial, entries).map_err(err)?;
    std::fs::rename(&partial, &file).map_err(err)
}

/// The unsaved edits kept for a project, as the JSON list written above ("[]" when none).
#[tauri::command]
pub fn backup_read(app: AppHandle, key: String) -> Result<String> {
    let file = backup_file(&app, &key)?;
    Ok(std::fs::read_to_string(file).unwrap_or_else(|_| "[]".into()))
}

/// The folder or file Still was started with (`still .`, `still notes.md`, Open with Still).
#[derive(Default)]
pub struct LaunchTarget(pub Mutex<Option<String>>);

/// Reads the first argument that names an existing folder or file, relative to where Still started.
pub fn target_from_args() -> Option<String> {
    let cwd = std::env::current_dir().ok()?;
    std::env::args_os().skip(1).map(PathBuf::from).filter(|path| !path.to_string_lossy().starts_with('-')).find_map(|path| {
        let full = if path.is_absolute() { path } else { cwd.join(path) };
        let full = full.canonicalize().ok()?;
        let text = full.to_string_lossy().into_owned();
        // Windows canonical paths start with \\?\; the rest of Still uses plain ones.
        Some(text.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(text).replace('\\', "/"))
    })
}

/// Hands the launch target to the page once: `{ path, directory }`, or null.
#[tauri::command]
pub fn launch_target(target: State<LaunchTarget>) -> Result<Option<serde_json::Value>> {
    let Some(path) = target.0.lock().map_err(err)?.take() else { return Ok(None) };
    let directory = Path::new(&path).is_dir();
    Ok(Some(serde_json::json!({ "path": path, "directory": directory })))
}

/// Writes a settings export where the person chose to save it.
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<()> {
    std::fs::write(path, contents).map_err(err)
}

/// Reads a settings file the person picked.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String> {
    let size = std::fs::metadata(&path).map_err(err)?.len();
    if size > 8 * 1024 * 1024 { return Err("That file is too large to be a settings file.".into()) }
    std::fs::read_to_string(path).map_err(err)
}

/// Adds a `still` command to the terminal: `still .` opens the current folder.
#[tauri::command]
pub fn install_cli() -> Result<String> {
    let exe = std::env::current_exe().map_err(err)?;
    let exe = exe.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        // This folder is on every user's PATH (it holds app execution aliases), so nothing else changes.
        let dir = PathBuf::from(std::env::var("LOCALAPPDATA").map_err(err)?).join("Microsoft").join("WindowsApps");
        std::fs::create_dir_all(&dir).map_err(err)?;
        let file = dir.join("still.cmd");
        std::fs::write(&file, format!("@echo off\r\nstart \"\" \"{exe}\" %*\r\n")).map_err(err)?;
        Ok(format!("Added the still command ({}). Open a new terminal and type still . to open the folder you're in.", file.to_string_lossy()))
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let home = std::env::var("HOME").map_err(err)?;
        let dir = PathBuf::from(&home).join(".local").join("bin");
        std::fs::create_dir_all(&dir).map_err(err)?;
        let file = dir.join("still");
        std::fs::write(&file, format!("#!/bin/sh\n# Opens Still with the given folder or file (still . opens this folder).\n\"{}\" \"$@\" >/dev/null 2>&1 &\n", exe.replace('"', "\\\""))).map_err(err)?;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).map_err(err)?;
        let on_path = std::env::var("PATH").unwrap_or_default().split(':').any(|part| Path::new(part) == dir);
        Ok(if on_path {
            format!("Added the still command ({}). Type still . in a terminal to open the folder you're in.", file.to_string_lossy())
        } else {
            format!("Added the still command ({}). Add {} to your PATH (for example in ~/.profile), then type still . in a terminal.", file.to_string_lossy(), dir.to_string_lossy())
        })
    }
}

/// Adds (or removes) "Open with Still" on folders and files in File Explorer (Windows).
#[tauri::command]
pub fn explorer_menu(enable: bool) -> Result<String> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(err)?.to_string_lossy().into_owned();
        let keys = [
            (r"HKCU\Software\Classes\Directory\shell\Still", "%V"),
            (r"HKCU\Software\Classes\Directory\Background\shell\Still", "%V"),
            (r"HKCU\Software\Classes\*\shell\Still", "%1"),
        ];
        let reg = |args: &[&str]| -> Result<()> {
            let status = crate::process::command("reg", Path::new(".")).args(args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().map_err(err)?;
            if status.success() { Ok(()) } else { Err("Windows did not accept the change to the Explorer menu.".into()) }
        };
        for (key, argument) in keys {
            if enable {
                reg(&["add", key, "/ve", "/d", "Open with Still", "/f"])?;
                reg(&["add", key, "/v", "Icon", "/d", &exe, "/f"])?;
                reg(&["add", &format!(r"{key}\command"), "/ve", "/d", &format!("\"{exe}\" \"{argument}\""), "/f"])?;
            } else {
                let _ = reg(&["delete", key, "/f"]);
            }
        }
        Ok(if enable { "Open with Still is in the Explorer menu for folders and files.".into() } else { "Removed Open with Still from the Explorer menu.".into() })
    }
    #[cfg(not(windows))]
    {
        let _ = enable;
        Err("This is for File Explorer on Windows.".into())
    }
}
