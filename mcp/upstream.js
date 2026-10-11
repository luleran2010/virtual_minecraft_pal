const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadUpstreamToolRegistrar() {
  const distributionDirectory = path.dirname(require.resolve('minecraft-mcp-server'));
  const loadModule = (modulePath) => import(pathToFileURL(path.join(distributionDirectory, modulePath)).href);
  const [
    { ToolFactory },
    { registerPositionTools },
    { registerInventoryTools },
    { registerBlockTools },
    { registerEntityTools },
    { registerChatTools },
    { registerFlightTools },
    { registerGameStateTools },
    { registerCraftingTools },
    { registerFurnaceTools },
  ] = await Promise.all([
    loadModule('tool-factory.js'),
    loadModule('tools/position-tools.js'),
    loadModule('tools/inventory-tools.js'),
    loadModule('tools/block-tools.js'),
    loadModule('tools/entity-tools.js'),
    loadModule('tools/chat-tools.js'),
    loadModule('tools/flight-tools.js'),
    loadModule('tools/gamestate-tools.js'),
    loadModule('tools/crafting-tools.js'),
    loadModule('tools/furnace-tools.js'),
  ]);

  return (server, runtime) => {
    const connection = {
      async checkConnectionAndReconnect() {
        const status = runtime.status();
        if (!status.connected) {
          return {
            connected: false,
            message: 'The Minecraft bot is disconnected. Restart the main server to reconnect.',
          };
        }
        if (!status.spawned) {
          return {
            connected: false,
            message: 'The Minecraft bot has not spawned yet. Wait for it to join the world.',
          };
        }
        return { connected: true };
      },
    };
    const upstreamFactory = new ToolFactory(server, connection);
    const factory = {
      registerTool(name, ...args) {
        if (name !== 'send-chat') upstreamFactory.registerTool(name, ...args);
      },
      createResponse: upstreamFactory.createResponse.bind(upstreamFactory),
      createErrorResponse: upstreamFactory.createErrorResponse.bind(upstreamFactory),
    };
    const getBot = () => runtime.requireBot();
    const messageStore = {
      getMaxMessages: () => runtime.maxChatMessages,
      getRecentMessages(count) {
        return runtime.chatMessages.slice(-count).map((message) => ({
          timestamp: Date.parse(message.receivedAt),
          username: message.username,
          content: message.message,
        }));
      },
    };

    registerPositionTools(factory, getBot);
    registerInventoryTools(factory, getBot);
    registerBlockTools(factory, getBot);
    registerEntityTools(factory, getBot);
    registerChatTools(factory, getBot, messageStore);
    registerFlightTools(factory, getBot);
    registerGameStateTools(factory, getBot);
    registerCraftingTools(factory, getBot);
    registerFurnaceTools(factory, getBot);
  };
}

module.exports = { loadUpstreamToolRegistrar };
