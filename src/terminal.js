import fsp from 'node:fs/promises';
import path from 'node:path';

import { commandExists, runProcess } from './exec.js';
import { PolicyError, resolveUserPath } from './security.js';
import {
  cleanEnv,
  findExecutable,
  isExecutable,
  resolveShell,
  sleep,
} from './shell.js';

const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_NAME = /^[A-Za-z0-9_+\-^[\]\\]{1,24}$/;
const PANE_FORMAT = [
  '#{session_name}',
  '#{session_created}',
  '#{session_attached}',
  '#{pane_current_command}',
  '#{pane_pid}',
  '#{pane_width}',
  '#{pane_height}',
  '#{pane_dead}',
  '#{session_windows}',
].join('\t');

function targetPane(name) {
  return `=${name}:`;
}

function targetSession(name) {
  return `=${name}`;
}

function validateName(name) {
  if (typeof name !== 'string' || !SESSION_NAME.test(name)) {
    throw new PolicyError(
      'session name must start with a letter/digit and contain only letters, digits, _, . or - (max 64 chars).',
    );
  }
  return name;
}

function validateEnv(env) {
  if (!env) return {};
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new PolicyError('env must be an object of string values.');
  }
  const entries = Object.entries(env);
  if (entries.length > 64) throw new PolicyError('Too many environment variables (max 64).');
  const out = {};
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key)) throw new PolicyError(`Invalid environment variable name: ${key}`);
    if (typeof value !== 'string') throw new PolicyError(`Environment value for ${key} must be a string.`);
    if (value.includes('\0') || value.length > 8192) {
      throw new PolicyError(`Invalid environment value for ${key}.`);
    }
    out[key] = value;
  }
  return out;
}

