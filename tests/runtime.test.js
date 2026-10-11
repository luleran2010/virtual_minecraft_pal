const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const minecraftData = require('minecraft-data');
const { createRuntime, positiveIntegerEnv } = require('../mcp/runtime');

function fakeBot() {
  const client = new EventEmitter();
  client.username = 'VirtualPal';
  client.version = '1.21.11';
  client.entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
  client.registry = minecraftData(client.version);
  client.setControlState = () => {};
  client.loadPlugin = () => {
    client.pathfinder = { setMovements: (movements) => { client.movements = movements; } };
  };
  client.quit = () => setImmediate(() => client.emit('end', 'test'));
  return client;
}

test('validates positive integer environment values', () => {
  assert.equal(positiveIntegerEnv({}, 'LIMIT', 8), 8);
  assert.equal(positiveIntegerEnv({ LIMIT: '12' }, 'LIMIT', 8), 12);
  assert.throws(() => positiveIntegerEnv({ LIMIT: '0' }, 'LIMIT', 8), /positive integer/);
  assert.throws(() => positiveIntegerEnv({ LIMIT: '2.5' }, 'LIMIT', 8), /positive integer/);
});

test('loads configured Minecraft connection settings and rejects invalid options', () => {
  const runtime = createRuntime({ env: { MINECRAFT_HOST: 'game.local', MINECRAFT_PORT: '25600', MINECRAFT_AUTH: 'microsoft' } });
  assert.deepEqual(runtime.configuredConnection(), {
    host: 'game.local',
    port: 25600,
    username: 'VirtualPal',
    auth: 'microsoft',
  });
  assert.throws(() => createRuntime({ env: { MCP_CONNECT_TIMEOUT_MS: '-1' } }), /MCP_CONNECT_TIMEOUT_MS/);
  assert.throws(() => createRuntime({ env: { MINECRAFT_PORT: '70000' } }).configuredConnection(), /valid TCP port/);
  assert.throws(() => createRuntime({ env: { MINECRAFT_AUTH: 'token' } }).configuredConnection(), /MINECRAFT_AUTH/);
});

test('validates bot connection and reports its state', async () => {
  const client = fakeBot();
  const runtime = createRuntime({ createBot: () => client });
  assert.throws(() => runtime.requireBot(), /not connected/);
  const connecting = runtime.connect();
  client.emit('spawn');
  await connecting;
  assert.equal(runtime.requireBot(), client);
  assert.ok(client.movements);
  assert.deepEqual(runtime.status(), {
    connected: true,
    spawned: true,
    state: 'spawned',
    username: 'VirtualPal',
    position: { x: 0, y: 64, z: 0 },
    yaw: null,
    pitch: null,
    health: undefined,
    food: undefined,
    oxygen: undefined,
  });
  const disconnected = await runtime.disconnect();
  assert.deepEqual(disconnected, {
    connected: false,
    spawned: false,
    disconnected: true,
    state: 'disconnected',
  });
  assert.equal(runtime.status().connected, false);
  assert.throws(() => runtime.requireBot(), /not connected/);
});

test('buffers and notifies incoming chat and releases active controls', async () => {
  const client = fakeBot();
  const runtime = createRuntime({
    createBot: () => client,
    env: { MCP_MAX_CHAT_MESSAGES: '1' },
  });
  const incoming = [];
  runtime.addIncomingChatListener((message) => incoming.push(message));
  const connecting = runtime.connect();
  client.emit('spawn');
  await connecting;
  client.emit('chat', 'Alex', 'first');
  client.emit('whisper', 'Sam', 'second');
  assert.equal(runtime.chatMessages.length, 1);
  assert.equal(runtime.chatMessages[0].message, 'second');
  assert.equal(runtime.chatMessages[0].channel, 'whisper');
  assert.equal(incoming.length, 2);

  runtime.activeControls.add('forward');
  let released = false;
  client.setControlState = (name, state) => {
    if (name === 'forward' && state === false) released = true;
  };
  runtime.releaseControls();
  assert.equal(released, true);
  assert.deepEqual([...runtime.activeControls], []);

  await runtime.disconnect();
});

test('tracks direct bot controls so shutdown releases upstream movement', async () => {
  const client = fakeBot();
  client.controls = {};
  client.setControlState = (control, state) => { client.controls[control] = state; };
  const runtime = createRuntime({ createBot: () => client });
  const connecting = runtime.connect();
  client.emit('spawn');
  await connecting;

  client.setControlState('forward', true);
  assert.deepEqual([...runtime.activeControls], ['forward']);
  await runtime.disconnect();
  assert.equal(client.controls.forward, false);
  assert.deepEqual([...runtime.activeControls], []);
});

test('reports a Minecraft connection error and rejects duplicate or failed connections', async () => {
  const client = fakeBot();
  const runtime = createRuntime({ createBot: () => client });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const connecting = runtime.connect();
    assert.throws(() => runtime.connect(), /already connecting/);
    client.emit('error', new Error('no route'));
    await assert.rejects(connecting, /Minecraft connection failed: no route/);
    assert.equal(runtime.status().state, 'disconnected');
  } finally {
    console.error = originalConsoleError;
  }
  const creationFailure = createRuntime({ createBot: () => { throw new Error('bad settings'); } });
  assert.throws(() => creationFailure.connect(), /Could not create the Minecraft connection: bad settings/);
});
