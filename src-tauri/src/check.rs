//! Editor support: the last committed version of a file (for change markers in
//! the gutter) and quick Python checks (for error underlines while typing).
use crate::{
    process::command,
    workspace::{err, relative, root, Result},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Write,
    path::PathBuf,
    process::Stdio,
    sync::{Mutex, OnceLock},
};

/// The file as it was in the last commit, or None when it is not in a Git repository
/// or not committed yet (new files get no change markers, like other editors).
#[tauri::command]
pub async fn git_head_text(root_path: String, path: String) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        relative(&path)?;
        let prefix = command("git", &cwd).args(["rev-parse", "--show-prefix"]).output().map_err(err)?;
        if !prefix.status.success() {
            return Ok(None);
        }
        let prefix = String::from_utf8_lossy(&prefix.stdout).trim_end_matches(['\r', '\n']).to_owned();
        let output = command("git", &cwd)
            .args(["--literal-pathspecs", "show", &format!("HEAD:{prefix}{path}")])
            .output()
            .map_err(err)?;
        if !output.status.success() || output.stdout.len() > 4 * 1024 * 1024 || output.stdout.contains(&0) {
            return Ok(None);
        }
        Ok(String::from_utf8(output.stdout).ok().map(|text| text.replace("\r\n", "\n")))
    })
    .await
    .map_err(err)?
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodeIssue {
    line: u32,
    column: u32,
    end_line: Option<u32>,
    end_column: Option<u32>,
    severity: String,
    message: String,
}

// Reads the source on stdin. Syntax errors come from Python's own compiler. If pyflakes
// is installed it adds unused imports, undefined names and so on; otherwise a small
// check flags names that are used but never defined anywhere in the file (typos).
const PYTHON_CHECK: &str = r#"
import sys, json, ast, builtins
src = sys.stdin.buffer.read().decode('utf-8', 'replace')
out = []
def add(line, col, msg, sev='error', end_line=None, end_col=None):
    out.append({'line': line or 1, 'column': max(1, col or 1), 'endLine': end_line, 'endColumn': end_col, 'severity': sev, 'message': msg})
try:
    tree = compile(src, '<file>', 'exec', ast.PyCF_ONLY_AST, dont_inherit=True)
    compile(tree, '<file>', 'exec', dont_inherit=True)
except SyntaxError as e:
    add(e.lineno, e.offset, e.msg, 'error', getattr(e, 'end_lineno', None), getattr(e, 'end_offset', None))
    tree = None
except Exception:
    tree = None
if tree is not None:
    try:
        from pyflakes import checker
        for m in checker.Checker(tree, filename='<file>').messages:
            kind = type(m).__name__
            sev = 'error' if kind in ('UndefinedName', 'UndefinedLocal', 'UndefinedExport', 'ReturnOutsideFunction', 'YieldOutsideFunction') else 'warning'
            add(m.lineno, (getattr(m, 'col', 0) or 0) + 1, m.message % m.message_args, sev)
    except ImportError:
        bound = set(dir(builtins)) | {'__file__', '__name__', '__doc__', '__builtins__', '__spec__', '__loader__', '__package__', '__path__', '__annotations__', '__class__', '__dict__', '__module__', '__qualname__'}
        star = False
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
                bound.add(node.id)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                bound.add(node.name)
            elif isinstance(node, ast.arg):
                bound.add(node.arg)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    if alias.name == '*':
                        star = True
                    bound.add((alias.asname or alias.name).split('.')[0])
            elif isinstance(node, ast.ExceptHandler) and node.name:
                bound.add(node.name)
            elif isinstance(node, (ast.Global, ast.Nonlocal)):
                bound.update(node.names)
            elif hasattr(ast, 'MatchAs') and isinstance(node, getattr(ast, 'MatchAs')) and node.name:
                bound.add(node.name)
            elif hasattr(ast, 'MatchStar') and isinstance(node, getattr(ast, 'MatchStar')) and node.name:
                bound.add(node.name)
            elif hasattr(ast, 'MatchMapping') and isinstance(node, getattr(ast, 'MatchMapping')) and node.rest:
                bound.add(node.rest)
            elif hasattr(ast, 'TypeVar') and isinstance(node, getattr(ast, 'TypeVar')):
                bound.add(node.name)
        if not star:
            for node in ast.walk(tree):
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in bound:
                    add(node.lineno, node.col_offset + 1, "undefined name '%s'" % node.id, 'error', getattr(node, 'end_lineno', None), (getattr(node, 'end_col_offset', None) or node.col_offset + len(node.id)) + 1)
print(json.dumps(out[:200]))
"#;

fn pythons() -> &'static Mutex<HashMap<PathBuf, Option<PathBuf>>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Option<PathBuf>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Checks Python source with the project's interpreter. Returns no issues when Python is missing.
#[tauri::command]
pub async fn check_python(root_path: String, source: String) -> Result<Vec<CodeIssue>> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        let interpreter = {
            let mut cache = pythons().lock().map_err(err)?;
            cache.entry(cwd.clone()).or_insert_with(|| crate::process::python(&cwd).map(|found| found.0)).clone()
        };
        let Some(interpreter) = interpreter else { return Ok(Vec::new()) };
        let mut child = command(&interpreter, &cwd)
            .args(["-I", "-c", PYTHON_CHECK])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(err)?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(source.as_bytes());
        }
        let output = child.wait_with_output().map_err(err)?;
        let text = String::from_utf8_lossy(&output.stdout);
        Ok(serde_json::from_str(text.lines().last().unwrap_or("[]")).unwrap_or_default())
    })
    .await
    .map_err(err)?
}
