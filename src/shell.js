import fs from 'node:fs';
import path from 'node:path';

export function cleanEnv(overrides = {}, { term = undefined } = {}) {
  const env = { ...process.env, ...overrides };
  delete env.TMUX;
  delete env.TMUX_PANE;

  for (const [key, value] of Object.entries(env)) {
    if (
      typeof value !== 'string'
      || key === ''
      || key.includes('=')
      || key.includes('\0')
      || value.includes('\0')
    ) {
      delete env[key];
    }
  }

  env.TERMUX_MCP_SERVER = '1';
  if (term) env.TERM = term;
  return env;
}

export function isExecutable(file) {
  if (!file) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(name) {
  if (!name) return null;
  if (name.includes('/')) return isExecutable(name) ? path.resolve(name) : null;

  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function resolveShell(config) {
  const candidates = [
    config?.terminal?.shell,
    process.env.SHELL,
    '/data/data/com.termux/files/usr/bin/bash',
    '/bin/bash',
    '/bin/sh',
  ];
  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }
  return '/bin/sh';
}

/**
 * Non-interactive shell for run_command and task scripts. $SHELL may be fish,
 * zsh or something else; these code paths rely on POSIX syntax, so prefer bash.
 */
export function resolveBash() {
  const candidates = [
    '/data/data/com.termux/files/usr/bin/bash',
    '/bin/bash',
    '/bin/sh',
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  return '/bin/sh';
}

export function isProcessAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
