#!/data/data/com.termux/files/usr/bin/bash
set -u

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/termux-mcp"
PID_FILE="$STATE_DIR/server.pid"
PORT_FILE="$STATE_DIR/server.port"
FLAG_FILE="$STATE_DIR/autostart.disabled"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true
PID="$(cat "$PID_FILE" 2>/dev/null || true)"

if [ -z "${PID:-}" ] || ! kill -0 "$PID" 2>/dev/null; then
  echo "termux-mcp is not running."
  rm -f "$PID_FILE" "$PORT_FILE"
  touch "$FLAG_FILE"
  exit 0
fi

kill "$PID" 2>/dev/null || true
for _ in $(seq 1 50); do
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  sleep 0.2
done
if kill -0 "$PID" 2>/dev/null; then
  echo "termux-mcp did not stop cleanly; sending SIGKILL."
  kill -9 "$PID" 2>/dev/null || true
fi

rm -f "$PID_FILE" "$PORT_FILE"
touch "$FLAG_FILE"
if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock 2>/dev/null || true
fi
echo "termux-mcp stopped. Terminal sessions and background tasks were left running."
echo "Autostart paused. Re-enable with: $(dirname "${BASH_SOURCE[0]}")/autostart-enable.sh"
echo "Or start manually with: $(dirname "${BASH_SOURCE[0]}")/start.sh"
