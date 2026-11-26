//! Debugging Java files through jdb, which ships with every JDK. Still compiles with `-g`,
//! starts jdb, and turns its text into the same events the Python debugger sends (stopped,
//! eval, ended), so the Debug panel works the same for both languages.
use crate::process::{compile_java, Job};
use crate::workspace::{err, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::Path,
    process::{ChildStdin, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

/// What jdb printed: a whole line, or a prompt (`> ` while running, `main[1] ` when paused).
enum Out {
    Line(String),
    Prompt(String),
    Closed,
}

fn reader(mut stdout: impl Read + Send + 'static) -> Receiver<Out> {
    let (sender, receiver) = mpsc::channel();
    let prompt = Regex::new(r"^(> |[\w$.\-]+\[\d+\] )$").unwrap();
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut pending = String::new();
        let mut bytes = Vec::new();
        loop {
            let size = match stdout.read(&mut buffer) { Ok(0) | Err(_) => break, Ok(size) => size };
            bytes.extend_from_slice(&buffer[..size]);
            let end = match std::str::from_utf8(&bytes) { Err(error) if error.error_len().is_none() => error.valid_up_to(), _ => bytes.len() };
            pending.push_str(&String::from_utf8_lossy(&bytes[..end]));
            bytes.drain(..end);
            while let Some(at) = pending.find('\n') {
                let line = pending[..at].trim_end_matches('\r').to_owned();
                pending.drain(..=at);
                let _ = sender.send(Out::Line(line));
            }
            // A prompt has no newline after it; it is the whole of what's left once jdb goes quiet.
            if prompt.is_match(&pending) {
                let text = std::mem::take(&mut pending);
                let _ = sender.send(Out::Prompt(text));
            }
        }
        if !pending.is_empty() { let _ = sender.send(Out::Line(pending)); }
        let _ = sender.send(Out::Closed);
    });
    receiver
}

struct Session<'a> {
    job: &'a Job,
    app: AppHandle,
    id: String,
    stdin: ChildStdin,
    out: Receiver<Out>,
    /// Project-relative paths of the Java sources, for turning classes into files.
    sources: Vec<String>,
    /// Reads a project file (from disk, or from the server over SSH).
    read: Box<dyn Fn(&str) -> String + 'a>,
    /// The frame jdb has selected (1 is the innermost).
    jdb_frame: usize,
    stack: Vec<(String, String, u32)>,
    watches: Vec<String>,
    breakpoints: Vec<(String, u32)>,
    /// Conditions and log messages, by file and line.
    options: std::collections::HashMap<(String, u32), (Option<String>, Option<String>)>,
    reason: String,
    detail: String,
    ended: bool,
}

