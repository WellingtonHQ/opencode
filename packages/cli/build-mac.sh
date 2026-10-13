#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Use the repository's exact Bun version for every install and build step.
BUN_VERSION="$(sed -nE 's/.*"packageManager"[[:space:]]*:[[:space:]]*"bun@([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' "$ROOT_DIR/package.json")"
if [[ ! "$BUN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: could not read the pinned Bun version from package.json" >&2
    exit 1
fi
if [[ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]]; then
    BUN_ARCH="x64"
    if [[ "$(uname -m)" == "arm64" ]]; then BUN_ARCH="aarch64"; fi
    BUN_DIR="$HOME/Library/Caches/opencode-build-tools/bun-$BUN_VERSION-darwin-$BUN_ARCH"
    if [[ ! -f "$BUN_DIR/bun" ]]; then
        STAGE="$(mktemp -d)"
        trap 'rm -rf "$STAGE"' EXIT
        curl -fL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-darwin-$BUN_ARCH.zip" -o "$STAGE/bun.zip"
        unzip -q "$STAGE/bun.zip" -d "$STAGE"
        mkdir -p "$BUN_DIR"
        cp "$STAGE/bun-darwin-$BUN_ARCH/bun" "$BUN_DIR/bun"
        chmod 755 "$BUN_DIR/bun"
    fi
    export PATH="$BUN_DIR:$PATH"
fi
if [[ "$(bun --version)" != "$BUN_VERSION" ]]; then
    echo "ERROR: cached Bun does not match $BUN_VERSION" >&2
    exit 1
fi

echo "=== Installing dependencies ==="
cd "$ROOT_DIR"
bun install --frozen-lockfile

echo "=== Building ==="
cd "$SCRIPT_DIR"
bun run build --single --skip-install

echo "=== Installing ==="
BIN=""
for f in "$SCRIPT_DIR"/dist/cli-darwin-*/bin/opencode; do
    if [[ -f "$f" ]]; then BIN="$f"; break; fi
done
if [[ -z "$BIN" ]]; then
    echo "ERROR: no built binary found under dist/cli-darwin-*/bin" >&2
    exit 1
fi

INSTALL_DIR="$HOME/.opencode/bin"
mkdir -p "$INSTALL_DIR"
cp "$BIN" "$INSTALL_DIR/"
chmod 755 "$INSTALL_DIR/opencode"

case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) echo "WARNING: $INSTALL_DIR is not in your PATH. Add it to run \"opencode\" from any terminal." ;;
esac

echo "=== Done ==="
echo "Installed: $INSTALL_DIR/opencode"
