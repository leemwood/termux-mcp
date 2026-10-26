#!/data/data/com.termux/files/usr/bin/bash
set -eu

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOT_DIR="$HOME/.termux/boot"
BOOT_FILE="$BOOT_DIR/10-termux-mcp.sh"

mkdir -p "$BOOT_DIR"
cat >"$BOOT_FILE" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Start termux-mcp at boot (requires the Termux:Boot app).
# ensure-running.sh respects the autostart.disabled flag and starts in background.
termux-wake-lock 2>/dev/null || true
sleep 20
exec "$DIR/scripts/ensure-running.sh"
EOF
chmod +x "$BOOT_FILE"

echo "Created $BOOT_FILE"
echo "Install the Termux:Boot app from F-Droid and open it once, otherwise this script will not run at boot."
