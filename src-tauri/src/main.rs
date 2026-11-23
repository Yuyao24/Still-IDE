#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod git;
mod packages;
mod process;
mod terminal;
mod workspace;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(process::Jobs::default())
        .manage(terminal::TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            workspace::workspace_info,
            workspace::sample_workspace,
            workspace::list_directory,
            workspace::list_files,
            workspace::read_file,
            workspace::save_file,
            workspace::create_file,
            process::detect_runtimes,
            process::run_file,
            process::stop_job,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_stop,
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_action,
            packages::package_state,
            packages::package_search,
            packages::package_action,
        ])
        .build(tauri::generate_context!())
        .expect("could not initialize Still")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = app.state::<terminal::TerminalState>().stop(None);
                let _ = app.state::<process::Jobs>().stop(None);
            }
        });
}