impl Session<'_> {
    fn send(&mut self, line: &str) -> Result<()> {
        self.stdin.write_all(format!("{line}\n").as_bytes()).and_then(|_| self.stdin.flush()).map_err(err)
    }

    /// Program output and jdb's own notices; a line that starts with the running prompt has it removed.
    fn output(&self, line: &str) {
        let text = line.strip_prefix("> ").unwrap_or(line);
        let text = text.strip_prefix("VM Started: ").unwrap_or(text);
        let notice = ["Set breakpoint ", "Removed: breakpoint", "Deferring ", "It will be set after", "Set uncaught ", "Set deferred ", "Initializing jdb", "run "];
        if text == ">" || text.is_empty() && line.starts_with("VM Started") || notice.iter().any(|prefix| text.starts_with(prefix)) {
            return;
        }
        self.job.emit("stdout", format!("{text}\n"));
    }

    /// Sends a command while paused and collects what it printed up to the next prompt.
    fn ask(&mut self, line: &str) -> Result<Vec<String>> {
        self.send(line)?;
        let mut lines = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            match self.out.recv_timeout(Duration::from_millis(200)) {
                Ok(Out::Line(text)) => lines.push(text),
                Ok(Out::Prompt(_)) => return Ok(lines),
                Ok(Out::Closed) => { self.ended = true; return Ok(lines) }
                Err(RecvTimeoutError::Timeout) if Instant::now() < deadline && !self.job.is_cancelled() => {}
                Err(_) => return Ok(lines),
            }
        }
    }

    fn class_for(&self, path: &str) -> String {
        let source = (self.read)(path);
        let package = Regex::new(r"(?m)^\s*package\s+([\w$.]+)\s*;").unwrap().captures(&source).map(|found| found[1].to_owned());
        let stem = Path::new(path).file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
        package.map_or(stem.clone(), |package| format!("{package}.{stem}"))
    }

    /// The project file a class came from, using its package as folders and jdb's file name.
    fn file_for(&self, class: &str, file: &str) -> Option<String> {
        let outer = class.split('$').next().unwrap_or(class);
        let folder = outer.rsplit_once('.').map(|(package, _)| package.replace('.', "/"));
        let wanted = match folder { Some(folder) => format!("{folder}/{file}"), None => file.to_owned() };
        self.sources.iter().find(|path| *path == &wanted || path.ends_with(&format!("/{wanted}"))).cloned()
    }

    fn parse_stack(&mut self, lines: &[String]) {
        // "  [1] demo.Main.square (Main.java:8)"
        let pattern = Regex::new(r"^\s*\[(\d+)\]\s+([\w$.<>]+)\s+\((?:([\w$]+\.java):(\d+)|[^)]*)\)").unwrap();
        self.stack = lines.iter().filter_map(|line| {
            let found = pattern.captures(line)?;
            let full = found[2].to_owned();
            let (class, method) = full.rsplit_once('.').map(|(class, method)| (class.to_owned(), method.to_owned())).unwrap_or((full.clone(), String::new()));
            let file = found.get(3).and_then(|file| self.file_for(&class, file.as_str())).unwrap_or_default();
            let line = found.get(4).and_then(|line| line.as_str().parse().ok()).unwrap_or(0);
            let short = class.rsplit('.').next().unwrap_or(&class).to_owned();
            Some((format!("{short}.{method}"), file, line))
        }).collect();
    }

    fn describe(&mut self, name: &str, value: &str) -> Value {
        let value = value.trim();
        let (kind, mut text) = if let Some(rest) = value.strip_prefix("instance of ") {
            let kind = rest.split(['(', ' ']).next().unwrap_or(rest).trim().to_owned();
            (kind, value.to_owned())
        } else if value.starts_with('"') {
            ("String".to_owned(), value.to_owned())
        } else if value == "true" || value == "false" {
            ("boolean".to_owned(), value.to_owned())
        } else if value == "null" {
            (String::new(), value.to_owned())
        } else if value.parse::<i64>().is_ok() {
            ("int".to_owned(), value.to_owned())
        } else if value.parse::<f64>().is_ok() {
            ("double".to_owned(), value.to_owned())
        } else if value.starts_with('\'') {
            ("char".to_owned(), value.to_owned())
        } else {
            (String::new(), value.to_owned())
        };
        let mut size = String::new();
        if value.starts_with("instance of ") {
            if let Some(found) = Regex::new(r"\[(\d+)\]").unwrap().captures(&kind) { size = found[1].to_owned(); }
            // Arrays and plain objects read better as their contents; others through toString().
            let array = kind.contains('[');
            let printed = if array { None } else { self.ask(&format!("print {name}")).ok().and_then(|lines| lines.iter().find_map(|line| line.trim().strip_prefix(&format!("{name} = ")).map(str::to_owned))) };
            let default_string = printed.as_deref().is_some_and(|text| Regex::new(r#"^"?[\w$.]+@[0-9a-f]+"?$"#).unwrap().is_match(text));
            text = match printed {
                // toString() comes back quoted; a list or map reads better without the quotes.
                Some(printed) if !default_string => if kind != "java.lang.String" && printed.len() >= 2 && printed.starts_with('"') && printed.ends_with('"') { printed[1..printed.len() - 1].to_owned() } else { printed },
                _ => {
                    let dumped = self.ask(&format!("dump {name}")).unwrap_or_default();
                    let body: Vec<String> = dumped.iter().map(|line| line.trim().to_owned()).filter(|line| !line.is_empty() && !line.ends_with(" = {") && line != "}").collect();
                    if body.is_empty() { if array { "[]".to_owned() } else { text } } else if array { format!("[{}]", body.join(" ").trim_end_matches(',')) } else { format!("{{{}}}", body.join(", ")) }
                }
            };
            if kind.starts_with("java.util.") && size.is_empty() {
                if let Some(count) = self.ask(&format!("print {name}.size()")).ok().and_then(|lines| lines.iter().find_map(|line| line.trim().split_once(" = ").map(|(_, value)| value.to_owned()))) {
                    if count.parse::<u64>().is_ok() { size = count; }
                }
            }
        }
        let short = kind.rsplit('.').next().unwrap_or(&kind).to_owned();
        let text: String = text.chars().take(400).collect();
        json!({ "name": name, "type": short, "value": text, "size": size })
    }

    fn evaluate(&mut self, expression: &str) -> (String, bool) {
        let lines = self.ask(&format!("print {expression}")).unwrap_or_default();
        if let Some(error) = lines.iter().find(|line| line.contains("Exception:") || line.starts_with("Name unknown") || line.contains("ParseException")) {
            let message = error.rsplit_once(": ").map(|(_, message)| message).unwrap_or(error);
            return (message.trim().to_owned(), false);
        }
        let value = lines.iter().find_map(|line| line.trim().strip_prefix(&format!("{expression} = ")).map(str::to_owned)).or_else(|| lines.iter().find_map(|line| line.split_once(" = ").map(|(_, value)| value.to_owned())));
        match value { Some(value) => (value, true), None => (lines.join(" ").trim().to_owned(), false) }
    }

    /// Reads the stack, variables and watches, and tells the window the program is paused.
    fn report(&mut self, frame_index: usize) -> Result<()> {
        if self.stack.is_empty() {
            let lines = self.ask("where")?;
            self.parse_stack(&lines);
        }
        let count = self.stack.len().max(1);
        // The panel lists the outermost call first; jdb numbers from the innermost.
        let wanted = count - frame_index.min(count - 1);
        if wanted != self.jdb_frame {
            let step = if wanted > self.jdb_frame { format!("up {}", wanted - self.jdb_frame) } else { format!("down {}", self.jdb_frame - wanted) };
            self.ask(&step)?;
            self.jdb_frame = wanted;
        }
        let mut locals = Vec::new();
        let lines = self.ask("locals")?;
        let pairs: Vec<(String, String)> = lines.iter().filter_map(|line| line.split_once(" = ").map(|(name, value)| (name.trim().to_owned(), value.to_owned()))).filter(|(name, _)| Regex::new(r"^[\w$]+$").unwrap().is_match(name)).take(60).collect();
        for (name, value) in pairs { let described = self.describe(&name, &value); locals.push(described); }
        if lines.iter().any(|line| line.contains("Local variable information not available")) {
            locals.push(json!({ "name": "(locals)", "type": "", "value": "not available for this frame", "size": "" }));
        }
        let mut watched = Vec::new();
        for expression in self.watches.clone() {
            let (value, ok) = self.evaluate(&expression);
            watched.push(json!({ "name": expression, "type": "", "value": value, "size": "", "ok": ok }));
        }
        let ordered: Vec<Value> = self.stack.iter().rev().map(|(name, file, line)| json!({ "name": name, "file": file, "line": line })).collect();
        let top = self.stack.first().cloned().unwrap_or_default();
        let selected = ordered.get(frame_index.min(ordered.len().saturating_sub(1))).cloned().unwrap_or(json!({ "file": top.1, "line": top.2 }));
        let _ = self.app.emit("debug-event", json!({
            "id": self.id, "event": "stopped", "reason": self.reason, "detail": self.detail,
            "file": top.1, "line": top.2, "frame": frame_index.min(ordered.len().saturating_sub(1)),
            "frameFile": selected["file"], "frameLine": selected["line"],
            "stack": ordered, "locals": locals, "globals": [], "watches": watched,
        }));
        Ok(())
    }

    fn set_breakpoints(&mut self, wanted: Vec<(String, u32)>, paused: bool) -> Result<()> {
        let old = std::mem::take(&mut self.breakpoints);
        for (path, line) in old.iter().filter(|item| !wanted.contains(item)) {
            let command = format!("clear {}:{line}", self.class_for(path));
            if paused { self.ask(&command)?; } else { self.send(&command)?; }
        }
        for (path, line) in wanted.iter().filter(|item| !old.contains(item)) {
            let command = format!("stop at {}:{line}", self.class_for(path));
            if paused { self.ask(&command)?; } else { self.send(&command)?; }
        }
        self.breakpoints = wanted;
        Ok(())
    }
}

fn breakpoint_options(value: &Value) -> std::collections::HashMap<(String, u32), (Option<String>, Option<String>)> {
    let text = |item: &Value, key: &str| item[key].as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned);
    value.as_array().into_iter().flatten().filter_map(|item| {
        let key = (item["file"].as_str()?.to_owned(), item["line"].as_u64()? as u32);
        let (condition, log) = (text(item, "condition"), text(item, "log"));
        (condition.is_some() || log.is_some()).then_some((key, (condition, log)))
    }).collect()
}

