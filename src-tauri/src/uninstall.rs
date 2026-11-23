//! In-app uninstall. The platform scripts in `uninstall/` are the single
//! source of truth: Still runs them in dry-run mode to show the plan, and for
//! real once the app has quit.

use crate::workspace::{err, Result};
use serde::Serialize;
use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
};
use tauri::{AppHandle, Manager};

const SCRIPT_UNIX: &str = include_str!("../../uninstall/uninstall.sh");
const SCRIPT_WINDOWS: &str = include_str!("../../uninstall/uninstall.ps1");

fn write_script(tag: &str) -> Result<PathBuf> {
    let (name, body) = if cfg!(windows) { ("ps1", SCRIPT_WINDOWS) } else { ("sh", SCRIPT_UNIX) };
    let path = std::env::temp_dir().join(format!("still-uninstall-{}-{tag}.{name}", std::process::id()));
    // PowerShell 5 reads BOM-less scripts as ANSI; the script is ASCII-only.
    fs::write(&path, body).map_err(err)?;
    Ok(path)
}

fn script_command(script: &PathBuf, dry_run: bool) -> Command {
    let exe = std::env::current_exe().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default();
    let mut cmd;
    if cfg!(windows) {
        cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File"]).arg(script);
        cmd.args(["-AppPath", &exe]);
        if dry_run {
            cmd.arg("-DryRun");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000 | 0x00000200); // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
        }
    } else {
        cmd = Command::new("/bin/sh");
        cmd.arg(script).args(["--app-path", &exe]);
        if let Some(appimage) = std::env::var_os("APPIMAGE") {
            cmd.arg("--appimage").arg(appimage);
        }
        if dry_run {
            cmd.arg("--dry-run");
        }
    }
    cmd.stdin(Stdio::null());
    cmd
}

#[derive(Serialize)]
pub struct PlanItem {
    action: String,
    detail: String,
}

#[tauri::command]
pub async fn uninstall_plan() -> Result<Vec<PlanItem>> {
    tauri::async_runtime::spawn_blocking(|| {
        let script = write_script("plan")?;
        let output = script_command(&script, true).stdout(Stdio::piped()).stderr(Stdio::piped()).output();
        let _ = fs::remove_file(&script);
        let output = output.map_err(err)?;
        let text = String::from_utf8_lossy(&output.stdout);
        let items: Vec<PlanItem> = text
            .lines()
            .filter_map(|line| {
                let (action, detail) = line.split_once(' ')?;
                ["REMOVE", "KEEP", "PACKAGE", "RESCUE", "NOTHING", "SKIP"]
                    .contains(&action)
                    .then(|| PlanItem { action: action.to_lowercase(), detail: detail.trim().to_owned() })
            })
            .collect();
        if items.is_empty() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned()).map_err(|message| {
                if message.is_empty() { "The uninstaller could not inspect this computer.".to_string() } else { message }
            });
        }
        Ok(items)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn uninstall_start(app: AppHandle, confirm: String) -> Result<()> {
    if confirm.trim().to_lowercase() != "uninstall" {
        return Err("Type uninstall to confirm.".into());
    }
    let script = write_script("run")?;
    let log = fs::File::create(std::env::temp_dir().join("still-uninstall.log")).map_err(err)?;
    let mut cmd = script_command(&script, false);
    let pid = std::process::id().to_string();
    if cfg!(windows) {
        cmd.args(["-Yes", "-Gui", "-WaitPid", &pid]);
    } else {
        cmd.args(["--yes", "--notify", "--wait-pid", &pid]);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
    }
    cmd.stdout(log.try_clone().map_err(err)?).stderr(log);
    cmd.spawn().map_err(err)?;
    let _ = app.state::<crate::terminal::TerminalState>().stop(None);
    let _ = app.state::<crate::process::Jobs>().stop(None);
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        handle.exit(0);
    });
    Ok(())
}
