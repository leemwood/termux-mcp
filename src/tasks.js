import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { PolicyError, checkCommand, resolveUserPath } from './security.js';
import { cleanEnv, isProcessAlive, resolveBash, sleep } from './shell.js';

const TASK_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGKILL']);

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

function validateSignal(signal) {
  const normalized = String(signal || 'SIGTERM').toUpperCase();
  if (!SIGNALS.has(normalized)) {
    throw new PolicyError(`Unsupported signal: ${signal}. Use one of ${[...SIGNALS].join(', ')}.`);
  }
  return normalized;
}

function writeJsonSync(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Ignore filesystems without chmod support.
  }
}

export class TaskManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.dir = config.tasks.dir;
  }

  async ensureDir() {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.dir, 0o700).catch(() => {});
  }

  metaPath(id) {
    return path.join(this.dir, `${id}.json`);
  }

  logPath(id) {
    return path.join(this.dir, `${id}.log`);
  }

  scriptPath(id) {
    return path.join(this.dir, `${id}.sh`);
  }

  statusPath(id) {
    return path.join(this.dir, `${id}.status`);
  }

  validateId(id) {
    if (typeof id !== 'string' || !TASK_ID.test(id)) {
      throw new PolicyError('Invalid task id.');
    }
    return id;
  }

  readStatus(id) {
    try {
      const text = fs.readFileSync(this.statusPath(id), 'utf8').trim();
      if (!/^-?\d+$/.test(text)) return null;
      const code = Number.parseInt(text, 10);
      return Number.isInteger(code) ? code : null;
    } catch {
      return null;
    }
  }

  readMetaSync(id) {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new PolicyError(`Failed to read task metadata for ${id}: ${error.message}`);
    }
  }

  writeMetaSync(meta) {
    writeJsonSync(this.metaPath(meta.id), meta);
  }

  async writeMeta(meta) {
    await writeJsonSyncAsync(this.metaPath(meta.id), meta);
  }

  async load(id) {
    this.validateId(id);
    const meta = this.readMetaSync(id);
    if (!meta) throw new PolicyError(`Task not found: ${id}`);
    return meta;
  }

  async all() {
    await this.ensureDir();
    let entries;
    try {
      entries = await fsp.readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }

    const tasks = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
      const id = entry.name.slice(0, -5);
      if (!TASK_ID.test(id)) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(this.dir, entry.name), 'utf8'));
        tasks.push(await this.hydrate(meta));
      } catch (error) {
        this.logger.warn('Skipping unreadable task metadata', { file: entry.name, error: error.message });
      }
    }

    return tasks.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  }

  async hydrate(meta) {
    const running = meta.state === 'running' && isProcessAlive(meta.pid);
    let changed = false;

    if (meta.state === 'running' && !running) {
      const code = this.readStatus(meta.id);
      meta.state = code === null ? 'unknown' : code === 0 ? 'exited' : 'failed';
      meta.exit_code = code;
      meta.running = false;
      try {
        const stat = await fsp.stat(this.statusPath(meta.id));
        meta.ended_at = stat.mtime.toISOString();
      } catch {
        try {
          const stat = await fsp.stat(this.logPath(meta.id));
          meta.ended_at = stat.mtime.toISOString();
        } catch {
          meta.ended_at = meta.ended_at || null;
        }
      }
      changed = true;
    }

    meta.running = meta.state === 'running' && isProcessAlive(meta.pid);

    try {
      const stat = await fsp.stat(this.logPath(meta.id));
      meta.log_size = stat.size;
    } catch {
      meta.log_size = 0;
    }

    if (changed) await this.writeMeta(meta);
    return meta;
  }

  async start(args = {}) {
    await this.ensureDir();
    checkCommand(args.command);

    const current = await this.all();
    const runningCount = current.filter((task) => task.running).length;
    if (runningCount >= this.config.tasks.maxTasks) {
      throw new PolicyError(
        `Maximum number of running background tasks reached (${this.config.tasks.maxTasks}). Stop one before starting another.`,
      );
    }

    const cwd = resolveUserPath(args.cwd || '~');
    let stat;
    try {
      stat = await fsp.stat(cwd);
    } catch (error) {
      throw new PolicyError(`cwd does not exist: ${cwd} (${error.message})`);
    }
    if (!stat.isDirectory()) throw new PolicyError(`cwd is not a directory: ${cwd}`);

    const env = validateEnv(args.env);
    const shell = resolveBash();
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    const logPath = this.logPath(id);
    const statusPath = this.statusPath(id);
    const scriptPath = this.scriptPath(id);

    const script = [
      `# termux-mcp background task ${id}`,
      `# Started: ${new Date().toISOString()}`,
      `# cwd: ${cwd}`,
      '(',
      args.command,
      ')',
      '__termux_mcp_exit=$?',
      `printf '%s\\n' "$__termux_mcp_exit" > ${shQuote(`${statusPath}.tmp`)}`,
      `mv -f ${shQuote(`${statusPath}.tmp`)} ${shQuote(statusPath)}`,
      'exit "$__termux_mcp_exit"',
      '',
    ].join('\n');

    await fsp.writeFile(scriptPath, script, { mode: 0o700 });
    await fsp.chmod(scriptPath, 0o700).catch(() => {});

    const logFd = fs.openSync(logPath, 'a', 0o600);
    try {
      fs.chmodSync(logPath, 0o600);
    } catch {
      // Ignore filesystems without chmod support.
    }
    let child;
    try {
      child = spawn(shell, [scriptPath], {
        cwd,
        env: cleanEnv(env),
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
    } catch (error) {
      fs.closeSync(logFd);
      await fsp.rm(scriptPath, { force: true });
      throw new PolicyError(`Failed to start background task: ${error.message}`);
    } finally {
      try {
        fs.closeSync(logFd);
      } catch {
        // Already closed.
      }
    }

    if (!child.pid) {
      throw new PolicyError('Failed to start background task: no PID was assigned.');
    }

    const meta = {
      id,
      name: args.name ? String(args.name).slice(0, 200) : null,
      command: args.command,
      cwd,
      shell,
      pid: child.pid,
      pgid: child.pid,
      state: 'running',
      exit_code: null,
      signal: null,
      started_at: new Date().toISOString(),
      ended_at: null,
      log_path: logPath,
      script_path: scriptPath,
      status_path: statusPath,
      env_keys: Object.keys(env),
    };

    child.once('exit', (code, signal) => {
      const current = this.readMetaSync(id);
      if (!current || current.state === 'stopped' || current.state === 'removed') return;

      const statusCode = this.readStatus(id);
      const exitCode = statusCode === null ? code : statusCode;
      const updated = {
        ...meta,
        state: exitCode === 0 ? 'exited' : 'failed',
        exit_code: exitCode,
        signal: signal || null,
        ended_at: new Date().toISOString(),
        running: false,
      };
      try {
        this.writeMetaSync(updated);
      } catch (error) {
        this.logger.warn('Failed to update task metadata', { id, error: error.message });
      }
      try {
        fs.appendFileSync(
          logPath,
          `\n[termux-mcp] task ${id} exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''} at ${updated.ended_at}\n`,
        );
      } catch {
        // Log may have been removed.
      }
    });

    child.on('error', (error) => {
      this.logger.warn('Background task process error', { id, error: error.message });
    });

    child.unref();
    this.writeMetaSync(meta);

    const waitMs = Math.min(Math.max(Number(args.wait_ms) || 0, 0), 60000);
    if (waitMs > 0) await sleep(waitMs);
    const hydrated = await this.hydrate(meta);
    const result = {
      ...hydrated,
      initial_output: waitMs > 0 ? await this.readTail(id, 200) : undefined,
    };
    return result;
  }

  async list(args = {}) {
    const includeFinished = args.include_finished !== false;
    const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);
    const all = await this.all();
    const filtered = includeFinished ? all : all.filter((task) => task.running);
    return {
      dir: this.dir,
      total: all.length,
      running: all.filter((task) => task.running).length,
      returned: Math.min(filtered.length, limit),
      tasks: filtered.slice(0, limit),
    };
  }

  async readTail(id, tailLines) {
    const logPath = this.logPath(id);
    let stat;
    try {
      stat = await fsp.stat(logPath);
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }

    const maxBytes = this.config.tasks.maxOutputReadBytes;
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return '';

    const handle = await fsp.open(logPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let text = buffer.toString('utf8');
      if (tailLines > 0) {
        const lines = text.split('\n');
        text = lines.slice(-tailLines).join('\n');
      }
      if (start > 0) text = `…[${start} earlier bytes omitted]…\n${text}`;
      return text;
    } finally {
      await handle.close();
    }
  }

  async output(args = {}) {
    const id = this.validateId(args.id);
    let meta = await this.hydrate(await this.load(id));
    const waitMs = Math.min(Math.max(Number(args.wait_ms) || 0, 0), 60000);
    const waitForExit = args.wait_for === 'exit';
    const offsetProvided = args.offset !== undefined && args.offset !== null;
    const offset = offsetProvided ? Math.max(0, Number.parseInt(args.offset, 10) || 0) : null;

    if (waitMs > 0) {
      const deadline = Date.now() + waitMs;
      const initialSize = meta.log_size || 0;
      while (Date.now() < deadline) {
        const stat = await fsp.stat(this.logPath(id)).catch(() => null);
        meta = await this.hydrate(await this.load(id));
        if (!meta.running) break;
        if (!waitForExit && (offsetProvided ? (stat?.size || 0) > offset : (stat?.size || 0) > initialSize)) break;
        await sleep(200);
      }
    }

    const logPath = this.logPath(id);
    let stat;
    try {
      stat = await fsp.stat(logPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      stat = { size: 0 };
    }

    const maxBytes = this.config.tasks.maxOutputReadBytes;
    let start;
    let length;
    if (offsetProvided) {
      start = Math.min(offset, stat.size);
      length = Math.min(maxBytes, Math.max(0, stat.size - start));
    } else {
      start = Math.max(0, stat.size - maxBytes);
      length = stat.size - start;
    }

    let output = '';
    if (length > 0) {
      const handle = await fsp.open(logPath, 'r');
      try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        output = buffer.toString('utf8');
      } finally {
        await handle.close();
      }
    }

    if (!offsetProvided) {
      const tailLines = Math.min(
        Math.max(Number(args.tail_lines) || this.config.tasks.defaultTailLines, 1),
        100000,
      );
      const lines = output.split('\n');
      output = lines.slice(-tailLines).join('\n');
      if (start > 0) output = `…[${start} earlier bytes omitted]…\n${output}`;
    }

    return {
      id,
      name: meta.name,
      state: meta.state,
      running: meta.running,
      exit_code: meta.exit_code,
      signal: meta.signal,
      started_at: meta.started_at,
      ended_at: meta.ended_at,
      size: stat.size,
      offset: offsetProvided ? start : null,
      next_offset: offsetProvided ? start + length : stat.size,
      truncated: offsetProvided ? start + length < stat.size : start > 0,
      log_path: logPath,
      output,
    };
  }

  async stop(args = {}) {
    const id = this.validateId(args.id);
    let meta = await this.hydrate(await this.load(id));
    if (!meta.running) {
      return {
        id,
        already_stopped: true,
        state: meta.state,
        exit_code: meta.exit_code,
        ended_at: meta.ended_at,
      };
    }

    const signal = validateSignal(args.signal);
    const graceMs = Math.min(
      Math.max(Number(args.grace_ms) || this.config.tasks.stopGraceMs, 100),
      120000,
    );

    const killGroup = (sig) => {
      try {
        process.kill(-meta.pid, sig);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        try {
          process.kill(meta.pid, sig);
          return true;
        } catch {
          return false;
        }
      }
    };

    killGroup(signal);
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && isProcessAlive(meta.pid)) {
      await sleep(100);
    }

    let forced = false;
    if (isProcessAlive(meta.pid)) {
      forced = true;
      killGroup('SIGKILL');
      const hardDeadline = Date.now() + 3000;
      while (Date.now() < hardDeadline && isProcessAlive(meta.pid)) {
        await sleep(100);
      }
    }

    const statusCode = this.readStatus(id);
    meta = {
      ...meta,
      state: 'stopped',
      exit_code: statusCode,
      signal: forced ? 'SIGKILL' : signal,
      ended_at: new Date().toISOString(),
      running: false,
    };
    await this.writeMeta(meta);
    try {
      await fsp.appendFile(
        this.logPath(id),
        `\n[termux-mcp] task ${id} stopped with ${forced ? 'SIGKILL' : signal} at ${meta.ended_at}\n`,
        { mode: 0o600 },
      );
    } catch {
      // Log may have been removed.
    }

    return {
      id,
      stopped: true,
      forced,
      signal: meta.signal,
      state: meta.state,
      exit_code: meta.exit_code,
      ended_at: meta.ended_at,
    };
  }

  async remove(args = {}) {
    const id = this.validateId(args.id);
    const meta = await this.hydrate(await this.load(id));
    if (meta.running) {
      throw new PolicyError(`Task ${id} is still running. Stop it before removing it.`);
    }
    const removed = [];
    for (const file of [this.metaPath(id), this.logPath(id), this.statusPath(id), this.scriptPath(id)]) {
      try {
        await fsp.rm(file, { force: true });
        removed.push(path.basename(file));
      } catch (error) {
        this.logger.warn('Failed to remove task file', { file, error: error.message });
      }
    }
    return { id, removed };
  }
}

async function writeJsonSyncAsync(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, file);
  await fsp.chmod(file, 0o600).catch(() => {});
}