fn breakpoint_list(value: &Value) -> Vec<(String, u32)> {
    value.as_array().into_iter().flatten().filter_map(|item| Some((item["file"].as_str()?.to_owned(), item["line"].as_u64()? as u32))).filter(|(file, _)| file.ends_with(".java")).collect()
}

fn java_sources(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut folders = vec![root.to_path_buf()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if !name.starts_with('.') && !["bin", "target", "build", "out", "node_modules"].contains(&name.as_str()) && found.len() < 20_000 { folders.push(path); }
            } else if name.ends_with(".java") {
                if let Ok(relative) = path.strip_prefix(root) { found.push(relative.to_string_lossy().replace('\\', "/")); }
            }
        }
    }
    found
}

/// A started jdb (on this computer, or on a server over SSH) and what's needed to follow it.
pub struct Launch<'a> {
    pub child: std::process::Child,
    pub class: String,
    pub sources: Vec<String>,
    pub read: Box<dyn Fn(&str) -> String + 'a>,
    pub diagnostics: Vec<crate::process::Diagnostic>,
}

/// Runs inside the debug job: compile, start jdb, then follow it until the program ends.
#[allow(clippy::too_many_arguments)]
pub fn run(job: &Job, app: AppHandle, id: String, cwd: &Path, file: &Path, path: &str, setup: Value, args: &[String], commands: Receiver<Value>) -> Result<(i32, Vec<crate::process::Diagnostic>)> {
    let compiled = compile_java(job, cwd, file, path, true)?;
    if compiled.code != 0 {
        return Ok((compiled.code, compiled.diagnostics));
    }
    let jdb = compiled.compiler.with_file_name(if cfg!(windows) { "jdb.exe" } else { "jdb" });
    let jdb = if jdb.is_file() { jdb } else { "jdb".into() };
    job.emit("command", format!("$ jdb {}{}\n", compiled.class, if args.is_empty() { String::new() } else { format!(" {}", shell_words::join(args)) }));
    let child = crate::process::command(&jdb, cwd)
        .args(["-J-Dfile.encoding=UTF-8", "-J-Duser.language=en", "-classpath", "bin", "-sourcepath"]).arg(&compiled.source_paths)
        .arg(&compiled.class).args(args).envs(job.env_vars())
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|error| if error.kind() == std::io::ErrorKind::NotFound { "jdb was not found. It comes with the JDK; check that JAVA_HOME points at a JDK.".to_owned() } else { err(error) })?;
    let root = cwd.to_path_buf();
    follow(job, app, id, Launch { child, class: compiled.class, sources: java_sources(cwd), read: Box::new(move |path| std::fs::read_to_string(root.join(path)).unwrap_or_default()), diagnostics: compiled.diagnostics }, setup, commands)
}

