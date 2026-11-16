//! App settings, persisted as JSON in the Tauri app config directory.
//!
//! Two settings, mirroring the VS Code extension:
//!   - `cli_path`: path to the built CLI entry (dist/cli.js). Empty means
//!     `<workspace_root>/dist/cli.js`, run with node.
//!   - `workspace_root`: the workbench repo root (workflows/, out/).
//!     Empty means "not configured yet" — the UI then asks the user to
//!     pick the folder instead of guessing a machine path.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub cli_path: String,
    #[serde(default)]
    pub workspace_root: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    let settings: Settings = {
        let Ok(path) = settings_path(&app) else {
            return Settings::default();
        };
        let Ok(text) = fs::read_to_string(path) else {
            return Settings::default();
        };
        serde_json::from_str(&text).unwrap_or_default()
    };
    if std::env::var("PLAN_AGENT_DEBUG").is_ok() {
        eprintln!(
            "plan-agent: get_settings -> workspace_root={:?} cli_path={:?}",
            settings.workspace_root, settings.cli_path
        );
    }
    settings
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

/// Folder picker (tauri-plugin-dialog). Returns the chosen path, if any.
#[tauri::command]
pub fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}
