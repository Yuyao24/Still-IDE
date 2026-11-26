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
        let candidates: Vec<(&str, Vec<String>)> = vec![
            ("latexmk", vec![if unicode { "-xelatex" } else { "-pdf" }.into(), "-interaction=nonstopmode".into(), "-halt-on-error".into(), "-file-line-error".into(), format!("-outdir={outdir}"), name.clone()]),
            ("tectonic", vec!["--outdir".into(), outdir.clone(), "--keep-logs".into(), "--chatter".into(), "minimal".into(), name.clone()]),
            (if unicode { "xelatex" } else { "pdflatex" }, vec!["-interaction=nonstopmode".into(), "-halt-on-error".into(), "-file-line-error".into(), format!("-output-directory={outdir}"), name.clone()]),
            (if unicode { "pdflatex" } else { "xelatex" }, vec!["-interaction=nonstopmode".into(), "-halt-on-error".into(), "-file-line-error".into(), format!("-output-directory={outdir}"), name.clone()]),
        ];
        let Some((engine, program, args)) = candidates.into_iter().find_map(|(engine, args)| find(&cwd, engine).map(|program| (engine, program, args))) else {
            return Ok(TexResult { pdf: None, engine: None, seconds: 0.0, errors: Vec::new(), log: String::new() });
        };
        let pdf_path = out.join(format!("{stem}.pdf"));
        let _ = std::fs::remove_file(&pdf_path);
        let started = Instant::now();
        let mut child = command(&program, &folder).args(&args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(err)?;
        let stdout = child.stdout.take();
        let reader = std::thread::spawn(move || { let mut text = String::new(); if let Some(mut pipe) = stdout { use std::io::Read; let _ = pipe.read_to_string(&mut text); } text });
        let deadline = started + Duration::from_secs(120);
        loop {
            if let Ok(Some(_)) = child.try_wait() { break }
            if Instant::now() > deadline { let _ = child.kill(); let _ = child.wait(); return Err("TeX took longer than two minutes and was stopped.".into()); }
            std::thread::sleep(Duration::from_millis(40));
        }
        let output = reader.join().unwrap_or_default();
        let log = std::fs::read_to_string(out.join(format!("{stem}.log"))).unwrap_or(output);
        let errors = tex_errors(&log, &name);
        let pdf = std::fs::read(&pdf_path).ok().map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes));
        let tail: Vec<&str> = log.lines().rev().take(40).collect();
        Ok(TexResult { pdf, engine: Some(engine.to_owned()), seconds: started.elapsed().as_secs_f64(), errors, log: tail.into_iter().rev().collect::<Vec<_>>().join("\n") })
    })
    .await
    .map_err(err)?
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
