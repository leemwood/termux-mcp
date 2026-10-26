# termux-mcp

本地 MCP（Model Context Protocol）服务：让同一台 Android 设备上的其他 App、AI 客户端或脚本，通过 `localhost` 直接操作 Termux 环境。

支持三种传输：

- **Streamable HTTP**：`http://127.0.0.1:8770/mcp`（推荐）
- **Legacy SSE**：`http://127.0.0.1:8770/sse`
- **stdio**：供运行在 Termux 内部的客户端直接拉起

> 重要：按需求，本服务**不提供命令白名单，也不限制工作目录，并且没有 token 鉴权**。它只监听 `127.0.0.1`；任何能访问该端口的本地 App 或进程都能以 Termux 用户身份执行任意操作。

## 功能

| 类别 | 能力 |
| --- | --- |
| Shell | `run_command` 一次性执行命令，返回退出码、stdout/stderr、耗时、超时和截断信息 |
| 交互式终端 | `terminal_create/write/read/list/resize/kill/attach_info`，tmux 持久会话，支持 REPL、SSH、密码提示、ncurses/TUI、Ctrl-C 等控制键 |
| 后台任务 | `task_start/list/output/stop/remove`，detached 进程、日志文件、退出码持久化、增量读取、进程组终止 |
| 文件管理 | `read_file/write_file/edit_file/list_dir/stat_path/mkdir/copy_path/move_path/delete_path/search_files`，支持 base64 二进制、原子写入、按行读取、内容搜索 |
| Android 集成 | 剪贴板、通知、Toast、振动、打开 URL/文件、电池状态、TTS，以及任意 `termux-api` 命令（Termux:API 已安装） |
| 系统信息 | 设备型号、Android 版本、CPU/内存/负载、磁盘、网络接口、工具可用性 |
| MCP 资源/提示 | `termux://system/info`、`termux://config`、`termux://audit/recent`、`termux://tasks`、`termux://terminals`、`termux://help`；`termux_operator` prompt |

## 安全模型

```text
Unix 权限边界：Termux 用户（u0_aXXX）
访问控制：     无 token；仅监听 127.0.0.1
可审计性：     JSONL 审计日志
删除保护：     delete_path 需要 confirm="DELETE"，且拒绝 /
```

- 没有 token、密码或 OAuth。HTTP 默认只监听 `127.0.0.1`；本机任何能访问该端口的 App 都可以执行任意命令、读写任意可访问文件、创建终端和后台任务。
- 不要把监听地址改成 `0.0.0.0` 或暴露到局域网/公网。服务没有 TLS，也没有身份认证。需要远程访问时，使用 SSH 隧道。
- 浏览器来源检查仍然保留：原生 App（不带 `Origin`）不受影响，任意网页不能直接驱动本机命令。这属于协议层防护，不是 token 登录。
- 审计日志默认在 `~/.local/state/termux-mcp/audit.jsonl`。`content`、`text`、`stdin`、`old_string`、`new_string` 等字段会被脱敏，但**命令本身会完整记录**；命令里不要直接写密码。
- `delete_path` 只有两个硬性保护：必须显式传 `confirm="DELETE"`，以及拒绝删除 `/`。其他路径（包括 Termux 前缀、共享存储）由 Termux/Android 权限决定。
- `termux_api` 不再限制子命令；SMS、通话记录、联系人、定位、相机、麦克风等能力是否可用，取决于 Termux:API App 获得的 Android 权限。

## 快速开始

依赖：Node.js（已在 Node 26.4 测试，`>=18`）、`tmux`（交互式终端）。

```bash
cd ~/termux-mcp
npm install
./scripts/doctor.sh
./scripts/start.sh
./scripts/status.sh
```

首次启动会自动生成配置。默认地址：

```text
MCP:    http://127.0.0.1:8770/mcp
SSE:    http://127.0.0.1:8770/sse
Health: http://127.0.0.1:8770/health
```

生成客户端配置：

```bash
./scripts/client-config.sh
```

停止服务（**不会**停止 tmux 终端会话和后台任务；同时暂停自启动）：

```bash
./scripts/stop.sh
```

## 客户端配置

### OpenCode v2（已验证）

```bash
opencode mcp add --global termux --url http://127.0.0.1:8770/mcp
opencode mcp list
```

