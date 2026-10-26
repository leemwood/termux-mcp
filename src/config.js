import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR_NAME = 'termux-mcp';
export const CONFIG_VERSION = 3;

export function expandHome(input) {
  if (typeof input !== 'string') return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function defaultConfigPath() {
  if (process.env.TERMUX_MCP_CONFIG) {
    return path.resolve(expandHome(process.env.TERMUX_MCP_CONFIG));
  }
  const base = process.env.XDG_CONFIG_HOME
    ? expandHome(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), '.config');
  return path.join(base, CONFIG_DIR_NAME, 'config.json');
}

export function defaultStateDir() {
  const base = process.env.XDG_STATE_HOME
    ? expandHome(process.env.XDG_STATE_HOME)
    : path.join(os.homedir(), '.local', 'state');
  return path.join(base, CONFIG_DIR_NAME);
}

export function buildDefaultConfig() {
  const stateDir = defaultStateDir();

  return {
    configVersion: CONFIG_VERSION,
    server: {
      name: 'termux-mcp',
      host: '127.0.0.1',
      port: 8770,
      allowOrigins: [],
      allowedHosts: [],
      maxBodyBytes: 10 * 1024 * 1024,
    },
    security: {
      maxOutputBytes: 256 * 1024,
      defaultTimeoutSec: 120,
      maxTimeoutSec: 600,
      maxConcurrentCommands: 16,
      auditEnabled: true,
      auditLog: path.join(stateDir, 'audit.jsonl'),
      auditMaxBytes: 5 * 1024 * 1024,
      maxReadBytes: 10 * 1024 * 1024,
      maxWriteBytes: 10 * 1024 * 1024,
      maxSearchResults: 200,
      searchTimeoutSec: 30,
    },
    terminal: {
      enabled: true,
      socketPath: path.join(stateDir, 'tmux.sock'),
      shell: '',
      shellArgs: [],
      useShellRc: false,
      defaultCols: 100,
      defaultRows: 30,
      historyLimit: 10000,
      maxSessions: 16,
      defaultReadLines: 120,
      maxReadBytes: 512 * 1024,
    },
    tasks: {
      dir: path.join(stateDir, 'tasks'),
      maxTasks: 32,
      maxOutputReadBytes: 256 * 1024,
      defaultTailLines: 200,
      stopGraceMs: 3000,
    },
    termuxApi: {
      enabled: true,
      timeoutSec: 30,
      maxOutputBytes: 1024 * 1024,
    },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep(base, override) {
  if (Array.isArray(override)) return override;
  if (isPlainObject(override)) {
    const result = isPlainObject(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(override)) {
      result[key] = mergeDeep(result[key], value);
    }
    return result;
  }
  return override === undefined ? base : override;
}

function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeConfig(config) {
  const defaults = buildDefaultConfig();
  const merged = mergeDeep(defaults, config);

  merged.configVersion = CONFIG_VERSION;

  merged.server.host = String(merged.server.host || '127.0.0.1').trim();
  merged.server.port = positiveInt(merged.server.port, 8770, { min: 1, max: 65535 });
  // v3 removes bearer-token authentication. Drop the legacy field so old configs
  // do not keep an unused secret around.
  delete merged.server.token;
  merged.server.allowOrigins = Array.isArray(merged.server.allowOrigins)
    ? merged.server.allowOrigins.map(String)
    : [];
  merged.server.allowedHosts = Array.isArray(merged.server.allowedHosts)
    ? merged.server.allowedHosts.map(String)
    : [];
  merged.server.maxBodyBytes = positiveInt(merged.server.maxBodyBytes, 10 * 1024 * 1024, {
    min: 1024,
    max: 100 * 1024 * 1024,
  });

  // Removed in v2: command and workspace allow lists. Drop legacy fields so a
  // rewritten config does not imply restrictions that no longer exist.
  for (const legacy of ['allowedRoots', 'readOnlyRoots', 'denyCommandPatterns']) {
    delete merged.security[legacy];
  }
  if (merged.termuxApi) delete merged.termuxApi.allowedCommands;

  merged.security.maxOutputBytes = positiveInt(merged.security.maxOutputBytes, 256 * 1024, {
    min: 4096,
    max: 16 * 1024 * 1024,
  });
  merged.security.defaultTimeoutSec = positiveInt(merged.security.defaultTimeoutSec, 120, {
    min: 1,
    max: 86400,
  });
  merged.security.maxTimeoutSec = positiveInt(merged.security.maxTimeoutSec, 600, {
    min: 1,
    max: 86400,
  });
  merged.security.maxConcurrentCommands = positiveInt(merged.security.maxConcurrentCommands, 16, {
    min: 1,
    max: 256,
  });
  merged.security.maxReadBytes = positiveInt(merged.security.maxReadBytes, 10 * 1024 * 1024, {
    min: 1024,
    max: 1024 * 1024 * 1024,
  });
  merged.security.maxWriteBytes = positiveInt(merged.security.maxWriteBytes, 10 * 1024 * 1024, {
    min: 1024,
    max: 1024 * 1024 * 1024,
  });
  merged.security.maxSearchResults = positiveInt(merged.security.maxSearchResults, 200, {
    min: 1,
    max: 10000,
  });
  merged.security.searchTimeoutSec = positiveInt(merged.security.searchTimeoutSec, 30, {
    min: 1,
    max: 600,
  });
  merged.security.auditMaxBytes = positiveInt(merged.security.auditMaxBytes, 5 * 1024 * 1024, {
    min: 64 * 1024,
    max: 1024 * 1024 * 1024,
  });
  merged.security.auditLog = path.resolve(expandHome(merged.security.auditLog || path.join(defaultStateDir(), 'audit.jsonl')));

  merged.terminal.socketPath = path.resolve(expandHome(merged.terminal.socketPath || path.join(defaultStateDir(), 'tmux.sock')));
  merged.terminal.defaultCols = positiveInt(merged.terminal.defaultCols, 100, { min: 20, max: 500 });
  merged.terminal.defaultRows = positiveInt(merged.terminal.defaultRows, 30, { min: 5, max: 300 });
  merged.terminal.historyLimit = positiveInt(merged.terminal.historyLimit, 10000, { min: 100, max: 1000000 });
  merged.terminal.maxSessions = positiveInt(merged.terminal.maxSessions, 16, { min: 1, max: 256 });
  merged.terminal.defaultReadLines = positiveInt(merged.terminal.defaultReadLines, 120, { min: 1, max: 100000 });
  merged.terminal.maxReadBytes = positiveInt(merged.terminal.maxReadBytes, 512 * 1024, {
    min: 4096,
    max: 16 * 1024 * 1024,
  });
  merged.terminal.shell = typeof merged.terminal.shell === 'string' ? merged.terminal.shell.trim() : '';
  merged.terminal.shellArgs = Array.isArray(merged.terminal.shellArgs)
    ? merged.terminal.shellArgs.filter((arg) => typeof arg === 'string' && !arg.includes('\0')).map(String)
    : [];
  merged.terminal.useShellRc = merged.terminal.useShellRc === true;
  merged.terminal.enabled = merged.terminal.enabled !== false;

  merged.tasks.dir = path.resolve(expandHome(merged.tasks.dir || path.join(defaultStateDir(), 'tasks')));
  merged.tasks.maxTasks = positiveInt(merged.tasks.maxTasks, 32, { min: 1, max: 1024 });
  merged.tasks.maxOutputReadBytes = positiveInt(merged.tasks.maxOutputReadBytes, 256 * 1024, {
    min: 4096,
    max: 16 * 1024 * 1024,
  });
  merged.tasks.defaultTailLines = positiveInt(merged.tasks.defaultTailLines, 200, {
    min: 1,
    max: 100000,
  });
  merged.tasks.stopGraceMs = positiveInt(merged.tasks.stopGraceMs, 3000, {
    min: 100,
    max: 120000,
  });

  merged.termuxApi.enabled = merged.termuxApi.enabled !== false;
  merged.termuxApi.timeoutSec = positiveInt(merged.termuxApi.timeoutSec, 30, { min: 1, max: 3600 });
  merged.termuxApi.maxOutputBytes = positiveInt(merged.termuxApi.maxOutputBytes, 1024 * 1024, {
    min: 4096,
    max: 16 * 1024 * 1024,
  });

  if (merged.terminal.socketPath.length > 100) {
    throw new Error(
      `terminal.socketPath is too long for a Unix socket (${merged.terminal.socketPath.length} chars, limit ~100). Set a shorter path in the config.`,
    );
  }

  return merged;
}

async function writeConfigFile(configPath, config) {
  await fsp.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fsp.chmod(path.dirname(configPath), 0o700).catch(() => {});

  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(tmp, 0o600).catch(() => {});
  await fsp.rename(tmp, configPath);
  await fsp.chmod(configPath, 0o600).catch(() => {});
}

/**
 * Load the JSON config, creating it with defaults on first run.
 * CLI/env overrides are applied after the file is read and are not persisted.
 */
export async function loadConfig({ configPath = defaultConfigPath(), overrides = {} } = {}) {
  const resolvedPath = path.resolve(expandHome(configPath));
  let raw = null;
  let created = false;
  let changed = false;

  if (fs.existsSync(resolvedPath)) {
    let text;
    try {
      text = await fsp.readFile(resolvedPath, 'utf8');
    } catch (error) {
      throw new Error(`Cannot read config ${resolvedPath}: ${error.message}`);
    }
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON in ${resolvedPath}: ${error.message}`);
    }
  } else {
    raw = buildDefaultConfig();
    created = true;
    changed = true;
  }

  const beforeVersion = raw?.configVersion;
  const hadToken = Boolean(raw?.server && Object.prototype.hasOwnProperty.call(raw.server, 'token'));
  let config = normalizeConfig(raw);

  if (created || beforeVersion !== CONFIG_VERSION || hadToken) {
    changed = true;
  }

  // Environment overrides are applied only in memory.
  if (process.env.TERMUX_MCP_HOST) config.server.host = process.env.TERMUX_MCP_HOST;
  if (process.env.TERMUX_MCP_PORT) config.server.port = Number.parseInt(process.env.TERMUX_MCP_PORT, 10);
  if (overrides.host) config.server.host = overrides.host;
  if (overrides.port !== undefined) config.server.port = Number(overrides.port);

  if (!Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65535) {
    throw new Error(`Invalid port: ${config.server.port}. Expected 1-65535.`);
  }

  config = normalizeConfig(config);

  if (changed) {
    await writeConfigFile(resolvedPath, config);
  }

  return { config, configPath: resolvedPath, created, changed };
}

export function sanitizeConfig(config) {
  return structuredClone(config);
}
