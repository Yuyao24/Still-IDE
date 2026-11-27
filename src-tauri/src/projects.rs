//! The home screen: the projects folder, individual projects kept elsewhere,
//! project templates, and cloning from Git.

use crate::{
    config::{inside_app_directories, now, ProjectRecord, Store},
    process::{command, Jobs},
    workspace::{err, Result, WorkspaceInfo},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Manager, State};

const SKIP: &[&str] = &[
    ".git", ".venv", "venv", "node_modules", "target", "__pycache__", "bin", "build", "dist", ".gradle", ".idea",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    name: String,
    path: String,
    location: &'static str,
    last_opened: Option<u64>,
    modified: Option<u64>,
    languages: Vec<String>,
    branch: Option<String>,
    description: Option<String>,
    pinned: bool,
    missing: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeState {
    projects_root: Option<String>,
    suggested_root: String,
    projects: Vec<ProjectSummary>,
}

pub fn canonical(path: &Path) -> String {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    plain(&path.to_string_lossy())
}

/// A Windows path without the verbatim prefix: `\\?\C:\x` → `C:\x`, and a network share
/// `\\?\UNC\server\share` → `\\server\share` (not the broken `UNC\server…`).
pub fn plain(text: &str) -> String {
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") { return format!(r"\\{rest}") }
    text.strip_prefix(r"\\?\").map(String::from).unwrap_or_else(|| text.to_owned())
}

/// How two project paths are compared: on Windows, case and slashes don't matter.
pub fn same_path(a: &str, b: &str) -> bool {
    key(a) == key(b)
}
fn key(path: &str) -> String {
    let path = plain(path.trim()).trim_end_matches(['/', '\\']).to_owned();
    if cfg!(windows) { path.replace('/', "\\").to_lowercase() } else { path }
}

fn language(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "py" | "pyi" | "ipynb" => "Python",
        "java" => "Java",
        "kt" | "kts" => "Kotlin",
        "js" | "mjs" | "cjs" | "jsx" => "JavaScript",
        "ts" | "tsx" => "TypeScript",
        "rs" => "Rust",
        "go" => "Go",
        "c" | "h" => "C",
        "cpp" | "cc" | "hpp" | "cxx" => "C++",
        "cs" => "C#",
        "rb" => "Ruby",
        "php" => "PHP",
        "swift" => "Swift",
        "html" | "css" | "scss" => "Web",
        "sh" | "bash" | "zsh" => "Shell",
        _ => return None,
    })
}

fn branch(path: &Path) -> Option<String> {
    let head = fs::read_to_string(path.join(".git/HEAD")).ok()?;
    let head = head.trim();
    Some(match head.strip_prefix("ref: refs/heads/") {
        Some(name) => name.to_owned(),
        None => head.chars().take(7).collect(),
    })
}

fn description(path: &Path) -> Option<String> {
    let readme = ["README.md", "readme.md", "README.txt", "README"]
        .iter()
        .find_map(|name| fs::read_to_string(path.join(name)).ok())?;
    let line = readme
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("![") && !line.starts_with('<'))?;
    let mut text: String = line.chars().take(140).collect();
    if line.chars().count() > 140 {
        text.push('…');
    }
    Some(text)
}

fn millis(time: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    time.ok()?.duration_since(UNIX_EPOCH).ok().map(|value| value.as_millis() as u64)
}

