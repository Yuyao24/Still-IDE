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
        Some(crate::projects::plain(&text))
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
        let _ = &exe;
        let file = windows_command(true)?;
        Ok(format!("Added the still command ({}). Type still . in a terminal to open the folder you're in.", file.to_string_lossy()))
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

/// Adds (or removes) "Open with Still" on folders, and Still in "Open with" for code and text files,
/// in File Explorer (Windows).
#[tauri::command]
pub fn explorer_menu(enable: bool) -> Result<String> {
    #[cfg(windows)]
    {
        windows_registry(enable)?;
        Ok(if enable {
            "Open with Still is in the Explorer menu for folders (on Windows 11, under Show more options), and Still is in Open with for code and text files.".into()
        } else {
            "Removed Still from the Explorer menu and Open with.".into()
        })
    }
    #[cfg(not(windows))]
    {
        let _ = enable;
        Err("This is for File Explorer on Windows.".into())
    }
}

/// File types Still offers itself for in Explorer's Open with.
#[cfg(windows)]
const OPEN_WITH: &[&str] = &[
    "py", "pyi", "pyw", "ipynb", "java", "kt", "kts", "gradle", "js", "mjs", "cjs", "jsx", "ts", "tsx", "json", "jsonc", "md", "markdown", "txt", "log", "csv",
    "html", "htm", "css", "scss", "less", "xml", "svg", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "sql", "c", "h", "cpp", "hpp", "cc", "cs", "rs", "go",
    "rb", "sh", "bash", "ps1", "tex", "bib", "lua", "php", "swift", "dart", "r",
];

/// Writes (or removes) Still's Explorer entries in one go: a .reg file imported by reg.exe.
#[cfg(windows)]
fn windows_registry(enable: bool) -> Result<()> {
    let exe = std::env::current_exe().map_err(err)?.to_string_lossy().into_owned();
    let exe_name = Path::new(&exe).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "still-ide.exe".into());
    let quoted = |text: &str| text.replace('\\', "\\\\").replace('"', "\\\"");
    let classes = r"HKEY_CURRENT_USER\Software\Classes";
    let mut reg = String::from("Windows Registry Editor Version 5.00\r\n\r\n");
    let mut key = |name: &str, values: &[(&str, String)]| {
        if enable {
            reg.push_str(&format!("[{classes}\\{name}]\r\n"));
            for (value, data) in values { reg.push_str(&format!("{}={}\r\n", if value.is_empty() { "@".to_owned() } else { format!("\"{value}\"") }, data)); }
        } else {
            reg.push_str(&format!("[-{classes}\\{name}]\r\n"));
        }
        reg.push_str("\r\n");
    };
    let text = |value: &str| format!("\"{}\"", quoted(value));
    let open = |argument: &str| text(&format!("\"{exe}\" \"{argument}\""));
    for (name, argument) in [(r"Directory\shell\Still", "%V"), (r"Directory\Background\shell\Still", "%V")] {
        key(name, &[("", text("Open with Still")), ("Icon", text(&exe))]);
        if enable { key(&format!(r"{name}\command"), &[("", open(argument))]); }
    }
    // A file type entry for Open with, and Still listed under each code and text extension.
    key("Still.Source", &[("", text("Source file"))]);
    if enable {
        key(r"Still.Source\DefaultIcon", &[("", text(&format!("{exe},0")))]);
        key(r"Still.Source\shell\open\command", &[("", open("%1"))]);
    }
    key(&format!(r"Applications\{exe_name}"), &[("FriendlyAppName", text("Still"))]);
    if enable { key(&format!(r"Applications\{exe_name}\shell\open\command"), &[("", open("%1"))]); }
    for extension in OPEN_WITH {
        reg.push_str(&format!("[{classes}\\.{extension}\\OpenWithProgids]\r\n\"Still.Source\"={}\r\n\r\n", if enable { "hex(0):" } else { "-" }));
    }
    // Older versions added "Open with Still" to every file; Open with replaces that.
    reg.push_str(&format!("[-{classes}\\*\\shell\\Still]\r\n\r\n"));
    // reg.exe reads UTF-16 with a byte order mark (so any user name works).
    let mut bytes = vec![0xFF, 0xFE];
    for unit in reg.encode_utf16() { bytes.extend_from_slice(&unit.to_le_bytes()); }
    let file = std::env::temp_dir().join(format!("still-explorer-{}.reg", std::process::id()));
    std::fs::write(&file, bytes).map_err(err)?;
    let status = crate::process::command("reg", Path::new(".")).arg("import").arg(&file).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().map_err(err);
    let _ = std::fs::remove_file(&file);
    if status?.success() { Ok(()) } else { Err("Windows did not accept the change to the Explorer menu.".into()) }
}

/// The `still` command for Windows terminals: a small script in a folder that's always on PATH.
#[cfg(windows)]
fn windows_command(enable: bool) -> Result<PathBuf> {
    let exe = std::env::current_exe().map_err(err)?.to_string_lossy().into_owned();
    let dir = PathBuf::from(std::env::var("LOCALAPPDATA").map_err(err)?).join("Microsoft").join("WindowsApps");
    let file = dir.join("still.cmd");
    if !enable { if file.exists() { std::fs::remove_file(&file).map_err(err)?; } return Ok(file) }
    std::fs::create_dir_all(&dir).map_err(err)?;
    let script = format!("@echo off\r\nrem Opens Still with a folder or file: still . opens the folder you're in.\r\nstart \"\" \"{exe}\" %*\r\n");
    if std::fs::read_to_string(&file).ok().as_deref() != Some(script.as_str()) { std::fs::write(&file, script).map_err(err)?; }
    Ok(file)
}

/// On Windows, keeps the still command and the Explorer entries in place and pointing at this copy
/// of Still (after an update or a move), unless turned off in Settings. Release builds only.
pub fn ensure_shell_integration(app: &AppHandle) {
    #[cfg(windows)]
    {
        if cfg!(debug_assertions) { return }
        let enabled = app.try_state::<crate::config::Store>().and_then(|store| store.read(|config| config.settings.get("shellIntegration").and_then(|value| value.as_bool())).ok().flatten()).unwrap_or(true);
        if !enabled { return }
        std::thread::spawn(|| {
            let _ = windows_command(true);
            // Rewrite the Explorer entries only when they're missing or name another copy of Still.
            let exe = std::env::current_exe().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default();
            let current = crate::process::command("reg", Path::new(".")).args(["query", r"HKCU\Software\Classes\Directory\shell\Still\command", "/ve"]).output()
                .map(|out| String::from_utf8_lossy(&out.stdout).into_owned()).unwrap_or_default();
            if !current.contains(&exe) || !current.contains("%V") { let _ = windows_registry(true); }
        });
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// Turns the still command and the Explorer entries on or off together (Settings).
#[tauri::command]
pub fn shell_integration(enable: bool) -> Result<String> {
    #[cfg(windows)]
    {
        windows_command(enable)?;
        windows_registry(enable)?;
        Ok(if enable { "Still is in File Explorer (Open with Still, and Open with for code files) and the still command works in new terminals.".into() } else { "Removed Still from File Explorer and the terminal.".into() })
    }
    #[cfg(not(windows))]
    {
        if enable { install_cli() } else {
            let file = PathBuf::from(std::env::var("HOME").map_err(err)?).join(".local").join("bin").join("still");
            if file.exists() { std::fs::remove_file(&file).map_err(err)?; }
            Ok("Removed the still command.".into())
        }
    }
}
