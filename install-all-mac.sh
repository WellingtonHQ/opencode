#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOCK="$HOME/Library/Caches/opencode-build-all.lock"
mkdir -p "$(dirname "$LOCK")"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "ERROR: another build or install holds $LOCK. If no build or install is running, remove the empty lock directory." >&2
  exit 1
fi
trap 'rmdir "$LOCK"' EXIT

DESKTOP=1
RESTART=1
YES=0
for arg in "$@"; do
  case "$arg" in
    --no-desktop) DESKTOP=0 ;;
    --no-restart) RESTART=0 ;;
    --yes) YES=1 ;;
    *) echo "ERROR: unknown argument $arg (use --yes, --no-desktop or --no-restart)" >&2; exit 1 ;;
  esac
done
[[ "$(uname -s)" == Darwin ]] || { echo "ERROR: macOS is required." >&2; exit 1; }
case "$(uname -m)" in
  x86_64) CLI_TARGET=darwin-x64-baseline; APP_DIR=mac ;;
  arm64) CLI_TARGET=darwin-arm64; APP_DIR=mac-arm64 ;;
  *) echo "ERROR: unsupported architecture." >&2; exit 1 ;;
esac
LATEST="$ROOT/packages/desktop/dist/build-all-mac-latest"
[[ -f "$LATEST" ]] || { echo "ERROR: run ./build-all-mac.sh first." >&2; exit 1; }
BUILD="$(cat "$LATEST")"
CLI="$BUILD/cli/cli-$CLI_TARGET/bin/opencode"
APP="$BUILD/desktop/$APP_DIR/OpenCode Dev.app"
[[ -x "$CLI" && -d "$APP" ]] || { echo "ERROR: the latest build is incomplete; run ./build-all-mac.sh." >&2; exit 1; }
VERSION="$("$CLI" --version)"
VERSION="${VERSION#opencode v}"
BUNDLED_VERSION="$(cat "$APP/Contents/Resources/opencode-cli.version")"
[[ -n "$VERSION" && "$VERSION" == "$BUNDLED_VERSION" ]] || { echo "ERROR: CLI and packaged app versions do not match." >&2; exit 1; }
echo "Build version: $VERSION"
if (( DESKTOP )) && pgrep -f '/OpenCode Dev.app/Contents/MacOS/' >/dev/null; then
  echo "ERROR: OpenCode Dev is running. Quit it before installing the desktop app." >&2
  exit 1
fi
if (( RESTART && ! YES )); then
  echo "Restarting the background server interrupts active sessions and their terminals."
  read -r -p 'Install and restart the background server? [y/N] ' answer
  [[ "$answer" == y || "$answer" == Y ]] || { echo "Aborted; nothing was installed."; exit 0; }
fi

mkdir -p "$HOME/.opencode/bin"
CLI_TMP="$(mktemp "$HOME/.opencode/bin/.opencode.XXXXXX")"
cp "$CLI" "$CLI_TMP"
chmod 755 "$CLI_TMP"
mv -f "$CLI_TMP" "$HOME/.opencode/bin/opencode"
echo "CLI installed: $HOME/.opencode/bin/opencode"
case ":$PATH:" in
  *":$HOME/.opencode/bin:"*) ;;
  *) echo "WARNING: $HOME/.opencode/bin is not on PATH." ;;
esac
if (( DESKTOP )); then
  if [[ -d "/Applications/OpenCode Dev.app" ]]; then APP_PARENT=/Applications; else APP_PARENT="$HOME/Applications"; fi
  mkdir -p "$APP_PARENT"
  STAGE="$(mktemp -d "$APP_PARENT/.opencode-install.XXXXXX")"
  ditto "$APP" "$STAGE/OpenCode Dev.app"
  if [[ -e "$APP_PARENT/OpenCode Dev.app" ]]; then
    BACKUP="$APP_PARENT/OpenCode Dev backup $(date +%Y%m%d%H%M%S).app"
    [[ ! -e "$BACKUP" ]] || { echo "ERROR: backup already exists: $BACKUP" >&2; exit 1; }
    mv "$APP_PARENT/OpenCode Dev.app" "$BACKUP"
    echo "Previous app saved: $BACKUP"
  fi
  mv "$STAGE/OpenCode Dev.app" "$APP_PARENT/OpenCode Dev.app"
  rmdir "$STAGE"
  echo "Desktop app installed: $APP_PARENT/OpenCode Dev.app"
fi
if (( RESTART )); then
  "$HOME/.opencode/bin/opencode" service restart
  "$HOME/.opencode/bin/opencode" service status
  echo "Background service restarted."
  (( DESKTOP )) || echo "NOTE: the old desktop app may replace this service with its bundled CLI."
fi
