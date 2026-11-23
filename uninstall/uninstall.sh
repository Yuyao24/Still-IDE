#!/bin/sh
# Still uninstaller for macOS and Linux.
#
# Removes the Still application and everything Still wrote to this computer:
# settings, saved servers, themes, web view storage, caches, logs, desktop
# entries and icons. It never deletes project folders. Code that earlier
# versions kept inside Still's data folder is moved to ~/Still Rescued Projects.
#
# Usage: sh uninstall.sh [--dry-run] [--yes] [--source DIR]
#   --dry-run     List what would be removed and change nothing.
#   --yes         Do not ask for confirmation.
#   --source DIR  Also delete build output (node_modules, dist, target) in a
#                 Still source checkout. The source code itself is kept.
# Still passes --wait-pid, --app-path, --appimage and --notify when you
# uninstall from Settings.

set -u
IDENTIFIER="dev.still.editor"
BINARY="still-ide"
PRODUCT="Still"

DRY_RUN=0 YES=0 NOTIFY=0 WAIT_PID="" APP_PATH="" APPIMAGE_PATH="" SOURCE_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) YES=1 ;;
    --notify) NOTIFY=1 ;;
    --wait-pid) shift; WAIT_PID="${1:-}" ;;
    --app-path) shift; APP_PATH="${1:-}" ;;
    --appimage) shift; APPIMAGE_PATH="${1:-}" ;;
    --source) shift; SOURCE_DIR="${1:-}" ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -n "${HOME:-}" ] && [ "$HOME" != "/" ] || { echo "HOME is not set; stopping." >&2; exit 1; }
OS="$(uname -s)"
REMOVE_LIST=""
FAILED=0

say() { printf '%s\n' "$*"; }

# Only paths that clearly belong to Still may be deleted.
safe_target() {
  case "$1" in
    ""|"/"|"$HOME"|"$HOME/") return 1 ;;
  esac
  printf '%s' "$1" | grep -qi 'still' || return 1
  return 0
}

add() {
  for candidate in "$@"; do
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
      if safe_target "$candidate"; then
        case "
$REMOVE_LIST
" in *"
$candidate
"*) ;; *) REMOVE_LIST="${REMOVE_LIST}${REMOVE_LIST:+
}$candidate" ;; esac
      fi
    fi
  done
}

json_value() { # json_value KEY FILE
  sed -n "s/^[[:space:]]*\"$1\":[[:space:]]*\"\(.*\)\",\{0,1\}[[:space:]]*$/\1/p" "$2" 2>/dev/null
}

