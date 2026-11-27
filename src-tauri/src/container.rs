//! Dev containers: a project with `.devcontainer/devcontainer.json` (or `.devcontainer.json`) can
//! run its code, tests and terminals inside that container. Still builds or pulls the image, starts
//! a container with the project folder mounted, and runs things there with `docker exec`. When the
//! Dev Containers CLI (`devcontainer`) is installed, Still lets it bring the container up, so
//! features and Docker Compose setups work as well.
use crate::{
    process::{command, parse_args, project_env, Jobs},
    tests::{emit_report, jacoco_reports, java_sources, parse_coverage, parse_jacoco, parse_junit, TestResult, GRADLE_JACOCO, JACOCO},
    tools::find,
    workspace::{relative, root, Result},
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

fn err(error: impl std::fmt::Display) -> String { error.to_string() }

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    /// The config file, relative to the project; empty when the project has none.
    config: String,
    name: String,
    /// Docker is installed and its engine answers.
    docker: bool,
    /// "none" (not made yet), "stopped" or "running".
    state: String,
    id: Option<String>,
    workspace: String,
    image: Option<String>,
    note: Option<String>,
}

/// devcontainer.json allows comments and trailing commas; serde_json doesn't.
fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let (mut index, mut in_string) = (0, false);
    while index < chars.len() {
        let char = chars[index];
        if in_string {
            out.push(char);
            if char == '\\' && index + 1 < chars.len() { out.push(chars[index + 1]); index += 1 }
            else if char == '"' { in_string = false }
        } else if char == '"' { in_string = true; out.push(char) }
        else if char == '/' && chars.get(index + 1) == Some(&'/') { while index < chars.len() && chars[index] != '\n' { index += 1 } continue }
        else if char == '/' && chars.get(index + 1) == Some(&'*') { index += 2; while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') { index += 1 } index += 2; continue }
        else { out.push(char) }
        index += 1;
    }
    // Trailing commas before } or ].
    let mut cleaned = String::with_capacity(out.len());
    let bytes: Vec<char> = out.chars().collect();
    let mut in_string = false;
    for (index, char) in bytes.iter().enumerate() {
        if in_string { cleaned.push(*char); if *char == '\\' { continue } if *char == '"' && bytes.get(index.wrapping_sub(1)) != Some(&'\\') { in_string = false } continue }
        if *char == '"' { in_string = true }
        if *char == ',' {
            let next = bytes[index + 1..].iter().find(|item| !item.is_whitespace());
            if matches!(next, Some('}') | Some(']')) { continue }
        }
        cleaned.push(*char);
    }
    cleaned
}

struct Config { file: PathBuf, value: serde_json::Value }

fn load(cwd: &Path) -> Option<Config> {
    let mut candidates = vec![cwd.join(".devcontainer/devcontainer.json"), cwd.join(".devcontainer.json")];
    if let Ok(entries) = std::fs::read_dir(cwd.join(".devcontainer")) {
        let mut nested: Vec<PathBuf> = entries.flatten().map(|entry| entry.path().join("devcontainer.json")).filter(|path| path.is_file()).collect();
        nested.sort();
        candidates.extend(nested);
    }
    let file = candidates.into_iter().find(|path| path.is_file())?;
    let text = std::fs::read_to_string(&file).ok()?;
    let value = serde_json::from_str(&strip_jsonc(&text)).ok()?;
    Some(Config { file, value })
}

fn hash(text: &str) -> String {
    let mut value: u64 = 0xcbf29ce484222325;
    for byte in text.bytes() { value ^= byte as u64; value = value.wrapping_mul(0x100000001b3) }
    format!("{:08x}", value as u32)
}

fn folder_name(cwd: &Path) -> String {
    cwd.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "project".into())
}

/// The label that marks this project's container (Still's own, or one the Dev Containers CLI made).
fn label(cwd: &Path) -> String { format!("still.root={}", hash(&crate::projects::plain(&cwd.to_string_lossy()))) }

fn docker() -> Option<PathBuf> { find(&std::env::temp_dir(), "docker") }

fn workspace_folder(config: &Config, cwd: &Path) -> String {
    config.value["workspaceFolder"].as_str().map(String::from).unwrap_or_else(|| format!("/workspaces/{}", folder_name(cwd)))
}

