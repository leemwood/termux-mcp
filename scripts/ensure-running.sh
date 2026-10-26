#!/data/data/com.termux/files/usr/bin/bash
# Quietly ensure the daemon is running. Intended for login hooks:
# it exits immediately when the service is already up or autostart is disabled.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/termux-mcp"
PID_FILE="$STATE_DIR/server.pid"
PORT_FILE="$STATE_DIR/server.port"
FLAG_FILE="$STATE_DIR/autostart.disabled"
LOG_FILE="$STATE_DIR/autostart.log"

[ -f "$FLAG_FILE" ] && exit 0

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
  exit 0
fi

PORT="$(cat "$PORT_FILE" 2>/dev/null || echo 8770)"
if curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  exit 0
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true
{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] autostart"
  "$DIR/scripts/start.sh"
} >>"$LOG_FILE" 2>&1
chmod 600 "$LOG_FILE" 2>/dev/null || true
exit 0
