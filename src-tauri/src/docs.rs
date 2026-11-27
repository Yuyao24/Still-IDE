//! Files shown rather than edited: binary files (PDFs, images) read as base64, and LaTeX
//! compiled to PDF with whichever TeX the machine has (latexmk, Tectonic, pdfLaTeX, XeLaTeX).
use crate::{
    process::command,
    tools::find,
    workspace::{err, relative, resolve, root, Result},
};
use base64::Engine;
use serde::Serialize;
use std::{
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};

const BINARY_LIMIT: u64 = 64 * 1024 * 1024;

#[tauri::command]
pub async fn read_binary(root_path: String, path: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let full = resolve(&root(&root_path)?, &path)?;
        let metadata = full.metadata().map_err(err)?;
        if !metadata.is_file() || metadata.len() > BINARY_LIMIT {
            return Err("Still shows files up to 64 MB.".into());
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(std::fs::read(full).map_err(err)?))
    })
    .await
    .map_err(err)?
}

#[derive(Serialize)]
pub struct TexError {
    line: u32,
    message: String,
}

#[derive(Serialize)]
pub struct TexResult {
    pdf: Option<String>,
    engine: Option<String>,
    seconds: f64,
    errors: Vec<TexError>,
    log: String,
    /// Engines that were passed over and why (latexmk without Perl, a program that didn't run).
    notes: Vec<String>,
}

/// Reads errors from a TeX log written with -file-line-error ("./main.tex:12: Undefined control
/// sequence.") or in the classic form ("! LaTeX Error: …" followed by "l.12 …").
fn tex_errors(log: &str, file_name: &str) -> Vec<TexError> {
    let mut errors = Vec::new();
    let lines: Vec<&str> = log.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        if let Some((location, message)) = line.split_once(": ") {
            if let Some((source, number)) = location.rsplit_once(':') {
                if source.ends_with(".tex") && number.chars().all(|char| char.is_ascii_digit()) && !number.is_empty() {
                    let mine = Path::new(source).file_name().is_some_and(|name| name == file_name);
                    errors.push(TexError { line: if mine { number.parse().unwrap_or(0) } else { 0 }, message: if mine { message.trim().to_owned() } else { format!("{source}: {}", message.trim()) } });
                    continue;
                }
            }
        }
        if let Some(message) = line.strip_prefix("! ") {
            let number = lines[index + 1..].iter().take(12).find_map(|next| next.strip_prefix("l.").and_then(|rest| rest.split(|char: char| !char.is_ascii_digit()).next()?.parse().ok())).unwrap_or(0);
            if !errors.iter().any(|known: &TexError| known.line == number && known.message.contains(message.trim())) {
                errors.push(TexError { line: number, message: message.trim().to_owned() });
            }
        }
    }
    errors.truncate(40);
    errors
}

