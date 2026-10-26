import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { createAuditLogger } from './audit.js';
import { PolicyError } from './security.js';
import { SERVER_NAME, VERSION } from './version.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerCommandTools } from './tools/command.js';
import { registerFileTools } from './tools/files.js';
import { registerSystemTools } from './tools/system.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerTerminalTools } from './tools/terminal.js';
import { registerTermuxApiTools } from './tools/termux-api.js';

function normalizeResult(value) {
  if (typeof value === 'string') {
    return { content: [{ type: 'text', text: value }] };
  }
  if (value && Array.isArray(value.content)) {
    return value;
  }
  if (value && Array.isArray(value.blocks)) {
    return { content: value.blocks, isError: value.isError === true };
  }
  if (value && typeof value.text === 'string') {
    return {
      content: [{ type: 'text', text: value.text }],
      isError: value.isError === true,
    };
  }
  if (value === undefined || value === null) {
    return { content: [{ type: 'text', text: 'OK' }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/**
 * Build an MCP server instance. HTTP is stateless, so a fresh instance is
 * created for each Streamable HTTP request; the audit logger is shared by the
 * caller to avoid one writer queue per request.
 */
export function createMcpServer({ config, logger, transport = 'unknown', audit = null }) {
  const server = new McpServer(
    {
      name: config.server.name || SERVER_NAME,
      version: VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
        logging: {},
      },
    },
  );

  const auditLog = audit || createAuditLogger(config, logger);

  function register(definition) {
    const started = Date.now();
    const toolConfig = {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.schema || {},
      annotations: definition.annotations,
    };

    server.registerTool(definition.name, toolConfig, async (args, extra) => {
      const callStarted = Date.now();
      try {
        const result = await definition.handler(args, extra);
        const durationMs = Date.now() - callStarted;
        auditLog({
          tool: definition.name,
          transport,
          sessionId: extra?.sessionId,
          ok: true,
          durationMs,
          args,
        });
        logger.debug('tool call completed', {
          tool: definition.name,
          durationMs,
          totalUptimeMs: Date.now() - started,
        });
        return normalizeResult(result);
      } catch (error) {
        const durationMs = Date.now() - callStarted;
        const isPolicy = error instanceof PolicyError || error?.name === 'PolicyError';
        auditLog({
          tool: definition.name,
          transport,
          sessionId: extra?.sessionId,
          ok: false,
          durationMs,
          args,
          error: error?.message || String(error),
        });
        if (!isPolicy) {
          logger.error('tool call failed', {
            tool: definition.name,
            error: error?.message || String(error),
            stack: error?.stack,
          });
        }
        const prefix = isPolicy ? 'Error' : 'Internal error';
        return {
          content: [
            {
              type: 'text',
              text: `${prefix} (${definition.name}): ${error?.message || String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  register.z = z;

  registerCommandTools(register, { config });
  registerFileTools(register, { config });
  registerSystemTools(register, { config });
  registerTermuxApiTools(register, { config });
  registerTerminalTools(register, { config, logger });
  registerTaskTools(register, { config, logger });

  registerResources(server, { config, logger });
  registerPrompts(server);

  return server;
}
