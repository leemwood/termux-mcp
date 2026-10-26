import { readRecentAudit } from './audit.js';
import { sanitizeConfig } from './config.js';
import { systemInfo } from './system.js';
import { TaskManager } from './tasks.js';
import { TerminalManager } from './terminal.js';

const HELP_TEXT = `# termux-mcp

Local MCP server with full access to the Termux user environment.

## Tool groups

- run_command: one-shot shell command with exit code, stdout/stderr and timeout.
- read_file, write_file, edit_file, list_dir, stat_path, mkdir, copy_path, move_path,
  delete_path, search_files: full file management. There is no workspace allow list;
  the Termux user's Android/Linux permissions are the boundary.
- terminal_create, terminal_write, terminal_read, terminal_list, terminal_resize,
  terminal_kill, terminal_attach_info: persistent interactive tmux sessions for shells,
  REPLs, SSH, prompts and TUI programs.
- task_start, task_list, task_output, task_stop, task_remove: detached background tasks
  with persisted logs and exit status.
- clipboard_get, clipboard_set, notify, toast, vibrate, open, battery_status, tts_speak,
  termux_api: Android integration through the Termux:API app (optional).
- system_info: device, storage, network and tool availability.

## Important

- HTTP has no authentication and is intended for 127.0.0.1 only. Any local app that can
  reach the port has the full permissions of the Termux user; do not bind it to a public
  network without a firewall or tunnel.
- Terminal sessions and background tasks survive termux-mcp restarts as long as the
  Termux process and the tmux server stay alive.
- delete_path requires confirm="DELETE"; it refuses only the filesystem root.
`;

export function registerResources(server, { config, logger }) {
  server.registerResource(
    'system-info',
    'termux://system/info',
    {
      title: 'Termux system information',
      description: 'Live device, Termux, storage and network information.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await systemInfo(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'config',
    'termux://config',
    {
      title: 'Effective termux-mcp config',
      description: 'The merged effective config.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(sanitizeConfig(config), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'audit-recent',
    'termux://audit/recent',
    {
      title: 'Recent tool calls',
      description: 'The last 50 audit log entries, with sensitive argument values redacted.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const entries = await readRecentAudit(config, 50);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ count: entries.length, entries }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'tasks',
    'termux://tasks',
    {
      title: 'Background tasks',
      description: 'Currently known background tasks and their status.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const manager = new TaskManager(config, logger);
      const data = await manager.list({ include_finished: true, limit: 100 });
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );

  server.registerResource(
    'terminals',
    'termux://terminals',
    {
      title: 'Terminal sessions',
      description: 'Currently known tmux terminal sessions and their status.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const manager = new TerminalManager(config, logger);
      const data = await manager.listSessions();
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );

  server.registerResource(
    'help',
    'termux://help',
    {
      title: 'termux-mcp help',
      description: 'Tool overview and security notes.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: HELP_TEXT }],
    }),
  );
}
