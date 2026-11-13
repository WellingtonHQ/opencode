#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Installing dependencies ==="
cd "$SCRIPT_DIR/../.."
bun install --frozen-lockfile

echo "=== Building ==="
cd "$SCRIPT_DIR"
bun run build

echo "=== Packaging for macOS ==="
bunx electron-builder --mac --publish never --config electron-builder.config.ts

echo "=== Done ==="
echo "Output: dist/"
