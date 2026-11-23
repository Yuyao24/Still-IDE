//! Persistent application state: the projects folder, the list of projects
//! opened from elsewhere, saved SSH servers, and the frontend's settings blob.
//!
//! Everything lives in a single `config.json` inside the app config directory,
//! so the uninstaller knows exactly what to remove.

use crate::workspace::{err, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectRecord {
    pub path: String,
    pub last_opened: Option<u64>,
    pub pinned: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SshHost {
    pub id: String,
    pub name: String,
    pub host: String,
    /// Display-only HostName from ~/.ssh/config.
    pub address: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub jump: Option<String>,
    pub forwards: Vec<String>,
    pub remote_path: Option<String>,
    pub last_used: Option<u64>,
    /// "saved" for hosts created in Still, "config" for ~/.ssh/config entries.
    pub source: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub projects_root: Option<String>,
    pub projects: Vec<ProjectRecord>,
    pub ssh_hosts: Vec<SshHost>,
    pub settings: serde_json::Value,
}

#[derive(Clone)]
pub struct Store {
    file: PathBuf,
    pub data: Arc<Mutex<Config>>,
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

/// Every directory Still itself writes to. The uninstaller removes these, and
/// projects may never be created inside them.
pub fn app_directories(app: &AppHandle) -> Vec<PathBuf> {
    let paths = app.path();
    let mut list: Vec<PathBuf> = [
        paths.app_config_dir(),
        paths.app_data_dir(),
        paths.app_local_data_dir(),
        paths.app_cache_dir(),
        paths.app_log_dir(),
    ]
    .into_iter()
    .flatten()
    .collect();
    list.sort();
    list.dedup();
    list
}

pub fn inside_app_directories(app: &AppHandle, path: &Path) -> bool {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    app_directories(app).iter().any(|dir| {
        let dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        path.starts_with(&dir)
    })
}

impl Store {
    pub fn load(app: &AppHandle) -> Store {
        let file = app
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("dev.still.editor"))
            .join("config.json");
        let data = fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Config>(&bytes).ok())
            .unwrap_or_default();
        Store {
            file,
            data: Arc::new(Mutex::new(data)),
        }
    }

    pub fn read<T>(&self, view: impl FnOnce(&Config) -> T) -> Result<T> {
        Ok(view(&*self.data.lock().map_err(err)?))
    }

    /// Apply a change and write the file atomically.
    pub fn update<T>(&self, change: impl FnOnce(&mut Config) -> Result<T>) -> Result<T> {
        let mut data = self.data.lock().map_err(err)?;
        let result = change(&mut data)?;
        let bytes = serde_json::to_vec_pretty(&*data).map_err(err)?;
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        let temporary = self.file.with_extension("json.tmp");
        fs::write(&temporary, bytes).map_err(err)?;
        fs::rename(&temporary, &self.file).map_err(err)?;
        Ok(result)
    }

    pub fn file(&self) -> &Path {
        &self.file
    }
}

#[tauri::command]
pub fn settings_get(store: State<Store>) -> Result<serde_json::Value> {
    store.read(|config| config.settings.clone())
}

#[tauri::command]
pub fn settings_set(store: State<Store>, settings: serde_json::Value) -> Result<()> {
    if !settings.is_object() {
        return Err("Settings must be an object.".into());
    }
    store.update(|config| {
        config.settings = settings;
        Ok(())
    })
}
