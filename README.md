# Still

Still is a calm, keyboard-centric desktop code editor built with Tauri 2, Rust,
React, TypeScript and Tailwind CSS. It runs Python, Java, JavaScript, Go and
shell files, has a real terminal, Git, a package manager panel, SSH remotes, and
17 built-in themes you can customize.

**Install and uninstall instructions are in [INSTALL.md](INSTALL.md).**

## What's inside

**Home.** A clean start page in the style of Notion. Recently opened projects as
cards, every project in your projects folder plus projects kept elsewhere, and
your SSH servers. Create a project from a template (Python, Java, JavaScript,
empty, or the Orbit Lab sample), open any folder, or clone a Git repository.

**Editor.** CodeMirror 6 with syntax highlighting for Python, Java, JavaScript,
TypeScript, JSX, HTML, CSS, JSON, Markdown, Rust, C/C++, Go, Kotlin, C#, Ruby,
SQL, YAML, TOML, XML, shell, PowerShell, Dockerfiles and more. Multiple tabs,
outline, breadcrumbs, find and replace, bracket matching, autocomplete, auto
save, and inline or side-by-side diffs.

**Run.** Ctrl/Cmd + Enter runs the active file. Python uses the project's
`.venv` (or `venv`, or `VIRTUAL_ENV`) and falls back to Python 3 on PATH. Java
compiles with `javac -d bin` and shows compiler errors in the gutter and the
Problems tab. Programs can read input: type into the box under the output.
Right-click Run to pass program arguments.

**Terminal.** xterm.js on a native PTY, with as many sessions as you like.
Your default shell, or pick zsh, bash, fish, PowerShell, Command Prompt, Git
Bash or WSL in Settings.

**Git.** Changed, staged and untracked files, one-click stage and unstage (or
all at once), discard (untracked files go to the trash), commit, pull, push
(sets the upstream on first push), fetch, branch switching and creation, and
recent history.

**Packages.** Detects `requirements.txt`, `pyproject.toml`, `pom.xml` and
`build.gradle`. Search PyPI, install and remove packages, install requirements,
create a virtual environment, resolve Maven dependencies, and inspect Gradle
dependencies, with logs streamed to the Output tab.

**SSH.** Save servers (host, user, port, key, jump host, port forwards) or use
the hosts already in `~/.ssh/config`. Open a terminal on a server, or open a
folder on it as a project: browse, search, edit and save files over SSH, and
run Python, JavaScript, shell, Java, Go or Ruby files remotely. Still uses your
system's OpenSSH client, so keys, agents and known hosts work exactly as they do
in a terminal, and Still never stores passwords.

**Themes.** Still Dark and Light, One Dark and One Light (Atom), GitHub Dark and
Light, Darcula, JetBrains Dark and IntelliJ Light, Solarized Dark and Light,
Nord, Gruvbox Dark, Monokai, Dracula, Tokyo Night, and Catppuccin Mocha and
Latte. Edit any color to make your own theme, import and export themes as JSON,
and optionally follow the system's light or dark mode. Fonts, sizes, line height
and ligatures are adjustable.

## Keyboard

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd + K or P | Find files and commands |
| Ctrl/Cmd + Shift + K | Commands only |
| Ctrl/Cmd + , | Settings |
| Ctrl/Cmd + Shift + H | Home |
| Ctrl/Cmd + N | New project (on Home) |
| Ctrl/Cmd + O | Open a folder |
| Ctrl/Cmd + S / Shift + S | Save / save all |
| Ctrl/Cmd + W | Close tab |
| Ctrl/Cmd + Tab / Shift + Tab | Next / previous tab |
| Ctrl/Cmd + Enter | Run the active file |
| Ctrl/Cmd + Shift + Enter | Check or compile only |
| Ctrl/Cmd + F | Find in file |
| Ctrl/Cmd + Shift + F | Find in all files |
| Ctrl/Cmd + B | Toggle the sidebar |
| Ctrl/Cmd + J | Toggle the bottom drawer |
| Ctrl/Cmd + Shift + ` | New terminal |
| Ctrl/Cmd + Shift + E / G | Explorer / Source control |
| F2 / Delete in the explorer | Rename / move to trash |

## Where Still keeps things

Settings, themes, saved servers and the list of projects live in one
`config.json` in the app's config folder (shown in **Settings → About &
uninstall**). Still writes nothing into your projects except what you ask for
(for example `bin/` from compiling Java, or a `.venv` you create).

## Development

```bash
npm ci
```

```bash
npm run tauri dev
```

`npm run build` type-checks and builds the frontend. `npm run dev` serves a
browser preview with a sample project, which is handy for UI work; running code,
terminals, Git remotes, packages and SSH need the desktop app.

- `src/` holds the React app: `App.tsx` (shell), `Home.tsx`, `Ide.tsx`
  (workbench), `SettingsView.tsx`, `themes.ts`, the editor, terminal and panels.
- `src-tauri/src/` holds the Rust backend: projects and settings, the file
  system, language runners, PTY terminals, Git, packages, SSH and the uninstaller.
- `scripts/` holds the install scripts and `uninstall/` the uninstall scripts.