等价的 `opencode.json` / `opencode.jsonc`：

```json
{
  "mcp": {
    "servers": {
      "termux": {
        "type": "remote",
        "url": "http://127.0.0.1:8770/mcp"
      }
    }
  }
}
```

> OpenCode v2 使用 `mcp.servers`。更老的版本可能是 `mcp.<name>`，以实际版本为准。

### 通用 Streamable HTTP 客户端

```text
URL:    http://127.0.0.1:8770/mcp
Accept: application/json, text/event-stream
```

服务端采用无状态 Streamable HTTP，每个 POST 请求独立处理，不要求 `Mcp-Session-Id`，也不需要任何认证头。

### Legacy SSE 客户端

```text
SSE URL: http://127.0.0.1:8770/sse
```

SSE 的 POST `/messages?sessionId=...` 使用会话 ID 路由；不需要 token 或 Authorization 头。

### stdio 客户端（客户端必须运行在 Termux 内）

```bash
node /data/data/com.termux/files/home/termux-mcp/src/server.js --stdio
```

在客户端配置里设置环境变量 `TERMUX_MCP_CONFIG` 可指定其他配置文件。stdio 模式不会输出日志到 stdout，日志只写 stderr。

### 原始 HTTP 检查

```bash
curl -s http://127.0.0.1:8770/health

curl -s http://127.0.0.1:8770/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

## 工具清单

### Shell

- `run_command`：`command`、`cwd`、`timeout_sec`、`env`、`stdin`。固定用 bash 执行，返回 JSON。

### 交互式终端

- `terminal_create`：`name`、`shell`、`shell_args`、`cwd`、`cols`、`rows`、`env`、`use_rc`
- `terminal_write`：`session`、`input`、`keys`、`submit`、`paste`、`wait_ms`
- `terminal_read`：`session`、`lines`、`full_history`、`ansi`、`join_wrapped`、`wait_ms`、`expect`、`timeout_ms`
- `terminal_list`
- `terminal_resize`：`session`、`cols`、`rows`
- `terminal_kill`：`session` 或 `all`
- `terminal_attach_info`：返回在 Termux 里人工接入的 `tmux attach` 命令

### 后台任务

- `task_start`：`command`、`name`、`cwd`、`env`、`wait_ms`
- `task_list`：`include_finished`、`limit`
- `task_output`：`id`、`offset`、`tail_lines`、`wait_ms`、`wait_for`（`any`/`exit`）
- `task_stop`：`id`、`signal`、`grace_ms`
- `task_remove`：`id`

### 文件管理

- `read_file`：`path`、`offset`、`limit`、`with_line_numbers`、`encoding`（含 `base64`）
- `write_file`：`path`、`content`、`encoding`、`append`、`create_parents`
- `edit_file`：`path`、`old_string`、`new_string`、`replace_all`
- `list_dir`：`path`、`show_hidden`、`max_entries`
- `stat_path`：`path`
- `mkdir`：`path`、`recursive`
- `copy_path`：`source`、`destination`、`overwrite`
- `move_path`：`source`、`destination`、`overwrite`
- `delete_path`：`path`、`recursive`、`dry_run`、`confirm`
- `search_files`：`root`、`glob`、`query`、`max_results`、`include_hidden`、`case_sensitive`、`max_depth`、`max_file_bytes`

### Android / Termux:API

- `clipboard_get`
- `clipboard_set`
- `notify`
- `toast`
- `vibrate`
- `open`
- `battery_status`
- `tts_speak`
- `termux_api`：直接运行任意 `termux-*` 子命令（不经过 shell）

### 系统

- `system_info`

## 使用示例

以下参数就是 MCP `tools/call` 的 `arguments`。

### 1. 一次性命令

```json
{"command": "pkg list-installed | head -20"}
```

### 2. 交互式 Python REPL

```json
{"name": "terminal_create", "arguments": {"name": "py", "shell": "/data/data/com.termux/files/usr/bin/bash", "cwd": "~/project", "cols": 120, "rows": 40}}
```

```json
{"name": "terminal_write", "arguments": {"session": "py", "input": "python3", "submit": true}}
```

```json
{"name": "terminal_read", "arguments": {"session": "py", "expect": "^>>> ", "timeout_ms": 5000}}
```

```json
{"name": "terminal_write", "arguments": {"session": "py", "input": "print(1 + 1)", "submit": true}}
```

```json
{"name": "terminal_read", "arguments": {"session": "py", "expect": "^2$", "timeout_ms": 3000}}
```

发送 Ctrl-D 退出：

```json
{"name": "terminal_write", "arguments": {"session": "py", "keys": ["C-d"]}}
```

`terminal_write` 的 `submit` 默认是 **false**，需要执行命令时显式传 `true`。多行输入默认走 bracketed paste，避免每一行提前执行。

### 3. 后台构建任务

```json
{"name": "task_start", "arguments": {"name": "build", "command": "npm run build > build.log 2>&1", "cwd": "~/project", "wait_ms": 500}}
```

```json
{"name": "task_output", "arguments": {"id": "t-xxxx", "wait_for": "exit", "wait_ms": 60000, "tail_lines": 200}}
```

增量读取：

```json
{"name": "task_output", "arguments": {"id": "t-xxxx", "offset": 4096}}
```

停止：

```json
{"name": "task_stop", "arguments": {"id": "t-xxxx", "signal": "SIGTERM", "grace_ms": 3000}}
```

### 4. 文件编辑

```json
{"name": "write_file", "arguments": {"path": "~/project/hello.txt", "content": "alpha\nbeta\n"}}
```

```json
{"name": "edit_file", "arguments": {"path": "~/project/hello.txt", "old_string": "beta", "new_string": "BETA"}}
```

删除前先 dry-run，再确认：

```json
{"name": "delete_path", "arguments": {"path": "~/project/tmp", "recursive": true, "dry_run": true}}
```

```json
{"name": "delete_path", "arguments": {"path": "~/project/tmp", "recursive": true, "confirm": "DELETE"}}
```

### 5. Android 通知与剪贴板

```json
{"name": "notify", "arguments": {"title": "构建完成", "content": "npm run build 已完成", "sound": true}}
```

```json
{"name": "clipboard_set", "arguments": {"text": "hello from MCP"}}
```

## 配置参考

配置路径：`~/.config/termux-mcp/config.json`（可用 `TERMUX_MCP_CONFIG` 或 `--config` 覆盖）。

```json
{
  "configVersion": 3,
  "server": {
    "name": "termux-mcp",
    "host": "127.0.0.1",
    "port": 8770,
    "allowOrigins": [],
    "allowedHosts": [],
    "maxBodyBytes": 10485760
  },
  "security": {
    "maxOutputBytes": 262144,
    "defaultTimeoutSec": 120,
    "maxTimeoutSec": 600,
    "maxConcurrentCommands": 16,
    "auditEnabled": true,
    "auditLog": "~/.local/state/termux-mcp/audit.jsonl",
    "auditMaxBytes": 5242880,
    "maxReadBytes": 10485760,
    "maxWriteBytes": 10485760,
    "maxSearchResults": 200,
    "searchTimeoutSec": 30
  },
  "terminal": {
    "enabled": true,
    "socketPath": "~/.local/state/termux-mcp/tmux.sock",
    "shell": "",
    "shellArgs": [],
    "useShellRc": false,
    "defaultCols": 100,
    "defaultRows": 30,
    "historyLimit": 10000,
    "maxSessions": 16,
    "defaultReadLines": 120,
    "maxReadBytes": 524288
  },
  "tasks": {
    "dir": "~/.local/state/termux-mcp/tasks",
    "maxTasks": 32,
    "maxOutputReadBytes": 262144,
    "defaultTailLines": 200,
    "stopGraceMs": 3000
  },
  "termuxApi": {
    "enabled": true,
    "timeoutSec": 30,
    "maxOutputBytes": 1048576
  }
}
```

说明：

- `terminal.shell` 为空时交互式终端使用 `$SHELL`（当前环境是 fish 时就是 fish），再用 Termux bash 兜底。`run_command` 和后台任务**始终使用 bash**，因为脚本依赖 POSIX 语法。
- bash 启动文件可能改变行编辑行为并导致 tmux 中 Enter 不执行。因此 `useShellRc=false` 时，默认 bash 会话带 `--noprofile --norc`。需要 `.bashrc` 时设为 `true`，或在 `terminal_create` 传 `use_rc: true`。
- 旧版的 `security.allowedRoots`、`security.readOnlyRoots`、`security.denyCommandPatterns`、`termuxApi.allowedCommands` 已移除；v2 配置加载时会丢弃这些字段。
- v3 移除了 `server.token` 和所有鉴权逻辑；旧配置升级时会自动删除该字段。
- 关闭审计：`security.auditEnabled=false`。

## 欢迎语与自启动

### 中文欢迎语

`./scripts/install-motd.sh` 会写入 `~/.termux/motd.sh`（Termux 登录时优先使用它），内容包括：

- 中文欢迎语、设备型号和 Android 版本
- `termux-mcp` 当前是否运行、MCP 地址
- 启动/停止服务的简短命令
- 自启动状态的一行小提示

欢迎语只做状态展示，不会启动前台进程，也不会占用会话。它由 Termux 的 `login` 在新会话启动时执行；如果当前会话没有看到，可手动运行 `~/.termux/motd.sh`，或新开一个 Termux 会话。

### 后台自启动（不占会话）

服务通过两条路径自启动：

1. **登录后台检查**：fish 交互式会话启动时，在后台执行 `scripts/ensure-running.sh`。
   - 服务已在运行：约 60ms 内退出，无输出，不阻塞提示符。
   - 服务未运行：后台调用 `scripts/start.sh`，`nohup` 拉起守护进程后立即返回。
   - `stop.sh` 会写入 `~/.local/state/termux-mcp/autostart.disabled`，暂停后续自动拉起；`start.sh` 或 `autostart-enable.sh` 会恢复。
2. **Termux:Boot**：`scripts/install-boot.sh` 写入 `~/.termux/boot/10-termux-mcp.sh`，调用 `ensure-running.sh`（尊重自启动暂停标记）。安装 **Termux:Boot** App 并打开一次后，开机时自动启动。

相关命令：

```bash
./scripts/install-motd.sh          # 安装/更新中文欢迎语
./scripts/install-boot.sh          # 安装 Termux:Boot 启动脚本（需 Termux:Boot App）
./scripts/uninstall-boot.sh
./scripts/autostart-enable.sh      # 恢复登录/开机自启动（下一次登录或手动 start 生效）
./scripts/autostart-disable.sh     # 暂停自启动（不影响当前运行中的服务）
./scripts/ensure-running.sh        # 内部使用：静默确保后台守护在运行
```

当前环境已把登录后台检查追加到：

- `~/.config/fish/config.fish`（备份：`config.fish.bak-termux-mcp`）
- `~/.xinhao_history/start_command.sh`（bash 启动脚本，备份：`start_command.sh.bak-termux-mcp`）

如果你不想让某个 shell 自动检查，删除对应文件里的 `termux-mcp` 段落即可。

### 服务管理

```bash
./scripts/start.sh                 # 启动 + termux-wake-lock + 恢复自启动
./scripts/status.sh                # 状态 + 自启动状态 + 地址
./scripts/stop.sh                  # 停止 + 暂停自启动（保留 tmux/后台任务）
./scripts/doctor.sh                # 环境自检
./scripts/client-config.sh         # 打印客户端配置
```

Android 后台限制建议：

1. 在系统设置中关闭 Termux 的电池优化。
2. 保持 `termux-wake-lock`（`start.sh` 已自动获取）。
3. Android 12+ 的 phantom process killer 可能杀掉后台子进程。常见缓解方式（需要 adb/root，视系统版本而定）：

```bash
adb shell settings put global settings_enable_monitor_phantom_procs false
# 或
adb shell device_config put activity_manager max_phantom_processes 2147483647
```

## Termux:API

Termux:API App 和 Termux 侧包装器已安装，`clipboard_get`、`notify`、`battery_status` 等工具可以直接使用。

如需在新环境重装：

```bash
./scripts/install-termux-api.sh
```

或手动：

```bash
pkg install termux-api
```

然后从 F-Droid 安装 **Termux:API** App，打开一次并授予需要的权限。SMS、通话记录、联系人、定位、相机、麦克风等命令也可以直接通过 `termux_api` 调用，但必须先在 Android 上授予 Termux:API 对应权限。

## 故障排查

### 端口被占用

```bash
./scripts/status.sh
ss -ltnp 2>/dev/null | grep 8770
```

换端口：

```bash
./scripts/start.sh --port 9000
```

或在配置里修改 `server.port`。`start.sh` 会把实际端口写入 `~/.local/state/termux-mcp/server.port`。

### tmux 未安装

```bash
./scripts/install-terminal-deps.sh
```

如果 `pkg` 镜像同步失败，可直接安装官方包（版本号按镜像实际内容调整）：

```bash
cd "$TMPDIR"
curl -fLO https://packages.termux.dev/apt/termux-main/pool/main/u/utf8proc/utf8proc_2.12.0_aarch64.deb
curl -fLO https://packages.termux.dev/apt/termux-main/pool/main/t/tmux/tmux_3.8_aarch64.deb
dpkg -i utf8proc_*.deb tmux_*.deb
```

本机已通过这种方式安装 tmux 3.8。

### 终端里输入了命令但回车不执行

通常是 bash 启动脚本改变了行编辑。默认 `terminal_create` 对 bash 使用 `--noprofile --norc`；如果手动设了 `terminal.shell` 或 `use_rc=true`，改回默认，或检查 `~/.bashrc`。

### `$SHELL` 是 fish，后台任务脚本报语法错误

`run_command` 和 `task_*` 固定用 bash，不读取 `$SHELL`；交互式 `terminal_create` 才会默认使用 `$SHELL`。如果任务里写了 fish 专属语法，请改成 POSIX/bash 语法。

### 共享存储无法访问

```bash
termux-setup-storage
```

授予存储权限后，`/storage/emulated/0` 才可读写。

### 服务被 Android 杀掉

参见“常驻与开机自启”中的电池优化、wake lock 和 phantom process killer。tmux 会话和后台任务在 Termux 进程存活时才能继续运行；Termux 本身被系统杀死后都无法保证。

### 后台任务退出码是 `null` / 状态 `unknown`

任务被外部 `SIGKILL`、Termux 被杀，或任务在写入状态文件前退出时可能出现。日志仍保留；状态文件路径在任务元数据里。

## 开发与测试

```bash
npm install
npm test
```

测试使用临时配置、临时 tmux socket 和临时任务目录，覆盖：

- stdio 工具列表与系统信息
- `run_command` 退出码、超时、bash 语义
- 文件读写/编辑/搜索/复制/移动/删除/base64
- `/etc/hosts` 读取（确认没有工作区白名单）
- 终端创建、多行粘贴、expect、Ctrl-C、resize、attach、kill
- 后台任务运行、退出码、增量输出、停止、删除
- MCP 资源与 prompt
- HTTP 无鉴权访问、Origin 拒绝、Streamable HTTP、Legacy SSE

## 目录结构

```text
termux-mcp/
├── src/
│   ├── server.js        # CLI 入口、stdio/HTTP 启动、信号处理
│   ├── http.js          # Streamable HTTP + legacy SSE + auth/CORS
│   ├── mcp.js           # MCP server 装配与工具包装
│   ├── config.js        # 配置生成/校验/脱敏
│   ├── security.js      # 路径解析与最小删除保护
│   ├── exec.js          # 受限输出缓冲的进程执行
│   ├── terminal.js      # tmux 交互式会话
│   ├── tasks.js         # detached 后台任务
│   ├── audit.js         # JSONL 审计与轮转
│   ├── resources.js     # MCP resources
│   ├── prompts.js       # MCP prompt
│   └── tools/           # 各类工具注册
├── scripts/             # 启停、自检、客户端配置、开机自启
├── test/smoke.mjs       # 端到端回归测试
└── README.md
```

## 已知限制

- 没有 TLS；不要直接暴露到公网。
- 外部 Android App 不能直接 attach 到 tmux 的 TTY；请使用 `terminal_read/terminal_write`，或在 Termux 里运行 `terminal_attach_info` 返回的命令人工接入。
- 后台任务是非交互式的；需要密码/提示/TUI 时用终端会话。
- 文件搜索会跳过符号链接，避免递归穿越；需要跟随符号链接时用 `run_command`。
- `delete_path` 的目录大小统计是近似值，超过 10,000 个条目会标记 `measured_partially`。
- 服务不限制单条命令的破坏性；请自行备份重要数据。