/// The project's container: its id and whether it's running.
fn find_container(docker: &Path, cwd: &Path) -> Option<(String, bool)> {
    let out = command(docker, cwd).args(["ps", "-a", "--filter", &format!("label={}", label(cwd)), "--format", "{{.ID}} {{.State}}"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?;
    let (id, state) = line.split_once(' ')?;
    Some((id.to_owned(), state.trim() == "running"))
}

fn engine_answers(docker: &Path) -> bool {
    command(docker, &std::env::temp_dir()).args(["version", "--format", "{{.Server.Version}}"]).output().is_ok_and(|out| out.status.success())
}

fn info(cwd: &Path) -> ContainerInfo {
    let Some(config) = load(cwd) else { return ContainerInfo { state: "none".into(), ..Default::default() } };
    let relative = config.file.strip_prefix(cwd).map(|path| path.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    let name = config.value["name"].as_str().map(String::from).unwrap_or_else(|| folder_name(cwd));
    let workspace = workspace_folder(&config, cwd);
    let image = config.value["image"].as_str().map(String::from);
    let mut result = ContainerInfo { config: relative, name, state: "none".into(), workspace, image, ..Default::default() };
    let Some(docker) = docker() else { result.note = Some("Docker isn't installed. Install Docker Desktop (or Docker Engine) to use the dev container.".into()); return result };
    if !engine_answers(&docker) { result.note = Some("Docker is installed but its engine isn't running. Start Docker Desktop, then try again.".into()); return result }
    result.docker = true;
    if let Some((id, running)) = find_container(&docker, cwd) { result.id = Some(id); result.state = if running { "running".into() } else { "stopped".into() } }
    result
}

/// What the project's dev container is, and whether it's running.
#[tauri::command]
pub async fn container_status(root_path: String) -> Result<ContainerInfo> {
    tauri::async_runtime::spawn_blocking(move || Ok(info(&root(&root_path)?))).await.map_err(err)?
}

fn string_list(value: &serde_json::Value) -> Vec<String> {
    match value {
        serde_json::Value::String(text) => vec![text.clone()],
        serde_json::Value::Array(items) => items.iter().filter_map(|item| item.as_str().map(String::from)).collect(),
        _ => Vec::new(),
    }
}

/// A lifecycle command (string for the shell, array for a program, object of several) in the container.
fn lifecycle(job: &crate::process::Job, docker: &Path, cwd: &Path, id: &str, workspace: &str, user: Option<&str>, value: &serde_json::Value, label: &str) -> Result<()> {
    let commands: Vec<serde_json::Value> = match value {
        serde_json::Value::Object(map) => map.values().cloned().collect(),
        serde_json::Value::Null => Vec::new(),
        other => vec![other.clone()],
    };
    for item in commands {
        let mut cmd = exec_base(docker, cwd, id, workspace, user, false, &[]);
        match &item {
            serde_json::Value::String(text) => { cmd.args(["sh", "-c", text]); }
            serde_json::Value::Array(_) => { cmd.args(string_list(&item)); }
            _ => continue,
        }
        job.emit("command", format!("$ {label}: {}\n", item.as_str().map(String::from).unwrap_or_else(|| string_list(&item).join(" "))));
        let (code, _) = job.run(&mut cmd, false)?;
        if code != 0 { return Err(format!("The dev container's {label} failed (exit code {code}).")) }
    }
    Ok(())
}

fn exec_base(docker: &Path, cwd: &Path, id: &str, workspace: &str, user: Option<&str>, interactive: bool, env: &[(String, String)]) -> std::process::Command {
    let mut cmd = command(docker, cwd);
    cmd.arg("exec");
    if interactive { cmd.arg("-i"); }
    cmd.args(["-w", workspace]);
    if let Some(user) = user { cmd.args(["-u", user]); }
    for (key, value) in env { cmd.arg("-e").arg(format!("{key}={value}")); }
    cmd.arg(id);
    cmd
}

/// Builds or pulls the image and starts the container (or starts the one already made).
#[tauri::command]
pub fn container_up(app: AppHandle, jobs: State<Jobs>, id: String, root_path: String, rebuild: Option<bool>) -> Result<()> {
    let cwd = root(&root_path)?;
    let config = load(&cwd).ok_or("This project has no dev container (.devcontainer/devcontainer.json).")?;
    let docker = docker().ok_or("Docker isn't installed. Install Docker Desktop (or Docker Engine) to use the dev container.")?;
    let events = app.clone();
    let rebuild = rebuild.unwrap_or(false);
    jobs.start(app, id, false, move |job| {
        if !engine_answers(&docker) { return Err("Docker's engine isn't running. Start Docker Desktop, then try again.".into()) }
        let value = &config.value;
        let workspace = workspace_folder(&config, &cwd);
        let user = value["remoteUser"].as_str().or(value["containerUser"].as_str()).map(String::from);
        let existing = find_container(&docker, &cwd);
        if rebuild {
            if let Some((old, _)) = &existing {
                job.emit("command", "$ docker rm -f (the old container)\n".into());
                let _ = job.run(command(&docker, &cwd).args(["rm", "-f", old]), false)?;
            }
        } else if let Some((existing, running)) = &existing {
            if !running {
                job.emit("command", "$ docker start\n".into());
                let (code, _) = job.run(command(&docker, &cwd).args(["start", existing]), false)?;
                if code != 0 { return Ok((code, Vec::new())) }
                lifecycle(job, &docker, &cwd, existing, &workspace, user.as_deref(), &value["postStartCommand"], "postStartCommand")?;
            } else { job.emit("stdout", "The dev container is already running.\n".into()) }
            let _ = events.emit("container-changed", ());
            return Ok((0, Vec::new()));
        }
        let config_dir = config.file.parent().unwrap_or(&cwd).to_path_buf();
        // The Dev Containers CLI handles features and Compose; use it when it's there.
        let cli = find(&cwd, "devcontainer");
        let needs_cli = value.get("dockerComposeFile").is_some() || value["features"].as_object().is_some_and(|features| !features.is_empty());
        if let Some(cli) = cli.filter(|_| needs_cli || value.get("image").is_none() && value.get("build").is_none() && value.get("dockerFile").is_none()) {
            let mut cmd = command(&cli, &cwd);
            cmd.args(["up", "--workspace-folder"]).arg(&cwd).args(["--id-label", &label(&cwd)]);
            if rebuild { cmd.arg("--remove-existing-container"); }
            job.emit("command", "$ devcontainer up\n".into());
            let (code, _) = job.run(&mut cmd, false)?;
            let _ = events.emit("container-changed", ());
            return Ok((code, Vec::new()));
        }
        if needs_cli {
            return Err(if value.get("dockerComposeFile").is_some() { "This dev container uses Docker Compose. Install the Dev Containers CLI (npm install -g @devcontainers/cli) and Still will use it." } else { "This dev container uses features. Install the Dev Containers CLI (npm install -g @devcontainers/cli) and Still will use it." }.into());
        }
        // The image: build the Dockerfile, or use (and pull) the named image.
        let build = value.get("build").cloned().unwrap_or(serde_json::Value::Null);
        let dockerfile = build["dockerfile"].as_str().or(build["dockerFile"].as_str()).or(value["dockerFile"].as_str()).map(String::from);
        let image = if let Some(dockerfile) = dockerfile {
            let context = config_dir.join(build["context"].as_str().or(value["context"].as_str()).unwrap_or("."));
            let tag = format!("still-{}-{}", folder_name(&cwd).to_lowercase().chars().filter(|char| char.is_ascii_alphanumeric() || *char == '-').collect::<String>(), hash(&cwd.to_string_lossy()));
            let mut cmd = command(&docker, &cwd);
            cmd.args(["build", "-t", &tag, "-f"]).arg(config_dir.join(&dockerfile));
            if let Some(args) = build["args"].as_object() { for (key, value) in args { if let Some(value) = value.as_str() { cmd.arg("--build-arg").arg(format!("{key}={value}")); } } }
            if let Some(target) = build["target"].as_str() { cmd.args(["--target", target]); }
            cmd.arg(&context);
            job.emit("command", format!("$ docker build -f {dockerfile}\n"));
            let (code, _) = job.run(&mut cmd, false)?;
            if code != 0 { return Ok((code, Vec::new())) }
            tag
        } else if let Some(image) = value["image"].as_str() {
            let present = command(&docker, &cwd).args(["image", "inspect", image]).output().is_ok_and(|out| out.status.success());
            if !present {
                job.emit("command", format!("$ docker pull {image}\n"));
                let (code, _) = job.run(command(&docker, &cwd).args(["pull", image]), false)?;
                if code != 0 { return Ok((code, Vec::new())) }
            }
            image.to_owned()
        } else {
            return Err("The dev container config names no image or Dockerfile.".into());
        };
        let mut cmd = command(&docker, &cwd);
        cmd.args(["run", "-d", "--label", &label(&cwd), "--label", &format!("still.project={}", folder_name(&cwd))]);
        cmd.arg("--mount").arg(format!("type=bind,source={},target={}", crate::projects::plain(&cwd.to_string_lossy()), workspace));
        cmd.args(["-w", &workspace]);
        if let Some(env) = value["containerEnv"].as_object() { for (key, value) in env { if let Some(value) = value.as_str() { cmd.arg("-e").arg(format!("{key}={value}")); } } }
        for port in value["forwardPorts"].as_array().into_iter().flatten().chain(value["appPort"].as_array().into_iter().flatten()) {
            if let Some(port) = port.as_u64() { cmd.arg("-p").arg(format!("{port}:{port}")); }
            else if let Some(port) = port.as_str().filter(|port| port.chars().all(|char| char.is_ascii_digit() || char == ':')) { cmd.arg("-p").arg(if port.contains(':') { port.to_owned() } else { format!("{port}:{port}") }); }
        }
        if let Some(user) = value["containerUser"].as_str() { cmd.args(["-u", user]); }
        cmd.args(string_list(&value["runArgs"]));
        // Keep the container up with a small loop, unless the config says to run the image's own command.
        let keep = value["overrideCommand"].as_bool().unwrap_or(true);
        if keep { cmd.args(["--entrypoint", "/bin/sh"]); }
        cmd.arg(&image);
        if keep { cmd.args(["-c", "trap 'exit 0' TERM INT; while sleep 1000 & wait $!; do :; done"]); }
        job.emit("command", format!("$ docker run {image} (project mounted at {workspace})\n"));
        let (code, _) = job.run(&mut cmd, false)?;
        if code != 0 { return Ok((code, Vec::new())) }
        let (made, _) = find_container(&docker, &cwd).ok_or("The container started but Docker can't find it.")?;
        lifecycle(job, &docker, &cwd, &made, &workspace, user.as_deref(), &value["onCreateCommand"], "onCreateCommand")?;
        lifecycle(job, &docker, &cwd, &made, &workspace, user.as_deref(), &value["postCreateCommand"], "postCreateCommand")?;
        lifecycle(job, &docker, &cwd, &made, &workspace, user.as_deref(), &value["postStartCommand"], "postStartCommand")?;
        job.emit("stdout", format!("The dev container is running. Runs, tests and new terminals use it.\n"));
        let _ = events.emit("container-changed", ());
        Ok((0, Vec::new()))
    })
}

#[tauri::command]
pub async fn container_stop(app: AppHandle, root_path: String, remove: Option<bool>) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        let docker = docker().ok_or("Docker isn't installed.")?;
        if let Some((id, _)) = find_container(&docker, &cwd) {
            let args: Vec<&str> = if remove.unwrap_or(false) { vec!["rm", "-f", &id] } else { vec!["stop", "-t", "3", &id] };
            let out = command(&docker, &cwd).args(args).output().map_err(err)?;
            if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned()) }
        }
        let _ = app.emit("container-changed", ());
        Ok(())
    }).await.map_err(err)?
}

