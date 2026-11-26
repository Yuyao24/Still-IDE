use crate::workspace::{err, relative, resolve, root, Result};
use regex::Regex;
use serde::Serialize;
use std::{
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{ChildStdin, Command, Output, Stdio},
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
    let mut envs = vec![cwd.join(".venv"), cwd.join("venv")];
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

pub fn node(cwd: &Path) -> Option<(PathBuf, String)> {
    let path = PathBuf::from(format!("node{}", std::env::consts::EXE_SUFFIX));
    probe(&path, &["--version"], cwd).map(|version| (path, format!("Node {}", version.trim_start_matches('v'))))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    python: Option<String>,
    python_venv: bool,
    java: Option<String>,
    node: Option<String>,
    git: Option<String>,
    ssh: Option<String>,
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
            node: node(&cwd).map(|(_, version)| version),
            git: probe(Path::new("git"), &["--version"], &cwd),
            ssh: probe(Path::new("ssh"), &["-V"], &cwd),
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

pub type Input = Arc<Mutex<Option<ChildStdin>>>;
type ActiveJob = Option<(String, Arc<AtomicBool>, Input)>;

#[derive(Default, Clone)]
pub struct Jobs(Arc<Mutex<ActiveJob>>);

impl Jobs {
    pub fn stop(&self, id: Option<&str>) -> Result<()> {
        if let Some((active_id, cancelled, _)) = self.0.lock().map_err(err)?.as_ref() {
            if id.is_none() || id == Some(active_id.as_str()) {
                cancelled.store(true, Ordering::Relaxed);
            }
        }
        Ok(())
    }

    pub fn input(&self, id: &str, text: Option<&str>) -> Result<()> {
        let input = match self.0.lock().map_err(err)?.as_ref() {
            Some((active_id, _, input)) if active_id == id => input.clone(),
            _ => return Err("The process is no longer running.".into()),
        };
        let mut slot = input.lock().map_err(err)?;
        match text {
            Some(text) => {
                let stdin = slot.as_mut().ok_or("This process does not accept input.")?;
                stdin.write_all(text.as_bytes()).and_then(|_| stdin.flush()).map_err(err)
            }
            None => {
                slot.take();
                Ok(())
            }
        }
    }

    pub fn start<F>(&self, app: AppHandle, id: String, interactive: bool, operation: F) -> Result<()>
    where
        F: FnOnce(&Job) -> Result<(i32, Vec<Diagnostic>)> + Send + 'static,
    {
        let mut active = self.0.lock().map_err(err)?;
        if active.is_some() {
            return Err("A process is already running.".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let input: Input = Arc::default();
        *active = Some((id.clone(), cancelled.clone(), input.clone()));
        let state = self.clone();
        thread::spawn(move || {
            let job = Job { app, id, cancelled, interactive, input, env: Mutex::new(Vec::new()) };
            let started = std::time::Instant::now();
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
            // How long it took, as people read it: 0.42 s, 12.3 s, 2 min 5 s.
            let elapsed = started.elapsed().as_secs_f64();
            let took = if elapsed < 10.0 { format!("{elapsed:.2} s") } else if elapsed < 60.0 { format!("{elapsed:.1} s") } else { format!("{} min {} s", (elapsed / 60.0).floor(), (elapsed % 60.0).round()) };
            let ended = if job.cancelled.load(Ordering::Relaxed) {
                format!("Process stopped after {took}.")
            } else {
                format!("Process exited with code {code} in {took}.")
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
    interactive: bool,
    input: Input,
    /// Environment variables for every program this job starts (the project's .env and the run's own).
    env: Mutex<Vec<(String, String)>>,
}

/// Variables from a .env file (KEY=VALUE lines; `export`, comments and quotes allowed) and from
/// the run configuration (same format), the run configuration winning.
pub fn project_env(cwd: &Path, dotenv: bool, extra: Option<&str>) -> Vec<(String, String)> {
    let parse = |text: &str| -> Vec<(String, String)> {
        text.lines().filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') { return None }
            let line = line.strip_prefix("export ").unwrap_or(line);
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            if key.is_empty() || !key.chars().all(|char| char.is_ascii_alphanumeric() || char == '_') { return None }
            let value = value.trim();
            let value = if value.len() >= 2 && ((value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\''))) { &value[1..value.len() - 1] } else { value.split(" #").next().unwrap_or(value).trim() };
            Some((key.to_owned(), value.replace("\\n", "\n")))
        }).collect()
    };
    let mut vars = if dotenv { std::fs::read_to_string(cwd.join(".env")).map(|text| parse(&text)).unwrap_or_default() } else { Vec::new() };
    if let Some(extra) = extra { vars.extend(parse(extra)); }
    vars
}

pub fn stream(mut reader: impl Read, job: &Job, kind: &'static str, capture: bool) -> String {
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
    /// Where typed input for the running program goes (a runner that spawns its own process fills it).
    pub fn input_slot(&self) -> Input {
        self.input.clone()
    }

    pub fn use_env(&self, vars: Vec<(String, String)>) {
        if let Ok(mut env) = self.env.lock() { *env = vars; }
    }

    pub fn env_vars(&self) -> Vec<(String, String)> {
        self.env.lock().map(|env| env.clone()).unwrap_or_default()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    pub fn emit(&self, kind: &'static str, text: String) {
        emit(&self.app, &self.id, kind, text, None, Vec::new());
    }

    pub fn run(&self, cmd: &mut Command, capture_stderr: bool) -> Result<(i32, String)> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Ok((130, String::new()));
        }
        if self.interactive {
            cmd.stdin(Stdio::piped());
        }
        for (key, value) in self.env_vars() {
            cmd.env(key, value);
        }
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => format!("{} was not found. Install it or add it to PATH.", cmd.get_program().to_string_lossy()),
                _ => err(error),
            })?;
        if let (Some(stdin), Ok(mut slot)) = (child.stdin.take(), self.input.lock()) {
            *slot = Some(stdin);
        }
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
            if let Ok(mut slot) = self.input.lock() {
                slot.take();
            }
            Ok((code, captured.join().unwrap_or_default()))
        })
    }
}

