#!/data/data/com.termux/files/usr/bin/bash
set -eu

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
PORT="$(node src/server.js --print-port)"
CONFIG_PATH="$(node src/server.js --print-config-path)"

cat <<EOF
termux-mcp client configuration
config: $CONFIG_PATH
port:   $PORT
auth:   none (localhost only)

== OpenCode v2 (recommended) ==

opencode mcp add --global termux --url http://127.0.0.1:${PORT}/mcp

Or add this to opencode.json/opencode.jsonc:

{
  "mcp": {
    "servers": {
      "termux": {
        "type": "remote",
        "url": "http://127.0.0.1:${PORT}/mcp"
      }
    }
  }
}

== Generic Streamable HTTP client ==

URL: http://127.0.0.1:${PORT}/mcp

== Legacy SSE client ==

URL: http://127.0.0.1:${PORT}/sse

== stdio client (only when the client runs inside Termux) ==

command: $(command -v node)
args:    ["$DIR/src/server.js", "--stdio"]
env:     TERMUX_MCP_CONFIG="$CONFIG_PATH"

No token is required. The server listens on 127.0.0.1 only; any local app or
process that can reach the port has the full permissions of your Termux user.
EOF
