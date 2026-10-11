const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { startServer } = require('../server');
const { createRuntime } = require('../mcp/runtime');

test('connects the Minecraft bot before publishing the MCP HTTP endpoint', async () => {
  const fakeBot = new EventEmitter();
  fakeBot.username = 'VirtualPal';
  fakeBot.entity = { position: { x: 0, y: 64, z: 0 } };
  fakeBot.quit = () => setImmediate(() => fakeBot.emit('end', 'test shutdown'));
  const runtime = createRuntime({ createBot: () => fakeBot });
  const lifecycle = [];
  const httpServer = {
    start: async () => {
      lifecycle.push('http-started');
      return { address: '127.0.0.1', port: 3001 };
    },
    close: async () => lifecycle.push('http-closed'),
  };
  const starting = startServer({
    runtime,
    httpServer,
    env: { LANGFLOW_FLOW_ID: 'flow' },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lifecycle, []);
  fakeBot.emit('spawn');
  const shutdown = await starting;
  assert.deepEqual(lifecycle, ['http-started']);
  assert.equal(runtime.status().spawned, true);
  await shutdown();
  assert.deepEqual(lifecycle, ['http-started', 'http-closed']);
  assert.equal(runtime.status().state, 'disconnected');
});
