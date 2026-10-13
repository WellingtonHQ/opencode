#!/bin/sh
# deploy-env.sh — sync OPENCODE_* vars from .env into the macOS GUI session and
# the persistent LaunchAgent at ~/Library/LaunchAgents/com.opencode.desktop.env.plist.
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
  case "$key" in OPENCODE_*) ;; *) continue ;; esac
  [ -n "${value:-}" ] || continue
  cmd="${cmd:+${cmd} &amp;&amp; }launchctl setenv ${key} $(xml_escape "$(shell_quote "$value")")"
  keys="$keys $key"
done <<EOF
$(grep -Ev '^[[:space:]]*(#|$)' "$env_file" || true)
EOF

[ -n "$cmd" ] || { echo "error: no OPENCODE_* vars found in $env_file" >&2; exit 1; }

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
