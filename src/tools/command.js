import { runShell } from '../exec.js';

export function registerCommandTools(register, { config }) {
  register({
    name: 'run_command',
    title: 'Run a shell command in Termux',
    description:
      'Run a command with bash -c as the Termux user and return exit code, stdout, stderr, duration and truncation flags. Use cwd for the working directory and timeout_sec for long jobs. There is no command allow list: the command runs with the full permissions of the Termux user. A non-zero exit code is returned as data, not as a tool failure. For long-running or interactive work use the task_* or terminal_* tools.',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    schema: {
      command: register.z.string().min(1).describe('Shell command to execute with bash -c.'),
      cwd: register.z.string().optional().describe('Working directory. Default $HOME.'),
      timeout_sec: register.z
        .number()
        .int()
        .min(1)
        .max(config.security.maxTimeoutSec)
        .optional()
        .describe(`Timeout in seconds. Default ${config.security.defaultTimeoutSec}, max ${config.security.maxTimeoutSec}.`),
      env: register.z.record(register.z.string(), register.z.string()).optional().describe('Extra environment variables.'),
      stdin: register.z.string().optional().describe('Text written to the command standard input.'),
    },
    handler: async (args, extra) => {
      const result = await runShell(config, args.command, {
        cwd: args.cwd,
        timeoutSec: args.timeout_sec,
        env: args.env,
        stdin: args.stdin,
        signal: extra?.signal,
      });
      const payload = {
        exit_code: result.code,
        ok: result.ok,
        timed_out: result.timedOut,
        aborted: result.aborted,
        signal: result.signal,
        duration_ms: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
      };
      if (result.spawnError) payload.spawn_error = result.spawnError;

      return {
        text: JSON.stringify(payload, null, 2),
        isError: Boolean(result.spawnError || result.timedOut || result.aborted),
      };
    },
  });
}
