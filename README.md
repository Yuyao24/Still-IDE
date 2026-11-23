# Still

Still is a local desktop code editor built with Tauri 2, Rust, React, TypeScript, and Tailwind CSS. It opens with Orbit Lab, a small Python and Java workspace.

## Start the desktop app

Install Node.js 22.12 or newer and the [Tauri desktop prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform. Windows development uses stable Rust targeting MSVC, Microsoft C++ Build Tools, and WebView2. Install Git and the language runtimes you plan to use. A Java run needs a JDK with both javac and java.

Run these from this project directory.

```sh
npm ci
npm run tauri dev
```

Use `npm run tauri build` to build the desktop bundle on the target platform. Use `npm run build` for the TypeScript check and production frontend bundle.

The separate **Still Preview.html** file opens directly in a browser. The preview supports editing, file switching, themes, resizing, and the sample Git workflow. Run, shell access, local workspace folders, and package changes use the Tauri desktop app.

## Work in Still

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd + K or P | Find workspace files and commands |
| Ctrl/Cmd + Shift + K | Open the palette in command mode |
| Ctrl/Cmd + O | Open a workspace folder |
| Ctrl/Cmd + S | Save the active file |
| Ctrl/Cmd + W | Close the active tab |
| Ctrl/Cmd + Enter | Save and run the active Python or Java file |
| Ctrl/Cmd + Shift + Enter | Check Python syntax or compile Java |
| Ctrl/Cmd + B | Toggle the sidebar |
| Ctrl/Cmd + J | Toggle the bottom drawer |
| Arrow keys on a focused divider | Resize the pane |

Python prefers the workspace `.venv`, then `VIRTUAL_ENV`, then a Python 3 executable on PATH. Java prefers `JAVA_HOME` and falls back to PATH. The Java file runner compiles into the workspace `bin/` directory and uses its package declaration to locate the main class. Javac diagnostics appear in the gutter, Problems, and the process output.

The terminal starts the system PowerShell on Windows and uses `SHELL` on macOS and Linux, with Bash as the fallback. Terminal input, output, and resizing go through a native PTY.

Source Control reads the working tree and index through Git. Click a changed file to view its inline diff. Pull uses fast-forward-only mode. Push and pull use the repository's existing remote and Git credential setup.

Packages shows workspace manifests and installed Python packages. Search looks up a package by its exact PyPI name. Install, remove, and requirements-file actions use the active interpreter's pip. The Maven action resolves dependencies and the Gradle action shows the dependency report, using a project wrapper when present.

## Project layout

- `src/` holds the React workbench, CodeMirror themes, and xterm.js bridge.
- `src-tauri/src/` holds the workspace, language runners, PTY, Git, and package commands.
- `src-tauri/sample/` holds the first-launch Orbit Lab example.
