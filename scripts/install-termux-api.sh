#!/data/data/com.termux/files/usr/bin/bash
set -u

echo "Installing the Termux:API command wrappers..."
if ! pkg install -y termux-api; then
  echo "warning: pkg install termux-api failed; fix your Termux mirror and retry." >&2
fi

cat <<'EOF'

The wrappers also require the Termux:API Android app:
  https://f-droid.org/packages/com.termux.api/

Install it from F-Droid (or the Termux:API GitHub releases), open it once, and grant
the Android permissions you want termux-mcp to use (clipboard, notifications, storage,
battery, etc.). SMS, call log, contacts, location, camera and microphone permissions are
optional and only needed if you use those termux_api commands.

Then restart the MCP server so it can see the new commands:
  scripts/stop.sh && scripts/start.sh
EOF
