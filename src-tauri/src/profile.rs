//! Profiling Python files: the program runs as usual (output, input, the Stop button) while a
//! sampler records the main thread's call stack about every millisecond. The stacks come back as
//! JSON for the flame graph. Sampling keeps the overhead small and shows whole call paths.
use crate::{
    process::{command, parse_args, project_env, python, Jobs},
    workspace::{relative, resolve, root, Result},
};
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

const SAMPLER: &str = r#"
import collections, json, os, runpy, sys, threading, time
target = os.path.abspath(sys.argv[1])
out = os.environ.get('STILL_PROFILE_OUT')
root = os.path.abspath(os.environ.get('STILL_PROFILE_ROOT') or os.getcwd())
sys.argv = sys.argv[1:]
sys.path.insert(0, os.path.dirname(target))
main = threading.main_thread().ident
counts = collections.Counter()
interval = 0.001
done = threading.Event()
def place(filename):
    path = os.path.abspath(filename)
    if path.startswith(root + os.sep):
        return os.path.relpath(path, root).replace(os.sep, '/'), True
    return path, False
def sample():
    while not done.is_set():
        frame = sys._current_frames().get(main)
        stack = []
        while frame is not None:
            code = frame.f_code
            stack.append((code.co_name, code.co_filename, code.co_firstlineno))
            frame = frame.f_back
        stack.reverse()
        # Start at the program's own module: drop runpy and this sampler.
        for index, (name, filename, line) in enumerate(stack):
            if os.path.abspath(filename) == target:
                stack = stack[index:]
                break
        else:
            stack = []
        if stack:
            counts[tuple(stack)] += 1
        done.wait(interval)
sys.setswitchinterval(0.0005)
thread = threading.Thread(target=sample, daemon=True)
started = time.perf_counter()
thread.start()
code = 0
try:
    runpy.run_path(target, run_name='__main__')
except SystemExit as stop:
    code = stop.code if isinstance(stop.code, int) else (0 if stop.code is None else 1)
finally:
    done.set()
    thread.join(0.5)
    elapsed = time.perf_counter() - started
    frames, index, samples = [], {}, []
    for stack, count in counts.items():
        ids = []
        for name, filename, line in stack:
            key = (name, filename, line)
            if key not in index:
                path, mine = place(filename)
                index[key] = len(frames)
                frames.append({'name': name, 'file': path, 'line': line, 'mine': mine})
            ids.append(index[key])
        samples.append({'stack': ids, 'count': count})
    if out:
        with open(out, 'w', encoding='utf-8') as handle:
            json.dump({'elapsed': elapsed, 'interval': interval, 'frames': frames, 'samples': samples}, handle)
sys.exit(code)
"#;

/// Runs a Python file under the sampler; when it ends, sends `profile-result` with the stacks.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn profile_start(app: AppHandle, jobs: State<Jobs>, id: String, root_path: String, path: String, args: Option<String>, env: Option<String>, dotenv: Option<bool>) -> Result<()> {
    let cwd = root(&root_path)?;
    let file = resolve(&cwd, &path)?;
    if !path.ends_with(".py") || !file.is_file() {
        return Err("Profiling works with Python files.".into());
    }
    let args = parse_args(args)?;
    let vars = project_env(&cwd, dotenv.unwrap_or(true), env.as_deref());
    let out = std::env::temp_dir().join(format!("still-profile-{}.json", std::process::id()));
    let events = app.clone();
    let session = id.clone();
    jobs.start(app, id, true, move |job| {
        job.use_env(vars);
        let (program, _, _) = python(&cwd).ok_or("Python 3 was not found on PATH or in .venv.")?;
        let _ = std::fs::remove_file(&out);
        job.emit("command", format!("$ profile {path}\n"));
        let mut cmd = command(program, &cwd);
        cmd.env("PYTHONIOENCODING", "utf-8").env("STILL_PROFILE_OUT", &out).env("STILL_PROFILE_ROOT", &cwd)
            .args(["-u", "-c", SAMPLER]).arg(Path::new(".").join(relative(&path)?)).args(&args);
        let (code, _) = job.run(&mut cmd, false)?;
        match std::fs::read_to_string(&out) {
            Ok(data) => { let _ = events.emit("profile-result", serde_json::json!({ "id": session, "path": path, "data": data })); }
            Err(_) => job.emit("stderr", "The profiler didn't record anything (the program may have stopped before it started).\n".to_owned()),
        }
        let _ = std::fs::remove_file(&out);
        Ok((code, Vec::new()))
    })
}
