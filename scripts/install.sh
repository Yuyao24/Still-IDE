#!/bin/sh
# Build and install Still from source on macOS or Linux.
#
#   sh scripts/install.sh          macOS: Still.app in /Applications (or ~/Applications)
#                                  Linux: ~/.local/bin/still-ide plus a menu entry (no sudo)
#   sh scripts/install.sh --deb    Linux: build a .deb package and install it with sudo
#
# Remove everything again with: sh uninstall/uninstall.sh

set -eu
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
MODE="user"
[ "${1:-}" = "--deb" ] && MODE="deb"

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\n%s\n' "$*" >&2; exit 1; }

say "Checking prerequisites"
command -v node >/dev/null 2>&1 || fail "Node.js 22.12 or newer is required: https://nodejs.org"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || fail "Node.js $(node -v) is too old. Install 22.12 or newer: https://nodejs.org"
command -v cargo >/dev/null 2>&1 || fail "Rust is required. Install it with:
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
then open a new terminal and run this script again."

OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  xcode-select -p >/dev/null 2>&1 || fail "Install the Xcode command line tools first: xcode-select --install"
else
  if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    fail "Still needs the WebKitGTK development libraries. Install them, then run this script again:
  Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  Fedora:        sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel
  Arch:          sudo pacman -S webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg"
  fi
fi
for tool in git python3 java ssh; do
  command -v "$tool" >/dev/null 2>&1 || printf '    note: %s was not found; Still works without it, but related features stay off.\n' "$tool"
done

say "Installing JavaScript dependencies"
npm ci

if [ "$OS" = "Darwin" ]; then
  say "Building Still.app (this takes a few minutes the first time)"
  npm run tauri -- build --bundles app
  APP="$ROOT/src-tauri/target/release/bundle/macos/Still.app"
  [ -d "$APP" ] || fail "The build did not produce $APP"
  TARGET="/Applications"
  [ -w "$TARGET" ] || TARGET="$HOME/Applications"
  mkdir -p "$TARGET"
  rm -rf "$TARGET/Still.app"
  cp -R "$APP" "$TARGET/"
  say "Installed $TARGET/Still.app"
  echo "Open it from Launchpad or Spotlight."
elif [ "$MODE" = "deb" ]; then
  say "Building the .deb package"
  npm run tauri -- build --bundles deb
  DEB="$(ls -t "$ROOT"/src-tauri/target/release/bundle/deb/*.deb | head -n 1)"
  sudo apt install -y "$DEB"
  say "Installed $(basename "$DEB")"
else
  say "Building Still (this takes a few minutes the first time)"
  npm run tauri -- build --no-bundle
  BIN="$ROOT/src-tauri/target/release/still-ide"
  [ -x "$BIN" ] || fail "The build did not produce $BIN"
  DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
  mkdir -p "$HOME/.local/bin" "$DATA_HOME/applications" "$DATA_HOME/icons/hicolor/128x128/apps"
  install -m 755 "$BIN" "$HOME/.local/bin/still-ide"
  install -m 644 "$ROOT/src-tauri/icons/icon.png" "$DATA_HOME/icons/hicolor/128x128/apps/dev.still.editor.png"
  cat > "$DATA_HOME/applications/dev.still.editor.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Still
Comment=A calm, keyboard-centric code editor
Exec=$HOME/.local/bin/still-ide
Icon=dev.still.editor
Terminal=false
Categories=Development;IDE;TextEditor;
StartupWMClass=still-ide
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true
  say "Installed $HOME/.local/bin/still-ide"
  echo "Launch Still from your applications menu, or run: still-ide"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Tip: add ~/.local/bin to your PATH to start it from a terminal." ;; esac
fi

echo ""
echo "To uninstall later: Settings → About & uninstall, or run: sh \"$ROOT/uninstall/uninstall.sh\""