/// The running container for a project, or why there isn't one.
fn running(cwd: &Path) -> Result<(PathBuf, String, String, Option<String>)> {
    let config = load(cwd).ok_or("This project has no dev container.")?;
    let docker = docker().ok_or("Docker isn't installed.")?;
    let (id, running) = find_container(&docker, cwd).ok_or("The dev container isn't made yet. Start it first (Dev container → Start).")?;
    if !running { return Err("The dev container is stopped. Start it first (Dev container → Start).".into()) }
    let user = config.value["remoteUser"].as_str().map(String::from);
    Ok((docker, id, workspace_folder(&config, cwd), user))
}

fn quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }

/// Runs a file inside the dev container, with input, output and Stop like a local run.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn container_run(app: AppHandle, jobs: State<Jobs>, id: String, root_path: String, path: String, args: Option<String>, env: Option<String>, dotenv: Option<bool>) -> Result<()> {
    let cwd = root(&root_path)?;
    let (docker, container, workspace, user) = running(&cwd)?;
    let rel = relative(&path)?.to_string_lossy().replace('\\', "/");
    let args = parse_args(args)?;
    let vars = project_env(&cwd, dotenv.unwrap_or(true), env.as_deref());
    let extension = path.rsplit_once('.').map(|(_, ext)| ext.to_lowercase()).unwrap_or_default();
    let runner = match extension.as_str() {
        "py" => "python3 -u",
        "js" | "mjs" | "cjs" => "node",
        "ts" | "mts" => "npx --yes tsx",
        "sh" | "bash" => "bash",
        "java" => "java",
        "go" => "go run",
        "rb" => "ruby",
        "rs" => return Err("Rust files run with cargo in the container's terminal for now.".into()),
        _ => return Err("In the dev container Still runs Python, JavaScript, TypeScript, shell, Java, Go and Ruby files.".into()),
    };
    let line = format!("{runner} {}{}", quote(&rel), args.iter().map(|arg| format!(" {}", quote(arg))).collect::<String>());
    jobs.start(app, id, true, move |job| {
        job.emit("command", format!("$ (dev container) {line}\n"));
        let mut cmd = exec_base(&docker, &cwd, &container, &workspace, user.as_deref(), true, &vars);
        cmd.args(["sh", "-c", &line]);
        let (code, _) = job.run(&mut cmd, false)?;
        Ok((code, Vec::new()))
    })
}

