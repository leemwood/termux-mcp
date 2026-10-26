# termux-mcp

**在同一台 Android 上，让任何 MCP 客户端通过 `localhost` 直接操作 Termux。**

[![License](https://img.shields.io/github/license/leemwood/termux-mcp)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![MCP](https://img.shields.io/badge/MCP-2025--06--18-blue)](https://modelcontextprotocol.io)

命令执行、tmux 交互终端、后台任务、文件管理、Android 能力（剪贴板 / 通知 / 电池 / TTS），全部以 Termux 用户身份执行。

> ⚠️ **默认没有鉴权，只监听 `127.0.0.1`。** 任何能访问该端口的本机进程都拥有 Termux 的完整权限。不要把 `server.host` 改成 `0.0.0.0`，也不要暴露到局域网或公网。

## 特性

- **三种传输**：Streamable HTTP（推荐）、Legacy SSE、stdio
- **交互式终端**：tmux 持久会话，支持 REPL、SSH、密码提示、ncurses/TUI、Ctrl-C
- **后台任务**：detached 进程、日志文件、退出码持久化、增量读取
- **文件操作**：读写、按行编辑、递归搜索、原子写入、base64
- **Android 集成**：剪贴板、通知、Toast、振动、打开链接、电池状态、TTS
- **审计**：JSONL 日志，敏感字段自动脱敏

## 环境要求

- Termux（F-Droid / GitHub 版），Node.js ≥ 18
- `tmux`：`pkg install tmux`
- 可选：Termux:API（Android 能力）、Termux:Boot（开机自启）

## 快速开始

```bash
cd ~/termux-mcp
npm install
./scripts/doctor.sh     # 环境自检
./scripts/start.sh      # 后台启动 + 唤醒锁 + 恢复自启动
./scripts/status.sh     # 状态与地址
```

```text
MCP:    http://127.0.0.1:8770/mcp
SSE:    http://127.0.0.1:8770/sse
Health: http://127.0.0.1:8770/health
```

验证：

```bash
curl -s http://127.0.0.1:8770/health
```

## 客户端接入

### OpenCode

```bash
opencode mcp add --global termux --url http://127.0.0.1:8770/mcp
```

等价的 `opencode.json`：

```json
{
  "mcp": {
    "servers": {
      "termux": { "type": "remote", "url": "http://127.0.0.1:8770/mcp" }
    }
  }
}
```

### 其他 Streamable HTTP 客户端

```text
URL:    http://127.0.0.1:8770/mcp
Accept: application/json, text/event-stream
```

服务端无状态：每个 POST 独立处理，不要求 `Mcp-Session-Id`，不需要任何认证头。

### stdio（客户端本身运行在 Termux 内）

```bash
node ~/termux-mcp/src/server.js --stdio
```

`./scripts/client-config.sh` 会打印当前环境适用的完整客户端配置。

## 工具

| 类别 | 工具 |
| --- | --- |
| Shell | `run_command` |
| 交互终端 | `terminal_create` `terminal_write` `terminal_read` `terminal_list` `terminal_resize` `terminal_kill` `terminal_attach_info` |
| 后台任务 | `task_start` `task_list` `task_output` `task_stop` `task_remove` |
| 文件 | `read_file` `write_file` `edit_file` `list_dir` `stat_path` `mkdir` `copy_path` `move_path` `delete_path` `search_files` |
| Android | `clipboard_get` `clipboard_set` `notify` `toast` `vibrate` `open` `battery_status` `tts_speak` `termux_api` |
| 系统 | `system_info` |
| 资源 / 提示 | `termux://system/info` `termux://config` `termux://audit/recent` `termux://tasks` `termux://terminals` `termux://help`、prompt `termux_operator` |

两个容易踩的默认值：`terminal_write` 的 `submit` 默认 **false**，要执行命令必须显式传 `true`；`delete_path` 必须显式传 `confirm: "DELETE"`，且拒绝删除 `/`。

## 示例

一次性命令：

```json
{ "name": "run_command", "arguments": { "command": "pkg list-installed | head -20" } }
```

交互式 Python REPL：

```json
{ "name": "terminal_create", "arguments": { "name": "py", "cwd": "~/project", "cols": 120, "rows": 40 } }
{ "name": "terminal_write",  "arguments": { "session": "py", "input": "python3", "submit": true } }
{ "name": "terminal_read",   "arguments": { "session": "py", "expect": "^>>> ", "timeout_ms": 5000 } }
```

后台构建：

```json
{ "name": "task_start",  "arguments": { "name": "build", "command": "npm run build > build.log 2>&1", "wait_ms": 500 } }
{ "name": "task_output", "arguments": { "id": "t-xxxx", "wait_for": "exit", "wait_ms": 60000, "tail_lines": 200 } }
```

Android 通知：

```json
{ "name": "notify", "arguments": { "title": "构建完成", "content": "npm run build 已完成", "sound": true } }
```

## 安全模型

- 无 token、无密码、无 OAuth，只监听 `127.0.0.1`
- 任何能访问 8770 的本机进程都能执行任意命令、读写任意可访问文件
- 权限边界是 Termux 用户本身（`u0_aXXX`），不是这个服务
- 浏览器来源检查保留：网页无法直接驱动本机命令，原生 App 不受影响
- 审计日志默认 `~/.local/state/termux-mcp/audit.jsonl`，命令全文会记录，不要在里面写密码；`security.auditEnabled=false` 可关闭
- 需要远程访问时走 SSH 隧道

## 配置

`~/.config/termux-mcp/config.json`，首次启动自动生成；可用 `TERMUX_MCP_CONFIG` 或 `--config` 覆盖。常改项：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `server.port` | `8770` | 监听端口 |
| `security.defaultTimeoutSec` | `120` | `run_command` 默认超时 |
| `security.maxOutputBytes` | `262144` | 输出截断阈值 |
| `security.auditEnabled` | `true` | 审计开关 |
| `terminal.shell` | `$SHELL` | 交互终端 shell；`run_command` 与后台任务固定用 bash |
| `terminal.useShellRc` | `false` | bash 会话默认 `--noprofile --norc`，避免 rc 改写行编辑导致 Enter 不执行 |
| `tasks.maxTasks` | `32` | 后台任务上限 |

## 服务管理

| 脚本 | 作用 |
| --- | --- |
| `scripts/start.sh` | 后台启动 + `termux-wake-lock` + 恢复自启动 |
| `scripts/stop.sh` | 停止服务并暂停自启动（不杀 tmux 会话和后台任务） |
| `scripts/status.sh` | 状态、自启动状态、地址 |
| `scripts/doctor.sh` | 环境自检 |
| `scripts/client-config.sh` | 打印客户端配置 |
| `scripts/install-motd.sh` | 安装中文登录欢迎语 |
| `scripts/install-boot.sh` / `uninstall-boot.sh` | Termux:Boot 开机自启 |
| `scripts/autostart-enable.sh` / `autostart-disable.sh` | 恢复 / 暂停自启动 |
| `scripts/install-termux-api.sh` | 安装 Termux:API 包装器 |

后台存活建议：关掉 Termux 的电池优化；`start.sh` 已自动获取唤醒锁。Android 12+ 的 phantom process killer 可能杀掉后台子进程，需要 adb/root 调整。

## 许可证

[MIT](LICENSE) © leemwood