pub(crate) fn java_diagnostics(output: &str, cwd: &Path, active: &str) -> Vec<Diagnostic> {
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

pub struct CompiledJava {
    pub code: i32,
    pub diagnostics: Vec<Diagnostic>,
    pub class: String,
    pub source_paths: std::ffi::OsString,
    pub compiler: PathBuf,
    pub runtime: PathBuf,
}

/// Compiles a Java file (and the sources it uses) into `bin`. `debug` keeps local variable names.
pub fn compile_java(job: &Job, cwd: &Path, file: &Path, path: &str, debug: bool) -> Result<CompiledJava> {
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
    job.emit("command", format!("$ javac{} -d bin {path}\n", if debug { " -g" } else { "" }));
    let mut cmd = command(&compiler, cwd);
    cmd.args([
        "-J-Dfile.encoding=UTF-8",
        "-J-Duser.language=en",
        "-encoding",
        "UTF-8",
        "-d",
        "bin",
        "-classpath",
        "bin",
    ]);
    if debug {
        cmd.arg("-g");
    }
    let (code, output) = job.run(cmd.arg("-sourcepath").arg(&source_paths).arg(Path::new(".").join(input)), true)?;
    let diagnostics = java_diagnostics(&output, cwd, path);
    Ok(CompiledJava { code, diagnostics, class, source_paths, compiler, runtime })
}

fn run_java(
    job: &Job,
    cwd: &Path,
    file: &Path,
    path: &str,
    build_only: bool,
    args: &[String],
) -> Result<(i32, Vec<Diagnostic>)> {
    let compiled = compile_java(job, cwd, file, path, false)?;
    if compiled.code != 0 || build_only {
        return Ok((compiled.code, compiled.diagnostics));
    }
    let class = compiled.class;
    job.emit("command", format!("$ java -cp bin {class}{}\n", display_args(args)));
    let (code, _) = job.run(
        command(compiled.runtime, cwd).args(["-Dfile.encoding=UTF-8", "-cp", "bin", &class]).args(args),
        false,
    )?;
    Ok((code, compiled.diagnostics))
}

fn display_args(args: &[String]) -> String {
    if args.is_empty() {
        String::new()
    } else {
        format!(" {}", shell_words::join(args))
    }
}

pub fn parse_args(args: Option<String>) -> Result<Vec<String>> {
    match args.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => shell_words::split(value).map_err(|_| "Check the quotes in the program arguments.".into()),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn run_file(
    app: AppHandle,
    jobs: State<Jobs>,
    root_path: String,
    path: String,
    id: String,
    build_only: bool,
    args: Option<String>,
    env: Option<String>,
    dotenv: Option<bool>,
) -> Result<()> {
    let cwd = root(&root_path)?;
    let file = resolve(&cwd, &path)?;
    if !file.is_file() {
        return Err("Select a source file to run.".into());
    }
    let args = parse_args(args)?;
    let vars = project_env(&cwd, dotenv.unwrap_or(true), env.as_deref());
    jobs.start(app, id, true, move |job| {
        job.use_env(vars);
        let input = Path::new(".").join(relative(&path)?);
        let extension = file.extension().and_then(|part| part.to_str()).unwrap_or_default().to_lowercase();
        match extension.as_str() {
            "py" => {
                let (program, _, _) =
                    python(&cwd).ok_or("Python 3 was not found on PATH or in .venv.")?;
                let mut cmd = command(program, &cwd);
                cmd.env("PYTHONIOENCODING", "utf-8");
                if build_only {
                    job.emit("command", format!("$ python -m py_compile {path}\n"));
                    cmd.args(["-m", "py_compile"]);
                } else {
                    job.emit("command", format!("$ python -u {path}{}\n", display_args(&args)));
                    cmd.arg("-u");
                }
                cmd.arg(input);
                if !build_only {
                    cmd.args(&args);
                }
                let (code, _) = job.run(&mut cmd, false)?;
                Ok((code, Vec::new()))
            }
            "java" => run_java(job, &cwd, &file, &path, build_only, &args),
            "js" | "mjs" | "cjs" => {
                let (program, _) = node(&cwd).ok_or("Node.js was not found on PATH.")?;
                let mut cmd = command(program, &cwd);
                if build_only {
                    job.emit("command", format!("$ node --check {path}\n"));
                    cmd.arg("--check").arg(input);
                } else {
                    job.emit("command", format!("$ node {path}{}\n", display_args(&args)));
                    cmd.arg(input).args(&args);
                }
                let (code, _) = job.run(&mut cmd, false)?;
                Ok((code, Vec::new()))
            }
            "sh" | "bash" if !cfg!(windows) => {
                let mut cmd = command("bash", &cwd);
                if build_only {
                    job.emit("command", format!("$ bash -n {path}\n"));
                    cmd.arg("-n").arg(input);
                } else {
                    job.emit("command", format!("$ bash {path}{}\n", display_args(&args)));
                    cmd.arg(input).args(&args);
                }
                let (code, _) = job.run(&mut cmd, false)?;
                Ok((code, Vec::new()))
            }
            "go" => {
                let mut cmd = command("go", &cwd);
                if build_only {
                    job.emit("command", format!("$ go vet {path}\n"));
                    cmd.arg("vet").arg(input);
                } else {
                    job.emit("command", format!("$ go run {path}{}\n", display_args(&args)));
                    cmd.arg("run").arg(input).args(&args);
                }
                let (code, _) = job.run(&mut cmd, false)?;
                Ok((code, Vec::new()))
            }
            _ => Err("Run supports Python, Java, JavaScript, Go, and shell files.".into()),
        }
    })
}

#[tauri::command]
pub fn job_input(jobs: State<Jobs>, id: String, text: Option<String>) -> Result<()> {
    jobs.input(&id, text.as_deref())
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
