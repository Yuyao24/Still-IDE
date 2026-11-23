use crate::workspace::{err, relative, resolve, root, Result};
use regex::Regex;
use serde::Serialize;
use std::{
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

pub fn command(program: impl AsRef<std::ffi::OsStr>, cwd: &Path) -> Command {
    let mut command = Command::new(program);
    command.current_dir(cwd).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

pub fn check(output: Output) -> Result<Output> {
    if output.status.success() {
        Ok(output)
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        Err(if message.is_empty() {
            format!("Command ended with {}.", output.status)
        } else {
            message
        })
    }
}

fn probe(program: &Path, args: &[&str], cwd: &Path) -> Option<String> {
    let mut child = command(program, cwd)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(16)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let result = child.wait_with_output().ok()?;
    if !result.status.success() {
        return None;
    }
    let bytes = if result.stdout.is_empty() {
        result.stderr
    } else {
        result.stdout
    };
    Some(
        String::from_utf8_lossy(&bytes)
            .lines()
            .next()?
            .trim()
            .to_owned(),
    )
}

fn venv_python(path: &Path) -> PathBuf {
    if cfg!(windows) {
        path.join("Scripts/python.exe")
    } else {
        path.join("bin/python")
    }
}

pub fn python(cwd: &Path) -> Option<(PathBuf, String, bool)> {
    let mut envs = vec![cwd.join(".venv")];
    if let Some(path) = std::env::var_os("VIRTUAL_ENV") {
        envs.push(PathBuf::from(path));
    }
    for env in envs {
        let path = venv_python(&env);
        if path.is_file() {
            if let Some(version) = probe(&path, &["--version"], cwd) {
                return Some((path, version, true));
            }
        }
    }
    let names = if cfg!(windows) {
        ["python", "python3"]
    } else {
        ["python3", "python"]
    };
    for name in names {
        let path = PathBuf::from(name);
        if let Some(version) =
            probe(&path, &["--version"], cwd).filter(|version| version.starts_with("Python 3."))
        {
            return Some((path, version, false));
        }
    }
    None
}

fn java(cwd: &Path) -> Option<(PathBuf, PathBuf, String)> {
    let suffix = std::env::consts::EXE_SUFFIX;
    let path = |name: &str| PathBuf::from(format!("{name}{suffix}"));
    let options = std::env::var_os("JAVA_HOME")
        .map(PathBuf::from)
        .into_iter()
        .map(|home| {
            (
                home.join("bin").join(path("javac")),
                home.join("bin").join(path("java")),
            )
        })
        .chain([(path("javac"), path("java"))]);
    for (javac, java) in options {
        if let Some(version) = probe(&javac, &["-version"], cwd) {
            if probe(&java, &["-version"], cwd).is_some() {
                return Some((javac, java, version.replacen("javac", "Java", 1)));
            }
        }
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    python: Option<String>,
    python_venv: bool,
    java: Option<String>,
    shell: String,
}

pub fn shell() -> OsString {
    if cfg!(windows) {
        if let Some(base) = std::env::var_os("SystemRoot") {
            return PathBuf::from(base)
                .join("System32/WindowsPowerShell/v1.0/powershell.exe")
                .into_os_string();
        }
        return "powershell.exe".into();
    }
    std::env::var_os("SHELL")
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| "/bin/bash".into())
}

#[tauri::command]
pub async fn detect_runtimes(root_path: String) -> Result<RuntimeInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        let interpreter = python(&cwd);
        Ok(RuntimeInfo {
            python_venv: interpreter.as_ref().is_some_and(|(_, _, venv)| *venv),
            python: interpreter.map(|(_, version, _)| version),
            java: java(&cwd).map(|(_, _, version)| version),
            shell: Path::new(&shell())
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        })
    })
    .await
    .map_err(err)?
}

#[derive(Clone, Serialize)]
pub struct Diagnostic {
    path: String,
    line: usize,
    column: usize,
    severity: String,
    message: String,
}

#[derive(Clone, Serialize)]
struct JobEvent {
    id: String,
    kind: &'static str,
    text: String,
    code: Option<i32>,
    diagnostics: Vec<Diagnostic>,
}

fn emit(
    app: &AppHandle,
    id: &str,
    kind: &'static str,
    text: String,
    code: Option<i32>,
    diagnostics: Vec<Diagnostic>,
) {
    let _ = app.emit(
        "job-output",
        JobEvent {
            id: id.into(),
            kind,
            text,
            code,
            diagnostics,
        },
    );
}

type ActiveJob = Option<(String, Arc<AtomicBool>)>;