/// Shallow scan for languages and the latest modification time.
fn scan(path: &Path) -> (Vec<String>, Option<u64>) {
    let mut counts = HashMap::<&'static str, usize>::new();
    let mut modified = millis(path.metadata().and_then(|meta| meta.modified()));
    let mut pending = vec![(path.to_path_buf(), 0)];
    let mut visited = 0;
    while let Some((folder, depth)) = pending.pop() {
        let Ok(entries) = fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 800 {
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if depth < 3 && !SKIP.contains(&name.as_str()) && !name.starts_with('.') {
                    pending.push((entry.path(), depth + 1));
                }
            } else if kind.is_file() {
                if let Some(found) = name.rsplit_once('.').and_then(|(_, ext)| language(&ext.to_lowercase())) {
                    *counts.entry(found).or_default() += 1;
                }
                if let Some(time) = millis(entry.metadata().and_then(|meta| meta.modified())) {
                    modified = modified.max(Some(time));
                }
            }
        }
    }
    let mut languages: Vec<_> = counts.into_iter().collect();
    languages.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    (languages.into_iter().take(3).map(|(name, _)| name.to_owned()).collect(), modified)
}

fn summary(path: &Path, location: &'static str, record: Option<&ProjectRecord>) -> ProjectSummary {
    let missing = !path.is_dir();
    let (languages, modified) = if missing { (Vec::new(), None) } else { scan(path) };
    ProjectSummary {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string()),
        path: canonical(path),
        location,
        last_opened: record.and_then(|record| record.last_opened),
        modified,
        languages,
        branch: if missing { None } else { branch(path) },
        description: if missing { None } else { description(path) },
        pinned: record.is_some_and(|record| record.pinned),
        missing,
    }
}

fn suggested_root(app: &AppHandle) -> String {
    app.path()
        .home_dir()
        .map(|home| home.join("Projects"))
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn home_state(app: AppHandle, store: State<'_, Store>) -> Result<HomeState> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (root, records) = store.read(|config| (config.projects_root.clone(), config.projects.clone()))?;
        let by_path: HashMap<String, &ProjectRecord> = records.iter().map(|record| (key(&record.path), record)).collect();
        let mut projects = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let root_path = root.as_deref().map(PathBuf::from).filter(|path| path.is_dir());
        if let Some(root) = &root_path {
            if let Ok(entries) = fs::read_dir(root) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.') || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                        continue;
                    }
                    let path = canonical(&entry.path());
                    seen.insert(key(&path));
                    projects.push(summary(&entry.path(), "library", by_path.get(&key(&path)).copied()));
                }
            }
        }
        for record in &records {
            // The same folder written another way (case, slashes, a network path) is one project.
            if seen.insert(key(&record.path)) {
                let path = PathBuf::from(&record.path);
                let location = if root_path.as_ref().is_some_and(|root| path.starts_with(root)) { "library" } else { "external" };
                projects.push(summary(&path, location, Some(record)));
            }
        }
        projects.sort_by(|a, b| b.last_opened.cmp(&a.last_opened).then(b.modified.cmp(&a.modified)));
        Ok(HomeState { projects_root: root, suggested_root: suggested_root(&app), projects })
    })
    .await
    .map_err(err)?
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Move a folder, falling back to copy-and-delete across file systems.
pub fn move_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_dir(from, to)?;
    fs::remove_dir_all(from)
}

#[tauri::command]
pub fn set_projects_root(app: AppHandle, store: State<Store>, path: String) -> Result<String> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() {
        return Err("Choose an absolute folder path.".into());
    }
    if inside_app_directories(&app, &path) {
        return Err("Choose a folder outside Still's own data folders so the uninstaller never touches your projects.".into());
    }
    fs::create_dir_all(&path).map_err(err)?;
    let root = canonical(&path);
    // Earlier versions kept the sample in app data. Move it somewhere safe.
    if let Ok(local) = app.path().app_local_data_dir() {
        let legacy = local.join("orbit-lab");
        let target = path.join("Orbit Lab");
        if legacy.is_dir() && !target.exists() && move_dir(&legacy, &target).is_ok() {
            let _ = fs::remove_file(target.join(".still-initialized"));
        }
    }
    store.update(|config| {
        config.projects_root = Some(root.clone());
        Ok(())
    })?;
    Ok(root)
}