/// Compiles a .tex file into a folder outside the project and returns the PDF (base64) and errors.
#[tauri::command]
pub async fn tex_compile(root_path: String, path: String) -> Result<TexResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        relative(&path)?;
        let file = resolve(&cwd, &path)?;
        let folder = file.parent().unwrap_or(&cwd).to_path_buf();
        let name = file.file_name().ok_or("Not a file.")?.to_string_lossy().into_owned();
        let stem = file.file_stem().ok_or("Not a file.")?.to_string_lossy().into_owned();
        let source = std::fs::read_to_string(&file).unwrap_or_default();
        let unicode = source.contains("fontspec") || source.contains("unicode-math") || source.contains("polyglossia");
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        file.hash(&mut hasher);
        let out = std::env::temp_dir().join("still-tex").join(format!("{:016x}", hasher.finish()));
        std::fs::create_dir_all(&out).map_err(err)?;
        let outdir = out.to_string_lossy().into_owned();
        let direct = |engine: &str| vec![engine.to_owned(), "-interaction=nonstopmode".into(), "-halt-on-error".into(), "-file-line-error".into(), format!("-output-directory={outdir}"), name.clone()];
        let (first, second) = if unicode { ("xelatex", "pdflatex") } else { ("pdflatex", "xelatex") };
        let candidates: Vec<Vec<String>> = vec![
            vec!["latexmk".into(), if unicode { "-xelatex" } else { "-pdf" }.into(), "-interaction=nonstopmode".into(), "-halt-on-error".into(), "-file-line-error".into(), format!("-outdir={outdir}"), name.clone()],
            vec!["tectonic".into(), "--outdir".into(), outdir.clone(), "--keep-logs".into(), "--chatter".into(), "minimal".into(), name.clone()],
            direct(first),
            direct(second),
            direct("lualatex"),
        ];
        let pdf_path = out.join(format!("{stem}.pdf"));
        let log_path = out.join(format!("{stem}.log"));
        let started = Instant::now();
        // Why engines were passed over, shown when nothing made a PDF.
        let mut notes: Vec<String> = Vec::new();
        let mut last: Option<TexResult> = None;
        for args in candidates {
            let engine = args[0].clone();
            let Some(program) = tex_find(&cwd, &engine) else { continue };
            let miktex = program.to_string_lossy().to_lowercase().contains("miktex");
            // latexmk is a Perl script; MiKTeX ships it, but Windows has no Perl unless you install it.
            if engine == "latexmk" && find(&cwd, "perl").is_none() && tex_find(&cwd, "perl").is_none() {
                notes.push("latexmk needs Perl, which isn't installed, so Still used pdflatex directly.".into());
                continue;
            }
            let mut args: Vec<String> = args[1..].to_vec();
            // MiKTeX: install packages a document needs without stopping to ask.
            if miktex && engine != "latexmk" && engine != "tectonic" { args.insert(0, "--enable-installer".into()); }
            let _ = std::fs::remove_file(&pdf_path);
            let _ = std::fs::remove_file(&log_path);
            let passes = if engine == "latexmk" || engine == "tectonic" { 1 } else { 2 };
            let mut output = String::new();
            for pass in 0..passes {
                output = run_tex(&program, &folder, &args, started)?;
                let log = std::fs::read_to_string(&log_path).unwrap_or_default();
                // A second run only when references or labels changed.
                if pass == 0 && !(log.contains("Rerun to get") || log.contains("Label(s) may have changed") || log.contains("Rerun LaTeX")) { break }
            }
            let log_file = std::fs::read_to_string(&log_path).ok();
            let log = log_file.clone().unwrap_or_else(|| output.clone());
            let errors = tex_errors(&log, &name);
            let pdf = std::fs::read(&pdf_path).ok().map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes));
            let mut tail: Vec<&str> = log.lines().rev().take(40).collect();
            tail.reverse();
            let mut text = tail.join("\n");
            if log_file.is_some() && !output.trim().is_empty() && pdf.is_none() && errors.is_empty() {
                // TeX wrote a log but printed something else too (a MiKTeX message, say): show both.
                let printed: Vec<&str> = output.lines().rev().take(12).collect();
                text = printed.into_iter().rev().collect::<Vec<_>>().join("\n") + "\n\n" + &text;
            }
            let result = TexResult { pdf, engine: Some(engine.clone()), seconds: started.elapsed().as_secs_f64(), errors, log: text, notes: notes.clone() };
            // A PDF, or real TeX errors in a log: that's the answer.
            if result.pdf.is_some() || !result.errors.is_empty() || log_file.is_some() { return Ok(result) }
            // The program didn't get as far as TeX (a missing script engine, a broken install): try the next one.
            let reason = output.lines().map(str::trim).filter(|line| !line.is_empty()).last().unwrap_or("it stopped without output").to_owned();
            notes.push(format!("{engine} didn't run: {reason}"));
            last = Some(result);
        }
        Ok(last.map(|mut result| { result.notes = notes.clone(); result }).unwrap_or(TexResult { pdf: None, engine: None, seconds: 0.0, errors: Vec::new(), log: String::new(), notes }))
    })
    .await
    .map_err(err)?
}

