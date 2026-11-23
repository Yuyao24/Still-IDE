# Installing and uninstalling Still

Still is built from source on the computer it will run on. Building takes a few
minutes the first time and needs about 3 GB of free disk space for the Rust
build cache (you can delete it afterwards; see [Cleaning up the build](#cleaning-up-the-build)).

## Easiest: download a prebuilt installer

GitHub builds Still automatically every time the code changes, so you don't
need any developer tools on your computer:

1. Open the repository on GitHub and click **Actions → Build Still**.
2. Open the newest run with a green tick, scroll to **Artifacts**, and
   download **Still-Windows** (or Still-macOS / Still-Linux).
3. Unzip it and run `Still_…_x64-setup.exe`. It installs for your user only,
   with no administrator rights needed.

Tagged versions (like `v0.2.1`) are also published under **Releases**.
To update, download the newer installer and run it over the old one; your
settings and projects are kept.

The installers are not code-signed, so Windows SmartScreen shows "Windows
protected your PC": click **More info → Run anyway**. If Smart App Control is
on, Windows may refuse to run unsigned apps altogether.

The rest of this page is for building Still yourself.

## 1. Install the prerequisites

| | Windows 10/11 | macOS 10.15+ | Linux |
| --- | --- | --- | --- |
| Node.js 22.12+ | `winget install OpenJS.NodeJS.LTS` | [nodejs.org](https://nodejs.org) or `brew install node` | [nodejs.org](https://nodejs.org) or your package manager |
| Rust (stable) | `winget install Rustlang.Rustup` | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` | same as macOS |
| System pieces | Microsoft C++ Build Tools (see below) and WebView2 (preinstalled on Windows 11) | `xcode-select --install` | WebKitGTK dev libraries (see below) |

**Windows C++ Build Tools:**

```bash
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

**Linux libraries** (Debian/Ubuntu shown; the install script prints the Fedora and Arch equivalents):

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Optional, for the features that use them: Git, Python 3, a JDK (both `javac`
and `java`), Node.js for running `.js` files, and the OpenSSH client for remote
servers (Windows: Settings → System → Optional features → OpenSSH Client).

Open a **new** terminal after installing Rust so `cargo` is on your PATH.

## 2. Build and install

Unzip the source somewhere permanent (for example `~/src/still`), open a
terminal in that folder, and run the script for your system.

**Windows** (PowerShell):

```bash
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

This builds a per-user installer (no administrator rights needed), runs it, and
adds Still to the Start menu. Add `-Silent` to skip the installer window.

**macOS:**

```bash
sh scripts/install.sh
```

This builds `Still.app` and copies it to `/Applications` (or `~/Applications`
if `/Applications` is not writable).

**Linux:**

```bash
sh scripts/install.sh
```

This installs the app to `~/.local/bin/still-ide` with a menu entry and icon,
without `sudo`. To install a system-wide `.deb` package instead:

```bash
sh scripts/install.sh --deb
```

### Doing it by hand

The scripts only wrap these steps:

```bash
npm ci
```

```bash
npm run tauri build
```

The finished installers land in `src-tauri/target/release/bundle/`:
`nsis/*-setup.exe` and `msi/*.msi` on Windows, `macos/Still.app` and `dmg/*.dmg`
on macOS, and `deb/`, `rpm/` and `appimage/` on Linux.

To try Still without installing it, run `npm run tauri dev`.

## 3. First launch

Still opens on **Home**. Choose a **projects folder** (the suggested
`~/Projects` is fine). Every folder inside it appears on Home, and new projects
are created there.

A project can also live anywhere else:

- **New project → Location → Somewhere else** creates an individual project in
  any folder you pick.
- **Open folder** (Ctrl/Cmd + O) opens an existing folder from anywhere. Still
  remembers it under “Elsewhere on this computer” on Home.

You can change the projects folder later in **Settings → Projects**. Changing it
never moves or deletes anything.

## Uninstalling

The uninstaller removes **everything Still put on your computer** and **never
touches your code**.

| Removed | Kept |
| --- | --- |
| The app itself (installed program, `.app` bundle, `.deb` package or `~/.local/bin/still-ide`) | Your projects folder and every project in it |
| Start menu, desktop and application-menu entries, icons | Projects you created or opened elsewhere |
| Uninstall registry entries (Windows) | Your SSH keys and everything in `~/.ssh` |
| Settings, custom themes and saved servers (`config.json`) | Git, Python, Java, Node and other tools |
| Web view storage, caches and logs | The Still source folder (unless you ask, see below) |
| SSH connection-sharing sockets in the temp folder | |

Earlier versions of Still kept the Orbit Lab sample inside the app's data
folder. If it exists, the uninstaller first moves it to
`~/Still Rescued Projects/orbit-lab` so no code is lost.

### From inside Still

**Settings → About & uninstall → Review what will be removed.** Still lists every
path it will delete and every folder it will keep. Type `uninstall` to confirm.
Still quits, finishes removing itself in the background, and shows a
notification when it is done.

### With the script

Use this if Still will not start, or to remove it from a terminal. Add
`--dry-run` (macOS/Linux) or `-DryRun` (Windows) to see the list without
changing anything.

**macOS and Linux:**

```bash
sh uninstall/uninstall.sh
```

**Windows:**

```bash
powershell -ExecutionPolicy Bypass -File uninstall\uninstall.ps1
```

The script shows the same list and asks for confirmation. On Linux, removing a
`.deb` or `.rpm` package asks for your password. Windows also lists Still under
**Settings → Apps**, but that entry only removes the program; the script also
removes Still's settings and caches.

### Cleaning up the build

Building leaves `node_modules`, `dist` and the Rust build cache
(`src-tauri/target`, usually 2–4 GB) in the source folder. To delete them while
keeping the source code, add the source folder to the uninstall command:

```bash
sh uninstall/uninstall.sh --source .
```

```bash
powershell -ExecutionPolicy Bypass -File uninstall\uninstall.ps1 -Source .
```

Rust, Node.js and the system libraries are shared with other programs, so the
uninstaller leaves them alone. To remove them as well: `rustup self uninstall`
removes Rust, and Node.js and the build tools are removed like any other app.
