//! Developer tools Still can use when they're installed: formatters (ruff, black,
//! google-java-format, prettier, rustfmt, gofmt), the ruff linter, test runners and
//! language servers. Tools are looked up in the project first (.venv, node_modules),
//! then on PATH. Nothing is bundled; Settings offers one-click installs for Python tools.
use crate::{
    process::{command, python, Jobs},
    workspace::{err, root, Result},
};
use serde::Serialize;
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
};
use tauri::{AppHandle, State};

fn executable(dir: &Path, name: &str) -> Option<PathBuf> {
    let candidates: Vec<String> = if cfg!(windows) { vec![format!("{name}.exe"), format!("{name}.cmd"), format!("{name}.bat")] } else { vec![name.to_owned()] };
    candidates.into_iter().map(|file| dir.join(file)).find(|path| path.is_file())
}

/// Finds a command: the project's virtual environment and node_modules first, then PATH.
pub fn find(cwd: &Path, name: &str) -> Option<PathBuf> {
    let bin = if cfg!(windows) { "Scripts" } else { "bin" };
    for dir in [cwd.join(".venv").join(bin), cwd.join("venv").join(bin), cwd.join("node_modules").join(".bin")] {
        if let Some(found) = executable(&dir, name) {
            return Some(found);
        }
    }
    if let Some(env) = std::env::var_os("VIRTUAL_ENV") {
        if let Some(found) = executable(&PathBuf::from(env).join(bin), name) {
            return Some(found);
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        if let Some(found) = std::env::split_paths(&path).find_map(|dir| executable(&dir, name)) { return Some(found) }
    }
    extra_dirs().iter().find_map(|dir| executable(dir, name))
}

/// Folders that hold tools but may be missing from Still's own PATH. On Windows, PATH as it is
/// now: Still's copy is from when it started, so a tool installed since (MiKTeX, Python, a JDK)
/// wouldn't be found until a restart. On macOS, Homebrew and TeX, which apps opened from the Dock
/// don't get. Read again at most once every 30 seconds.
pub fn extra_dirs() -> Vec<PathBuf> {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    static CACHE: Mutex<Option<(Instant, Vec<PathBuf>)>> = Mutex::new(None);
    if let Ok(cache) = CACHE.lock() {
        if let Some((when, dirs)) = cache.as_ref() { if when.elapsed() < Duration::from_secs(30) { return dirs.clone() } }
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        for key in [r"HKCU\Environment", r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment"] {
            let Ok(out) = command("reg", Path::new(".")).args(["query", key, "/v", "Path"]).output() else { continue };
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            let Some(line) = text.lines().find(|line| line.trim_start().starts_with("Path") || line.trim_start().starts_with("PATH")) else { continue };
            let Some(value) = line.split("REG_EXPAND_SZ").nth(1).or_else(|| line.split("REG_SZ").nth(1)) else { continue };
            // %SystemRoot%, %USERPROFILE%… expanded from the environment.
            let expanded = regex::Regex::new(r"%([^%]+)%").unwrap().replace_all(value.trim(), |found: &regex::Captures| std::env::var(&found[1]).unwrap_or_default()).into_owned();
            dirs.extend(expanded.split(';').filter(|part| !part.trim().is_empty()).map(|part| PathBuf::from(part.trim())));
        }
    }
    #[cfg(target_os = "macos")]
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/Library/TeX/texbin"].map(PathBuf::from));
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        if let Some(home) = std::env::var_os("HOME") { dirs.push(PathBuf::from(home).join(".local").join("bin")); }
    }
    if let Ok(mut cache) = CACHE.lock() { *cache = Some((Instant::now(), dirs.clone())); }
    dirs
}

