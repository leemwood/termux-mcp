#!/data/data/com.termux/files/usr/bin/bash
set -eu

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/termux-mcp"
mkdir -p "$STATE_DIR"
rm -f "$STATE_DIR/autostart.disabled"
echo "termux-mcp 自启动已启用：Termux:Boot 和登录后台检查都会尝试拉起服务。"
