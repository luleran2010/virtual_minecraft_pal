const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { createRuntime } = require('./runtime');

function createMcpApplication(options = {}) {
  const runtime = options.runtime || createRuntime(options);
  if (typeof options.registerTools !== 'function') {
    throw new Error('An MCP tool registrar is required.');
  }
  const server = new McpServer({ name: 'minecraft-mcp-server', version: '2.0.4' });
  options.registerTools(server, runtime);
  return { server, runtime };
}

function createServer(options = {}) {
  return createMcpApplication(options).server;
}

module.exports = { createMcpApplication, createServer };
