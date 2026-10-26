import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { loadConfig } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASH = '/data/data/com.termux/files/usr/bin/bash';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`FAIL ${name}\n${error.stack || error.message}\n`);
  }
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function makeClient(configPath) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/server.js', '--stdio'],
    cwd: ROOT,
    env: {
      ...process.env,
      TERMUX_MCP_CONFIG: configPath,
      TERMUX_MCP_LOG_LEVEL: 'warn',
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    if (/ ERROR | FATAL /.test(text)) process.stderr.write(`[server] ${text}`);
  });

  const client = new Client({ name: 'termux-mcp-smoke', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.map((item) => item.text || '').join('\n') || '';
  return { ...result, text, data: parseJson(text) };
}

async function waitForHealth(baseUrl, child, output, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP server exited early:\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return await response.json();
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`HTTP server did not become healthy:\n${output()}`);
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'termux-mcp-smoke-'));
  const configPath = path.join(tempDir, 'config.json');
  const port = await freePort();

  const loaded = await loadConfig({ configPath });
  const config = loaded.config;
  config.server.port = port;
  config.security.auditLog = path.join(tempDir, 'audit.jsonl');
  config.security.auditEnabled = false;
  config.terminal.socketPath = path.join(tempDir, 'tmux.sock');
  config.tasks.dir = path.join(tempDir, 'tasks');
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const baseUrl = `http://127.0.0.1:${port}`;
  let client = null;

  try {
    client = await makeClient(configPath);

    await test('stdio lists the expected tools', async () => {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((tool) => tool.name));
      for (const name of [
        'run_command',
        'read_file',
        'write_file',
        'edit_file',
        'search_files',
        'terminal_create',
        'terminal_write',
        'terminal_read',
        'terminal_kill',
        'task_start',
        'task_output',
        'task_stop',
        'system_info',
      ]) {
        assert.ok(names.has(name), `missing tool ${name}`);
      }
      assert.ok(tools.length >= 30);
    });

    await test('system_info reports Termux and tmux', async () => {
      const result = await call(client, 'system_info');
      assert.ok(!result.isError, result.text);
      assert.equal(result.data.termux.isTermux, true);
      assert.equal(result.data.tools.tmux, true);
    });

    await test('run_command uses bash and returns exit data', async () => {
      const result = await call(client, 'run_command', {
        command: 'echo $((2+3)); printf "no-newline"',
      });
      assert.ok(!result.isError, result.text);
      assert.equal(result.data.exit_code, 0);
      assert.equal(result.data.stdout, '5\nno-newline');
    });

    await test('run_command reports timeouts', async () => {
      const result = await call(client, 'run_command', {
        command: 'sleep 3',
        timeout_sec: 1,
      });
      assert.equal(result.isError, true);
      assert.equal(result.data.timed_out, true);
    });

    await test('files can be read outside $HOME (no workspace allow list)', async () => {
      const result = await call(client, 'read_file', { path: '/etc/hosts' });
      assert.ok(!result.isError, result.text);
      assert.match(result.text, /localhost|127\.0\.0\.1/);
    });

    const fileRoot = path.join(tempDir, 'files');
    await fsp.mkdir(fileRoot, { recursive: true });
    const hello = path.join(fileRoot, 'hello.txt');

    await test('write/read/edit/append files', async () => {
      let result = await call(client, 'write_file', {
        path: hello,
        content: 'alpha\nbeta\ngamma\n',
      });
      assert.ok(!result.isError, result.text);
      assert.equal(result.data.created, true);

      result = await call(client, 'read_file', { path: hello });
      assert.equal(result.text, 'alpha\nbeta\ngamma\n');

      result = await call(client, 'edit_file', {
        path: hello,
        old_string: 'beta',
        new_string: 'BETA',
      });
      assert.equal(result.data.replacements, 1);

      result = await call(client, 'write_file', { path: hello, content: 'delta\n', append: true });
      assert.equal(result.data.mode, 'append');

      result = await call(client, 'read_file', { path: hello, with_line_numbers: true });
      assert.match(result.text, /BETA/);
      assert.match(result.text, /delta/);
    });

    await test('list/stat/search/copy/move files', async () => {
      let result = await call(client, 'list_dir', { path: fileRoot });
      assert.ok(result.data.entries.some((entry) => entry.name === 'hello.txt'));

      result = await call(client, 'stat_path', { path: hello });
      assert.equal(result.data.type, 'file');

      result = await call(client, 'search_files', {
        root: fileRoot,
        glob: '*.txt',
        query: 'BETA',
      });
      assert.equal(result.data.matches.length, 1);
      assert.equal(result.data.matches[0].line, 2);

      result = await call(client, 'copy_path', {
        source: hello,
        destination: path.join(fileRoot, 'copy.txt'),
      });
      assert.ok(!result.isError, result.text);

      result = await call(client, 'move_path', {
        source: path.join(fileRoot, 'copy.txt'),
        destination: path.join(fileRoot, 'moved.txt'),
      });
      assert.equal(result.data.method, 'rename');
    });

    await test('delete_path requires confirmation and dry_run works', async () => {
      const target = path.join(fileRoot, 'moved.txt');
      let result = await call(client, 'delete_path', { path: target, dry_run: true });
      assert.equal(result.data.required_confirm, 'DELETE');

      result = await call(client, 'delete_path', { path: target });
      assert.equal(result.isError, true);
      assert.match(result.text, /confirm="DELETE"/);

      result = await call(client, 'delete_path', { path: target, confirm: 'DELETE' });
      assert.equal(result.data.deleted, true);
    });

    await test('delete_path refuses the filesystem root', async () => {
      const result = await call(client, 'delete_path', { path: '/', recursive: true, confirm: 'DELETE' });
      assert.equal(result.isError, true);
      assert.match(result.text, /filesystem root/);
    });

    await test('binary files can be read as base64', async () => {
      const target = path.join(fileRoot, 'binary.bin');
      const original = Buffer.from([0, 1, 2, 255, 65]);
      let result = await call(client, 'write_file', {
        path: target,
        content: original.toString('base64'),
        encoding: 'base64',
      });
      assert.ok(!result.isError, result.text);

      result = await call(client, 'read_file', { path: target });
      assert.equal(result.isError, true);

      result = await call(client, 'read_file', { path: target, encoding: 'base64' });
      assert.equal(result.text, original.toString('base64'));
    });

    const terminalName = `smoke-${Date.now().toString(36)}`;
    await test('terminal create/write/read/expect', async () => {
      let result = await call(client, 'terminal_create', {
        name: terminalName,
        shell: BASH,
        cwd: fileRoot,
        cols: 100,
        rows: 30,
      });
      assert.ok(!result.isError, result.text);
      assert.equal(result.data.alive, true);

      result = await call(client, 'terminal_write', {
        session: terminalName,
        input: 'echo TERM_OK',
        submit: true,
      });
      assert.ok(!result.isError, result.text);

      result = await call(client, 'terminal_read', {
        session: terminalName,
        expect: 'TERM_OK',
        timeout_ms: 5000,
      });
      assert.equal(result.data.expect_matched, true);
      assert.match(result.data.output, /TERM_OK/);
    });

    await test('terminal multi-line paste and control keys', async () => {
      let result = await call(client, 'terminal_write', {
        session: terminalName,
        input: 'for i in 1 2 3\ndo\n  echo "LOOP$i"\ndone',
        submit: true,
      });
      assert.ok(!result.isError, result.text);

      result = await call(client, 'terminal_read', {
        session: terminalName,
        expect: 'LOOP3',
        timeout_ms: 5000,
        lines: 60,
      });
      assert.match(result.data.output, /LOOP1/);
      assert.match(result.data.output, /LOOP3/);

      result = await call(client, 'terminal_write', {
        session: terminalName,
        input: 'sleep 30',
        submit: true,
      });
      assert.ok(!result.isError, result.text);
      result = await call(client, 'terminal_write', {
        session: terminalName,
        keys: ['C-c'],
        wait_ms: 500,
      });
      assert.ok(!result.isError, result.text);
      assert.match(result.data.output, /\^C/);
    });

    await test('terminal resize/list/attach/kill', async () => {
      let result = await call(client, 'terminal_resize', {
        session: terminalName,
        cols: 120,
        rows: 40,
      });
      assert.equal(result.data.size, '120x40');

      result = await call(client, 'terminal_list');
      assert.ok(result.data.sessions.some((session) => session.name === terminalName));

      result = await call(client, 'terminal_attach_info', { session: terminalName });
      assert.match(result.data.attach_command, /tmux -S .* attach -t/);

      result = await call(client, 'terminal_kill', { session: terminalName });
      assert.equal(result.data.killed, true);

      result = await call(client, 'terminal_list');
      assert.ok(!result.data.sessions.some((session) => session.name === terminalName));
    });

    await test('terminal sessions and tasks survive a server restart', async () => {
      const persistentTerminal = `persist-${Date.now().toString(36)}`;
      let result = await call(client, 'terminal_create', {
        name: persistentTerminal,
        shell: BASH,
        cwd: fileRoot,
      });
      assert.ok(!result.isError, result.text);

      result = await call(client, 'task_start', {
        name: 'persist-sleeper',
        command: 'sleep 60',
        wait_ms: 100,
      });
      assert.ok(!result.isError, result.text);
      const persistentTask = result.data.id;

      // Stop the MCP server by closing the stdio transport, then reconnect with
      // the same config. tmux and the detached task must still be there.
      await client.close();
      client = null;
      client = await makeClient(configPath);

      const sessions = await call(client, 'terminal_list');
      assert.ok(
        sessions.data.sessions.some((session) => session.name === persistentTerminal),
        'terminal session did not survive restart',
      );

      const tasks = await call(client, 'task_list');
      const found = tasks.data.tasks.find((task) => task.id === persistentTask);
      assert.ok(found, 'background task did not survive restart');
      assert.equal(found.running, true);

      await call(client, 'terminal_kill', { session: persistentTerminal });
      await call(client, 'task_stop', { id: persistentTask, grace_ms: 1000 });
      await call(client, 'task_remove', { id: persistentTask });
    });

    let tickerId = null;
    let sleeperId = null;
    let failingId = null;

    await test('background task runs, persists output and exit code', async () => {
      let result = await call(client, 'task_start', {
        name: 'smoke-ticker',
        command: 'for i in 1 2 3; do echo tick-$i; sleep 0.3; done',
        wait_ms: 200,
      });
      assert.ok(!result.isError, result.text);
      tickerId = result.data.id;
      assert.equal(result.data.running, true);

      result = await call(client, 'task_output', {
        id: tickerId,
        wait_ms: 3000,
        wait_for: 'exit',
        tail_lines: 50,
      });
      assert.equal(result.data.state, 'exited');
      assert.equal(result.data.exit_code, 0);
      assert.match(result.data.output, /tick-1/);
      assert.match(result.data.output, /tick-3/);

      const incremental = await call(client, 'task_output', {
        id: tickerId,
        offset: 0,
      });
      assert.ok(incremental.data.next_offset > 0);

      result = await call(client, 'task_list', { include_finished: true });
      assert.ok(result.data.tasks.some((task) => task.id === tickerId));
    });

    await test('background task can be stopped', async () => {
      const started = await call(client, 'task_start', {
        name: 'smoke-sleeper',
        command: 'sleep 60',
        wait_ms: 100,
      });
      assert.ok(!started.isError, started.text);
      sleeperId = started.data.id;

      const stopped = await call(client, 'task_stop', { id: sleeperId, grace_ms: 1000 });
      assert.ok(!stopped.isError, stopped.text);
      assert.equal(stopped.data.stopped, true);

      const listed = await call(client, 'task_list');
      const task = listed.data.tasks.find((item) => item.id === sleeperId);
      assert.ok(task);
      assert.equal(task.running, false);
    });

    await test('background task exit 7 is persisted', async () => {
      const started = await call(client, 'task_start', {
        name: 'smoke-failing',
        command: 'echo before-fail; exit 7',
        wait_ms: 500,
      });
      assert.ok(!started.isError, started.text);
      failingId = started.data.id;

      const output = await call(client, 'task_output', { id: failingId, wait_ms: 1000 });
      assert.equal(output.data.exit_code, 7);
      assert.equal(output.data.running, false);
      assert.match(output.data.output, /before-fail/);
    });

    await test('finished tasks can be removed', async () => {
      for (const id of [tickerId, sleeperId, failingId].filter(Boolean)) {
        const result = await call(client, 'task_remove', { id });
        assert.ok(!result.isError, result.text);
      }
      const listed = await call(client, 'task_list');
      for (const id of [tickerId, sleeperId, failingId].filter(Boolean)) {
        assert.ok(!listed.data.tasks.some((task) => task.id === id));
      }
    });

    await test('resources and prompts are exposed', async () => {
      const resources = await client.listResources();
      assert.ok(resources.resources.some((resource) => resource.uri === 'termux://system/info'));

      const resource = await client.readResource({ uri: 'termux://system/info' });
      const data = JSON.parse(resource.contents[0].text);
      assert.equal(data.termux.isTermux, true);

      const prompts = await client.listPrompts();
      assert.ok(prompts.prompts.some((prompt) => prompt.name === 'termux_operator'));

      const prompt = await client.getPrompt({
        name: 'termux_operator',
        arguments: { task: 'Check the battery' },
      });
      assert.ok(prompt.messages[0].content.text.includes('Check the battery'));
    });

    await client.close();
    client = null;

    await test('HTTP server: health, origin and Streamable HTTP', async () => {
      let stderr = '';
      const child = spawn(process.execPath, ['src/server.js', '--http'], {
        cwd: ROOT,
        env: {
          ...process.env,
          TERMUX_MCP_CONFIG: configPath,
          TERMUX_MCP_LOG_LEVEL: 'error',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      try {
        const health = await waitForHealth(baseUrl, child, () => stderr);
        assert.equal(health.ok, true);

        const initBody = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'raw', version: '1.0.0' },
          },
        });
        const baseHeaders = {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        };

        let response = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: baseHeaders,
          body: initBody,
        });
        assert.equal(response.status, 200);
        const initResult = await response.json();
        assert.equal(initResult.result.serverInfo.name, 'termux-mcp');

        response = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            ...baseHeaders,
            origin: 'http://evil.example',
          },
          body: initBody,
        });
        assert.equal(response.status, 403);

        const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
        const httpClient = new Client({ name: 'http-smoke', version: '1.0.0' });
        await httpClient.connect(transport);
        const tools = await httpClient.listTools();
        assert.ok(tools.tools.some((tool) => tool.name === 'terminal_create'));
        const result = await httpClient.callTool({
          name: 'run_command',
          arguments: { command: 'echo HTTP_OK' },
        });
        assert.match(result.content[0].text, /HTTP_OK/);
        await httpClient.close();
      } finally {
        child.kill('SIGTERM');
        await waitForExit(child);
      }
    });

    await test('HTTP server: legacy SSE transport', async () => {
      let stderr = '';
      const child = spawn(process.execPath, ['src/server.js', '--http'], {
        cwd: ROOT,
        env: {
          ...process.env,
          TERMUX_MCP_CONFIG: configPath,
          TERMUX_MCP_LOG_LEVEL: 'error',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      try {
        await waitForHealth(baseUrl, child, () => stderr);
        const transport = new SSEClientTransport(
          new URL(`${baseUrl}/sse`),
        );
        const sseClient = new Client({ name: 'sse-smoke', version: '1.0.0' });
        await sseClient.connect(transport);
        const tools = await sseClient.listTools();
        assert.ok(tools.tools.some((tool) => tool.name === 'task_start'));
        await sseClient.close();
      } finally {
        child.kill('SIGTERM');
        await waitForExit(child);
      }
    });
  } finally {
    if (client) {
      try {
        await client.callTool({ name: 'terminal_kill', arguments: { all: true } });
      } catch {
        // Best effort.
      }
      try {
        const listed = await client.callTool({ name: 'task_list', arguments: { limit: 500 } });
        const tasks = parseJson(listed.content?.[0]?.text || '')?.tasks || [];
        for (const task of tasks) {
          if (task.running) {
            await client.callTool({ name: 'task_stop', arguments: { id: task.id, grace_ms: 500 } });
          }
          await client.callTool({ name: 'task_remove', arguments: { id: task.id } });
        }
      } catch {
        // Best effort.
      }
      await client.close().catch(() => {});
    }

    try {
      execFileSync('tmux', ['-S', config.terminal.socketPath, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // No tmux server.
    }
    await fsp.rm(tempDir, { recursive: true, force: true });
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
