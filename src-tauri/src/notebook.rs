//! Jupyter notebooks without Jupyter: a small Python kernel that runs cells one after another in
//! one shared namespace, and reports printed text, results (with HTML for tables such as pandas
//! DataFrames), errors and matplotlib figures as JSON lines.
use crate::{
    process::{command, python},
    workspace::{err, relative, resolve, root, Result},
};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, State};

const KERNEL: &str = r#"
import sys, json, io, traceback, ast, base64, os, builtins
os.environ.setdefault('MPLBACKEND', 'Agg')
scope = {'__name__': '__main__'}
out = sys.__stdout__
def emit(message):
    out.write(json.dumps(message) + '\n'); out.flush()
class Stream(io.TextIOBase):
    def __init__(self, name, cell): self.name = name; self.cell = cell
    def writable(self): return True
    def write(self, text):
        if text: emit({'cell': self.cell, 'kind': 'stream', 'name': self.name, 'text': text})
        return len(text)
def no_input(prompt=''):
    raise RuntimeError('input() is not available in notebook cells. Set the value in the code instead.')
builtins.input = no_input
def figures(cell):
    plt = sys.modules.get('matplotlib.pyplot')
    if not plt: return
    for number in plt.get_fignums():
        buffer = io.BytesIO()
        plt.figure(number).savefig(buffer, format='png', bbox_inches='tight', dpi=110)
        emit({'cell': cell, 'kind': 'display', 'mime': 'image/png', 'data': base64.b64encode(buffer.getvalue()).decode()})
    plt.close('all')
def show(cell, value):
    for method, mime in (('_repr_html_', 'text/html'), ('_repr_png_', 'image/png'), ('_repr_svg_', 'image/svg+xml')):
        render = getattr(value, method, None)
        if callable(render):
            try:
                data = render()
                if data:
                    if isinstance(data, bytes): data = base64.b64encode(data).decode()
                    emit({'cell': cell, 'kind': 'result', 'mime': mime, 'data': data, 'text': repr(value)[:4000]}); return
            except Exception: pass
    emit({'cell': cell, 'kind': 'result', 'mime': 'text/plain', 'data': repr(value)[:20000]})
for line in sys.stdin:
    try: request = json.loads(line)
    except ValueError: continue
    cell = request.get('cell'); code = request.get('code', '')
    sys.stdout = Stream('stdout', cell); sys.stderr = Stream('stderr', cell)
    ok = True
    try:
        tree = ast.parse(code, '<cell>', 'exec')
        last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        exec(compile(tree, '<cell>', 'exec'), scope)
        if last is not None:
            value = eval(compile(ast.Expression(last.value), '<cell>', 'eval'), scope)
            if value is not None: show(cell, value)
        figures(cell)
    except BaseException as error:
        ok = False
        frames = [frame for frame in traceback.extract_tb(error.__traceback__) if frame.filename == '<cell>']
        lines = ['  line %d%s' % (frame.lineno, (': ' + frame.line) if frame.line else '') for frame in frames]
        if isinstance(error, SyntaxError): lines = ['  line %s: %s' % (error.lineno, (error.text or '').rstrip())]
        emit({'cell': cell, 'kind': 'error', 'name': type(error).__name__, 'message': str(error), 'traceback': lines})
        if isinstance(error, SystemExit): break
    finally:
        sys.stdout = sys.__stdout__; sys.stderr = sys.__stderr__
    emit({'cell': cell, 'kind': 'done', 'ok': ok})
"#;

struct Kernel {
    stdin: ChildStdin,
    child: Child,
}

#[derive(Default, Clone)]
pub struct Kernels(Arc<Mutex<HashMap<String, Kernel>>>);

impl Kernels {
    pub fn stop_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            for (_, mut kernel) in map.drain() { let _ = kernel.child.kill(); let _ = kernel.child.wait(); }
        }
    }
}

/// Starts a kernel for a notebook (in the notebook's folder, with the project's Python).
#[tauri::command]
pub fn notebook_start(app: AppHandle, kernels: State<Kernels>, root_path: String, path: String, id: String) -> Result<String> {
    let cwd = root(&root_path)?;
    relative(&path)?;
    let file = resolve(&cwd, &path)?;
    let folder = file.parent().unwrap_or(&cwd).to_path_buf();
    let (interpreter, version, _) = python(&cwd).ok_or("Python 3 was not found on PATH or in .venv.")?;
    if let Some(mut old) = kernels.0.lock().map_err(err)?.remove(&id) { let _ = old.child.kill(); }
    let mut child = command(&interpreter, &folder).env("PYTHONIOENCODING", "utf-8").env("PYTHONUNBUFFERED", "1").args(["-u", "-c", KERNEL])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(err)?;
    let stdin = child.stdin.take().ok_or("The kernel takes no input.")?;
    let stdout = child.stdout.take().ok_or("The kernel has no output.")?;
    let stderr = child.stderr.take();
    let events = app.clone();
    let kernel_id = id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(|line| line.ok()) {
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&line) {
                value["id"] = serde_json::Value::String(kernel_id.clone());
                let _ = events.emit("notebook-event", value);
            }
        }
        let _ = events.emit("notebook-event", serde_json::json!({ "id": kernel_id, "kind": "exit" }));
        if let Ok(mut map) = events.state::<Kernels>().0.lock() {
            if map.get_mut(&kernel_id).is_some_and(|kernel| !matches!(kernel.child.try_wait(), Ok(None))) { map.remove(&kernel_id); }
        }
    });
    // Anything the kernel itself prints to stderr (outside a cell) is shown with the next cell.
    if let Some(stderr) = stderr {
        let events = app.clone();
        let kernel_id = id.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(|line| line.ok()) {
                let _ = events.emit("notebook-event", serde_json::json!({ "id": kernel_id, "kind": "log", "text": line }));
            }
        });
    }
    kernels.0.lock().map_err(err)?.insert(id, Kernel { stdin, child });
    Ok(version)
}

#[tauri::command]
pub fn notebook_run(kernels: State<Kernels>, id: String, cell: String, code: String) -> Result<()> {
    let mut map = kernels.0.lock().map_err(err)?;
    let kernel = map.get_mut(&id).ok_or("The kernel is not running.")?;
    let line = serde_json::json!({ "cell": cell, "code": code }).to_string();
    kernel.stdin.write_all(line.as_bytes()).and_then(|_| kernel.stdin.write_all(b"\n")).and_then(|_| kernel.stdin.flush()).map_err(err)
}

/// Stops a long cell. On macOS and Linux the cell gets KeyboardInterrupt and the kernel keeps its
/// variables; on Windows the kernel has to be restarted.
#[tauri::command]
pub fn notebook_interrupt(kernels: State<Kernels>, id: String) -> Result<bool> {
    let map = kernels.0.lock().map_err(err)?;
    let kernel = map.get(&id).ok_or("The kernel is not running.")?;
    #[cfg(unix)]
    {
        let status = std::process::Command::new("kill").args(["-INT", &kernel.child.id().to_string()]).status().map_err(err)?;
        return Ok(status.success());
    }
    #[cfg(not(unix))]
    {
        let _ = kernel;
        Ok(false)
    }
}

#[tauri::command]
pub fn notebook_stop(kernels: State<Kernels>, id: String) -> Result<()> {
    if let Some(mut kernel) = kernels.0.lock().map_err(err)?.remove(&id) {
        let _ = kernel.child.kill();
        let _ = kernel.child.wait();
    }
    Ok(())
}
