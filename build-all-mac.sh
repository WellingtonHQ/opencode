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

case "$(uname -m)" in
  x86_64) ARCH=x64; CLI_TARGET=darwin-x64-baseline ;;
  arm64) ARCH=arm64; CLI_TARGET=darwin-arm64 ;;
  *) echo "ERROR: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
[[ "$(uname -s)" == Darwin ]] || { echo "ERROR: macOS is required." >&2; exit 1; }
command -v bun >/dev/null || { echo "ERROR: Bun is required." >&2; exit 1; }
PINNED="$(bun -e 'console.log(require(process.argv[1]).packageManager.replace(/^bun@/, ""))' "$ROOT/package.json")"
[[ "$(bun --version)" == "$PINNED" ]] || { echo "ERROR: Bun $PINNED is required; found $(bun --version)." >&2; exit 1; }
node --version >/dev/null || { echo "ERROR: Node.js is unavailable or broken; repair it before building." >&2; exit 1; }

export OPENCODE_CHANNEL=dev
export OPENCODE_VERSION="0.0.0-dev-$(date +%Y%m%d%H%M%S)"
BUILD="$ROOT/packages/desktop/dist/build-all-$OPENCODE_VERSION"
mkdir -p "$(dirname "$BUILD")"
mkdir "$BUILD"
CLI_DIST="$BUILD/cli"
CLI_BIN="$CLI_DIST/cli-$CLI_TARGET/bin/opencode"
echo "=== Building $OPENCODE_VERSION for $ARCH ==="
cd "$ROOT"
bun install --frozen-lockfile
cd "$ROOT/packages/cli"
OPENCODE_TARGET="$CLI_TARGET" bun run build --skip-install "--outdir=$CLI_DIST"
[[ -x "$CLI_BIN" ]] || { echo "ERROR: CLI not found at $CLI_BIN" >&2; exit 1; }
cd "$ROOT/packages/desktop"
OPENCODE_CLI_DIST="$CLI_DIST" OPENCODE_TARGET="darwin-$ARCH" bun run build
OPENCODE_TARGET="darwin-$ARCH" bunx electron-builder --mac "--$ARCH" --publish never --config electron-builder.config.ts "--config.directories.output=$BUILD/desktop"
APP="$BUILD/desktop/$([[ "$ARCH" == arm64 ]] && echo mac-arm64 || echo mac)/OpenCode Dev.app"
[[ -d "$APP" && -f "$BUILD/desktop/opencode-desktop-mac-$ARCH.dmg" ]] || { echo "ERROR: desktop app or DMG missing." >&2; exit 1; }
printf '%s\n' "$BUILD" > "$ROOT/packages/desktop/dist/build-all-mac-latest"
echo "=== Build complete ==="
echo "CLI: $CLI_BIN"
echo "App: $APP"
echo "DMG: $BUILD/desktop/opencode-desktop-mac-$ARCH.dmg"
echo "Nothing was installed or restarted. Run ./install-all-mac.sh to install."
