import { TaskManager } from '../tasks.js';

export function registerTaskTools(register, { config, logger }) {
  const tasks = new TaskManager(config, logger);

  register({
    name: 'task_start',
    title: 'Start a background task',
    description:
      'Start a detached background shell command and return immediately with a task id, PID and log path. The task keeps running if termux-mcp restarts, and its exit code is persisted in a status file. Use task_output to read incremental output and task_stop to terminate it. Background tasks are non-interactive; use terminal_create for prompts and TUI programs.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    schema: {
      command: register.z.string().min(1).describe('Shell command to run in the background.'),
      name: register.z.string().max(200).optional().describe('Optional human-readable label.'),
      cwd: register.z.string().optional().describe('Working directory. Default $HOME.'),
      env: register.z.record(register.z.string(), register.z.string()).optional().describe('Extra environment variables.'),
      wait_ms: register.z
        .number()
        .int()
        .min(0)
        .max(60000)
        .optional()
        .describe('Wait this long before returning, so initial output/failures are visible. Default 0.'),
    },
    handler: async (args) => JSON.stringify(await tasks.start(args), null, 2),
  });

  register({
    name: 'task_list',
    title: 'List background tasks',
    description:
      'List background tasks with state, PID, exit code, log size and paths. Reads persisted metadata, so tasks started before a termux-mcp restart are included.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    schema: {
      include_finished: register.z.boolean().optional().describe('Include finished tasks. Default true.'),
      limit: register.z.number().int().min(1).max(500).optional().describe('Maximum tasks to return. Default 50.'),
    },
    handler: async (args) => JSON.stringify(await tasks.list(args), null, 2),
  });

  register({
    name: 'task_output',
    title: 'Read background task output',
    description:
      'Read a task log, either the last N lines (default) or an incremental byte range via offset. Use wait_ms to wait for new output. The result includes next_offset for cheap incremental polling.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    schema: {
      id: register.z.string().describe('Task id returned by task_start.'),
      offset: register.z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Byte offset to read from. Omit to read the tail.'),
      tail_lines: register.z
        .number()
        .int()
        .min(1)
        .max(100000)
        .optional()
        .describe('When reading the tail, number of lines. Default 200.'),
      wait_ms: register.z
        .number()
        .int()
        .min(0)
        .max(60000)
        .optional()
        .describe('Wait for new output or task exit. Default 0.'),
      wait_for: register.z
        .enum(['any', 'exit'])
        .optional()
        .describe('With wait_ms: return on new output/exit (any) or only when the task exits. Default any.'),
    },
    handler: async (args) => JSON.stringify(await tasks.output(args), null, 2),
  });

  register({
    name: 'task_stop',
    title: 'Stop a background task',
    description:
      'Send a signal to the task process group, wait for the grace period, then force SIGKILL if it is still alive. Defaults to SIGTERM.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    schema: {
      id: register.z.string().describe('Task id.'),
      signal: register.z
        .enum(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGKILL'])
        .optional()
        .describe('Initial signal. Default SIGTERM.'),
      grace_ms: register.z.number().int().min(100).max(120000).optional().describe('Grace period before SIGKILL. Default 3000.'),
    },
    handler: async (args) => JSON.stringify(await tasks.stop(args), null, 2),
  });

  register({
    name: 'task_remove',
    title: 'Remove a finished task',
    description: 'Delete the metadata, log, status and script files of a task that is no longer running.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    schema: {
      id: register.z.string().describe('Task id.'),
    },
    handler: async (args) => JSON.stringify(await tasks.remove(args), null, 2),
  });
}
