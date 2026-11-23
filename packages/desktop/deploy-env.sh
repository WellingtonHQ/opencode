#!/bin/sh
# deploy-env.sh — sync OPENCODE_* and LLAMA_* vars from .env into:
#
#   1. The opencode service store (~/.config/opencode/service.json)
#      The backend service reads this file on startup and self-injects it
#      into its own process.env. We also stop the running service so the
#      next desktop launch spawns a fresh one that picks up the new values.
#
#   2. The macOS GUI session via `launchctl setenv` (persisted in a
#      LaunchAgent). This makes the vars available to the desktop app
#      process itself.
#
#   sh deploy-env.sh [path/to/.env]     (defaults to .env next to this script)
#
# Re-run any time you change a value in .env. Then quit + relaunch OpenCode.

set -eu

script_dir=$(cd "$(dirname "$0")" && pwd)
env_file=${1:-"$script_dir/.env"}
plist="$HOME/Library/LaunchAgents/com.opencode.desktop.env.plist"
label="com.opencode.desktop.env"
domain="gui/$(id -u)"
service_config="$HOME/.config/opencode/service.json"
service_state="$HOME/.local/state/opencode/service.json"

[ -f "$env_file" ] || { echo "error: no .env at $env_file" >&2; exit 1; }

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

cmd=""
keys=""
while IFS='=' read -r key value; do
  case "$key" in OPENCODE_*|LLAMA_*|WELLISEARCH_*) ;; *) continue ;; esac
  [ -n "${value:-}" ] || continue
  keys="$keys $key"
  cmd="${cmd:+${cmd} &amp;&amp; }launchctl setenv ${key} $(xml_escape "$(shell_quote "$value")")"
done <<EOF
$(grep -Ev '^[[:space:]]*(#|$)' "$env_file" || true)
EOF

[ -n "$cmd" ] || { echo "error: no OPENCODE_*/LLAMA_* vars found in $env_file" >&2; exit 1; }

# --- 1. Sync into the service store (service.json) ---
# Merge each key/value into the env object of ~/.config/opencode/service.json.
mkdir -p "$(dirname "$service_config")"
if [ ! -f "$service_config" ]; then
  printf '{\n  "env": {}\n}\n' > "$service_config"
fi
chmod 600 "$service_config"

for key in $keys; do
  value=$(grep -E "^${key}=" "$env_file" | head -1 | cut -d'=' -f2-)
  python3 - "$service_config" "$key" "$value" <<'PYEOF'
import json, sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    data = json.load(f)
data.setdefault("env", {})[key] = value
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYEOF
done

# --- 2. Stop the running background service so the next launch is fresh ---
if [ -f "$service_state" ]; then
  pid=$(python3 -c "import json; print(json.load(open('$service_state')).get('pid',''))" 2>/dev/null)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "stopping background service (pid $pid)…"
    kill "$pid" 2>/dev/null || true
    # Give it a moment to shut down.
    i=0
    while [ $i -lt 10 ] && kill -0 "$pid" 2>/dev/null; do
      i=$((i + 1))
      sleep 0.5
    done
  fi
  rm -f "$service_state"
fi

# --- 3. Write the LaunchAgent plist for the GUI session ---
mkdir -p "$(dirname "$plist")"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$label</string>
	<key>RunAtLoad</key>
	<true/>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>-c</string>
		<string>$cmd</string>
	</array>
</dict>
</plist>
EOF
chmod 600 "$plist"

launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"

echo "--- configured session variables ---"
for key in $keys; do
  printf '%s\n' "$key"
done
echo "done — quit + relaunch OpenCode to pick up the new values."
