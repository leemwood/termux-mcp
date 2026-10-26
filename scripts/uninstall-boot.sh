#!/data/data/com.termux/files/usr/bin/bash
set -eu

BOOT_FILE="$HOME/.termux/boot/10-termux-mcp.sh"
if [ -f "$BOOT_FILE" ]; then
  rm -f "$BOOT_FILE"
  echo "Removed $BOOT_FILE"
else
  echo "No boot script found at $BOOT_FILE"
fi