# ---- Locate Still's files ---------------------------------------------------
if [ "$OS" = "Darwin" ]; then
  SUPPORT="$HOME/Library/Application Support/$IDENTIFIER"
  CONFIG_FILE="$SUPPORT/config.json"
  DATA_DIRS="$SUPPORT"
  add "$SUPPORT" \
      "$HOME/Library/Caches/$IDENTIFIER" "$HOME/Library/Caches/$BINARY" \
      "$HOME/Library/WebKit/$IDENTIFIER" "$HOME/Library/WebKit/$BINARY" \
      "$HOME/Library/HTTPStorages/$IDENTIFIER" "$HOME/Library/HTTPStorages/$IDENTIFIER.binarycookies" \
      "$HOME/Library/Preferences/$IDENTIFIER.plist" \
      "$HOME/Library/Saved Application State/$IDENTIFIER.savedState" \
      "$HOME/Library/Logs/$IDENTIFIER"
  is_still_bundle() {
    [ -d "$1" ] && [ "$(defaults read "$1/Contents/Info" CFBundleIdentifier 2>/dev/null)" = "$IDENTIFIER" ]
  }
  BUNDLES=""
  if [ -n "$APP_PATH" ]; then
    case "$APP_PATH" in *.app/Contents/MacOS/*) BUNDLES="${APP_PATH%%.app/Contents/MacOS/*}.app" ;; esac
  fi
  for bundle in "$BUNDLES" "/Applications/$PRODUCT.app" "$HOME/Applications/$PRODUCT.app"; do
    [ -n "$bundle" ] && is_still_bundle "$bundle" && add "$bundle"
  done
else
  CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
  DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
  CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
  CONFIG_FILE="$CONFIG_HOME/$IDENTIFIER/config.json"
  DATA_DIRS="$DATA_HOME/$IDENTIFIER"
  add "$CONFIG_HOME/$IDENTIFIER" "$CONFIG_HOME/$BINARY" \
      "$DATA_HOME/$IDENTIFIER" "$DATA_HOME/$BINARY" \
      "$CACHE_HOME/$IDENTIFIER" "$CACHE_HOME/$BINARY" \
      "$HOME/.local/bin/$PRODUCT.AppImage" "$HOME/.local/bin/$BINARY" \
      "$DATA_HOME/applications/$IDENTIFIER.desktop"
  for icon in "$DATA_HOME"/icons/hicolor/*/apps/"$IDENTIFIER".png "$DATA_HOME"/icons/hicolor/*/apps/"$BINARY".png; do
    add "$icon"
  done
  # Desktop entries created by AppImage integration tools.
  for entry in "$DATA_HOME"/applications/*.desktop; do
    [ -f "$entry" ] || continue
    grep -qE "^Exec=.*($BINARY|$PRODUCT[^/ ]*\.AppImage)" "$entry" 2>/dev/null && add "$entry"
  done
  if [ -n "$APPIMAGE_PATH" ]; then
    case "$APPIMAGE_PATH" in *.AppImage|*.appimage) add "$APPIMAGE_PATH" ;; esac
  fi
fi
# SSH connection-sharing sockets (owned by this user only).
for leftover in /tmp/still-ssh-*; do [ -d "$leftover" ] && [ -O "$leftover" ] && add "$leftover"; done
for leftover in "${TMPDIR:-/tmp}"/still-uninstall-*.sh; do [ "$leftover" = "$0" ] || add "$leftover"; done

PACKAGE="" PACKAGE_TOOL=""
if [ "$OS" != "Darwin" ]; then
  for binary in "/usr/bin/$BINARY" "/usr/local/bin/$BINARY"; do
    [ -e "$binary" ] || continue
    if command -v dpkg >/dev/null 2>&1 && owner="$(dpkg -S "$binary" 2>/dev/null)"; then
      PACKAGE="${owner%%:*}"; PACKAGE_TOOL="dpkg"; break
    elif command -v rpm >/dev/null 2>&1 && owner="$(rpm -qf "$binary" 2>/dev/null)"; then
      PACKAGE="$owner"; PACKAGE_TOOL="rpm"; break
    fi
  done
fi

# ---- Folders that are kept --------------------------------------------------
KEEP_LIST=""
if [ -f "$CONFIG_FILE" ]; then
  ROOT="$(json_value projectsRoot "$CONFIG_FILE")"
  [ -n "$ROOT" ] && KEEP_LIST="$ROOT"
  OTHERS="$(json_value path "$CONFIG_FILE")"
  [ -n "$OTHERS" ] && KEEP_LIST="${KEEP_LIST}${KEEP_LIST:+
}$OTHERS"
fi
RESCUE_FROM="$DATA_DIRS/orbit-lab"
RESCUE_TO="$HOME/Still Rescued Projects"

# ---- Report -----------------------------------------------------------------
say "Still uninstaller"
say ""
if [ -n "$PACKAGE" ]; then
  say "PACKAGE $PACKAGE_TOOL $PACKAGE"
fi
if [ -n "$REMOVE_LIST" ]; then
  printf '%s\n' "$REMOVE_LIST" | while IFS= read -r item; do say "REMOVE $item"; done
fi
if [ -d "$RESCUE_FROM" ]; then
  say "RESCUE $RESCUE_FROM -> $RESCUE_TO/orbit-lab"
fi
if [ -n "$KEEP_LIST" ]; then
  printf '%s\n' "$KEEP_LIST" | sort -u | while IFS= read -r item; do [ -n "$item" ] && say "KEEP $item"; done
fi
if [ -n "$SOURCE_DIR" ]; then
  if grep -q "$IDENTIFIER" "$SOURCE_DIR/src-tauri/tauri.conf.json" 2>/dev/null; then
    for build in node_modules dist src-tauri/target src-tauri/gen; do
      [ -e "$SOURCE_DIR/$build" ] && say "REMOVE $SOURCE_DIR/$build"
    done
  else
    say "SKIP $SOURCE_DIR is not a Still source checkout"
    SOURCE_DIR=""
  fi
fi
if [ -z "$REMOVE_LIST" ] && [ -z "$PACKAGE" ] && [ -z "$SOURCE_DIR" ] && [ ! -d "$RESCUE_FROM" ]; then
  say "NOTHING Still is not installed for this user."
fi
[ "$DRY_RUN" = 1 ] && exit 0

if [ "$YES" != 1 ]; then
  printf '\nRemove everything listed above? Projects are kept. [y/N] '
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) say "Nothing was changed."; exit 0 ;; esac
fi

# ---- Uninstall --------------------------------------------------------------
if [ -n "$WAIT_PID" ]; then
  tries=0
  while kill -0 "$WAIT_PID" 2>/dev/null && [ $tries -lt 150 ]; do sleep 0.2; tries=$((tries + 1)); done
fi

if [ -d "$RESCUE_FROM" ]; then
  mkdir -p "$RESCUE_TO" && mv "$RESCUE_FROM" "$RESCUE_TO/orbit-lab" 2>/dev/null \
    || { mkdir -p "$RESCUE_TO/orbit-lab" && cp -R "$RESCUE_FROM/." "$RESCUE_TO/orbit-lab/"; }
  [ -d "$RESCUE_TO/orbit-lab" ] && say "Moved Orbit Lab to $RESCUE_TO/orbit-lab" || { say "Could not move $RESCUE_FROM; stopping so no code is lost."; exit 1; }
fi

if [ -n "$PACKAGE" ]; then
  if [ "$PACKAGE_TOOL" = "dpkg" ]; then remove_cmd="dpkg -r $PACKAGE"; else remove_cmd="rpm -e $PACKAGE"; fi
  if [ "$(id -u)" = 0 ]; then sh -c "$remove_cmd"
  elif [ -t 0 ] && command -v sudo >/dev/null 2>&1; then sudo sh -c "$remove_cmd"
  elif command -v pkexec >/dev/null 2>&1; then pkexec sh -c "$remove_cmd"
  else false; fi || { FAILED=1; say "Could not remove the $PACKAGE package. Run: sudo $remove_cmd"; }
fi

printf '%s\n' "$REMOVE_LIST" | while IFS= read -r item; do
  [ -n "$item" ] || continue
  safe_target "$item" || continue
  if rm -rf -- "$item" 2>/dev/null || [ ! -e "$item" ]; then
    say "Removed $item"
  elif [ "$OS" = "Darwin" ] && case "$item" in *.app) true ;; *) false ;; esac; then
    escaped="$(printf '%s' "$item" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    osascript -e "do shell script \"rm -rf \\\"$escaped\\\"\" with administrator privileges" >/dev/null 2>&1 \
      && say "Removed $item" || say "Could not remove $item"
  else
    say "Could not remove $item"
  fi
done

if [ "$OS" = "Darwin" ]; then
  defaults delete "$IDENTIFIER" >/dev/null 2>&1 || true
else
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "${XDG_DATA_HOME:-$HOME/.local/share}/applications" >/dev/null 2>&1
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" >/dev/null 2>&1
fi

if [ -n "$SOURCE_DIR" ]; then
  for build in node_modules dist src-tauri/target src-tauri/gen; do
    [ -e "$SOURCE_DIR/$build" ] && rm -rf -- "${SOURCE_DIR:?}/$build" && say "Removed $SOURCE_DIR/$build"
  done
fi

message="Still was removed. Your projects were not touched."
[ "$FAILED" = 1 ] && message="Still's files were removed, but the system package needs: sudo ${remove_cmd:-}"
say ""
say "$message"
if [ "$NOTIFY" = 1 ]; then
  if [ "$OS" = "Darwin" ]; then
    osascript -e "display notification \"$message\" with title \"Still\"" >/dev/null 2>&1 || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "Still" "$message" >/dev/null 2>&1 || true
  fi
fi
case "$0" in "${TMPDIR:-/tmp}"/still-uninstall-*|/tmp/still-uninstall-*) rm -f -- "$0" ;; esac
# The in-app uninstall logs to a temporary file; keep it only if something failed.
[ "$FAILED" = 0 ] && [ "$NOTIFY" = 1 ] && rm -f -- "${TMPDIR:-/tmp}/still-uninstall.log"
exit 0
