//! Debugging Python files: breakpoints, stepping, the call stack, variables and watch
//! expressions. The program runs under a small driver built on Python's own `bdb`, so
//! nothing needs installing. Program output goes through the normal Output pane; the
//! driver and the app talk over a private local socket (JSON lines).
use crate::{
    process::{command, parse_args, python, Jobs},
    workspace::{err, relative, resolve, root, Result},
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    sync::{mpsc, Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter, Manager, State};

pub const DRIVER: &str = r#"
import bdb, sys, os, json, socket, reprlib, linecache, traceback, types
root = os.path.realpath(os.environ.get('STILL_DEBUG_ROOT', os.getcwd()))
if os.environ.get('STILL_DEBUG_STDIO'):
    # Over SSH there is only stdin and stderr: debugger messages are marked lines on stderr, and
    # commands are marked lines on stdin, set apart from what the program itself reads.
    import io, queue, threading
    commands, typed = queue.Queue(), queue.Queue()
    real_in, real_err = sys.stdin, sys.__stderr__
    def pump():
        for line in real_in:
            if line.startswith('\x1eSTILL '): commands.put(line[7:])
            else: typed.put(line)
        commands.put(None); typed.put(None)
    threading.Thread(target=pump, daemon=True).start()
    class Typed(io.TextIOBase):
        ended = False
        def readable(self): return True
        def readline(self, size=-1):
            if self.ended: return ''
            line = typed.get()
            if line is None: self.ended = True; return ''
            return line
        def read(self, size=-1):
            out = []
            while True:
                line = self.readline()
                if not line: break
                out.append(line)
            return ''.join(out)
    sys.stdin = Typed()
    def send(message):
        real_err.write('\x1eSTILL-DEBUG ' + json.dumps(message) + '\n'); real_err.flush()
    def receive():
        line = commands.get()
        if line is None: raise SystemExit(0)
        return json.loads(line)
else:
    sock = socket.create_connection(('127.0.0.1', int(os.environ['STILL_DEBUG_PORT'])))
    reader = sock.makefile('r', encoding='utf-8'); writer = sock.makefile('w', encoding='utf-8')
    def send(message):
        writer.write(json.dumps(message) + '\n'); writer.flush()
    def receive():
        line = reader.readline()
        if not line: raise SystemExit(0)
        return json.loads(line)
short = reprlib.Repr(); short.maxstring = 160; short.maxother = 160; short.maxlist = 12; short.maxdict = 12; short.maxlevel = 3
def rel(path):
    full = os.path.realpath(path)
    return os.path.relpath(full, root).replace(os.sep, '/') if full.startswith(root + os.sep) else full
def mine(path):
    full = os.path.realpath(path)
    return full.startswith(root + os.sep) and '/site-packages/' not in full.replace(os.sep, '/') and '/.venv/' not in full.replace(os.sep, '/')
def describe(name, value):
    kind = type(value).__name__
    try: text = short.repr(value)
    except Exception as error: text = '<unprintable: %s>' % error
    size = ''
    try:
        if isinstance(value, (list, tuple, dict, set, str, bytes)): size = str(len(value))
    except Exception: pass
    return {'name': name, 'type': kind, 'value': text, 'size': size}
def interesting(name, value):
    return not (name.startswith('__') and name.endswith('__')) and not isinstance(value, types.ModuleType) and not (isinstance(value, (types.FunctionType, type)) and getattr(value, '__module__', '') != '__main__')
class Driver(bdb.Bdb):
    def __init__(self):
        bdb.Bdb.__init__(self)
        self.started = False; self.watches = []; self.frames = []
    def user_line(self, frame):
        if not self.started:
            self.started = True
            if not self.entry: self.set_continue(); return
        if not mine(frame.f_code.co_filename): self.set_step(); return
        self.pause(frame, 'breakpoint' if self.get_breaks(self.canonic(frame.f_code.co_filename), frame.f_lineno) else 'step')
    def user_exception(self, frame, info):
        if not mine(frame.f_code.co_filename): return
        kind, value, _ = info
        if kind in (StopIteration, GeneratorExit, KeyboardInterrupt, SystemExit): return
        self.pause(frame, 'exception', '%s: %s' % (kind.__name__, value))
    def pause(self, frame, reason, detail=''):
        stack, index = self.get_stack(frame, None)
        self.frames = [entry for entry in stack if mine(entry[0].f_code.co_filename)]
        self.report(len(self.frames) - 1, reason, detail)
        while True:
            command = receive()
            op = command.get('op')
            if op == 'continue': self.set_continue(); return
            if op == 'next': self.set_next(frame); return
            if op == 'step': self.set_step(); return
            if op == 'out': self.set_return(frame); return
            if op == 'stop': self.set_quit(); return
            if op == 'frame': self.report(int(command.get('index', 0)), reason, detail)
            elif op == 'breakpoints': self.breakpoints(command.get('items', []))
            elif op == 'watches': self.watches = list(command.get('items', [])); self.report(self.selected, reason, detail)
            elif op == 'eval':
                target = self.frames[self.selected][0] if self.frames else frame
                try:
                    try: result = eval(command.get('expression', ''), target.f_globals, target.f_locals); value = describe('', result)['value']
                    except SyntaxError: exec(command.get('expression', ''), target.f_globals, target.f_locals); value = ''
                    send({'event': 'eval', 'expression': command.get('expression', ''), 'value': value, 'ok': True})
                except Exception as error:
                    send({'event': 'eval', 'expression': command.get('expression', ''), 'value': '%s: %s' % (type(error).__name__, error), 'ok': False})
    def report(self, index, reason, detail):
        index = max(0, min(index, len(self.frames) - 1)) if self.frames else 0
        self.selected = index
        if not self.frames: return
        frame, line = self.frames[index]
        local = [describe(name, value) for name, value in frame.f_locals.items() if interesting(name, value)]
        globs = [] if frame.f_globals is frame.f_locals else [describe(name, value) for name, value in frame.f_globals.items() if interesting(name, value)]
        watched = []
        for expression in self.watches:
            try: watched.append(dict(describe(expression, eval(expression, frame.f_globals, frame.f_locals)), ok=True))
            except Exception as error: watched.append({'name': expression, 'type': '', 'value': '%s: %s' % (type(error).__name__, error), 'size': '', 'ok': False})
        top = self.frames[-1]
        send({'event': 'stopped', 'reason': reason, 'detail': detail, 'file': rel(top[0].f_code.co_filename), 'line': top[1],
              'frame': index, 'frameFile': rel(frame.f_code.co_filename), 'frameLine': line,
              'stack': [{'name': entry[0].f_code.co_name if entry[0].f_code.co_name != '<module>' else '(module)', 'file': rel(entry[0].f_code.co_filename), 'line': entry[1]} for entry in self.frames],
              'locals': local[:300], 'globals': globs[:300], 'watches': watched})
    def breakpoints(self, items):
        self.clear_all_breaks()
        for item in items:
            path = os.path.join(root, item['file']) if not os.path.isabs(item['file']) else item['file']
            if self.set_break(self.canonic(path), int(item['line'])): pass
setup = receive()
driver = Driver()
driver.entry = bool(setup.get('stopOnEntry'))
driver.breakpoints(setup.get('breakpoints', []))
driver.watches = list(setup.get('watches', []))
target = os.path.abspath(sys.argv[1])
sys.argv = sys.argv[1:]
sys.path.insert(0, os.path.dirname(target))
source = open(target, 'rb').read()
code = compile(source, target, 'exec')
scope = {'__name__': '__main__', '__file__': target, '__builtins__': __builtins__}
send({'event': 'started'})
try:
    driver.run(code, scope)
except bdb.BdbQuit:
    pass
except SystemExit:
    raise
except BaseException:
    traceback.print_exc()
    sys.exit(1)
finally:
    try: send({'event': 'ended'})
    except Exception: pass
"#;

/// Each running debug session takes commands from the panel through a channel: the Python driver
/// gets them over its socket, the Java session turns them into jdb commands.
#[derive(Default, Clone)]
pub struct Debuggers(pub Arc<Mutex<HashMap<String, mpsc::Sender<serde_json::Value>>>>);

#[derive(Deserialize)]
pub struct Breakpoint {
    file: String,
    line: u32,
}

/// Runs a Python or Java file under the debugger. Output streams to the Output pane like a normal run;
/// pauses, stacks and variables arrive as `debug-event`s.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn debug_start(
    app: AppHandle,
    jobs: State<Jobs>,
    root_path: String,
    path: String,
    id: String,
    breakpoints: Vec<Breakpoint>,
    watches: Vec<String>,
    stop_on_entry: bool,
    args: Option<String>,
) -> Result<()> {
    let cwd = root(&root_path)?;
    let file = resolve(&cwd, &path)?;
    relative(&path)?;
    let args = parse_args(args)?;
    if path.ends_with(".java") {
        let (sender, commands) = mpsc::channel();
        app.state::<Debuggers>().0.lock().map_err(err)?.insert(id.clone(), sender);
        let setup = serde_json::json!({
            "breakpoints": breakpoints.iter().map(|item| serde_json::json!({ "file": item.file, "line": item.line })).collect::<Vec<_>>(),
            "watches": watches,
            "stopOnEntry": stop_on_entry,
        });
        let events = app.clone();
        let sessions = app.state::<Debuggers>().inner().clone();
        let session_id = id.clone();
        return jobs.start(app, id, true, move |job| {
            let result = crate::jdebug::run(job, events, session_id.clone(), &cwd, &file, &path, setup, &args, commands);
            if let Ok(mut map) = sessions.0.lock() { map.remove(&session_id); }
            result
        });
    }
    if !path.ends_with(".py") {
        return Err("The debugger works with Python and Java files.".into());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    let setup = serde_json::json!({
        "breakpoints": breakpoints.iter().map(|item| serde_json::json!({ "file": item.file, "line": item.line })).collect::<Vec<_>>(),
        "watches": watches,
        "stopOnEntry": stop_on_entry,
    });
    // The driver connects back once; its messages become events for the window.
    let sessions = app.state::<Debuggers>().inner().clone();
    let events = app.clone();
    let session_id = id.clone();
    thread::spawn(move || {
        let _ = listener.set_nonblocking(false);
        let Ok((stream, _)) = listener.accept() else { return };
        let Ok(mut writer) = stream.try_clone() else { return };
        let _ = writer.write_all(format!("{setup}\n").as_bytes());
        let (sender, commands) = mpsc::channel::<serde_json::Value>();
        if let Ok(mut map) = sessions.0.lock() {
            map.insert(session_id.clone(), sender);
        }
        thread::spawn(move || {
            for command in commands {
                if writer.write_all(format!("{command}\n").as_bytes()).is_err() { break }
            }
        });
        for line in BufReader::new(stream).lines() {
            let Ok(line) = line else { break };
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&line) {
                value["id"] = serde_json::Value::String(session_id.clone());
                let _ = events.emit("debug-event", value);
            }
        }
        if let Ok(mut map) = sessions.0.lock() {
            map.remove(&session_id);
        }
        let _ = events.emit("debug-event", serde_json::json!({ "id": session_id, "event": "ended" }));
    });
    let root_for_driver = cwd.clone();
    jobs.start(app, id, true, move |job| {
        let (program, _, _) = python(&cwd).ok_or("Python 3 was not found on PATH or in .venv.")?;
        let mut cmd = command(program, &cwd);
        cmd.env("PYTHONIOENCODING", "utf-8")
            .env("STILL_DEBUG_PORT", port.to_string())
            .env("STILL_DEBUG_ROOT", &root_for_driver)
            .args(["-u", "-c", DRIVER])
            .arg(&file)
            .args(&args);
        job.emit("command", format!("$ debug {path}\n"));
        let (code, _) = job.run(&mut cmd, false)?;
        Ok((code, Vec::new()))
    })
}

/// Sends a command to a paused program: continue, next, step, out, stop, frame, eval, watches, breakpoints.
#[tauri::command]
pub fn debug_send(state: State<Debuggers>, id: String, command: serde_json::Value) -> Result<()> {
    let map = state.0.lock().map_err(err)?;
    if let Some(sender) = map.get(&id) {
        let _ = sender.send(command);
    }
    Ok(())
}
