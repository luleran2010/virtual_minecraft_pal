const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createMcpHttpServer, hasValidToken, httpSettings } = require('../mcp/http');
const { loadUpstreamToolRegistrar } = require('../mcp/upstream');
const { createRuntime } = require('../mcp/runtime');

test('validates HTTP listener settings and bearer token checks', () => {
  assert.deepEqual(httpSettings({}), {
    host: '127.0.0.1',
    port: 3001,
    token: null,
    maxSessions: 20,
  });
  assert.throws(() => httpSettings({ MCP_HTTP_PORT: '70000' }), /between 0 and 65535/);
  assert.throws(() => httpSettings({ MCP_HTTP_HOST: '0.0.0.0' }), /MCP_HTTP_TOKEN is required/);
  assert.throws(() => httpSettings({ MCP_HTTP_MAX_SESSIONS: '0' }), /positive integer/);
  assert.equal(httpSettings({ MCP_HTTP_HOST: '0.0.0.0', MCP_HTTP_TOKEN: 'secret' }).token, 'secret');
  assert.equal(hasValidToken('Bearer secret', 'secret'), true);
  assert.equal(hasValidToken('Bearer wrong', 'secret'), false);
  assert.equal(hasValidToken(undefined, 'secret'), false);
  assert.equal(hasValidToken(undefined, null), true);
});

test('serves upstream MCP tools over authenticated Streamable HTTP', async () => {
  const registerTools = await loadUpstreamToolRegistrar();
  const runtime = createRuntime();
  const httpServer = createMcpHttpServer({
    runtime,
    registerTools,
    env: {
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_PORT: '0',
      MCP_HTTP_TOKEN: 'local-secret',
      MCP_HTTP_MAX_SESSIONS: '1',
    },
  });
  let client;
  let clientTransport;

  try {
    const address = await httpServer.start();
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const denied = await fetch(url, { method: 'GET' });
    assert.equal(denied.status, 401);
    const missing = await fetch(`${url}/not-found`);
    assert.equal(missing.status, 404);
    const invalidJson = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer local-secret',
        'content-type': 'application/json',
      },
      body: '{',
    });
    assert.equal(invalidJson.status, 400);

    clientTransport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: 'Bearer local-secret' } },
    });
    client = new Client({ name: 'langflow-mcp-test', version: '1.0.0' });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const names = new Set(tools.map(({ name }) => name));
    for (const name of [
      'get-position',
      'move-to-position',
      'list-inventory',
      'find-blocks',
      'find-entity',
      'read-chat',
      'list-recipes',
      'smelt-item',
    ]) {
      assert.ok(names.has(name), `expected upstream tool ${name}`);
    }
    assert.equal(names.size, 21);
    assert.equal(names.has('send-chat'), false);

    const disconnected = await client.callTool({ name: 'get-position', arguments: {} });
    assert.equal(disconnected.isError, true);
    assert.match(disconnected.content[0].text, /disconnected/i);

    const cappedSession = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer local-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'session-cap-test', version: '1.0.0' },
        },
      }),
    });
    assert.equal(cappedSession.status, 503);
    await clientTransport.terminateSession();
    await client.close();
    client = null;

    clientTransport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: 'Bearer local-secret' } },
    });
    client = new Client({ name: 'langflow-mcp-test-reconnect', version: '1.0.0' });
    await client.connect(clientTransport);
    assert.ok((await client.listTools()).tools.length > 0);
  } finally {
    if (client) await client.close();
    await httpServer.close();
  }
});

test('upstream tools use the main runtime bot and can read its chat buffer', async () => {
  const registerTools = await loadUpstreamToolRegistrar();
  const bot = new EventEmitter();
  bot.username = 'VirtualPal';
  bot.entity = { position: { x: 2, y: 64, z: -3 } };
  bot.game = { gameMode: 'survival' };
  bot.inventory = { items: () => [] };
  bot.quit = () => setImmediate(() => bot.emit('end', 'test shutdown'));
  const runtime = createRuntime({ createBot: () => bot });
  const connecting = runtime.connect();
  bot.emit('spawn');
  await connecting;

  const httpServer = createMcpHttpServer({
    runtime,
    registerTools,
    env: { MCP_HTTP_HOST: '127.0.0.1', MCP_HTTP_PORT: '0' },
  });
  let client;

  try {
    bot.emit('chat', 'Alex', 'Hello bot');
    const address = await httpServer.start();
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );
    client = new Client({ name: 'shared-runtime-test', version: '1.0.0' });
    await client.connect(transport);

    const position = await client.callTool({ name: 'get-position', arguments: {} });
    assert.equal(position.isError, undefined);
    assert.match(position.content[0].text, /2.*64.*-3/);
    const chat = await client.callTool({ name: 'read-chat', arguments: { count: 10 } });
    assert.equal(chat.isError, undefined);
    assert.match(chat.content[0].text, /Alex: Hello bot/);
  } finally {
    if (client) await client.close();
    await httpServer.close();
    await runtime.disconnect();
  }
});
