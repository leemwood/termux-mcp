#!/data/data/com.termux/files/usr/bin/bash
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/termux-mcp"
PID_FILE="$STATE_DIR/server.pid"
PORT_FILE="$STATE_DIR/server.port"
PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -f "$PORT_FILE" ]; then
  PORT="$(cat "$PORT_FILE" 2>/dev/null || echo 8770)"
else
  PORT="$(cd "$DIR" && node src/server.js --print-port 2>/dev/null || echo 8770)"
fi

if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
  echo "termux-mcp: running (pid $PID)"
else
  echo "termux-mcp: stopped"
fi

if [ -f "$STATE_DIR/autostart.disabled" ]; then
  echo "autostart: paused (run $DIR/scripts/autostart-enable.sh)"
elif pm path com.termux.boot >/dev/null 2>&1; then
  echo "autostart: enabled (login hook + Termux:Boot)"
else
  echo "autostart: enabled (login hook; install Termux:Boot for cold boot)"
fi

echo "auth:   none (localhost only)"
echo "MCP:    http://127.0.0.1:${PORT}/mcp"
echo "SSE:    http://127.0.0.1:${PORT}/sse"
echo "Health: http://127.0.0.1:${PORT}/health"
if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null; then
  echo
fi
