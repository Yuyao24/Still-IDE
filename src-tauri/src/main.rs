#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod ai;
mod check;
mod debug;
mod docs;
mod history;
mod jdebug;
mod lsp;
mod notebook;
mod tests;
mod tools;
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
        .manage(ssh::Relays::default())
        .manage(debug::Debuggers::default())
        .manage(lsp::Servers::default())
        .manage(notebook::Kernels::default())
        .manage(ssh::Workers::default())
        .manage(ssh::Forwards::default())
        .manage(backup::LaunchTarget(std::sync::Mutex::new(backup::target_from_args())))
        .setup(|app| {
            let store = config::Store::load(app.handle());
            app.manage(store);
            // The window starts hidden and the page shows it once it has painted in the theme's
            // colours (no white flash). If the page never does, show it anyway.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if let Some(window) = handle.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(false) { let _ = window.show(); }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::settings_get,
            check::git_head_text,
            check::check_python,
            debug::debug_start,
            debug::debug_send,
            tools::format_code,
            tools::tools_status,
            tools::install_tool,
            history::history_save,
            history::history_list,
            history::history_read,
            history::git_blame,
            history::git_file_log,
            history::git_show_at,
            tests::tests_run,
            lsp::lsp_available,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            notebook::notebook_start,
            notebook::notebook_run,
            notebook::notebook_interrupt,
            notebook::notebook_stop,
            config::settings_set,
            projects::home_state,
            projects::set_projects_root,
            projects::open_project,
            projects::forget_project,
            projects::delete_project,
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
            git::git_stash,
            git::git_apply_patch,
            git::git_remote_url,
            git::git_checkout_pr,
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
            ssh::ssh_debug_start,
            backup::backup_write,
            backup::backup_read,
            backup::launch_target,
            backup::write_text_file,
            backup::read_text_file,
            backup::install_cli,
            backup::explorer_menu,
            git::git_graph,
            git::git_commit_detail,
            ssh::ssh_forward_start,
            ssh::ssh_forward_stop,
            ssh::ssh_forward_list,
            ssh::ssh_listening_ports,
            ssh::ssh_read_binary,
            ssh::ssh_lsp_start,
            ssh::ssh_tests_run,
            docs::read_binary,
            docs::tex_compile,
            uninstall::uninstall_plan,
            uninstall::uninstall_start,
        ])
        .build(tauri::generate_context!())
        .expect("could not initialize Still")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = app.state::<terminal::TerminalState>().stop(None);
                let _ = app.state::<process::Jobs>().stop(None);
                app.state::<lsp::Servers>().stop_all();
                app.state::<notebook::Kernels>().stop_all();
                app.state::<ssh::Forwards>().stop_all();
            }
        });
}
