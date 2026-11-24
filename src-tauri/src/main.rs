#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod check;
mod config;
mod git;
mod packages;
mod process;
mod projects;
mod ssh;
mod terminal;
mod uninstall;
mod workspace;

use tauri::Manager;

fn main() {
    if ssh::askpass_mode() {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(process::Jobs::default())
        .manage(terminal::TerminalState::default())
        .manage(ssh::Passwords::default())
        .manage(ssh::Prompts::default())
        .manage(ssh::Workers::default())
        .setup(|app| {
            let store = config::Store::load(app.handle());
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::settings_get,
            check::git_head_text,
            check::check_python,
            config::settings_set,
            projects::home_state,
            projects::set_projects_root,
            projects::open_project,
            projects::forget_project,
            projects::pin_project,
            projects::create_project,
            projects::clone_project,
            projects::reveal_path,
            projects::app_paths,
            projects::open_external,
            projects::save_png,
            ssh::ssh_set_password,
            ssh::ssh_command,
            ai::ai_key_status,
            ai::ai_key_get,
            ai::ai_key_set,
            ai::ai_run_command,
            workspace::workspace_info,
            workspace::list_directory,
            workspace::list_files,
            workspace::read_file,
            workspace::save_file,
            workspace::create_file,
            workspace::create_folder,
            workspace::rename_path,
            workspace::delete_path,
            workspace::search_workspace,
            process::detect_runtimes,
            process::run_file,
            process::stop_job,
            process::job_input,
            terminal::detect_shells,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_stop,
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_stage_all,
            git::git_discard,
            git::git_action,
            git::git_branches,
            git::git_checkout,
            git::git_log,
            git::git_init,
            packages::package_state,
            packages::package_search,
            packages::package_action,
            ssh::ssh_hosts,
            ssh::ssh_save_host,
            ssh::ssh_delete_host,
            ssh::ssh_test,
            ssh::ssh_resolve,
            ssh::ssh_browse,
            ssh::ssh_prompt_answer,
            ssh::ssh_list,
            ssh::ssh_files,
            ssh::ssh_read,
            ssh::ssh_write,
            ssh::ssh_fs,
            ssh::ssh_search,
            ssh::ssh_run,
            uninstall::uninstall_plan,
            uninstall::uninstall_start,
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