#[derive(Default, Clone)]
pub struct Jobs(Arc<Mutex<ActiveJob>>);

impl Jobs {
    pub fn stop(&self, id: Option<&str>) -> Result<()> {
        if let Some((active_id, cancelled)) = self.0.lock().map_err(err)?.as_ref() {
            if id.is_none() || id == Some(active_id.as_str()) {
                cancelled.store(true, Ordering::Relaxed);
            }
        }
        Ok(())
    }

    pub fn start<F>(&self, app: AppHandle, id: String, operation: F) -> Result<()>
    where
        F: FnOnce(&Job) -> Result<(i32, Vec<Diagnostic>)> + Send + 'static,
    {
        let mut active = self.0.lock().map_err(err)?;
        if active.is_some() {
            return Err("A process is already running.".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some((id.clone(), cancelled.clone()));
        let state = self.clone();
        thread::spawn(move || {
            let job = Job { app, id, cancelled };
            let (code, diagnostics) = match operation(&job) {
                Ok(result) => result,
                Err(error) => {
                    job.emit("stderr", format!("{error}\n"));
                    (1, Vec::new())
                }
            };
            if let Ok(mut active) = state.0.lock() {
                *active = None;
            }
            let ended = if job.cancelled.load(Ordering::Relaxed) {
                "Process stopped.".into()
            } else {
                format!("Process exited with code {code}.")
            };
            emit(&job.app, &job.id, "exit", ended, Some(code), diagnostics);
        });
        Ok(())
    }
}

pub struct Job {
    app: AppHandle,
    id: String,
    cancelled: Arc<AtomicBool>,
}

fn stream(mut reader: impl Read, job: &Job, kind: &'static str, capture: bool) -> String {
    let mut captured = String::new();
    let mut buffer = [0u8; 8192];
    let mut pending = Vec::new();
    while let Ok(size) = reader.read(&mut buffer) {
        if size == 0 {
            break;
        }
        pending.extend_from_slice(&buffer[..size]);
        // Hold an incomplete UTF-8 sequence across pipe reads.
        let end = match std::str::from_utf8(&pending) {
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            _ => pending.len(),
        };
        let chunk = String::from_utf8_lossy(&pending[..end]);
        if !chunk.is_empty() {
            job.emit(kind, chunk.to_string());
            if capture && captured.len() < 512 * 1024 {
                captured.push_str(&chunk);
            }
        }
        pending.drain(..end);
    }
    if !pending.is_empty() {
        job.emit(kind, String::from_utf8_lossy(&pending).into_owned());
    }
    captured
}

impl Job {
    pub fn emit(&self, kind: &'static str, text: String) {
        emit(&self.app, &self.id, kind, text, None, Vec::new());
    }

    pub fn run(&self, cmd: &mut Command, capture_stderr: bool) -> Result<(i32, String)> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Ok((130, String::new()));
        }
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(err)?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        thread::scope(|scope| {
            scope.spawn(move || stream(stdout, self, "stdout", false));
            let captured = scope.spawn(move || stream(stderr, self, "stderr", capture_stderr));
            let code = loop {
                if self.cancelled.load(Ordering::Relaxed) {
                    let _ = child.kill();
                    let _ = child.wait();
                    break 130;
                }
                if let Some(status) = child.try_wait().map_err(err)? {
                    break status.code().unwrap_or(1);
                }
                thread::sleep(Duration::from_millis(22));
            };
            Ok((code, captured.join().unwrap_or_default()))
        })
    }
}

fn java_diagnostics(output: &str, cwd: &Path, active: &str) -> Vec<Diagnostic> {
    let pattern = Regex::new(r"^(.+\.java):(\d+):\s*(error|warning):\s*(.+)$")
        .expect("valid Java diagnostic pattern");
    let mut diagnostics = Vec::<Diagnostic>::new();
    for line in output.lines() {
        if let Some(found) = pattern.captures(line) {
            let source = Path::new(&found[1]);
            let source = if source.is_absolute() {
                source.strip_prefix(cwd).unwrap_or(source)
            } else {
                source
            };
            let path = if source.is_absolute() {
                active.into()
            } else {
                let path = source.to_string_lossy().replace('\\', "/");
                path.trim_start_matches("./").to_owned()
            };
            diagnostics.push(Diagnostic {
                path,
                line: found[2].parse().unwrap_or(1),
                column: 1,
                severity: found[3].into(),
                message: found[4].into(),
            });
        } else if line.trim() == "^" {
            if let Some(last) = diagnostics.last_mut() {
                last.column = line.find('^').unwrap_or(0) + 1;
            }
        }
    }
    diagnostics
}

