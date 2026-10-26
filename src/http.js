import http from 'node:http';

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createMcpServer } from './mcp.js';
import { isLoopbackHost } from './security.js';
import { SERVER_NAME, VERSION } from './version.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function setCommonHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function originAllowed(config, origin) {
  if (!origin) return true;
  const allowed = config.server.allowOrigins || [];
  if (allowed.includes('*') || allowed.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('Access-Control-Max-Age', '600');
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  const value = String(hostHeader).toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(1, end);
  }
  return value.split(':')[0];
}

function hostAllowed(config, req) {
  if (!isLoopbackHost(config.server.host)) return true;
  const hostHeader = req.headers.host;
  if (!hostHeader) return true;
  const hostname = hostnameOf(hostHeader);
  if (['127.0.0.1', 'localhost', '::1'].includes(hostname)) return true;

  const allowedHosts = config.server.allowedHosts || [];
  if (allowedHosts.includes('*')) return true;
  if (allowedHosts.includes(hostHeader)) return true;
  return allowedHosts.includes(hostname);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendRpcError(res, status, code, message, extraHeaders = {}) {
  sendJson(
    res,
    status,
    { jsonrpc: '2.0', error: { code, message }, id: null },
    { Allow: 'POST, DELETE, OPTIONS', ...extraHeaders },
  );
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
      req.removeListener('data', onData);
      req.resume();
    };

    const onData = (chunk) => {
      total += chunk.length;
      if (total > limit) {
        fail(new HttpError(413, `Request body exceeds ${limit} bytes.`));
        return;
      }
      chunks.push(chunk);
    };

    req.on('data', onData);
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => fail(new HttpError(400, `Failed to read request body: ${error.message}`)));
  });
}

async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) throw new HttpError(400, 'Empty request body.');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new HttpError(400, `Invalid JSON: ${error.message}`);
  }
}

export async function startHttpServer({ config, logger, audit }) {
  const sseSessions = new Map();

  async function handleRequest(req, res) {
    const started = Date.now();
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    res.on('finish', () => {
      logger.debug('http request', {
        method: req.method,
        path: pathname,
        status: res.statusCode,
        durationMs: Date.now() - started,
      });
    });

    setCommonHeaders(res);

    if (req.headers.origin && !originAllowed(config, req.headers.origin)) {
      sendJson(res, 403, { error: 'Origin not allowed.' });
      return;
    }
    applyCors(req, res);

    if (!hostAllowed(config, req)) {
      sendJson(res, 403, { error: 'Host header not allowed.' });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        name: config.server.name || SERVER_NAME,
        version: VERSION,
        pid: process.pid,
        uptime_sec: Math.round(process.uptime()),
        transport: 'http',
        auth: 'none',
        endpoints: { mcp: '/mcp', sse: '/sse', messages: '/messages' },
        sse_sessions: sseSessions.size,
      });
      return;
    }

    if (pathname === '/' && req.method === 'GET') {
      sendJson(res, 200, {
        name: config.server.name || SERVER_NAME,
        version: VERSION,
        description: 'Local MCP server for operating the Termux environment.',
        auth: 'none (localhost only)',
        endpoints: {
          streamable_http: '/mcp',
          legacy_sse: '/sse',
          legacy_messages: '/messages?sessionId=...',
          health: '/health',
        },
      });
      return;
    }

    if (pathname === '/mcp') {
      if (req.method === 'GET' || req.method === 'DELETE') {
        sendRpcError(res, 405, -32000, 'Method not allowed. Use POST for Streamable HTTP.');
        return;
      }
      if (req.method !== 'POST') {
        sendRpcError(res, 405, -32000, 'Method not allowed.');
        return;
      }

      let body;
      try {
        body = await readJson(req, config.server.maxBodyBytes);
      } catch (error) {
        if (error instanceof HttpError) {
          sendRpcError(res, error.status, error.status === 413 ? -32000 : -32700, error.message);
        } else {
          throw error;
        }
        return;
      }

      const mcp = createMcpServer({ config, logger, transport: 'http', audit });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        try {
          await transport.close();
        } catch {
          // Ignore close errors.
        }
        try {
          await mcp.close();
        } catch {
          // Ignore close errors.
        }
      };

      try {
        await mcp.connect(transport);
        res.on('close', () => {
          cleanup().catch(() => {});
        });
        await transport.handleRequest(req, res, body);
      } catch (error) {
        logger.error('Streamable HTTP request failed', {
          error: error.message,
          stack: error.stack,
        });
        await cleanup();
        if (!res.headersSent) {
          sendRpcError(res, 500, -32603, 'Internal server error.');
        } else {
          res.end();
        }
      }
      return;
    }

    if (pathname === '/sse' && req.method === 'GET') {
      const transport = new SSEServerTransport('/messages', res);
      const mcp = createMcpServer({ config, logger, transport: 'sse', audit });
      let cleaned = false;
      let heartbeat = null;

      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        if (heartbeat) clearInterval(heartbeat);
        sseSessions.delete(transport.sessionId);
        try {
          await transport.close();
        } catch {
          // Ignore close errors.
        }
        try {
          await mcp.close();
        } catch {
          // Ignore close errors.
        }
      };

      sseSessions.set(transport.sessionId, { transport, mcp, createdAt: Date.now(), cleanup });
      res.on('close', () => {
        cleanup().catch(() => {});
      });

      try {
        await mcp.connect(transport);
        heartbeat = setInterval(() => {
          if (!res.writableEnded) {
            try {
              res.write(': ping\n\n');
            } catch {
              // The connection is gone.
            }
          }
        }, 20000);
        heartbeat.unref?.();
      } catch (error) {
        await cleanup();
        logger.error('SSE connection failed', { error: error.message });
        if (!res.headersSent) sendJson(res, 500, { error: 'Failed to start SSE transport.' });
      }
      return;
    }

    if (pathname === '/messages' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId') || url.searchParams.get('session_id');
      const entry = sessionId ? sseSessions.get(sessionId) : null;

      if (!entry) {
        sendJson(res, 404, { error: 'Unknown or expired SSE session.' });
        return;
      }

      let body;
      try {
        body = await readJson(req, config.server.maxBodyBytes);
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { error: error.message });
        } else {
          throw error;
        }
        return;
      }

      await entry.transport.handlePostMessage(req, res, body);
      return;
    }

    sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      if (error instanceof HttpError) {
        if (!res.headersSent) {
          sendJson(res, error.status, { error: error.message });
        } else {
          res.end();
        }
        return;
      }
      logger.error('Unhandled HTTP error', { error: error.message, stack: error.stack });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error.' });
      } else {
        res.end();
      }
    });
  });

  server.headersTimeout = 60000;
  server.requestTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 65000;

  server.on('clientError', (error, socket) => {
    logger.debug('HTTP client error', { error: error.message });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.server.port, config.server.host);
  });

  server.on('error', (error) => {
    logger.error('HTTP server error', { error: error.message });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : config.server.port;
  const displayHost = ['0.0.0.0', '::', '::0'].includes(config.server.host)
    ? '127.0.0.1'
    : config.server.host;
  const baseUrl = `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${actualPort}`;

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    for (const entry of [...sseSessions.values()]) {
      await entry.cleanup().catch(() => {});
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
      setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, 1500).unref?.();
    });
  }

  return {
    server,
    port: actualPort,
    host: config.server.host,
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    sseUrl: `${baseUrl}/sse`,
    close,
  };
}
