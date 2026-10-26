import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PolicyError, checkCommand, resolveUserPath } from './security.js';
import { cleanEnv, resolveBash } from './shell.js';

const activeChildren = new Set();
const commandCache = new Map();
let activeShells = 0;

export class CappedBuffer {
  constructor(limit) {
    this.limit = Math.max(1024, Number(limit) || 262144);
    this.headLimit = Math.floor(this.limit * 0.7);
    this.tailLimit = this.limit - this.headLimit;
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.total = 0;
  }

  push(chunk) {
    this.total += chunk.length;

    let rest = chunk;
    if (this.head.length < this.headLimit) {
      const take = Math.min(rest.length, this.headLimit - this.head.length);
      this.head = Buffer.concat([this.head, rest.subarray(0, take)]);
      rest = rest.subarray(take);
      if (rest.length === 0) return;
    }

    if (rest.length >= this.tailLimit) {
      this.tail = rest.subarray(rest.length - this.tailLimit);
    } else {
      const overflow = this.tail.length + rest.length - this.tailLimit;
      if (overflow > 0) this.tail = this.tail.subarray(overflow);
      this.tail = Buffer.concat([this.tail, rest]);
    }
  }

  get truncated() {
    return this.total > this.limit;
  }

  toString() {
    if (!this.truncated) return Buffer.concat([this.head, this.tail]).toString('utf8');
    const omitted = this.total - this.limit;
    return `${this.head.toString('utf8')}\n…[${omitted} bytes truncated]…\n${this.tail.toString(
      'utf8',
    )}`;
  }
}

export function commandExists(name) {
  if (name.includes('/')) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  if (commandCache.has(name)) return commandCache.get(name);

  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const found = dirs.some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  commandCache.set(name, found);
  return found;
}

export function killTree(child, signal) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process has already exited.
    }
  }
}

export function killAllChildren(signal = 'SIGKILL') {
  for (const child of activeChildren) killTree(child, signal);
}

/**
 * Spawn a process and capture bounded stdout/stderr. Never uses a shell unless
 * the caller explicitly passes a shell as `file`.
 */
export async function runProcess(file, args = [], options = {}) {
  const {
    cwd = os.homedir(),
    env = process.env,
    timeoutMs = 120_000,
    maxBytes = 262144,
    stdin = undefined,
    signal = undefined,
  } = options;

  return await new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout = new CappedBuffer(maxBytes);
    const stderr = new CappedBuffer(maxBytes);
    let child;
    let settled = false;
    let timedOut = false;
    let aborted = false;

    try {
      child = spawn(file, args, {
        cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ok: false,
        code: null,
        signal: null,
        timedOut: false,
        aborted: false,
        spawnError: error.message,
        stdout: '',
        stderr: '',
        truncated: { stdout: false, stderr: false },
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    activeChildren.add(child);

    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        killTree(child, 'SIGKILL');
      }, timeoutMs)
      : null;

    const onAbort = () => {
      aborted = true;
      killTree(child, 'SIGKILL');
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', () => {});

    function finish(code, exitSignal, spawnError) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      activeChildren.delete(child);

      resolve({
        ok: !spawnError && !timedOut && !aborted && code === 0,
        code: code ?? null,
        signal: exitSignal ?? null,
        timedOut,
        aborted,
        spawnError: spawnError ? spawnError.message : undefined,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
        durationMs: Date.now() - startedAt,
      });
    }

    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, exitSignal) => finish(code, exitSignal, null));

    try {
      if (stdin !== undefined && stdin !== null) child.stdin.end(String(stdin));
      else child.stdin.end();
    } catch {
      // The child may have exited before reading stdin.
    }
  });
}

export async function runShell(config, command, options = {}) {
  checkCommand(command);

  if (activeShells >= config.security.maxConcurrentCommands) {
    throw new PolicyError(
      `Too many concurrent shell commands (max ${config.security.maxConcurrentCommands}). Retry after one finishes.`,
    );
  }

  const cwd = options.cwd ? resolveUserPath(options.cwd) : os.homedir();
  let stat;
  try {
    stat = await fsp.stat(cwd);
  } catch (error) {
    throw new PolicyError(`cwd does not exist or is not accessible: ${cwd} (${error.message})`);
  }
  if (!stat.isDirectory()) throw new PolicyError(`cwd is not a directory: ${cwd}`);

  const timeoutSec = Math.min(
    Math.max(Number(options.timeoutSec) || config.security.defaultTimeoutSec, 1),
    config.security.maxTimeoutSec,
  );

  activeShells += 1;
  try {
    return await runProcess(resolveBash(), ['-c', command], {
      cwd,
      env: cleanEnv(options.env),
      timeoutMs: timeoutSec * 1000,
      maxBytes: config.security.maxOutputBytes,
      stdin: options.stdin,
      signal: options.signal,
    });
  } finally {
    activeShells -= 1;
  }
}
