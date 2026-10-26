#!/data/data/com.termux/files/usr/bin/bash
set -eu

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/termux-mcp"
mkdir -p "$STATE_DIR"
touch "$STATE_DIR/autostart.disabled"
echo "termux-mcp 自启动已暂停。当前运行中的服务不受影响；下次登录/开机不会自动拉起。"
echo "恢复：$(dirname "${BASH_SOURCE[0]}")/autostart-enable.sh"
