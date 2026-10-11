const DEFAULT_CHAT_LIMIT = 240;
const { randomUUID } = require('node:crypto');
const { errorDetails, logEvent } = require('./logger');

function langflowSettings(env = process.env) {
  const baseUrl = env.LANGFLOW_BASE_URL || 'http://127.0.0.1:7860';
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error('LANGFLOW_BASE_URL must be an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('LANGFLOW_BASE_URL must use HTTP or HTTPS.');
  }
  const flowId = env.LANGFLOW_FLOW_ID;
  if (!flowId) throw new Error('LANGFLOW_FLOW_ID is required to use Langflow as the in-game chat agent.');
  const timeoutMs = Number(env.LANGFLOW_TIMEOUT_MS || 60000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('LANGFLOW_TIMEOUT_MS must be a positive integer.');
  }
  return {
    baseUrl: parsedUrl.toString().replace(/\/+$/, ''),
    flowId,
    apiKey: env.LANGFLOW_API_KEY,
    timeoutMs,
  };
}

function extractResponseText(payload) {
  const output = payload?.outputs?.[0]?.outputs?.[0];
  const candidates = [
    output?.results?.message?.text,
    output?.results?.message,
    output?.results?.text,
    output?.outputs?.message?.message,
    output?.outputs?.message?.text,
    output?.outputs?.text,
    output?.text,
    payload?.output,
    payload?.text,
    payload?.message,
    payload?.result,
  ];
  const response = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
  if (response) return response.trim();
  throw new Error('Langflow returned a successful response without a text output.');
}

function chunkChatMessage(message, maxLength = DEFAULT_CHAT_LIMIT) {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new Error('maxLength must be a positive integer.');
  }
  const words = message.trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const word of words) {
    if (word.length > maxLength) {
      if (current) chunks.push(current);
      current = '';
      for (let index = 0; index < word.length; index += maxLength) {
        chunks.push(word.slice(index, index + maxLength));
      }
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxLength) {
      chunks.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function createLangflowAgent({ runtime, env = process.env, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime must provide fetch for Langflow requests.');
  const settings = langflowSettings(env);
  const sessionId = randomUUID();
  let queue = Promise.resolve();

  async function respondToMessage(incoming) {
    if (incoming.channel !== 'public') return;
    const inputValue = incoming.message;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
    try {
      const headers = { 'content-type': 'application/json' };
      if (settings.apiKey) headers['x-api-key'] = settings.apiKey;
      const response = await fetchImpl(
        `${settings.baseUrl}/api/v1/run/${encodeURIComponent(settings.flowId)}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            input_value: inputValue,
            input_type: 'chat',
            output_type: 'chat',
            session_id: sessionId,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const details = await response.text();
        throw new Error(`Langflow request failed with HTTP ${response.status}${details ? `: ${details.slice(0, 500)}` : '.'}`);
      }
      const answer = extractResponseText(await response.json());
      const client = runtime.requireBot();
      const chunks = chunkChatMessage(answer);
      if (!chunks.length) throw new Error('Langflow returned an empty chat reply.');
      for (const chunk of chunks) client.chat(chunk);
    } catch (error) {
      logEvent('error', 'langflow.request.failed', {
        flowId: settings.flowId,
        parameters: { channel: incoming.channel, username: incoming.username },
        error: errorDetails(error),
      });
      const client = runtime.bot;
      if (client?.entity) {
        client.chat('Sorry, I could not reach Langflow right now.');
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  const unsubscribe = runtime.addIncomingChatListener((incoming) => {
    queue = queue.then(() => respondToMessage(incoming));
    return queue;
  });
  return { close: unsubscribe, respondToMessage };
}

module.exports = { chunkChatMessage, createLangflowAgent, extractResponseText, langflowSettings };
