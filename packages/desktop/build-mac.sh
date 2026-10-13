#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Installing dependencies ==="
cd "$SCRIPT_DIR/../.."
bun install --frozen-lockfile

echo "=== Prebuilding ==="
cd "$SCRIPT_DIR"
bun run prebuild

echo "=== Building ==="
bun run build

echo "=== Packaging for macOS ==="
bun run package:mac

echo "=== Done ==="
echo "Output: dist/"
