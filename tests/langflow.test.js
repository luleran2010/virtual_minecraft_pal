const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const {
  chunkChatMessage,
  createLangflowAgent,
  extractResponseText,
  langflowSettings,
} = require('../mcp/langflow');
const { createRuntime } = require('../mcp/runtime');

test('validates Langflow settings and defaults the API base URL and timeout', () => {
  assert.deepEqual(langflowSettings({ LANGFLOW_FLOW_ID: 'flow-123' }), {
    baseUrl: 'http://127.0.0.1:7860',
    flowId: 'flow-123',
    apiKey: undefined,
    timeoutMs: 60000,
  });
  assert.throws(() => langflowSettings({}), /LANGFLOW_FLOW_ID is required/);
  assert.throws(() => langflowSettings({ LANGFLOW_FLOW_ID: 'x', LANGFLOW_BASE_URL: 'ftp://example.org' }), /HTTP or HTTPS/);
  assert.throws(() => langflowSettings({ LANGFLOW_FLOW_ID: 'x', LANGFLOW_TIMEOUT_MS: '0' }), /positive integer/);
});

test('extracts supported Langflow output shapes and rejects empty output', () => {
  assert.equal(extractResponseText({
    outputs: [{ outputs: [{ results: { message: { text: '  Hello player  ' } } }] }],
  }), 'Hello player');
  assert.equal(extractResponseText({ output: 'A plain text answer' }), 'A plain text answer');
  assert.throws(() => extractResponseText({ outputs: [] }), /without a text output/);
});

test('splits Langflow replies into bounded chat messages', () => {
  assert.deepEqual(chunkChatMessage('A short reply'), ['A short reply']);
  assert.deepEqual(chunkChatMessage('one two three four', 7), ['one two', 'three', 'four']);
  assert.deepEqual(chunkChatMessage('abcdefgh', 3), ['abc', 'def', 'gh']);
  assert.deepEqual(chunkChatMessage('   '), []);
  assert.throws(() => chunkChatMessage('test', 0), /positive integer/);
});

test('sends public chat through Langflow and publishes responses to public chat only', async () => {
  const gameBot = new EventEmitter();
  gameBot.username = 'VirtualPal';
  gameBot.entity = { position: { x: 0, y: 64, z: 0 } };
  gameBot.quit = () => setImmediate(() => gameBot.emit('end', 'test'));
  const runtime = createRuntime({ createBot: () => gameBot });
  const requests = [];
  const responses = [];
  const agent = createLangflowAgent({
    runtime,
    env: {
      MINECRAFT_PORT: '25565',
      LANGFLOW_FLOW_ID: 'flow id/1',
      LANGFLOW_API_KEY: 'test-api-key',
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({ outputs: [{ outputs: [{ results: { message: { text: 'Public reply' } } }] }] }),
      };
    },
  });
  gameBot.chat = (message) => responses.push({ channel: 'public', message });
  gameBot.whisper = (username, message) => responses.push({ channel: 'whisper', username, message });
  let nextRunAgent;

  try {
    const connecting = runtime.connect();
    gameBot.emit('spawn');
    await connecting;
    gameBot.emit('chat', 'Alex', 'Hello agent');
    gameBot.emit('whisper', 'Sam', 'Private question');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/api\/v1\/run\/flow%20id%2F1$/);
    assert.equal(requests[0].options.headers['x-api-key'], 'test-api-key');
    assert.equal(JSON.parse(requests[0].options.body).input_value, 'Hello agent');
    const firstSessionId = JSON.parse(requests[0].options.body).session_id;
    assert.match(firstSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(JSON.parse(requests[0].options.body).session_id, firstSessionId);
    assert.deepEqual(responses, [
      { channel: 'public', message: 'Public reply' },
    ]);

    agent.close();
    nextRunAgent = createLangflowAgent({
      runtime,
      env: { LANGFLOW_FLOW_ID: 'flow id/1' },
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return {
          ok: true,
          json: async () => ({ output: 'Next run reply' }),
        };
      },
    });
    gameBot.emit('chat', 'Alex', 'New server run');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.notEqual(JSON.parse(requests[1].options.body).session_id, firstSessionId);
  } finally {
    agent.close();
    if (nextRunAgent) nextRunAgent.close();
    await runtime.disconnect();
  }
});

test('reports Langflow failures to the player without crashing the chat handler', async () => {
  const gameBot = new EventEmitter();
  gameBot.username = 'VirtualPal';
  gameBot.entity = { position: { x: 0, y: 64, z: 0 } };
  gameBot.quit = () => setImmediate(() => gameBot.emit('end', 'test'));
  const runtime = createRuntime({ createBot: () => gameBot });
  const replies = [];
  gameBot.chat = (message) => replies.push(message);
  const originalConsoleError = console.error;
  console.error = () => {};
  const agent = createLangflowAgent({
    runtime,
    env: { LANGFLOW_FLOW_ID: 'flow' },
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'offline' }),
  });

  try {
    const connecting = runtime.connect();
    gameBot.emit('spawn');
    await connecting;
    gameBot.emit('chat', 'Alex', 'Are you there?');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(replies, ['Sorry, I could not reach Langflow right now.']);
  } finally {
    agent.close();
    console.error = originalConsoleError;
    await runtime.disconnect();
  }
});