/// Runs the tests inside the dev container; results and coverage come back as for a local run.
#[tauri::command]
pub fn container_tests(app: AppHandle, jobs: State<Jobs>, root_path: String, id: String, target: Option<String>, language: String, coverage: Option<bool>) -> Result<()> {
    let cwd = root(&root_path)?;
    let (docker, container, workspace, user) = running(&cwd)?;
    let want = coverage.unwrap_or(false);
    let target = target.filter(|value| !value.trim().is_empty());
    if target.as_deref().is_some_and(|value| value.starts_with('-')) { return Err("Unknown test.".into()) }
    let events = app.clone();
    let report_id = id.clone();
    jobs.start(app, id, true, move |job| {
        let exec = |interactive: bool| exec_base(&docker, &cwd, &container, &workspace, user.as_deref(), interactive, &[]);
        let fetch = |path: &str| -> Option<String> {
            let out = exec(false).args(["cat", path]).output().ok()?;
            out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
        };
        let mut results: Vec<TestResult> = Vec::new();
        let mut found_coverage = None;
        let (code, tool) = if language == "java" {
            let maven = cwd.join("pom.xml").is_file();
            let mut line = if maven { "mvn -q -B".to_owned() } else if cwd.join("gradlew").is_file() { "./gradlew test --console=plain".to_owned() } else { "gradle test --console=plain".to_owned() };
            if maven {
                if want { line += &format!(" {JACOCO}:prepare-agent"); }
                line += " test";
                if want { line += &format!(" {JACOCO}:report -Dmaven.test.failure.ignore=true"); }
                if let Some(value) = &target { line += &format!(" {} -Dsurefire.failIfNoSpecifiedTests=false", quote(&format!("-Dtest={value}"))); }
            } else {
                if want {
                    let script = std::env::temp_dir().join("still-jacoco.gradle");
                    std::fs::write(&script, GRADLE_JACOCO).map_err(err)?;
                    let _ = command(&docker, &cwd).arg("cp").arg(&script).arg(format!("{container}:/tmp/still-jacoco.gradle")).output();
                    line += " --init-script /tmp/still-jacoco.gradle --continue";
                }
                if let Some(value) = &target { line += &format!(" --tests {}", quote(&value.replace('#', "."))); }
            }
            let report_dir = cwd.join(if maven { "target/surefire-reports" } else { "build/test-results/test" });
            let _ = std::fs::remove_dir_all(&report_dir);
            for report in jacoco_reports(&cwd) { let _ = std::fs::remove_file(report); }
            job.emit("command", format!("$ (dev container) {line}\n"));
            let (code, _) = job.run(exec(true).args(["sh", "-c", &line]), false)?;
            // Reports land in the project folder, which is shared with the container.
            for entry in std::fs::read_dir(&report_dir).into_iter().flatten().flatten() {
                if entry.path().extension().is_some_and(|ext| ext == "xml") { if let Ok(xml) = std::fs::read_to_string(entry.path()) { parse_junit(&xml, &mut results); } }
            }
            if want {
                let mut map = std::collections::HashMap::new();
                let sources = java_sources(&cwd);
                for report in jacoco_reports(&cwd) { if let Ok(xml) = std::fs::read_to_string(&report) { parse_jacoco(&xml, &sources, &mut map); } }
                found_coverage = Some(map);
            }
            (code, if maven { "maven" } else { "gradle" })
        } else {
            let has_pytest = exec(false).args(["python3", "-c", "import pytest"]).output().is_ok_and(|out| out.status.success());
            if has_pytest {
                let mut line = "python3 -m pytest -q --tb=short -o junit_family=xunit1 -p no:cacheprovider --junitxml=/tmp/still-pytest.xml".to_owned();
                if want { line += " --cov=. --cov-report=json:/tmp/still-coverage.json --cov-report="; }
                if let Some(value) = &target { line += &format!(" {}", quote(value)); }
                let _ = exec(false).args(["rm", "-f", "/tmp/still-pytest.xml", "/tmp/still-coverage.json"]).output();
                job.emit("command", format!("$ (dev container) {line}\n"));
                let (code, _) = job.run(exec(true).args(["sh", "-c", &line]), false)?;
                if let Some(xml) = fetch("/tmp/still-pytest.xml") { parse_junit(&xml, &mut results); }
                if want { found_coverage = fetch("/tmp/still-coverage.json").map(|json| parse_coverage(&json, Path::new(&workspace))); }
                (code, "pytest")
            } else {
                job.emit("command", "$ (dev container) python3 -m unittest discover -v\n".into());
                let (code, output) = job.run(exec(true).args(["python3", "-m", "unittest", "discover", "-v"]), true)?;
                for line in output.lines() {
                    let Some((head, outcome)) = line.rsplit_once(" ... ") else { continue };
                    let name = head.split(' ').next().unwrap_or("").to_owned();
                    let group = head.split_once('(').map(|(_, group)| group.trim_end_matches(')').to_owned()).unwrap_or_default();
                    let status = match outcome.trim() { "ok" => "passed", "FAIL" => "failed", "ERROR" => "error", other if other.starts_with("skipped") => "skipped", _ => continue };
                    results.push(TestResult { name, group, status: status.into(), ..Default::default() });
                }
                (code, "unittest")
            }
        };
        emit_report(&events, report_id, tool.into(), results, found_coverage);
        Ok((code, Vec::new()))
    })
}

/// The program and arguments for a terminal inside the project's container.
pub fn terminal_command(cwd: &Path) -> Result<(PathBuf, Vec<String>)> {
    let (docker, id, workspace, user) = running(cwd)?;
    let mut args = vec!["exec".to_owned(), "-it".to_owned(), "-w".to_owned(), workspace, "-e".to_owned(), "TERM=xterm-256color".to_owned()];
    if let Some(user) = user { args.push("-u".into()); args.push(user); }
    args.push(id);
    args.extend(["sh".to_owned(), "-c".to_owned(), "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi".to_owned()]);
    Ok((docker, args))
}

#[cfg(test)]
mod check {
    #[test]
    fn reads_jsonc() {
        let text = "{\n  // a comment\n  \"name\": \"web // not a comment\",\n  /* block */ \"image\": \"python:3.12\",\n  \"forwardPorts\": [8000, 5432,],\n}\n";
        let value: serde_json::Value = serde_json::from_str(&super::strip_jsonc(text)).expect("valid JSON");
        assert_eq!(value["name"], "web // not a comment");
        assert_eq!(value["forwardPorts"][1], 5432);
    }
}
