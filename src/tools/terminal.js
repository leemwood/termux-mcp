import { TerminalManager } from '../terminal.js';

export function registerTerminalTools(register, { config, logger }) {
  const terminal = new TerminalManager(config, logger);

  register({
    name: 'terminal_create',
    title: 'Create an interactive terminal session',
    description:
      'Create a persistent interactive shell in tmux. Sessions survive termux-mcp restarts and can run REPLs, SSH, TUI programs and prompts. The shell defaults to $SHELL (Termux bash if unset); when bash is selected, startup files are skipped by default because a custom .bashrc can break Enter handling. Set use_rc=true or terminal.useShellRc in the config to load them. Use terminal_write to type and terminal_read to capture output.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    schema: {
      name: register.z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
        .optional()
        .describe('Session name. Defaults to term-<timestamp>.'),
      shell: register.z.string().optional().describe('Shell or executable path. Default $SHELL or Termux bash.'),
      shell_args: register.z.array(register.z.string()).max(32).optional().describe('Extra shell arguments.'),
      cwd: register.z.string().optional().describe('Working directory. Default $HOME.'),
      cols: register.z.number().int().min(20).max(500).optional().describe('Terminal width. Default 100.'),
      rows: register.z.number().int().min(5).max(300).optional().describe('Terminal height. Default 30.'),
      env: register.z.record(register.z.string(), register.z.string()).optional().describe('Extra environment variables.'),
      use_rc: register.z.boolean().optional().describe('Load the shell startup files (.bashrc). Default false.'),
    },
    handler: async (args) => JSON.stringify(await terminal.create(args), null, 2),
  });

  register({
    name: 'terminal_write',
    title: 'Type into a terminal session',
    description:
      'Send literal text, special key names, and/or Enter to a terminal session. Multi-line or large text is pasted through a tmux buffer by default; set paste=false to force literal send-keys. Key names use tmux notation: Enter, Tab, Escape, Up, Down, Left, Right, C-c, C-d, M-x, F1, etc. Set wait_ms to return a capture in the same call.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    schema: {
      session: register.z.string().describe('Session name.'),
      input: register.z.string().optional().describe('Literal text to type or paste.'),
      keys: register.z
        .array(register.z.string())
        .max(50)
        .optional()
        .describe('tmux key names, e.g. ["C-c"] or ["Tab","Enter"].'),
      submit: register.z.boolean().optional().describe('Send Enter after the input/keys. Default false.'),
      paste: register.z.boolean().optional().describe('Force bracketed paste. Default: auto for multi-line/large input.'),
      wait_ms: register.z.number().int().min(0).max(60000).optional().describe('Wait before capturing output. Default 0.'),
      read_lines: register.z.number().int().min(1).max(1000).optional().describe('Lines captured when wait_ms > 0. Default 80.'),
    },
    handler: async (args) => await terminal.write(args),
  });

  register({
    name: 'terminal_read',
    title: 'Read terminal output',
    description:
      'Capture the visible screen and recent scrollback of a terminal session. Use expect with a regex to wait until a prompt or marker appears; if it does not match within timeout_ms, the result has expect_matched=false and timed_out=true. ANSI escapes are stripped by default. full_history=true captures the whole tmux history.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    schema: {
      session: register.z.string().describe('Session name.'),
      lines: register.z.number().int().min(1).max(100000).optional().describe('Scrollback lines to capture. Default 120.'),
      full_history: register.z.boolean().optional().describe('Capture the entire tmux history. Default false.'),
      ansi: register.z.boolean().optional().describe('Keep ANSI escape sequences. Default false.'),
      join_wrapped: register.z.boolean().optional().describe('Join wrapped lines (tmux -J). Default false.'),
      wait_ms: register.z.number().int().min(0).max(60000).optional().describe('Wait before the first capture.'),
      expect: register.z.string().optional().describe('Regex to wait for in the captured output.'),
      timeout_ms: register.z.number().int().min(0).max(120000).optional().describe('Expect polling timeout. Default 10000.'),
    },
    handler: async (args) => await terminal.read(args),
  });

  register({
    name: 'terminal_list',
    title: 'List terminal sessions',
    description:
      'List tmux-backed terminal sessions with size, current command, PID, alive/dead state and a command for attaching from a Termux terminal.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    schema: {},
    handler: async () => JSON.stringify(await terminal.listSessions(), null, 2),
  });

  register({
    name: 'terminal_resize',
    title: 'Resize a terminal session',
    description: 'Resize the tmux window/PTY used by a terminal session. Useful before launching TUI programs.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    schema: {
      session: register.z.string().describe('Session name.'),
      cols: register.z.number().int().min(20).max(500).describe('Width in columns.'),
      rows: register.z.number().int().min(5).max(300).describe('Height in rows.'),
    },
    handler: async (args) => await terminal.resize(args),
  });

  register({
    name: 'terminal_kill',
    title: 'Kill a terminal session',
    description:
      'Kill one terminal session by name, or every session with all=true. Killing a session terminates its shell and any programs running in that pane.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    schema: {
      session: register.z.string().optional().describe('Session name.'),
      all: register.z.boolean().optional().describe('Kill every terminal session.'),
    },
    handler: async (args) => await terminal.kill(args),
  });

  register({
    name: 'terminal_attach_info',
    title: 'Show how to attach to a session',
    description:
      'Return the tmux attach command for a session. Run it from a Termux terminal for direct human interaction; external Android apps should keep using terminal_read/terminal_write.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    schema: {
      session: register.z.string().describe('Session name.'),
    },
    handler: async (args) => await terminal.attachInfo(args),
  });
}
