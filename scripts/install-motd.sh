#!/data/data/com.termux/files/usr/bin/bash
set -eu

MOTD_FILE="$HOME/.termux/motd.sh"
mkdir -p "$HOME/.termux"

cat >"$MOTD_FILE" <<'MOTD'
#!/data/data/com.termux/files/usr/bin/bash
# Termux 中文欢迎语 + termux-mcp 后台守护提示（不占用会话）。

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/termux-mcp"
PID_FILE="$STATE_DIR/server.pid"
PORT_FILE="$STATE_DIR/server.port"
CONFIG_FILE="$HOME/.config/termux-mcp/config.json"
FLAG_FILE="$STATE_DIR/autostart.disabled"

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
  RUNNING=1
else
  RUNNING=0
fi

if [ -f "$PORT_FILE" ]; then
  PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
elif [ -f "$CONFIG_FILE" ]; then
  PORT="$(sed -n 's/.*"port": *\([0-9][0-9]*\).*/\1/p' "$CONFIG_FILE" | head -n 1)"
fi
PORT="${PORT:-8770}"

MODEL="$(getprop ro.product.model 2>/dev/null || true)"
ANDROID="$(getprop ro.build.version.release 2>/dev/null || true)"
DEVICE="${MODEL:-Android}"
[ -n "${ANDROID:-}" ] && DEVICE="$DEVICE · Android $ANDROID"

printf '\n'
printf '  \033[1;36m欢迎使用 Termux\033[0m  \033[2m%s\033[0m\n' "$DEVICE"
printf '  \033[2m终端与 Android 工具已经就绪。\033[0m\n'
printf '\n'

if [ "$RUNNING" -eq 1 ]; then
  printf '  \033[1mtermux-mcp\033[0m  \033[0;32m● 运行中\033[0m  \033[2m127.0.0.1:%s/mcp\033[0m\n' "$PORT"
  printf '  \033[2m管理：~/termux-mcp/scripts/status.sh  停止：~/termux-mcp/scripts/stop.sh\033[0m\n'
else
  printf '  \033[1mtermux-mcp\033[0m  \033[0;33m○ 未运行\033[0m\n'
  printf '  \033[2m启动：~/termux-mcp/scripts/start.sh  （后台守护，不占用当前会话）\033[0m\n'
fi

if [ -f "$FLAG_FILE" ]; then
  printf '  \033[2m自启动：已暂停  恢复：~/termux-mcp/scripts/autostart-enable.sh\033[0m\n'
elif pm path com.termux.boot >/dev/null 2>&1; then
  printf '  \033[2m自启动：已启用 · Termux:Boot + 登录后台检查，不占用会话\033[0m\n'
else
  printf '  \033[2m自启动：登录后台检查已启用 · 安装 Termux:Boot 可开机自启（不占用会话）\033[0m\n'
fi
printf '\n'
MOTD

chmod 700 "$MOTD_FILE"
echo "已更新 Termux 中文欢迎语：$MOTD_FILE"
echo "打开新的 Termux 会话即可看到；当前会话可运行：$MOTD_FILE"