fn record_open(store: &Store, path: &str) -> Result<()> {
    store.update(|config| {
        // Merge records that turn out to be the same folder (left by older versions), keeping the
        // newest time and any pin, under the path as it's written now.
        let (same, mut others): (Vec<ProjectRecord>, Vec<ProjectRecord>) = std::mem::take(&mut config.projects).into_iter().partition(|record| same_path(&record.path, path));
        let pinned = same.iter().any(|record| record.pinned);
        others.push(ProjectRecord { path: path.to_owned(), last_opened: Some(now()), pinned });
        config.projects = others;
        Ok(())
    })
}

#[tauri::command]
pub fn open_project(store: State<Store>, path: String) -> Result<WorkspaceInfo> {
    let info = crate::workspace::workspace_info(path)?;
    record_open(&store, &info.root)?;
    Ok(info)
}

/// A single file opened on its own: its folder serves the file, but it isn't added to your projects.
#[derive(serde::Serialize)]
pub struct LooseFile { root: String, name: String, file: String }

#[tauri::command]
pub fn open_loose_file(path: String) -> Result<LooseFile> {
    let full = std::path::PathBuf::from(plain(&path));
    if !full.is_file() { return Err(format!("{path} isn't a file.")) }
    let parent = full.parent().ok_or("That file has no folder.")?;
    let info = crate::workspace::workspace_info(parent.to_string_lossy().to_string())?;
    let file = full.file_name().map(|name| name.to_string_lossy().to_string()).ok_or("That file has no name.")?;
    Ok(LooseFile { root: info.root, name: file.clone(), file })
}

#[tauri::command]
pub fn forget_project(store: State<Store>, path: String) -> Result<()> {
    store.update(|config| {
        config.projects.retain(|record| !same_path(&record.path, &path));
        Ok(())
    })
}

/// Moves a project folder to the system trash (so it can be restored) and takes it off Home.
/// Only folders Home knows as projects; never a home folder or a drive's root.
#[tauri::command]
pub fn delete_project(store: State<Store>, path: String) -> Result<()> {
    let folder = std::path::PathBuf::from(&path);
    let canonical = folder.canonicalize().map_err(err)?;
    if !canonical.is_dir() {
        return Err("That project folder no longer exists.".into());
    }
    if canonical.parent().is_none() || dirs_home().is_some_and(|home| home == canonical) {
        return Err("Still won't delete that folder.".into());
    }
    let (root, known) = store.read(|config| (config.projects_root.clone(), config.projects.iter().any(|record| same_path(&record.path, &path))))?;
    let in_library = root.as_ref().is_some_and(|root| std::path::Path::new(root).canonicalize().is_ok_and(|root| canonical.starts_with(&root) && canonical != root));
    if !known && !in_library {
        return Err("Still only deletes projects listed on Home.".into());
    }
    trash::delete(&canonical).map_err(|error| format!("Couldn't move the project to the trash: {error}"))?;
    store.update(|config| {
        config.projects.retain(|record| !same_path(&record.path, &path));
        Ok(())
    })
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(std::path::PathBuf::from).and_then(|home| home.canonicalize().ok())
}

#[tauri::command]
pub fn pin_project(store: State<Store>, path: String, pinned: bool) -> Result<()> {
    store.update(|config| {
        match config.projects.iter_mut().find(|record| same_path(&record.path, &path)) {
            Some(record) => record.pinned = pinned,
            None => config.projects.push(ProjectRecord { path, last_opened: None, pinned }),
        }
        Ok(())
    })
}

pub fn valid_name(name: &str) -> Result<&str> {
    let name = name.trim();
    let reserved = ["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "lpt1", "lpt2", "lpt3"];
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > 120
        || name.ends_with('.')
        || name.chars().any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c))
        || reserved.contains(&name.to_lowercase().as_str())
    {
        return Err("Use a project name without slashes or special characters.".into());
    }
    Ok(name)
}