/// Runs a command with `input` on stdin and returns stdout when it succeeds.
fn pipe(cwd: &Path, program: &Path, args: &[&str], input: &str) -> Option<String> {
    let mut child = command(program, cwd).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let text = input.to_owned();
    let writer = std::thread::spawn(move || { let _ = stdin.write_all(text.as_bytes()); });
    let output = child.wait_with_output().ok()?;
    let _ = writer.join();
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Python tools may only be importable as modules (pip install --user without Scripts on PATH).
fn python_module(cwd: &Path, module: &str) -> Option<PathBuf> {
    let (interpreter, _, _) = python(cwd)?;
    let ok = command(&interpreter, cwd).args(["-c", &format!("import {module}")]).output().ok()?.status.success();
    ok.then_some(interpreter)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Formatted {
    text: Option<String>,
    tool: Option<String>,
    hint: Option<String>,
}

/// How formatters should lay code out (Settings → Formatting). A project's own config file
/// (pyproject.toml, .prettierrc, .clang-format, rustfmt.toml) wins over these.
#[derive(serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct FormatOptions {
    java_style: Option<String>,
    python_line_length: Option<u32>,
    python_indent: Option<u32>,
    python_quotes: Option<String>,
    web_indent: Option<u32>,
    web_tabs: Option<bool>,
    web_semicolons: Option<bool>,
    web_quotes: Option<String>,
    web_print_width: Option<u32>,
    web_trailing_commas: Option<String>,
    c_style: Option<String>,
    c_indent: Option<u32>,
    rust_indent: Option<u32>,
}

fn has_any(cwd: &Path, names: &[&str]) -> bool { names.iter().any(|name| cwd.join(name).is_file()) }
fn pyproject_has(cwd: &Path, table: &str) -> bool {
    std::fs::read_to_string(cwd.join("pyproject.toml")).is_ok_and(|text| text.lines().any(|line| line.trim_start().starts_with(&format!("[{table}"))))
}

/// The command-line options for each formatter from Still's settings (none when the project configures it).
fn ruff_args(cwd: &Path, options: &FormatOptions) -> Vec<String> {
    if has_any(cwd, &["ruff.toml", ".ruff.toml"]) || pyproject_has(cwd, "tool.ruff") { return Vec::new() }
    let mut args = Vec::new();
    if let Some(length) = options.python_line_length.filter(|value| (40..=320).contains(value)) { args.push("--line-length".into()); args.push(length.to_string()); }
    if let Some(indent) = options.python_indent.filter(|value| (1..=8).contains(value)) { args.push("--config".into()); args.push(format!("indent-width = {indent}")); }
    match options.python_quotes.as_deref() {
        Some("single") => { args.push("--config".into()); args.push("format.quote-style = 'single'".into()); }
        Some("preserve") => { args.push("--config".into()); args.push("format.quote-style = 'preserve'".into()); }
        _ => {}
    }
    args
}
fn black_args(cwd: &Path, options: &FormatOptions) -> Vec<String> {
    if pyproject_has(cwd, "tool.black") { return Vec::new() }
    let mut args = Vec::new();
    if let Some(length) = options.python_line_length.filter(|value| (40..=320).contains(value)) { args.push("-l".into()); args.push(length.to_string()); }
    if options.python_quotes.as_deref().is_some_and(|quotes| quotes != "double") { args.push("-S".into()); }
    args
}
fn prettier_args(options: &FormatOptions) -> Vec<String> {
    // A .prettierrc (or "prettier" in package.json) wins; these apply only without one.
    let mut args = vec!["--config-precedence".to_owned(), "prefer-file".to_owned()];
    if let Some(indent) = options.web_indent.filter(|value| (1..=8).contains(value)) { args.push("--tab-width".into()); args.push(indent.to_string()); }
    if options.web_tabs == Some(true) { args.push("--use-tabs".into()); }
    if options.web_semicolons == Some(false) { args.push("--no-semi".into()); }
    if options.web_quotes.as_deref() == Some("single") { args.push("--single-quote".into()); }
    if let Some(width) = options.web_print_width.filter(|value| (40..=320).contains(value)) { args.push("--print-width".into()); args.push(width.to_string()); }
    if let Some(commas) = options.web_trailing_commas.as_deref().filter(|value| matches!(*value, "all" | "es5" | "none")) { args.push("--trailing-comma".into()); args.push(commas.into()); }
    args
}
fn clang_args(cwd: &Path, path: &str, options: &FormatOptions) -> Vec<String> {
    let mut args = vec![format!("--assume-filename={path}")];
    if has_any(cwd, &[".clang-format", "_clang-format"]) { args.push("--style=file".into()); return args }
    let style = options.c_style.as_deref().filter(|value| matches!(*value, "LLVM" | "Google" | "Chromium" | "Mozilla" | "WebKit" | "Microsoft" | "GNU")).unwrap_or("LLVM");
    let indent = options.c_indent.filter(|value| (1..=8).contains(value)).map(|value| format!(", IndentWidth: {value}")).unwrap_or_default();
    args.push(format!("--style={{BasedOnStyle: {style}{indent}}}"));
    args
}

/// Formats source with the formatter for its language. `text` is None when no formatter is installed
/// (then `hint` says what to install) or when the code couldn't be parsed.
#[tauri::command]
pub async fn format_code(root_path: String, path: String, source: String, options: Option<FormatOptions>) -> Result<Formatted> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        let options = options.unwrap_or_default();
        let extension = path.rsplit_once('.').map(|(_, ext)| ext.to_lowercase()).unwrap_or_default();
        let done = |text: Option<String>, tool: &str| Ok(Formatted { text, tool: Some(tool.into()), hint: None });
        let with = |base: &[&str], extra: &[String]| -> Vec<String> { base.iter().map(|item| item.to_string()).chain(extra.iter().cloned()).collect() };
        let run = |program: &Path, args: Vec<String>| { let refs: Vec<&str> = args.iter().map(String::as_str).collect(); pipe(&cwd, program, &refs, &source) };
        match extension.as_str() {
            "py" | "pyi" => {
                let ruff = ruff_args(&cwd, &options);
                if let Some(tool) = find(&cwd, "ruff") { return done(run(&tool, with(&["format"], &ruff).into_iter().chain(["--stdin-filename".into(), path.clone(), "-".into()]).collect()), "ruff") }
                if let Some(interpreter) = python_module(&cwd, "ruff") { return done(run(&interpreter, with(&["-m", "ruff", "format"], &ruff).into_iter().chain(["--stdin-filename".into(), path.clone(), "-".into()]).collect()), "ruff") }
                let black = black_args(&cwd, &options);
                if let Some(tool) = find(&cwd, "black") { return done(run(&tool, with(&["-q"], &black).into_iter().chain(["--stdin-filename".into(), path.clone(), "-".into()]).collect()), "black") }
                if let Some(interpreter) = python_module(&cwd, "black") { return done(run(&interpreter, with(&["-m", "black", "-q"], &black).into_iter().chain(["-".into()]).collect()), "black") }
                Ok(Formatted { text: None, tool: None, hint: Some("Install ruff to format Python (Settings → Editor → Tools).".into()) })
            }
            "java" => match find(&cwd, "google-java-format") {
                // AOSP style indents by 4; Google style by 2.
                Some(tool) => done(run(&tool, if options.java_style.as_deref() == Some("aosp") { vec!["--aosp".into(), "-".into()] } else { vec!["-".into()] }), "google-java-format"),
                None => Ok(Formatted { text: None, tool: None, hint: Some("Install google-java-format to format Java (it must be on PATH).".into()) }),
            },
            "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "json" | "css" | "scss" | "less" | "html" | "vue" | "md" | "yaml" | "yml" => match find(&cwd, "prettier") {
                Some(tool) => done(run(&tool, prettier_args(&options).into_iter().chain(["--stdin-filepath".into(), path.clone()]).collect()), "prettier"),
                None => Ok(Formatted { text: None, tool: None, hint: Some("Install prettier in the project (npm install --save-dev prettier) to format this file.".into()) }),
            },
            "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" | "m" | "mm" => match find(&cwd, "clang-format") {
                Some(tool) => done(run(&tool, clang_args(&cwd, &path, &options)), "clang-format"),
                None => Ok(Formatted { text: None, tool: None, hint: Some("Install clang-format to format C and C++ (it comes with LLVM).".into()) }),
            },
            "rs" => match find(&cwd, "rustfmt") {
                Some(tool) => {
                    let mut args = vec!["--emit".to_owned(), "stdout".to_owned(), "--quiet".to_owned()];
                    if !has_any(&cwd, &["rustfmt.toml", ".rustfmt.toml"]) { if let Some(indent) = options.rust_indent.filter(|value| (1..=8).contains(value)) { args.push("--config".into()); args.push(format!("tab_spaces={indent}")); } }
                    done(run(&tool, args), "rustfmt")
                }
                None => Ok(Formatted { text: None, tool: None, hint: Some("Install rustfmt (rustup component add rustfmt).".into()) }),
            },
            "go" => match find(&cwd, "gofmt") {
                Some(tool) => done(run(&tool, Vec::new()), "gofmt"),
                None => Ok(Formatted { text: None, tool: None, hint: Some("Install Go to get gofmt.".into()) }),
            },
            _ => Ok(Formatted { text: None, tool: None, hint: Some("There's no formatter for this kind of file.".into()) }),
        }
    })
    .await
    .map_err(err)?
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LintIssue {
    pub line: u32,
    pub column: u32,
    pub end_line: Option<u32>,
    pub end_column: Option<u32>,
    pub severity: String,
    pub message: String,
}