function trimTerminalOutput(text) {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

export class TerminalManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.socketPath = config.terminal.socketPath;
  }

  ensureEnabled() {
    if (!this.config.terminal.enabled) {
      throw new PolicyError('Terminal support is disabled (terminal.enabled=false in the config).');
    }
  }

  async ensureTmux() {
    this.ensureEnabled();
    if (!commandExists('tmux')) {
      throw new PolicyError(
        'tmux is required for interactive terminal sessions. Install it inside Termux with: pkg install tmux',
      );
    }
    await fsp.mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await fsp.chmod(path.dirname(this.socketPath), 0o700).catch(() => {});
  }

  async tmux(args, { timeoutMs = 15000, maxBytes = 1024 * 1024, stdin } = {}) {
    await this.ensureTmux();
    return await runProcess(
      'tmux',
      ['-S', this.socketPath, '-f', '/dev/null', ...args],
      {
        env: cleanEnv({}, { term: 'xterm-256color' }),
        timeoutMs,
        maxBytes,
        stdin,
      },
    );
  }

  async setGlobalOption(key, value) {
    const result = await this.tmux(['set-option', '-g', key, value]);
    if (!result.ok) {
      this.logger.debug('tmux set-option failed', { key, value, stderr: result.stderr.trim() });
    }
  }

  async initializeServerOptions() {
    const start = await this.tmux(['start-server']);
    if (!start.ok) throw new PolicyError(`Failed to start tmux server: ${start.stderr.trim()}`);
    await this.setGlobalOption('history-limit', String(this.config.terminal.historyLimit));
    await this.setGlobalOption('status', 'off');
    await this.setGlobalOption('remain-on-exit', 'on');
    await this.setGlobalOption('default-terminal', 'xterm-256color');
    await this.setGlobalOption('mouse', 'off');
    await this.setGlobalOption('escape-time', '0');
    await this.setGlobalOption('exit-empty', 'on');
    await this.setGlobalOption('set-clipboard', 'off');
  }

  async listSessions() {
    this.ensureEnabled();
    if (!commandExists('tmux')) {
      return { sessions: [], socket_path: this.socketPath, tmux_available: false };
    }

    const result = await this.tmux(['list-sessions', '-F', PANE_FORMAT]);
    if (!result.ok) {
      const message = `${result.stderr}\n${result.stdout}`.trim();
      if (/no server running|error connecting|No such file or directory/i.test(message)) {
        return { sessions: [], socket_path: this.socketPath, tmux_available: true };
      }
      throw new PolicyError(`tmux list-sessions failed: ${message || `exit ${result.code}`}`);
    }

    const sessions = result.stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const [
          name,
          created,
          attached,
          currentCommand,
          pid,
          width,
          height,
          dead,
          windows,
        ] = line.split('\t');
        return {
          name,
          created_at: created ? new Date(Number(created) * 1000).toISOString() : null,
          attached: Number(attached) > 0,
          windows: Number(windows) || 0,
          current_command: currentCommand || null,
          pid: pid ? Number(pid) : null,
          size: width && height ? `${width}x${height}` : null,
          alive: dead !== '1',
          attach_command: `tmux -S ${this.socketPath} attach -t ${name}`,
        };
      })
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

    return { sessions, socket_path: this.socketPath, tmux_available: true };
  }

  async findSession(name) {
    const normalized = validateName(name);
    const { sessions } = await this.listSessions();
    return sessions.find((session) => session.name === normalized) || null;
  }

  async requireSession(name, { requireAlive = false } = {}) {
    const info = await this.findSession(name);
    if (!info) {
      const { sessions } = await this.listSessions();
      const available = sessions.map((session) => session.name).join(', ') || '(none)';
      throw new PolicyError(`Terminal session not found: ${name}. Available sessions: ${available}`);
    }
    if (requireAlive && !info.alive) {
      throw new PolicyError(`Terminal session "${name}" has exited. Kill it and create a new session.`);
    }
    return info;
  }

  resolveShellForSession(requestedShell) {
    const shell = requestedShell || resolveShell(this.config);
    const resolved = findExecutable(shell);
    if (!resolved) {
      throw new PolicyError(`Shell is not executable or not found: ${shell}`);
    }
    return resolved;
  }

  async create(args = {}) {
    this.ensureEnabled();
    await this.initializeServerOptions();

    const { sessions } = await this.listSessions();
    if (sessions.length >= this.config.terminal.maxSessions) {
      throw new PolicyError(
        `Maximum number of terminal sessions reached (${this.config.terminal.maxSessions}). Kill one before creating another.`,
      );
    }

    let name = args.name ? validateName(args.name) : `term-${Date.now().toString(36)}`;
    if (args.name && sessions.some((session) => session.name === name)) {
      throw new PolicyError(`Terminal session already exists: ${name}`);
    }
    while (sessions.some((session) => session.name === name)) {
      name = `term-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
    }

    const shell = this.resolveShellForSession(args.shell);
    let shellArgs = Array.isArray(args.shell_args)
      ? args.shell_args
      : [...this.config.terminal.shellArgs];
    for (const arg of shellArgs) {
      if (typeof arg !== 'string' || arg.includes('\0')) {
        throw new PolicyError('shell_args must be an array of strings without NUL bytes.');
      }
    }

    const useRc = args.use_rc === true || this.config.terminal.useShellRc === true;
    if (
      !useRc
      && path.basename(shell).startsWith('bash')
      && shellArgs.length === 0
      && !args.shell_args
      && this.config.terminal.shellArgs.length === 0
    ) {
      // A user's .bashrc can change line editing and break Enter handling in a
      // fresh tmux pane. Default to a clean bash; set terminal.useShellRc=true
      // (or pass use_rc=true) to load the normal startup files.
      shellArgs = ['--noprofile', '--norc'];
    }

    const cwd = resolveUserPath(args.cwd || '~');
    let cwdStat;
    try {
      cwdStat = await fsp.stat(cwd);
    } catch (error) {
      throw new PolicyError(`cwd does not exist: ${cwd} (${error.message})`);
    }
    if (!cwdStat.isDirectory()) throw new PolicyError(`cwd is not a directory: ${cwd}`);

    const cols = Math.min(Math.max(Number(args.cols) || this.config.terminal.defaultCols, 20), 500);
    const rows = Math.min(Math.max(Number(args.rows) || this.config.terminal.defaultRows, 5), 300);
    const env = validateEnv(args.env);

    const newSessionArgs = [
      'new-session',
      '-d',
      '-s',
      name,
      '-x',
      String(cols),
      '-y',
      String(rows),
      '-c',
      cwd,
    ];
    for (const [key, value] of Object.entries(env)) {
      newSessionArgs.push('-e', `${key}=${value}`);
    }
    newSessionArgs.push(shell, ...shellArgs);

    const result = await this.tmux(newSessionArgs, { timeoutMs: 20000 });
    if (!result.ok) {
      throw new PolicyError(`Failed to create tmux session: ${result.stderr.trim() || `exit ${result.code}`}`);
    }

    await sleep(200);
    const info = await this.findSession(name);
    return {
      ...info,
      backend: 'tmux',
      shell,
      shell_args: shellArgs,
      cwd,
      requested_size: `${cols}x${rows}`,
      env_keys: Object.keys(env),
      attach_command: `tmux -S ${this.socketPath} attach -t ${name}`,
    };
  }

  async write(args) {
    const info = await this.requireSession(args.session, { requireAlive: true });
    const name = info.name;
    const hasInput = typeof args.input === 'string' && args.input.length > 0;
    const keys = Array.isArray(args.keys) ? args.keys : [];

    if (!hasInput && keys.length === 0 && args.submit !== true) {
      throw new PolicyError('Provide input, keys, or submit=true.');
    }
    if (typeof args.input === 'string' && args.input.includes('\0')) {
      throw new PolicyError('input contains a NUL byte.');
    }
    if (args.input && args.input.length > 1_000_000) {
      throw new PolicyError('input is too large (max 1,000,000 chars).');
    }
    if (keys.length > 50) throw new PolicyError('Too many keys in one call (max 50).');
    for (const key of keys) {
      if (typeof key !== 'string' || !KEY_NAME.test(key)) {
        throw new PolicyError(
          `Invalid tmux key name: ${JSON.stringify(key)}. Examples: Enter, Tab, Escape, Up, C-c, M-x, F1.`,
        );
      }
    }

    let pasted = false;
    if (hasInput) {
      const shouldPaste = args.paste === true
        || (args.paste !== false && (args.input.includes('\n') || args.input.length > 4096));

      if (shouldPaste) {
        const bufferName = `tmux-mcp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const load = await this.tmux(['load-buffer', '-b', bufferName, '-'], {
          stdin: args.input,
          timeoutMs: 10000,
        });
        if (!load.ok) {
          throw new PolicyError(`Failed to load paste buffer: ${load.stderr.trim()}`);
        }
        const paste = await this.tmux([
          'paste-buffer',
          '-p',
          '-d',
          '-b',
          bufferName,
          '-t',
          targetPane(name),
        ]);
        if (!paste.ok) {
          this.logger.debug('tmux paste-buffer failed, falling back to literal input', {
            stderr: paste.stderr.trim(),
          });
          const literal = await this.tmux([
            'send-keys',
            '-t',
            targetPane(name),
            '-l',
            '--',
            args.input,
          ]);
          if (!literal.ok) {
            throw new PolicyError(`Failed to send input: ${literal.stderr.trim()}`);
          }
        } else {
          pasted = true;
        }
      } else {
        const result = await this.tmux([
          'send-keys',
          '-t',
          targetPane(name),
          '-l',
          '--',
          args.input,
        ]);
        if (!result.ok) throw new PolicyError(`Failed to send input: ${result.stderr.trim()}`);
      }
    }

    if (keys.length > 0) {
      const result = await this.tmux([
        'send-keys',
        '-t',
        targetPane(name),
        ...keys,
      ]);
      if (!result.ok) throw new PolicyError(`Failed to send keys: ${result.stderr.trim()}`);
    }

    if (args.submit === true) {
      const result = await this.tmux(['send-keys', '-t', targetPane(name), 'Enter']);
      if (!result.ok) throw new PolicyError(`Failed to send Enter: ${result.stderr.trim()}`);
    }

    const waitMs = Math.min(Math.max(Number(args.wait_ms) || 0, 0), 60000);
    if (waitMs > 0) await sleep(waitMs);

    const payload = {
      session: name,
      ok: true,
      sent_bytes: hasInput ? Buffer.byteLength(args.input, 'utf8') : 0,
      pasted,
      keys_sent: keys,
      submitted: args.submit === true,
      waited_ms: waitMs,
    };

    if (waitMs > 0) {
      const read = await this.captureForRead(name, {
        lines: Math.min(Math.max(Number(args.read_lines) || 80, 1), 1000),
        full_history: false,
        ansi: false,
        join_wrapped: false,
        maxBytes: this.config.terminal.maxReadBytes,
      });
      payload.output = read.output;
      payload.alive = read.alive;
    }

    return JSON.stringify(payload, null, 2);
  }

  async captureForRead(name, { lines, full_history, ansi, join_wrapped, maxBytes }) {
    const args = ['capture-pane', '-p', '-t', targetPane(name)];
    if (full_history) args.push('-S', '-');
    else args.push('-S', `-${Math.max(1, lines)}`);
    if (ansi) args.push('-e');
    if (join_wrapped) args.push('-J');

    const result = await this.tmux(args, { maxBytes: Math.max(maxBytes * 2, 1024 * 1024) });
    if (!result.ok) {
      throw new PolicyError(`Failed to capture terminal output: ${result.stderr.trim()}`);
    }

    let output = trimTerminalOutput(result.stdout);
    if (Buffer.byteLength(output, 'utf8') > maxBytes) {
      output = output.slice(-maxBytes);
      output = `…[terminal output truncated to last ${maxBytes} bytes]…\n${output}`;
    }

    const info = await this.findSession(name);
    return {
      output,
      alive: Boolean(info?.alive),
      size: info?.size || null,
      current_command: info?.current_command || null,
    };
  }

  async read(args) {
    const info = await this.requireSession(args.session);
    const lines = Math.min(Math.max(Number(args.lines) || this.config.terminal.defaultReadLines, 1), 100000);
    const waitMs = Math.min(Math.max(Number(args.wait_ms) || 0, 0), 60000);
    const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 10000, 0), 120000);
    const maxBytes = this.config.terminal.maxReadBytes;

    let expect = null;
    if (args.expect) {
      try {
        expect = new RegExp(args.expect, 'm');
      } catch (error) {
        throw new PolicyError(`Invalid expect regex: ${error.message}`);
      }
    }

    const started = Date.now();
    if (waitMs > 0) await sleep(waitMs);

    let captured = null;
    let matched = null;
    for (;;) {
      try {
        captured = await this.captureForRead(info.name, {
          lines,
          full_history: Boolean(args.full_history),
          ansi: Boolean(args.ansi),
          join_wrapped: Boolean(args.join_wrapped),
          maxBytes,
        });
      } catch (error) {
        if (captured) break;
        throw error;
      }

      matched = expect ? expect.test(captured.output) : null;
      if (!expect || matched) break;
      if (Date.now() - started >= timeoutMs) break;
      await sleep(150);
    }

    return JSON.stringify(
      {
        session: info.name,
        alive: captured?.alive ?? false,
        size: captured?.size ?? info.size,
        current_command: captured?.current_command ?? info.current_command,
        expect: args.expect || null,
        expect_matched: matched,
        timed_out: Boolean(expect && matched === false),
        waited_ms: Date.now() - started,
        output: captured?.output || '',
      },
      null,
      2,
    );
  }

  async resize(args) {
    const info = await this.requireSession(args.session, { requireAlive: true });
    const cols = Math.min(Math.max(Number(args.cols) || this.config.terminal.defaultCols, 20), 500);
    const rows = Math.min(Math.max(Number(args.rows) || this.config.terminal.defaultRows, 5), 300);

    let result = await this.tmux([
      'resize-window',
      '-t',
      targetPane(info.name),
      '-x',
      String(cols),
      '-y',
      String(rows),
    ]);
    if (!result.ok) {
      result = await this.tmux([
        'resize-pane',
        '-t',
        targetPane(info.name),
        '-x',
        String(cols),
        '-y',
        String(rows),
      ]);
    }
    if (!result.ok) throw new PolicyError(`Failed to resize terminal: ${result.stderr.trim()}`);

    await sleep(100);
    const updated = await this.findSession(info.name);
    return JSON.stringify(
      {
        session: info.name,
        size: updated?.size || `${cols}x${rows}`,
        requested_size: `${cols}x${rows}`,
      },
      null,
      2,
    );
  }

  async kill(args) {
    this.ensureEnabled();
    if (args.all === true) {
      const { sessions } = await this.listSessions();
      const killed = [];
      for (const session of sessions) {
        const result = await this.tmux(['kill-session', '-t', targetSession(session.name)]);
        if (result.ok) killed.push(session.name);
      }
      return JSON.stringify({ killed, count: killed.length }, null, 2);
    }

    if (!args.session) throw new PolicyError('Provide session, or set all=true.');
    const info = await this.requireSession(args.session);
    const result = await this.tmux(['kill-session', '-t', targetSession(info.name)]);
    if (!result.ok) throw new PolicyError(`Failed to kill session: ${result.stderr.trim()}`);
    return JSON.stringify({ session: info.name, killed: true }, null, 2);
  }

  async attachInfo(args) {
    const info = await this.requireSession(args.session);
    return JSON.stringify(
      {
        session: info.name,
        attach_command: info.attach_command,
        note: 'Run this command inside a Termux terminal. External Android apps cannot attach to the TTY, but can use terminal_read/terminal_write.',
      },
      null,
      2,
    );
  }
}
