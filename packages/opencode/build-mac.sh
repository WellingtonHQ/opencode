#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Installing dependencies ==="
cd "$SCRIPT_DIR/.."
bun install

echo "=== Building ==="
cd "$SCRIPT_DIR"
bun run build --single

echo "=== Installing ==="
BIN=""
for f in "$SCRIPT_DIR"/dist/opencode-darwin-*/bin/opencode; do
    if [[ -f "$f" ]]; then BIN="$f"; break; fi
done
if [[ -z "$BIN" ]]; then
    echo "ERROR: no built binary found under dist/opencode-darwin-*/bin" >&2
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