fn parent_folder(app: &AppHandle, store: &Store, parent: Option<String>) -> Result<PathBuf> {
    let parent = match parent.filter(|value| !value.trim().is_empty()) {
        Some(parent) => PathBuf::from(parent),
        None => PathBuf::from(
            store
                .read(|config| config.projects_root.clone())?
                .ok_or("Choose a projects folder first, or pick a location for this project.")?,
        ),
    };
    if !parent.is_dir() {
        return Err("The parent folder does not exist.".into());
    }
    if inside_app_directories(app, &parent) {
        return Err("Choose a location outside Still's own data folders.".into());
    }
    Ok(parent)
}

fn template(kind: &str, name: &str) -> Vec<(&'static str, String)> {
    let readme = |body: &str| format!("# {name}\n\n{body}\n");
    match kind {
        "python" => vec![
            ("README.md", readme("A Python project. Open `main.py` and press Ctrl/Cmd + Enter to run it.")),
            ("main.py", format!("def main() -> None:\n    print(\"Hello from {name}\")\n\n\nif __name__ == \"__main__\":\n    main()\n")),
            ("requirements.txt", String::new()),
            (".gitignore", ".venv/\n__pycache__/\n*.pyc\n".into()),
        ],
        "java" => vec![
            ("README.md", readme("A Java project. Open `src/Main.java` and press Ctrl/Cmd + Enter to compile and run it.")),
            ("src/Main.java", format!("public class Main {{\n    public static void main(String[] args) {{\n        System.out.println(\"Hello from {name}\");\n    }}\n}}\n")),
            (".gitignore", "bin/\n*.class\n".into()),
        ],
        "node" => vec![
            ("README.md", readme("A JavaScript project. Open `index.js` and press Ctrl/Cmd + Enter to run it with Node.")),
            ("index.js", format!("console.log('Hello from {name}')\n")),
            ("package.json", format!("{{\n  \"name\": \"{}\",\n  \"version\": \"0.1.0\",\n  \"private\": true,\n  \"type\": \"module\"\n}}\n", name.to_lowercase().replace(' ', "-"))),
            (".gitignore", "node_modules/\n".into()),
        ],
        "sample" => vec![
            ("src/app.py", include_str!("../sample/app.py").into()),
            ("src/Main.java", include_str!("../sample/Main.java").into()),
            ("tests/test_orbit.py", include_str!("../sample/test_orbit.py").into()),
            ("README.md", include_str!("../sample/README.md").into()),
            ("requirements.txt", include_str!("../sample/requirements.txt").into()),
            (".gitignore", include_str!("../sample/gitignore.txt").into()),
        ],
        _ => vec![("README.md", readme("Notes and code for this project."))],
    }
}