/// Ruff's findings for Python source, when ruff is installed.
pub fn ruff_lint(cwd: &Path, path: &str, source: &str) -> Vec<LintIssue> {
    let (program, prefix): (PathBuf, Vec<&str>) = match find(cwd, "ruff") {
        Some(ruff) => (ruff, vec![]),
        None => match python_module(cwd, "ruff") { Some(interpreter) => (interpreter, vec!["-m", "ruff"]), None => return Vec::new() },
    };
    let mut args = prefix;
    args.extend(["check", "--output-format", "json", "--quiet", "--exit-zero", "--stdin-filename", path, "-"]);
    let Some(text) = pipe(cwd, &program, &args, source) else { return Vec::new() };
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&text) else { return Vec::new() };
    items.iter().filter_map(|item| {
        let code = item["code"].as_str().unwrap_or("");
        let message = item["message"].as_str()?.to_owned();
        let at = &item["location"];
        let end = &item["end_location"];
        Some(LintIssue {
            line: at["row"].as_u64()? as u32, column: at["column"].as_u64()? as u32,
            end_line: end["row"].as_u64().map(|value| value as u32), end_column: end["column"].as_u64().map(|value| value as u32),
            // Undefined names and syntax problems are errors; style and unused things are warnings.
            severity: if code.starts_with("F82") || code.starts_with("E9") || code.is_empty() { "error".into() } else { "warning".into() },
            message: if code.is_empty() { message } else { format!("{message} ({code})") },
        })
    }).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    name: String,
    purpose: String,
    found: Option<String>,
    install: Option<String>,
}

