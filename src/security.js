import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expandHome } from './config.js';

export class PolicyError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'PolicyError';
    this.details = details;
  }
}

export function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase());
}

/**
 * Resolve a path without requiring the final component to exist. Symlinks are
 * followed manually, including dangling symlinks, so callers can operate on the
 * real target or report it accurately.
 */
export async function realpathLoose(input, depth = 0) {
  if (depth > 32) {
    throw new PolicyError('Too many levels of symbolic links while resolving path.');
  }

  const resolved = path.resolve(input);
  const tail = [];
  let current = resolved;

  for (;;) {
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) {
        const link = await fsp.readlink(current);
        const target = path.resolve(path.dirname(current), link);
        const joined = path.join(target, ...tail.reverse());
        return realpathLoose(joined, depth + 1);
      }
      const real = await fsp.realpath(current);
      return path.join(real, ...tail.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export function resolveUserPath(input, { base = os.homedir() } = {}) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new PolicyError('Path must be a non-empty string.');
  }
  if (input.includes('\0')) {
    throw new PolicyError('Path contains a NUL byte.');
  }
  const expanded = expandHome(input.trim());
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base, expanded);
}

/**
 * Resolve a user-supplied path and its symlink target. There is no workspace
 * allow list: the Termux user's own Android/Linux permissions are the boundary.
 * A missing final component is allowed (for create operations).
 */
export async function assertPathAllowed(config, input, { label = 'path' } = {}) {
  const resolved = resolveUserPath(input);
  let real;
  try {
    real = await realpathLoose(resolved);
  } catch {
    real = resolved;
  }
  return { resolved, real, label };
}

/**
 * Destructive operations keep two non-configurable sanity rules: the target
 * must not be the filesystem root, and delete_path still requires an explicit
 * confirm string. Everything else is the user's responsibility.
 */
export async function assertDeleteAllowed(config, input, { label = 'path' } = {}) {
  const allowed = await assertPathAllowed(config, input, { label });
  if (path.dirname(allowed.resolved) === allowed.resolved) {
    throw new PolicyError(`Refusing to delete a filesystem root: ${allowed.resolved}`);
  }
  return allowed;
}

export function checkCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new PolicyError('command must be a non-empty string.');
  }
  if (command.includes('\0')) {
    throw new PolicyError('command contains a NUL byte.');
  }
  return true;
}

export function checkTermuxApiCommand(config, command) {
  if (!config.termuxApi.enabled) {
    throw new PolicyError('Termux:API integration is disabled in the config (termuxApi.enabled=false).');
  }
  if (typeof command !== 'string' || !/^[a-z0-9-]+$/.test(command)) {
    throw new PolicyError('Termux:API command must contain only lowercase letters, digits and hyphens.');
  }
  return true;
}
