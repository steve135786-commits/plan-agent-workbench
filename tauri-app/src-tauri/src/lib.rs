//! PlanAgent Workbench — Tauri 2 desktop shell.
//!
//! Thin desktop shell over the local `plan-agent` CLI: it discovers the
//! CLI, runs workflows, surfaces the human-review gate, and reads run
//! state from the files the CLI wrote (review-state.json, audit.log).
//! It never writes workflow outputs itself and never fakes agent output
//! — approval always goes through the CLI's `run --approve` path
//! (hash verification + recorded decision).

mod cli;
mod settings;
mod workflows;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Diagnostic hook for the headless smoke test: with
            // PLAN_AGENT_DEBUG set, the app reports window creation on
            // stderr so a scripted launch can confirm the webview opened.
            if std::env::var("PLAN_AGENT_DEBUG").is_ok() {
                if let Some(window) = app.get_webview_window("main") {
                    eprintln!(
                        "plan-agent: window ready ({}x{})",
                        window.inner_size().map(|s| s.width).unwrap_or(0),
                        window.inner_size().map(|s| s.height).unwrap_or(0)
                    );
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::save_settings,
            settings::pick_folder,
            cli::agent_status,
            workflows::list_workflows,
            workflows::workflow_status,
            workflows::run_workflow,
            workflows::approve_workflow,
            workflows::list_outputs,
            workflows::read_output,
            workflows::draft_for_review
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
