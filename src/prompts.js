import { z } from 'zod';

const INSTRUCTIONS = `You are operating a real Android device through the termux-mcp server.

Environment:
- The server runs inside Termux as the Termux user, with access to home, shared storage
  (/storage/emulated/0 if granted) and the Termux prefix.
- There is no command or workspace allow list. Destructive operations are possible.
- Use system_info first when you need to understand the device.
- Use run_command for non-interactive one-shot commands.
- Use terminal_create + terminal_write + terminal_read for REPLs, SSH, sudo/password
  prompts, ncurses/TUI programs and anything that needs a persistent TTY.
  Prefer terminal_read with expect (a prompt regex) over blind sleeps.
- Use task_start for long-running non-interactive jobs; task_output supports incremental
  byte offsets via next_offset. Use task_stop instead of killing by PID.
- Use the file tools instead of shell redirection when you need precise reads/edits,
  especially for binary or multi-line content.
- Prefer dry_run=true before delete_path, then confirm="DELETE".
- Avoid printing secrets into logs; the audit log records tool arguments (sensitive
  content fields are redacted).

Task:
`;

export function registerPrompts(server) {
  server.registerPrompt(
    'termux_operator',
    {
      title: 'Operate this Termux device',
      description: 'Plan and execute a task on the Android device using termux-mcp tools.',
      argsSchema: {
        task: z.string().describe('What should be done on the device?'),
      },
    },
    ({ task }) => ({
      description: 'Termux operation instructions',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `${INSTRUCTIONS}${task}`,
          },
        },
      ],
    }),
  );
}
