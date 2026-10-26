#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createAuditLogger } from './audit.js';
import { defaultConfigPath, loadConfig, sanitizeConfig } from './config.js';
import { killAllChildren } from './exec.js';
import { startHttpServer } from './http.js';
import { createLogger } from './logger.js';
import { createMcpServer } from './mcp.js';
import { isLoopbackHost } from './security.js';
import { SERVER_NAME, VERSION } from './version.js';

const HELP = `termux-mcp ${VERSION} - local MCP server for the Termux environment

Usage:
  node src/server.js [options]

Transport:
  --http                 Run Streamable HTTP + legacy SSE on localhost (default: stdio)
  --stdio                Run MCP over stdio (default)
  --host <host>          Bind host for HTTP (config default: 127.0.0.1)
  --port <port>          Bind port for HTTP (config default: 8770)
  --config <path>        Config file path (default: ${defaultConfigPath()})
  --log-level <level>    debug, info, warn or error (default: info)

Inspection:
  --print-config         Print the effective config
  --print-port           Print the effective HTTP port
  --print-config-path    Print the config file path
  --version              Print the version
  --help                 Show this help

Examples:
  node src/server.js --http
  node src/server.js --http --port 8770
`;

function parseArgs(argv) {
  const options = {
    http: false,
    stdio: false,
    host: undefined,
    port: undefined,
    config: undefined,
    logLevel: undefined,
    printConfig: false,
    printPort: false,
    printConfigPath: false,
    version: false,
    help: false,
  };

  const takeValue = (index, arg) => {
    if (index + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
    return argv[index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') ? arg.split('=', 2) : [arg, undefined];
    const value = () => (inline !== undefined ? inline : takeValue(i++, flag));

    switch (flag) {
      case '--http':
        options.http = true;
        break;
      case '--stdio':
        options.stdio = true;
        break;
      case '--host':
        options.host = value();
        break;
      case '--port':
        options.port = Number.parseInt(value(), 10);
        break;
      case '--config':
        options.config = value();
        break;
      case '--log-level':
        options.logLevel = value();
        break;
      case '--print-config':
        options.printConfig = true;
        break;
      case '--print-port':
        options.printPort = true;
        break;
      case '--print-config-path':
        options.printConfigPath = true;
        break;
      case '--version':
        options.version = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`termux-mcp: ${error.message}\n\n${HELP}`);
    process.exit(2);
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`${SERVER_NAME} ${VERSION}\n`);
    return;
  }

  let loaded;
  try {
    loaded = await loadConfig({
      configPath: options.config,
      overrides: {
        host: options.host,
        port: options.port,
      },
    });
  } catch (error) {
    process.stderr.write(`termux-mcp: ${error.message}\n`);
    process.exit(1);
  }

  const { config, configPath } = loaded;

  if (options.printConfigPath) {
    process.stdout.write(`${configPath}\n`);
    return;
  }
  if (options.printConfig) {
    process.stdout.write(`${JSON.stringify(sanitizeConfig(config), null, 2)}\n`);
    return;
  }
  if (options.printPort) {
    process.stdout.write(`${config.server.port}\n`);
    return;
  }

  const logger = createLogger({
    level: options.logLevel || process.env.TERMUX_MCP_LOG_LEVEL || 'info',
  });

  if (config.server.host !== '0.0.0.0' && !isLoopbackHost(config.server.host)) {
    logger.warn('Binding HTTP to a non-loopback address without authentication; any reachable client can control Termux.', {
      host: config.server.host,
    });
  }

  const httpMode = options.http
    || (!options.stdio && (
      options.port !== undefined
      || options.host !== undefined
      || process.env.TERMUX_MCP_TRANSPORT === 'http'
    ));

  if (httpMode) {
    const audit = createAuditLogger(config, logger);
    let httpServer;
    try {
      httpServer = await startHttpServer({ config, logger, audit });
    } catch (error) {
      logger.error('Failed to start HTTP server', { error: error.message, host: config.server.host, port: config.server.port });
      process.exit(1);
    }

    logger.info(`termux-mcp ${VERSION} listening`, {
      transport: 'http',
      mcp: httpServer.mcpUrl,
      sse: httpServer.sseUrl,
      health: `${httpServer.baseUrl}/health`,
    });
    logger.info('No authentication is enabled; the server is intended for local use.', { config: configPath });
    if (config.server.host !== '0.0.0.0' && !isLoopbackHost(config.server.host)) {
      logger.warn('This server is reachable from the network without authentication. Use a firewall or SSH tunnel if unintended.');
    }

    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('Shutting down', { signal });
      killAllChildren('SIGTERM');
      const force = setTimeout(() => process.exit(0), 5000);
      force.unref?.();
      try {
        await httpServer.close();
      } catch (error) {
        logger.warn('Error while closing HTTP server', { error: error.message });
      }
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception', { error: error.message, stack: error.stack });
      shutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
    });
    return;
  }

  const audit = createAuditLogger(config, logger);
  const server = createMcpServer({ config, logger, transport: 'stdio', audit });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`termux-mcp ${VERSION} ready`, { transport: 'stdio', config: configPath });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    killAllChildren('SIGTERM');
    try {
      await transport.close();
    } catch {
      // Ignore.
    }
    logger.info('Shutting down', { signal });
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });
}

main().catch((error) => {
  process.stderr.write(`termux-mcp fatal: ${error.stack || error.message}\n`);
  process.exit(1);
});
