use crate::{
    process::{check, command, python, Jobs},
    workspace::{err, resolve, root, Result},
};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};
use tauri::{AppHandle, State};

const MANIFESTS: &[&str] = &[
    "requirements.txt",
    "pyproject.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
];

#[derive(Serialize, Deserialize)]
pub struct Package {
    name: String,
    version: String,
}

#[derive(Serialize)]
pub struct PackageState {
    manifests: Vec<String>,
    installed: Vec<Package>,
    environment: Option<String>,
    warning: Option<String>,
}

#[tauri::command]
pub async fn package_state(root_path: String) -> Result<PackageState> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        let manifests = MANIFESTS
            .iter()
            .filter(|path| resolve(&cwd, path).is_ok_and(|path| path.is_file()))
            .map(|name| name.to_string())
            .collect();
        let mut state = PackageState {
            manifests,
            installed: Vec::new(),
            environment: None,
            warning: None,
        };
        if let Some((program, version, venv)) = python(&cwd) {
            state.environment = Some(if venv {
                format!("{version} · virtual environment")
            } else {
                version
            });
            let result = command(program, &cwd)
                .args([
                    "-m",
                    "pip",
                    "--disable-pip-version-check",
                    "list",
                    "--format=json",
                ])
                .output()
                .map_err(err)
                .and_then(check)
                .and_then(|output| serde_json::from_slice(&output.stdout).map_err(err));
            match result {
                Ok(installed) => state.installed = installed,
                Err(error) => state.warning = Some(error),
            }
        }
        Ok(state)
    })
    .await
    .map_err(err)?
}

fn valid_package(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 214
        && name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

#[derive(Serialize, Deserialize)]
pub struct PackageMatch {
    name: String,
    version: String,
    summary: Option<String>,
}

#[derive(Deserialize)]
struct RegistryResponse {
    info: PackageMatch,
}

#[tauri::command]
pub async fn package_search(name: String) -> Result<Option<PackageMatch>> {
    if !valid_package(&name) {
        return Err("Enter a PyPI package name, such as requests.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(10)))
            .build();
        let agent: ureq::Agent = config.into();
        let response = agent
            .get(&format!("https://pypi.org/pypi/{name}/json"))
            .call();
        match response {
            Ok(mut response) => response
                .body_mut()
                .read_json::<RegistryResponse>()
                .map(|item| Some(item.info))
                .map_err(err),
            Err(ureq::Error::StatusCode(404)) => Ok(None),
            Err(error) => Err(err(error)),
        }
    })
    .await
    .map_err(err)?
}

fn wrapper(cwd: &Path, script: &str, fallback: &str) -> String {
    if resolve(cwd, script).is_ok_and(|path| path.is_file()) {
        cwd.join(script).to_string_lossy().into_owned()
    } else if cfg!(windows) {
        format!("{fallback}.cmd")
    } else {
        fallback.into()
    }
}

#[tauri::command]
pub fn package_action(
    app: AppHandle,
    jobs: State<Jobs>,
    root_path: String,
    id: String,
    action: String,
    name: Option<String>,
) -> Result<()> {
    let cwd = root(&root_path)?;
    jobs.start(app, id, false, move |job| {
        let (mut cmd, label) = match action.as_str() {
            "install" | "remove" | "requirements" => {
                let (program, _, _) =
                    python(&cwd).ok_or("Python 3 was not found on PATH or in .venv.")?;
                let mut cmd = command(program, &cwd);
                cmd.env("PYTHONIOENCODING", "utf-8").args([
                    "-u",
                    "-m",
                    "pip",
                    "--disable-pip-version-check",
                    "--no-input",
                ]);
                if action == "requirements" {
                    resolve(&cwd, "requirements.txt")?;
                    cmd.args(["install", "-r", "requirements.txt"]);
                    (cmd, "python -m pip install -r requirements.txt".into())
                } else {
                    let name = name
                        .as_deref()
                        .filter(|name| valid_package(name))
                        .ok_or("Enter a valid PyPI package name.")?;
                    if action == "install" {
                        cmd.args(["install", name]);
                        (cmd, format!("python -m pip install {name}"))
                    } else {
                        cmd.args(["uninstall", "-y", name]);
                        (cmd, format!("python -m pip uninstall {name}"))
                    }
                }
            }
            "venv" => {
                if resolve(&cwd, ".venv").is_ok() {
                    return Err("This project already has a .venv folder.".into());
                }
                let (program, _, venv) = python(&cwd).ok_or("Python 3 was not found on PATH.")?;
                if venv {
                    return Err("A virtual environment is already active.".into());
                }
                let mut cmd = command(program, &cwd);
                cmd.args(["-m", "venv", ".venv"]);
                (cmd, "python -m venv .venv".into())
            }
            "maven" => {
                resolve(&cwd, "pom.xml")?;
                let program = wrapper(&cwd, if cfg!(windows) { "mvnw.cmd" } else { "mvnw" }, "mvn");
                let mut cmd = command(program, &cwd);
                cmd.args(["-B", "dependency:resolve"]);
                (cmd, "mvn dependency:resolve".into())
            }
            "gradle" => {
                if resolve(&cwd, "build.gradle").is_err() {
                    resolve(&cwd, "build.gradle.kts")?;
                }
                let program = wrapper(
                    &cwd,
                    if cfg!(windows) {
                        "gradlew.bat"
                    } else {
                        "gradlew"
                    },
                    "gradle",
                );
                let mut cmd = command(program, &cwd);
                cmd.args(["--console=plain", "dependencies"]);
                (cmd, "gradle dependencies".into())
            }
            _ => return Err("Unknown package action.".into()),
        };
        job.emit("command", format!("$ {label}\n"));
        let (code, _) = job.run(&mut cmd, false)?;
        Ok((code, Vec::new()))
    })
}
