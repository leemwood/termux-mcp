#!/data/data/com.termux/files/usr/bin/bash
set -u

if command -v tmux >/dev/null 2>&1; then
  echo "tmux is already installed: $(tmux -V)"
  exit 0
fi

echo "Installing tmux from the Termux repository..."
if pkg install -y tmux; then
  echo "tmux installed: $(tmux -V)"
  exit 0
fi

cat >&2 <<'EOF'

Could not install tmux through pkg (often a temporarily desynchronised mirror).
You can install the official Termux packages directly:

  # aarch64 example; adjust the version if needed
  cd "$TMPDIR"
  curl -fLO https://packages.termux.dev/apt/termux-main/pool/main/u/utf8proc/utf8proc_2.12.0_aarch64.deb
  curl -fLO https://packages.termux.dev/apt/termux-main/pool/main/t/tmux/tmux_3.8_aarch64.deb
  dpkg -i utf8proc_*.deb tmux_*.deb

Or fix the mirror in $PREFIX/etc/apt/sources.list and run:
  pkg update && pkg install tmux
EOF
exit 1
