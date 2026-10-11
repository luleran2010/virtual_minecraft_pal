const { randomUUID, timingSafeEqual } = require('node:crypto');
const { createServer: createHttpServer } = require('node:http');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createMcpApplication } = require('./index');
const { createRuntime } = require('./runtime');
const { errorDetails, logEvent } = require('./logger');

function httpSettings(env = process.env) {
  const host = env.MCP_HTTP_HOST || '127.0.0.1';
  const rawPort = env.MCP_HTTP_PORT || '3001';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('MCP_HTTP_PORT must be an integer between 0 and 65535.');
  }
  const token = env.MCP_HTTP_TOKEN || null;
  if (!token && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('MCP_HTTP_TOKEN is required when MCP_HTTP_HOST is not a loopback address.');
  }
  const maxSessions = Number(env.MCP_HTTP_MAX_SESSIONS || 20);
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new Error('MCP_HTTP_MAX_SESSIONS must be a positive integer.');
  }
  return { host, port, token, maxSessions };
}

function hasValidToken(header, expectedToken) {
  if (!expectedToken) return true;
  const provided = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : '';
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function readJsonBody(request, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        if (!exceeded) reject(new Error('MCP initialization request body exceeds the 1 MiB limit.'));
        exceeded = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', (error) => {
      if (!exceeded) reject(error);
    });
    request.on('end', () => {
      if (exceeded) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('MCP request body must contain valid JSON.'));
      }
    });
  });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function createMcpHttpServer({ runtime, registerTools, env = process.env } = {}) {
  if (!runtime) runtime = createRuntime({ env });
  if (typeof registerTools !== 'function') {
    throw new Error('An MCP tool registrar is required for the HTTP server.');
  }
  const settings = httpSettings(env);
  const sessions = new Map();
  let pendingSessions = 0;
  const httpServer = createHttpServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      logEvent('error', 'mcp.http.request.failed', {
        parameters: { method: request.method, path: request.url },
        error: errorDetails(error),
      });
      if (!response.headersSent) sendJson(response, 500, { error: 'MCP request failed.' });
    });
  });
  let started = false;

  function createSession() {
    let mcpServer;
    let transport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { server: mcpServer, transport });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    transport.onerror = (error) => {
      logEvent('error', 'mcp.http.transport.failed', { error: errorDetails(error) });
    };
    mcpServer = createMcpApplication({ runtime, registerTools }).server;
    return mcpServer.connect(transport).then(() => ({ server: mcpServer, transport }));
  }

  async function handleRequest(request, response) {
    const requestPath = new URL(request.url || '/', 'http://localhost').pathname;
    if (requestPath !== '/mcp') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    if (!hasValidToken(request.headers.authorization, settings.token)) {
      response.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer',
      });
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const sessionId = request.headers['mcp-session-id'];
    let session = sessionId ? sessions.get(sessionId) : null;
    let parsedBody;
    if (!sessionId) {
      try {
        parsedBody = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.message.includes('1 MiB') ? 413 : 400, { error: error.message });
        return;
      }
      if (parsedBody?.method !== 'initialize') {
        sendJson(response, 400, { error: 'An MCP initialize request is required to create a session.' });
        return;
      }
      if (sessions.size + pendingSessions >= settings.maxSessions) {
        sendJson(response, 503, { error: 'The HTTP MCP server has reached its active session limit.' });
        return;
      }
      pendingSessions += 1;
      try {
        session = await createSession();
      } catch (error) {
        sendJson(response, 500, { error: `Could not create an MCP session: ${error.message}` });
        return;
      } finally {
        pendingSessions -= 1;
      }
    } else if (!session) {
      sendJson(response, 404, { error: 'MCP session not found. Reconnect to initialize a new session.' });
      return;
    }

    try {
      await session.transport.handleRequest(request, response, parsedBody);
    } catch (error) {
      logEvent('error', 'mcp.http.session_request.failed', {
        parameters: { method: request.method, path: request.url },
        error: errorDetails(error),
      });
      if (!response.headersSent) sendJson(response, 500, { error: 'MCP request failed.' });
    }
  }

  return {
    async start() {
      if (started) throw new Error('The HTTP MCP server is already listening.');
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          httpServer.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.removeListener('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(settings.port, settings.host);
      }).catch((error) => {
        throw new Error(`Could not start HTTP MCP server: ${error.message}`);
      });
      started = true;
      return httpServer.address();
    },
    async close() {
      const activeSessions = [...sessions.values()];
      sessions.clear();
      await Promise.all(activeSessions.map(async ({ server, transport }) => {
        await transport.close();
        await server.close();
      }));
      if (started) {
        await new Promise((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
        started = false;
      }
    },
  };
}

module.exports = { createMcpHttpServer, hasValidToken, httpSettings };