/// What's installed, for Settings → Editor → Tools.
#[tauri::command]
pub async fn tools_status(root_path: Option<String>) -> Result<Vec<ToolStatus>> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = match root_path.filter(|path| !path.is_empty()) { Some(path) => root(&path)?, None => std::env::current_dir().map_err(err)? };
        let module = |name: &str| python_module(&cwd, name).map(|_| format!("python -m {name}"));
        let found = |name: &str| find(&cwd, name).map(|path| path.to_string_lossy().into_owned());
        let list = vec![
            ("ruff", "Formats and lints Python", found("ruff").or_else(|| module("ruff")), Some("ruff")),
            ("black", "Formats Python (used when ruff isn't installed)", found("black").or_else(|| module("black")), Some("black")),
            ("pytest", "Runs Python tests", found("pytest").or_else(|| module("pytest")), Some("pytest")),
            ("pyright", "Python language server: types, go to definition, rename", found("pyright-langserver").or_else(|| found("basedpyright-langserver")), Some("pyright")),
            ("google-java-format", "Formats Java", found("google-java-format"), None),
            ("jdtls", "Java language server", found("jdtls"), None),
            ("prettier", "Formats JavaScript, TypeScript, CSS, HTML, Markdown", found("prettier"), None),
            ("typescript-language-server", "JavaScript and TypeScript language server", found("typescript-language-server"), None),
        ];
        Ok(list.into_iter().map(|(name, purpose, found, install)| ToolStatus { name: name.into(), purpose: purpose.into(), found, install: install.map(Into::into) }).collect())
    })
    .await
    .map_err(err)?
}

/// Installs a Python tool with pip (for the project's interpreter), showing progress in Output.
#[tauri::command]
pub fn install_tool(app: AppHandle, jobs: State<Jobs>, root_path: Option<String>, id: String, tool: String) -> Result<()> {
    let package = match tool.as_str() {
        "ruff" | "black" | "pytest" | "pyright" | "jedi-language-server" => tool.clone(),
        _ => return Err("Still can only install Python tools itself.".into()),
    };
    let cwd = match root_path.filter(|path| !path.is_empty()) { Some(path) => root(&path)?, None => std::env::current_dir().map_err(err)? };
    jobs.start(app, id, false, move |job| {
        let (interpreter, _, virtual_env) = python(&cwd).ok_or("Python 3 was not found on PATH or in .venv.")?;
        let mut cmd = command(&interpreter, &cwd);
        cmd.args(["-m", "pip", "install", "--upgrade"]);
        if !virtual_env { cmd.arg("--user"); }
        cmd.arg(&package);
        job.emit("command", format!("$ python -m pip install {package}\n"));
        let (code, _) = job.run(&mut cmd, false)?;
        Ok((code, Vec::new()))
    })
}