/// Follows a started jdb until the program ends, turning its text into debugger events.
pub fn follow(job: &Job, app: AppHandle, id: String, launch: Launch, setup: Value, commands: Receiver<Value>) -> Result<(i32, Vec<crate::process::Diagnostic>)> {
    let Launch { mut child, class, sources, read, diagnostics } = launch;
    let stdin = child.stdin.take().ok_or("jdb takes no input.")?;
    let out = reader(child.stdout.take().ok_or("jdb has no output.")?);
    // jdb's own errors (the program's stderr arrives on stdout, mixed with jdb's).
    let (error_sender, errors) = mpsc::channel::<String>();
    if let Some(mut stderr) = child.stderr.take() {
        thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            for line in text.lines().filter(|line| !line.starts_with("Picked up ")) { let _ = error_sender.send(line.to_owned()); }
        });
    }
    let mut session = Session {
        job, app: app.clone(), id: id.clone(), stdin, out, sources, read, jdb_frame: 1, stack: Vec::new(),
        watches: setup["watches"].as_array().into_iter().flatten().filter_map(|item| item.as_str().map(str::to_owned)).collect(),
        breakpoints: Vec::new(), options: breakpoint_options(&setup["breakpoints"]), reason: String::new(), detail: String::new(), ended: false,
    };
    // jdb's first prompt, then breakpoints (deferred until the class loads) and run.
    let _ = session.ask("");
    session.set_breakpoints(breakpoint_list(&setup["breakpoints"]), true)?;
    match setup["pauseOn"].as_str().unwrap_or("uncaught") {
        "all" => { session.ask("catch all java.lang.Throwable")?; }
        "none" => {}
        _ => { session.ask("catch uncaught java.lang.Throwable")?; }
    }
    if setup["stopOnEntry"].as_bool().unwrap_or(false) { session.ask(&format!("stop in {class}.main"))?; }
    let _ = app.emit("debug-event", json!({ "id": id, "event": "started" }));
    session.send("run")?;
    let event = Regex::new(r#"^(?:> )?(Breakpoint hit|Step completed|Exception occurred|Method entered): (?:(.+?) \((?:un)?caught\))?"thread=[^"]*", ([\w$.<>]+)\(\), line=([\d,]+)"#).unwrap();
    let mut paused = false;
    let mut skip_source = false;
    // Where the last breakpoint hit was (class, line), to apply its condition or log message.
    let mut hit: Option<(String, u32)> = None;
    // jdb puts a blank line before each event; hold blank lines until it's clear which they are.
    let mut blanks = 0usize;
    'outer: loop {
        if job.is_cancelled() || session.ended { break }
        if !paused {
            match session.out.recv_timeout(Duration::from_millis(60)) {
                Ok(Out::Line(line)) => {
                    while let Ok(text) = errors.try_recv() { job.emit("stderr", format!("{text}\n")); }
                    if !skip_source && line.trim_start_matches("> ").is_empty() { blanks += 1; continue }
                    let is_event = event.is_match(&line);
                    if !is_event { for _ in 0..std::mem::take(&mut blanks) { session.output("") } } else { blanks = 0 }
                    if let Some(found) = event.captures(&line) {
                        session.reason = match &found[1] { "Breakpoint hit" | "Method entered" => "breakpoint", "Exception occurred" => "exception", _ => "step" }.to_owned();
                        hit = (&found[1] == "Breakpoint hit").then(|| {
                            let method = found[3].to_owned();
                            let class = method.rsplit_once('.').map(|(class, _)| class.to_owned()).unwrap_or_default();
                            (class, found[4].replace(',', "").parse().unwrap_or(0))
                        });
                        session.detail = found.get(2).map(|exception| format!("{} (uncaught)", exception.as_str())).unwrap_or_default();
                        skip_source = true;
                    } else if line.trim_start_matches("> ").trim() == "The application exited" || line.contains("The application has been disconnected") {
                        break;
                    } else if skip_source && Regex::new(r"^\d+\s").unwrap().is_match(&line) {
                        // jdb echoes the source line it stopped on.
                    } else if !(skip_source && line.trim().is_empty()) {
                        session.output(&line);
                    }
                }
                Ok(Out::Prompt(prompt)) => {
                    if skip_source && prompt != "> " {
                        skip_source = false;
                        session.jdb_frame = 1;
                        session.stack.clear();
                        // Conditional breakpoints and logpoints: jdb has neither, so check here and carry on.
                        let options = hit.take().and_then(|(class, line)| {
                            let outer = class.split('$').next().unwrap_or(&class).to_owned();
                            let simple = outer.rsplit('.').next().unwrap_or(&outer).to_owned();
                            let path = session.file_for(&class, &format!("{simple}.java"))?;
                            session.options.get(&(path, line)).cloned()
                        });
                        if let Some((condition, log)) = options {
                            if let Some(condition) = condition {
                                let (value, ok) = session.evaluate(&condition);
                                if !ok || value.trim() != "true" { session.send("cont")?; continue; }
                            }
                            if let Some(message) = log {
                                let filled = Regex::new(r"\{([^{}]+)\}").unwrap().replace_all(&message, |found: &regex::Captures| session.evaluate(&found[1]).0.trim_matches('"').to_owned()).into_owned();
                                session.output(&filled);
                                session.send("cont")?;
                                continue;
                            }
                        }
                        paused = true;
                        session.report(usize::MAX)?;
                    }
                }
                Ok(Out::Closed) => break,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            while let Ok(command) = commands.try_recv() {
                match command["op"].as_str().unwrap_or("") {
                    "stop" => break 'outer,
                    "breakpoints" => { session.options = breakpoint_options(&command["items"]); session.set_breakpoints(breakpoint_list(&command["items"]), false)? }
                    "watches" => session.watches = command["items"].as_array().into_iter().flatten().filter_map(|item| item.as_str().map(str::to_owned)).collect(),
                    _ => {}
                }
            }
            continue;
        }
        // Paused: wait for the panel.
        let command = match commands.recv_timeout(Duration::from_millis(100)) {
            Ok(command) => command,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let resume = |session: &mut Session, line: &str| -> Result<()> { session.send(line) };
        match command["op"].as_str().unwrap_or("") {
            "continue" => { resume(&mut session, "cont")?; paused = false; }
            "next" => { resume(&mut session, "next")?; paused = false; }
            "step" => { resume(&mut session, "step")?; paused = false; }
            "out" => { resume(&mut session, "step up")?; paused = false; }
            "stop" => break,
            "frame" => { let index = command["index"].as_u64().unwrap_or(0) as usize; session.report(index)?; }
            "watches" => {
                session.watches = command["items"].as_array().into_iter().flatten().filter_map(|item| item.as_str().map(str::to_owned)).collect();
                let index = session.stack.len().saturating_sub(session.jdb_frame);
                session.report(index)?;
            }
            "breakpoints" => { session.options = breakpoint_options(&command["items"]); session.set_breakpoints(breakpoint_list(&command["items"]), true)? }
            "eval" => {
                let expression = command["expression"].as_str().unwrap_or("").to_owned();
                let (value, ok) = session.evaluate(&expression);
                let _ = app.emit("debug-event", json!({ "id": id, "event": "eval", "expression": expression, "value": value, "ok": ok }));
            }
            _ => {}
        }
    }
    let _ = session.send("exit");
    let deadline = Instant::now() + Duration::from_millis(800);
    let code = loop {
        if let Ok(Some(status)) = child.try_wait() { break status.code().unwrap_or(0) }
        if Instant::now() > deadline { let _ = child.kill(); let _ = child.wait(); break if job.is_cancelled() { 130 } else { 0 } }
        // Drain what's left so the last output reaches the pane.
        while let Ok(Out::Line(line)) = session.out.try_recv() { if !line.contains("The application exited") { session.output(&line) } }
        thread::sleep(Duration::from_millis(30));
    };
    let _ = app.emit("debug-event", json!({ "id": id, "event": "ended" }));
    while let Ok(line) = errors.try_recv() { job.emit("stderr", format!("{line}\n")); }
    Ok((code, diagnostics))
}
