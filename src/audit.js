import fsp from 'node:fs/promises';
import path from 'node:path';

import { expandHome } from './config.js';

const SENSITIVE_KEY = /^(content|text|stdin|new_string|old_string|password|passwd|token|secret|api_?key|clipboard)$/i;

function summarizeValue(key, value) {
  if (SENSITIVE_KEY.test(key)) {
    if (typeof value === 'string') return `<redacted ${value.length} chars>`;
    return '<redacted>';
  }

  if (key === 'env' && value && typeof value === 'object') {
    return `<env keys: ${Object.keys(value).sort().join(', ')}>`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string' && item.length > 120) return `<${item.length} chars>`;
      return item;
    });
  }

  if (typeof value === 'string' && value.length > 400) {
    return `${value.slice(0, 400)}…`;
  }

  return value;
}

function redactArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = summarizeValue(key, value);
  }
  return out;
}

export function createAuditLogger(config, logger) {
  const enabled = config.security.auditEnabled;
  const file = path.resolve(expandHome(config.security.auditLog));
  const maxBytes = config.security.auditMaxBytes;
  let queue = Promise.resolve();
  let initialized = false;

  async function init() {
    if (initialized) return;
    initialized = true;
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      await fsp.chmod(path.dirname(file), 0o700);
    } catch {
      // Ignore filesystems without chmod support.
    }
  }

  async function rotateIfNeeded() {
    try {
      const stat = await fsp.stat(file);
      if (stat.size < maxBytes) return;
      const archive = `${file}.1`;
      await fsp.rm(archive, { force: true });
      await fsp.rename(file, archive);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async function append(entry) {
    await init();
    await rotateIfNeeded();
    const line = `${JSON.stringify(entry)}\n`;
    await fsp.appendFile(file, line, { mode: 0o600 });
    await fsp.chmod(file, 0o600).catch(() => {});
  }

  return function audit(event) {
    if (!enabled) return;

    const entry = {
      ts: new Date().toISOString(),
      tool: event.tool,
      transport: event.transport,
      sessionId: event.sessionId,
      ok: event.ok,
      durationMs: event.durationMs,
      args: redactArgs(event.args),
    };
    if (event.error) entry.error = String(event.error).slice(0, 1000);

    queue = queue
      .then(() => append(entry))
      .catch((error) => {
        logger.warn('Failed to write audit log', { file, error: error.message });
      });
  };
}

export async function readRecentAudit(config, limit = 50) {
  const file = path.resolve(expandHome(config.security.auditLog));
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const lines = text.trim().split('\n').filter(Boolean);
  return lines.slice(-Math.max(1, limit)).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { raw: line };
    }
  });
}
