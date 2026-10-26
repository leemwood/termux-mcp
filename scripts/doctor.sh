#!/data/data/com.termux/files/usr/bin/bash
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1

ok() { printf '  [ok]   %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; }
bad() { printf '  [fail] %s\n' "$*"; }

echo "termux-mcp doctor"
echo

echo "Runtime:"
if command -v node >/dev/null 2>&1; then
  ok "node $(node --version) ($(command -v node))"
else
  bad "node not found"
fi

if [ -d node_modules/@modelcontextprotocol/sdk ] && [ -d node_modules/zod ]; then
  ok "npm dependencies installed"
else
  bad "npm dependencies missing (run: npm install)"
fi

echo
echo "Terminal:"
if command -v tmux >/dev/null 2>&1; then
  ok "tmux $(tmux -V 2>/dev/null | awk '{print $2}')"
else
  bad "tmux not found (run: $DIR/scripts/install-terminal-deps.sh)"
fi

echo
echo "Android integration:"
for command in termux-clipboard-get termux-battery-status termux-notification termux-toast; do
  if command -v "$command" >/dev/null 2>&1; then
    ok "$command"
  else
    warn "$command missing (run: $DIR/scripts/install-termux-api.sh)"
  fi
done

echo
echo "Config:"
CONFIG_PATH="$(node src/server.js --print-config-path 2>/dev/null || true)"
if [ -n "${CONFIG_PATH:-}" ] && [ -f "$CONFIG_PATH" ]; then
  ok "config: $CONFIG_PATH"
else
  warn "config not created yet; it will be created on first run"
fi

PORT="$(node src/server.js --print-port 2>/dev/null || echo 8770)"
echo "  port:   $PORT"
if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  ok "health endpoint responds"
else
  warn "health endpoint not responding (server may be stopped)"
fi

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/termux-mcp"
if [ -f "$STATE_DIR/server.pid" ] && kill -0 "$(cat "$STATE_DIR/server.pid" 2>/dev/null)" 2>/dev/null; then
  ok "server running (pid $(cat "$STATE_DIR/server.pid"))"
else
  warn "server not running (start it with: $DIR/scripts/start.sh)"
fi

echo
echo "Welcome / autostart:"
if [ -x "$HOME/.termux/motd.sh" ]; then
  ok "Chinese MOTD: ~/.termux/motd.sh"
else
  warn "Chinese MOTD not installed (run: $DIR/scripts/install-motd.sh)"
fi
if [ -f "$HOME/.termux/boot/10-termux-mcp.sh" ]; then
  ok "Termux:Boot script installed"
else
  warn "Termux:Boot script missing (run: $DIR/scripts/install-boot.sh)"
fi
if pm path com.termux.boot >/dev/null 2>&1; then
  ok "Termux:Boot app installed"
else
  warn "Termux:Boot app not installed; login hook still runs in background"
fi
if [ -f "$STATE_DIR/autostart.disabled" ]; then
  warn "autostart paused (run: $DIR/scripts/autostart-enable.sh)"
else
  ok "autostart enabled (login hook)"
fi

echo
echo "Storage:"
df -h "$HOME" 2>/dev/null | tail -n 1 || true

echo
echo "Hints:"
echo "  - Disable Android battery optimization for Termux, otherwise Android may kill it."
echo "  - Keep Termux awake for long tasks: termux-wake-lock (start.sh does this)."
echo "  - Android 12+ may kill phantom processes; see the README troubleshooting section."