#[tauri::command]
pub fn create_project(
    app: AppHandle,
    store: State<Store>,
    name: String,
    template_kind: String,
    parent: Option<String>,
    git: bool,
    readme: Option<bool>,
    requirements: Option<bool>,
) -> Result<WorkspaceInfo> {
    let name = valid_name(&name)?.to_owned();
    let folder = parent_folder(&app, &store, parent)?.join(&name);
    if folder.exists() {
        return Err(format!("A folder named “{name}” already exists there."));
    }
    fs::create_dir_all(&folder).map_err(err)?;
    // README.md and requirements.txt are optional (both on unless turned off in the dialog).
    let files = template(&template_kind, &name).into_iter().filter(|(path, _)| {
        !(*path == "README.md" && readme == Some(false) && template_kind != "sample")
            && !(*path == "requirements.txt" && requirements == Some(false) && template_kind != "sample")
    });
    for (path, contents) in files {
        let target = folder.join(path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        fs::write(target, contents).map_err(err)?;
    }
    if git && template_kind == "sample" {
        crate::git::initialize_sample(&folder);
    } else if git {
        let initialized = command("git", &folder).args(["init", "-q", "-b", "main"]).output().is_ok_and(|out| out.status.success());
        if !initialized {
            let _ = command("git", &folder).args(["init", "-q"]).output();
        }
    }
    let info = crate::workspace::workspace_info(folder.to_string_lossy().into_owned())?;
    record_open(&store, &info.root)?;
    Ok(info)
}

fn repository_name(url: &str) -> String {
    url.trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .unwrap_or("repository")
        .trim_end_matches(".git")
        .to_owned()
}

#[tauri::command]
pub fn clone_project(
    app: AppHandle,
    store: State<Store>,
    jobs: State<Jobs>,
    id: String,
    url: String,
    name: Option<String>,
    parent: Option<String>,
) -> Result<String> {
    let url = url.trim().to_owned();
    if url.is_empty() || url.starts_with('-') || url.chars().any(char::is_whitespace) {
        return Err("Enter a Git repository URL.".into());
    }
    let name = name.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| repository_name(&url));
    let name = valid_name(&name)?.to_owned();
    let parent = parent_folder(&app, &store, parent)?;
    let target = parent.join(&name);
    if target.exists() {
        return Err(format!("A folder named “{name}” already exists there."));
    }
    let target_text = target.to_string_lossy().into_owned();
    let result = target_text.clone();
    jobs.start(app, id, false, move |job| {
        job.emit("command", format!("$ git clone {url} {name}\n"));
        let mut cmd = command("git", &parent);
        cmd.env("GIT_TERMINAL_PROMPT", "0").args(["clone", "--progress", "--", &url, &target_text]);
        let (code, _) = job.run(&mut cmd, false)?;
        Ok((code, Vec::new()))
    })?;
    Ok(result)
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<()> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err("This folder no longer exists.".into());
    }
    let cwd = std::env::temp_dir();
    let mut cmd = if cfg!(windows) {
        let mut cmd = command("explorer", &cwd);
        cmd.arg(&path);
        cmd
    } else if cfg!(target_os = "macos") {
        let mut cmd = command("open", &cwd);
        cmd.arg(&path);
        cmd
    } else {
        let mut cmd = command("xdg-open", &cwd);
        cmd.arg(&path);
        cmd
    };
    cmd.spawn().map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn app_paths(app: AppHandle, store: State<Store>) -> Result<serde_json::Value> {
    Ok(serde_json::json!({
        "config": store.file().to_string_lossy(),
        "directories": crate::config::app_directories(&app).iter().map(|path| path.to_string_lossy().into_owned()).collect::<Vec<_>>(),
        "home": app.path().home_dir().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default(),
        "version": app.package_info().version.to_string(),
        "platform": std::env::consts::OS,
    }))
}

/// Open a web or mail link in the system's default app (used by Markdown previews).
#[tauri::command]
pub fn open_external(url: String) -> Result<()> {
    let url = url.trim().to_owned();
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")) || url.chars().any(char::is_control) {
        return Err("Only web and mail links can be opened.".into());
    }
    let cwd = std::env::temp_dir();
    let mut cmd = if cfg!(windows) {
        // rundll32 opens the URL without going through a shell, so it can't be misread as a command.
        let mut cmd = command("rundll32", &cwd);
        cmd.args(["url.dll,FileProtocolHandler", &url]);
        cmd
    } else if cfg!(target_os = "macos") {
        let mut cmd = command("open", &cwd);
        cmd.arg(&url);
        cmd
    } else {
        let mut cmd = command("xdg-open", &cwd);
        cmd.arg(&url);
        cmd
    };
    cmd.spawn().map_err(err)?;
    Ok(())
}

/// Write a PNG produced in the app (code images) to a path the user picked in the save dialog.
#[tauri::command]
pub fn save_png(path: String, data: String) -> Result<()> {
    use base64::Engine;
    let path = PathBuf::from(path);
    if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("png")) {
        return Err("Images are saved as .png files.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim_start_matches("data:image/png;base64,")).map_err(err)?;
    if !bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err("That image data is not a PNG.".into());
    }
    fs::write(path, bytes).map_err(err)
}
