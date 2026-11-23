# Still

Still is a calm, keyboard-centric desktop code editor built with Tauri 2, Rust,
React, TypeScript and Tailwind CSS. It runs Python, Java, JavaScript, Go and
shell files, has a real terminal, Git, a package manager panel, SSH remotes, and
17 built-in themes you can customize.

**Install and uninstall instructions are in [INSTALL.md](INSTALL.md).**

## What's inside

**Look.** Neutral white or near-black, IBM Plex Sans and Mono, square corners
and thin hairlines. Motion is short and quiet: underlines draw in, islands fade
up, the caret glides between lines.

**Home.** One centred column. Continue takes you back to the file and line you
were on; Projects lists everything in your projects folder and projects kept
elsewhere; Today shows the latest entries from your journal; servers sit on one
line at the bottom. Create a project from a template (Python, Java, JavaScript,
empty, or the Orbit Lab sample), open any folder, or clone a Git repository.

**Islands.** The workbench is a set of separate panels on a white page: Files
(or Search, Git, Packages, Servers) on the left, the editor in the middle, the
graph on the right and the terminal below. The underlined names at the top show
or hide each one. On narrow windows the graph steps aside by itself.

**Overview.** Ctrl/Cmd + ↑ shows every island and your recent projects at once.
Click or press Enter to jump, Delete to hide or show an island, and pick a
layout (Classic, Code and graph, Review, Writing, Focus, or one you saved).

**Focus.** Ctrl/Cmd + . hides everything but the code. The file's name sits
large in the background, lines other than the current one are dimmed, and a thin
timeline on the right marks where you edited this session (click a mark to go
back there). Esc shows everything again.

**Graph.** Still reads imports (Python, JavaScript/TypeScript, Java, Kotlin) and
Markdown links to see how files connect. The right island shows the files around
the one you are editing; Open graph shows the whole project, the files around
this one, or only changed files, with tests, packages and data files on or off.

**Journal and idle screen.** Saves, runs and commits are noted in a journal on
this computer (turn it off in Settings → Editor). After a few minutes without
input an idle screen shows drifting code, one excerpt at a time, the time and
today's numbers; any key brings you back.

**Editor.** CodeMirror 6 with syntax highlighting for Python, Java, JavaScript,
TypeScript, JSX, HTML, CSS, JSON, Markdown, Rust, C/C++, Go, Kotlin, C#, Ruby,
SQL, YAML, TOML, XML, shell, PowerShell, Dockerfiles and more. Multiple tabs,
outline, breadcrumbs, find and replace, bracket matching, autocomplete, auto
save, and inline or side-by-side diffs.

**Markdown and text.** `.md`, `.txt` and `.text` files have Edit, Split and
Preview views (Ctrl/Cmd + Shift + V cycles them). The preview renders tables,
task lists and code blocks, and opens web links in your browser.

**Code images.** Select some code and click the camera button (or run "Create
image of selected code" from the palette) to get a framed image in your theme's
colours. Copy it or save it as a PNG.

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
| Ctrl/Cmd + Shift + V | Markdown/text: edit, split, preview |
| Ctrl/Cmd + F | Find in file |
| Ctrl/Cmd + Shift + F | Find in all files |
| Ctrl/Cmd + ↑ | Overview (Esc or Ctrl/Cmd + ↓ to return) |
| Ctrl/Cmd + . | Focus mode (Esc to leave) |
| Ctrl/Cmd + B | Show or hide the left island |
| Ctrl/Cmd + J | Show or hide the terminal island |
| Ctrl/Cmd + Shift + ` | New terminal |
| Ctrl/Cmd + Shift + E / G | Files / Git |
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