/// Runs one TeX program to the end (two minutes at most) and returns what it printed.
fn run_tex(program: &Path, folder: &Path, args: &[String], started: Instant) -> Result<String> {
    let mut cmd = command(program, folder);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // The engine's own folder first on PATH, so the tools it calls are found too.
    if let Some(dir) = program.parent() {
        let path = std::env::var_os("PATH").unwrap_or_default();
        if let Ok(joined) = std::env::join_paths(std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&path))) { cmd.env("PATH", joined); }
    }
    let mut child = cmd.spawn().map_err(err)?;
    let read = |pipe: Option<Box<dyn std::io::Read + Send>>| std::thread::spawn(move || { let mut text = String::new(); if let Some(mut pipe) = pipe { let _ = pipe.read_to_string(&mut text); } text });
    let stdout = read(child.stdout.take().map(|pipe| Box::new(pipe) as Box<dyn std::io::Read + Send>));
    let stderr = read(child.stderr.take().map(|pipe| Box::new(pipe) as Box<dyn std::io::Read + Send>));
    let deadline = started + Duration::from_secs(120);
    loop {
        if let Ok(Some(_)) = child.try_wait() { break }
        if Instant::now() > deadline { let _ = child.kill(); let _ = child.wait(); return Err("TeX took longer than two minutes and was stopped. (MiKTeX may be installing packages; try again in a moment.)".into()); }
        std::thread::sleep(Duration::from_millis(40));
    }
    let mut text = stdout.join().unwrap_or_default();
    let errors = stderr.join().unwrap_or_default();
    if !errors.trim().is_empty() { text.push_str("\n"); text.push_str(&errors); }
    Ok(text)
}

/// A TeX program: on PATH (or PATH as it is now, on Windows), or in a usual install folder.
fn tex_find(cwd: &Path, name: &str) -> Option<std::path::PathBuf> {
    find(cwd, name).or_else(|| tex_dirs().into_iter().find_map(|dir| {
        let file = dir.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() });
        file.is_file().then_some(file)
    }))
}

/// Where MiKTeX, TeX Live and MacTeX put their programs, newest TeX Live first.
fn tex_dirs() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut dirs = Vec::new();
    let years = |base: &Path, platforms: &[&str]| -> Vec<PathBuf> {
        let mut found: Vec<PathBuf> = std::fs::read_dir(base).into_iter().flatten().flatten().map(|entry| entry.path()).filter(|path| path.file_name().is_some_and(|name| name.to_string_lossy().chars().all(|c| c.is_ascii_digit()))).collect();
        found.sort();
        found.reverse();
        found.into_iter().flat_map(|year| platforms.iter().map(move |platform| year.join("bin").join(platform))).collect()
    };
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") { dirs.push(PathBuf::from(local).join("Programs").join("MiKTeX").join("miktex").join("bin").join("x64")); }
        for key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(base) = std::env::var_os(key) { dirs.push(PathBuf::from(&base).join("MiKTeX").join("miktex").join("bin").join("x64")); dirs.push(PathBuf::from(base).join("MiKTeX").join("miktex").join("bin")); }
        }
        dirs.extend(years(Path::new(r"C:\texlive"), &["windows", "win64", "win32"]));
    } else if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/Library/TeX/texbin"));
        dirs.extend(years(Path::new("/usr/local/texlive"), &["universal-darwin", "x86_64-darwin", "arm64-darwin"]));
    } else {
        dirs.extend(years(Path::new("/usr/local/texlive"), &["x86_64-linux", "aarch64-linux"]));
    }
    dirs.into_iter().filter(|dir| dir.is_dir()).collect()
}

#[cfg(test)]
mod check {
    #[test]
    fn reads_tex_errors() {
        let log = "./main.tex:7: Undefined control sequence.\nl.7 \\foo\n! LaTeX Error: File `missing.sty' not found.\n\nl.3 \\usepackage\n";
        let errors = super::tex_errors(log, "main.tex");
        assert_eq!(errors[0].line, 7);
        assert!(errors.iter().any(|error| error.line == 3 && error.message.contains("missing.sty")));
    }
}
