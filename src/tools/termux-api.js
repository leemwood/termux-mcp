import { commandExists, runProcess } from '../exec.js';
import { PolicyError, checkTermuxApiCommand } from '../security.js';

const INSTALL_HINT =
  'Termux:API is not available. Run "pkg install termux-api" inside Termux, install the Termux:API app from F-Droid, then open the app once and grant the permissions you need. Restart termux-mcp afterwards.';

function binaryName(command) {
  const normalized = command.replace(/^termux-/, '');
  return `termux-${normalized}`;
}

function parseMaybeJson(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function validateArgs(args) {
  if (!Array.isArray(args)) return [];
  if (args.length > 100) throw new PolicyError('Too many Termux:API arguments (max 100).');
  return args.map((value) => {
    if (typeof value !== 'string') throw new PolicyError('Every Termux:API argument must be a string.');
    if (value.length > 24000) throw new PolicyError('A Termux:API argument is too long.');
    if (value.includes('\0')) throw new PolicyError('Termux:API arguments must not contain NUL bytes.');
    return value;
  });
}

async function runTermuxApi(config, command, args = [], { stdin, timeoutSec } = {}) {
  checkTermuxApiCommand(config, command);
  const binary = binaryName(command);
  if (!commandExists(binary)) throw new PolicyError(INSTALL_HINT);

  const result = await runProcess(binary, validateArgs(args), {
    timeoutMs: (Number(timeoutSec) || config.termuxApi.timeoutSec) * 1000,
    maxBytes: config.termuxApi.maxOutputBytes,
    stdin,
  });

  if (result.spawnError) throw new PolicyError(`${binary} failed to start: ${result.spawnError}`);

  const data = parseMaybeJson(result.stdout);
  return { ...result, binary, data };
}

function resultJson(result) {
  const payload = {
    ok: result.ok,
    exit_code: result.code,
    timed_out: result.timedOut,
    duration_ms: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  if (result.data !== undefined) payload.data = result.data;
  if (result.truncated.stdout || result.truncated.stderr) payload.truncated = result.truncated;
  return JSON.stringify(payload, null, 2);
}

export function registerTermuxApiTools(register, { config }) {
  register({
    name: 'clipboard_get',
    title: 'Read the Android clipboard',
    description: 'Return the current Android clipboard text via Termux:API. Requires the termux-api package and Termux:API app.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    schema: {},
    handler: async () => {
      const result = await runTermuxApi(config, 'clipboard-get');
      if (!result.ok) throw new PolicyError(`Failed to read clipboard: ${result.stderr || `exit ${result.code}`}`);
      return result.stdout;
    },
  });

  register({
    name: 'clipboard_set',
    title: 'Write the Android clipboard',
    description: 'Set the Android clipboard text via Termux:API. Requires the termux-api package and Termux:API app.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    schema: {
      text: register.z.string().max(500_000).describe('Text to place on the clipboard.'),
    },
    handler: async (args) => {
      const result = await runTermuxApi(config, 'clipboard-set', [args.text]);
      if (!result.ok) throw new PolicyError(`Failed to set clipboard: ${result.stderr || `exit ${result.code}`}`);
      return JSON.stringify({ ok: true, bytes: Buffer.byteLength(args.text, 'utf8') }, null, 2);
    },
  });

  register({
    name: 'notify',
    title: 'Post an Android notification',
    description: 'Create an Android notification via Termux:API. Requires the Termux:API app and notification permission. Use a stable id to update an existing notification.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    schema: {
      title: register.z.string().max(500).optional().describe('Notification title.'),
      content: register.z.string().max(4000).optional().describe('Notification body.'),
      id: register.z.number().int().min(1).optional().describe('Notification id used for updates.'),
      priority: register.z.enum(['min', 'low', 'default', 'high', 'max']).optional().describe('Notification priority.'),
      sound: register.z.boolean().optional().describe('Play the notification sound.'),
      vibrate: register.z.string().optional().describe('Vibration pattern, e.g. "100,200,100".'),
      ongoing: register.z.boolean().optional().describe('Make the notification ongoing (not dismissible).'),
      group: register.z.string().max(100).optional().describe('Notification group key.'),
    },
    handler: async (args) => {
      if (!args.title && !args.content) throw new PolicyError('Provide at least one of title or content.');

      const apiArgs = [];
      if (args.title) apiArgs.push('--title', args.title);
      if (args.content) apiArgs.push('--content', args.content);
      if (args.id) apiArgs.push('--id', String(args.id));
      if (args.priority) apiArgs.push('--priority', args.priority);
      if (args.sound) apiArgs.push('--sound');
      if (args.vibrate) apiArgs.push('--vibrate', args.vibrate);
      if (args.ongoing) apiArgs.push('--ongoing');
      if (args.group) apiArgs.push('--group', args.group);

      const result = await runTermuxApi(config, 'notification', apiArgs);
      if (!result.ok) throw new PolicyError(`Failed to post notification: ${result.stderr || `exit ${result.code}`}`);
      return resultJson(result);
    },
  });

  register({
    name: 'toast',
    title: 'Show an Android toast',
    description: 'Show a short toast message on the device via Termux:API.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    schema: {
      text: register.z.string().min(1).max(500).describe('Toast text.'),
      short: register.z.boolean().optional().describe('Use the short toast duration. Default true.'),
    },
    handler: async (args) => {
      const apiArgs = [args.text];
      if (args.short !== false) apiArgs.unshift('-s');
      const result = await runTermuxApi(config, 'toast', apiArgs);
      if (!result.ok) throw new PolicyError(`Failed to show toast: ${result.stderr || `exit ${result.code}`}`);
      return resultJson(result);
    },
  });

  register({
    name: 'vibrate',
    title: 'Vibrate the device',
    description: 'Vibrate the device for the given duration via Termux:API.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    schema: {
      duration_ms: register.z.number().int().min(1).max(60000).optional().describe('Duration in milliseconds. Default 300.'),
      force: register.z.boolean().optional().describe('Vibrate even in silent mode.'),
    },
    handler: async (args) => {
      const apiArgs = ['-d', String(args.duration_ms || 300)];
      if (args.force) apiArgs.push('-f');
      const result = await runTermuxApi(config, 'vibrate', apiArgs);
      if (!result.ok) throw new PolicyError(`Failed to vibrate: ${result.stderr || `exit ${result.code}`}`);
      return resultJson(result);
    },
  });

  register({
    name: 'open',
    title: 'Open a URL or file on Android',
    description: 'Open an http(s) URL in the default browser, or open a local file with Android via Termux:API. Local paths are resolved on the device; Android permissions still apply.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    schema: {
      target: register.z.string().min(1).describe('http(s) URL or local file path.'),
      content_type: register.z.string().optional().describe('MIME type for local files, e.g. text/plain.'),
    },
    handler: async (args) => {
      let result;
      if (/^https?:\/\//i.test(args.target)) {
        result = await runTermuxApi(config, 'open-url', [args.target]);
      } else {
        const { assertPathAllowed } = await import('../security.js');
        const allowed = await assertPathAllowed(config, args.target, { write: false, label: 'target' });
        const apiArgs = [allowed.real];
        if (args.content_type) apiArgs.push('--content-type', args.content_type);
        result = await runTermuxApi(config, 'open', apiArgs);
      }
      if (!result.ok) throw new PolicyError(`Failed to open target: ${result.stderr || `exit ${result.code}`}`);
      return resultJson(result);
    },
  });

  register({
    name: 'battery_status',
    title: 'Read Android battery status',
    description: 'Return battery percentage, charging state, temperature and related fields via Termux:API.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    schema: {},
    handler: async () => {
      const result = await runTermuxApi(config, 'battery-status');
      if (!result.ok) throw new PolicyError(`Failed to read battery status: ${result.stderr || `exit ${result.code}`}`);
      if (result.data !== undefined) return JSON.stringify(result.data, null, 2);
      return resultJson(result);
    },
  });

  register({
    name: 'tts_speak',
    title: 'Speak text with Android TTS',
    description: 'Speak text aloud using the Android text-to-speech engine via Termux:API.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    schema: {
      text: register.z.string().min(1).max(4000).describe('Text to speak.'),
      rate: register.z.number().min(0.1).max(2).optional().describe('Speech rate. Default 1.'),
      pitch: register.z.number().min(0.1).max(2).optional().describe('Speech pitch. Default 1.'),
      language: register.z.string().max(20).optional().describe('BCP-47 language tag, e.g. en-US or zh-CN.'),
    },
    handler: async (args) => {
      const apiArgs = [];
      if (args.rate !== undefined) apiArgs.push('-r', String(args.rate));
      if (args.pitch !== undefined) apiArgs.push('-p', String(args.pitch));
      if (args.language) apiArgs.push('-l', args.language);
      apiArgs.push(args.text);
      const result = await runTermuxApi(config, 'tts-speak', apiArgs);
      if (!result.ok) throw new PolicyError(`Failed to speak: ${result.stderr || `exit ${result.code}`}`);
      return resultJson(result);
    },
  });

  register({
    name: 'termux_api',
    title: 'Run a raw Termux:API command',
    description:
      'Advanced escape hatch: run any termux-* command directly (for example command="wifi-connectioninfo", args=["-i"]). No shell is involved, but the command still has the full permissions granted to Termux:API. Privacy-sensitive commands such as SMS, calls, contacts, location, camera and microphone are available if the Termux:API app has been granted those Android permissions; every call is written to the audit log.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    schema: {
      command: register.z
        .string()
        .regex(/^(termux-)?[a-z0-9-]+$/)
        .describe('Command name with or without the termux- prefix, e.g. "wifi-connectioninfo".'),
      args: register.z.array(register.z.string()).optional().describe('Command arguments. No shell expansion is performed.'),
      stdin: register.z.string().optional().describe('Text written to standard input.'),
      timeout_sec: register.z.number().int().min(1).max(300).optional().describe('Timeout. Default from config.'),
    },
    handler: async (args) => {
      const command = args.command.replace(/^termux-/, '');
      const result = await runTermuxApi(config, command, args.args || [], {
        stdin: args.stdin,
        timeoutSec: args.timeout_sec,
      });
      return resultJson(result);
    },
  });
}
