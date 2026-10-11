require('dotenv').config({ path: require('node:path').resolve(__dirname, '.env') });

const { loadUpstreamToolRegistrar } = require('./mcp/upstream');
const { createMcpHttpServer } = require('./mcp/http');
const { createRuntime } = require('./mcp/runtime');
const { createLangflowAgent } = require('./mcp/langflow');
const { errorDetails, logEvent } = require('./mcp/logger');

async function startServer({ runtime, httpServer, env = process.env }) {
  if (!runtime) throw new Error('A Minecraft runtime is required for the main server.');
  if (!httpServer) throw new Error('An HTTP MCP server is required for the main server.');
  const langflowAgent = createLangflowAgent({ runtime, env });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    langflowAgent.close();
    try {
      await httpServer.close();
    } catch (error) {
      logEvent('error', 'server.shutdown.mcp_http_failed', { error: errorDetails(error) });
    }
    try {
      await runtime.disconnect('Main server shutting down');
    } catch (error) {
      logEvent('error', 'server.shutdown.minecraft_failed', { error: errorDetails(error) });
    }
    logEvent('info', 'server.shutdown.completed');
  };

  try {
    await runtime.connect();
    const address = await httpServer.start();
    if (address && typeof address === 'object') {
      logEvent('info', 'mcp.http.listening', {
        url: `http://${address.address === '::' ? '[::1]' : address.address}:${address.port}/mcp`,
      });
    }
    logEvent('info', 'server.ready', { role: 'minecraft-main', transports: ['streamable-http'] });
  } catch (error) {
    langflowAgent.close();
    try {
      await httpServer.close();
    } catch (cleanupError) {
      logEvent('error', 'server.startup.mcp_http_cleanup_failed', { error: errorDetails(cleanupError) });
    }
    try {
      await runtime.disconnect('Main server startup failed');
    } catch (cleanupError) {
      logEvent('error', 'server.startup.minecraft_cleanup_failed', { error: errorDetails(cleanupError) });
    }
    throw error;
  }
  return shutdown;
}

async function main() {
  const registerTools = await loadUpstreamToolRegistrar();
  const runtime = createRuntime();
  const httpServer = createMcpHttpServer({ runtime, registerTools });
  const shutdown = await startServer({
    runtime,
    httpServer,
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    logEvent('fatal', 'server.startup.failed', { error: errorDetails(error) });
    process.exitCode = 1;
  });
}

module.exports = { main, startServer };