fn run_java(
    job: &Job,
    cwd: &Path,
    file: &Path,
    path: &str,
    build_only: bool,
) -> Result<(i32, Vec<Diagnostic>)> {
    let (compiler, runtime, _) =
        java(cwd).ok_or("Install a JDK with both javac and java on PATH or set JAVA_HOME.")?;
    let source = std::fs::read_to_string(file).map_err(err)?;
    let uncommented = Regex::new(r"(?s)/\*.*?\*/|//[^\r\n]*")
        .unwrap()
        .replace_all(&source, "");
    let package = Regex::new(r"(?m)^\s*package\s+([\w$.]+)\s*;")
        .unwrap()
        .captures(&uncommented)
        .map(|found| found[1].to_string());
    std::fs::create_dir_all(cwd.join("bin")).map_err(err)?;
    resolve(cwd, "bin")?;
    let filename = file
        .file_stem()
        .ok_or("Java source is missing its class name.")?
        .to_string_lossy();
    let class = package
        .as_ref()
        .map_or_else(|| filename.to_string(), |pkg| format!("{pkg}.{filename}"));
    let input = relative(path)?;
    let mut source_root = input.parent().unwrap_or(Path::new(""));
    for _ in package
        .as_deref()
        .into_iter()
        .flat_map(|name| name.split('.'))
    {
        source_root = source_root.parent().unwrap_or(source_root);
    }
    let source_root = if source_root.as_os_str().is_empty() {
        Path::new(".")
    } else {
        source_root
    };
    let source_paths = std::env::join_paths([
        source_root,
        Path::new("src"),
        Path::new("src/main/java"),
        Path::new("."),
    ])
    .map_err(err)?;
    job.emit("command", format!("$ javac -d bin {path}\n"));
    let (code, output) = job.run(
        command(compiler, cwd)
            .args([
                "-J-Dfile.encoding=UTF-8",
                "-J-Duser.language=en",
                "-encoding",
                "UTF-8",
                "-d",
                "bin",
                "-classpath",
                "bin",
                "-sourcepath",
            ])
            .arg(source_paths)
            .arg(Path::new(".").join(input)),
        true,
    )?;
    let diagnostics = java_diagnostics(&output, cwd, path);
    if code != 0 || build_only {
        return Ok((code, diagnostics));
    }
    job.emit("command", format!("$ java -cp bin {class}\n"));
    let (code, _) = job.run(
        command(runtime, cwd).args(["-Dfile.encoding=UTF-8", "-cp", "bin", &class]),
        false,
    )?;
    Ok((code, diagnostics))
}

#[tauri::command]
pub fn run_file(
    app: AppHandle,
    jobs: State<Jobs>,
    root_path: String,
    path: String,
    id: String,
    build_only: bool,
) -> Result<()> {
    let cwd = root(&root_path)?;
    let file = resolve(&cwd, &path)?;
    if !file.is_file() {
        return Err("Select a source file to run.".into());
    }
    jobs.start(app, id, move |job| {
        match file.extension().and_then(|part| part.to_str()) {
            Some("py") => {
                let (program, _, _) =
                    python(&cwd).ok_or("Python 3 was not found on PATH or in .venv.")?;
                let mut cmd = command(program, &cwd);
                cmd.env("PYTHONIOENCODING", "utf-8");
                if build_only {
                    job.emit("command", format!("$ python -m py_compile {path}\n"));
                    cmd.args(["-m", "py_compile"]);
                } else {
                    job.emit("command", format!("$ python -u {path}\n"));
                    cmd.arg("-u");
                }
                let input = Path::new(".").join(relative(&path)?);
                let (code, _) = job.run(cmd.arg(input), false)?;
                Ok((code, Vec::new()))
            }
            Some("java") => run_java(job, &cwd, &file, &path, build_only),
            _ => Err("Run supports Python and Java files.".into()),
        }
    })
}

#[tauri::command]
pub fn stop_job(jobs: State<Jobs>, id: String) -> Result<()> {
    jobs.stop(Some(&id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javac_diagnostics_use_workspace_paths() {
        let output = ".\\src\\Main.java:4: error: cannot find symbol\n        absent();\n        ^\n./src/Helper.java:8: warning: use of deprecated API";
        let items = java_diagnostics(output, Path::new("."), "src/Main.java");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].path, "src/Main.java");
        assert_eq!(items[0].line, 4);
        assert_eq!(items[0].column, 9);
        assert_eq!(items[1].path, "src/Helper.java");
        assert_eq!(items[1].severity, "warning");
    }
}
