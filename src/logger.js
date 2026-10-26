const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function formatExtra(extra) {
  if (extra === undefined) return '';
  try {
    return ` ${JSON.stringify(extra)}`;
  } catch {
    return ` ${String(extra)}`;
  }
}

/**
 * Small stderr logger. MCP stdio uses stdout for the protocol, so every log
 * line must go to stderr (or a file), never to stdout.
 */
export function createLogger({ level = 'info' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(lvl, message, extra) {
    if (LEVELS[lvl] < threshold) return;
    const line = `[${new Date().toISOString()}] ${lvl.toUpperCase()} ${message}${formatExtra(extra)}`;
    process.stderr.write(`${line}\n`);
  }

  return {
    debug: (msg, extra) => write('debug', msg, extra),
    info: (msg, extra) => write('info', msg, extra),
    warn: (msg, extra) => write('warn', msg, extra),
    error: (msg, extra) => write('error', msg, extra),
  };
}
