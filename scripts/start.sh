#!/data/data/com.termux/files/usr/bin/bash
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/termux-mcp"
PID_FILE="$STATE_DIR/server.pid"
PORT_FILE="$STATE_DIR/server.port"
LOG_FILE="$STATE_DIR/server.log"
FLAG_FILE="$STATE_DIR/autostart.disabled"
LOCK_DIR="$STATE_DIR/start.lock"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

# Serialise concurrent starts from boot, shell hooks and manual commands.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  OLD_LOCK_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "${OLD_LOCK_PID:-}" ] && kill -0 "$OLD_LOCK_PID" 2>/dev/null; then
    exit 0
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || exit 0
fi
echo "$$" >"$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

# Accept --port/--port=N in addition to TERMUX_MCP_PORT. Exporting it makes the
# health probe and the server agree on the effective port.
PORT="${TERMUX_MCP_PORT:-}"
ARGS=("$@")
for ((i = 0; i < ${#ARGS[@]}; i++)); do
  case "${ARGS[$i]}" in
    --port)
      PORT="${ARGS[$((i + 1))]:-}"
      ;;
    --port=*)
      PORT="${ARGS[$i]#--port=}"
      ;;
  esac
done
if [ -n "${PORT:-}" ]; then
  export TERMUX_MCP_PORT="$PORT"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not installed. Install Node.js inside Termux first." >&2
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "termux-mcp is already running (pid $OLD_PID)."
    if [ -f "$PORT_FILE" ]; then
      RUNNING_PORT="$(cat "$PORT_FILE" 2>/dev/null || echo 8770)"
    else
      RUNNING_PORT="$(cd "$DIR" && node src/server.js --print-port 2>/dev/null || echo 8770)"
    fi
    echo "MCP: http://127.0.0.1:${RUNNING_PORT}/mcp"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if [ -z "${PORT:-}" ]; then
  PORT="$(cd "$DIR" && node src/server.js --print-port 2>/dev/null || echo 8770)"
fi

# An explicit start re-enables login/boot autostart.
rm -f "$FLAG_FILE"

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock 2>/dev/null || true
fi

cd "$DIR" || exit 1
nohup node src/server.js --http "$@" >>"$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" >"$PID_FILE"
echo "$PORT" >"$PORT_FILE"

HEALTH_URL="http://127.0.0.1:${PORT}/health"

READY=0
for _ in $(seq 1 100); do
  if curl -fsS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  sleep 0.2
done

if [ "$READY" -ne 1 ]; then
  echo "error: termux-mcp failed to start. Last log lines:" >&2
  tail -n 30 "$LOG_FILE" >&2 || true
  kill "$PID" 2>/dev/null || true
  rm -f "$PID_FILE" "$PORT_FILE"
  command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock 2>/dev/null || true
  exit 1
fi

echo "termux-mcp started (pid $PID)."
echo "Streamable HTTP: http://127.0.0.1:${PORT}/mcp"
echo "Legacy SSE:      http://127.0.0.1:${PORT}/sse"
echo "Health:          http://127.0.0.1:${PORT}/health"
echo "Log:             $LOG_FILE"
echo "Client config:   $DIR/scripts/client-config.sh"
