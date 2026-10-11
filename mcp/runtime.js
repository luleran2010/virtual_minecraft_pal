const { EventEmitter } = require('node:events');
const mineflayer = require('mineflayer');
const { Movements, pathfinder } = require('mineflayer-pathfinder');
const minecraftData = require('minecraft-data');
const { errorDetails, logEvent } = require('./logger');

function positiveIntegerEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function createRuntime({ createBot = mineflayer.createBot, env = process.env } = {}) {
  const maxChatMessages = positiveIntegerEnv(env, 'MCP_MAX_CHAT_MESSAGES', 200);
  const connectTimeoutMs = positiveIntegerEnv(env, 'MCP_CONNECT_TIMEOUT_MS', 60000);
  const incomingListeners = new Set();
  const chatMessages = [];
  const activeControls = new Set();
  let nextChatMessageId = 1;
  let bot = null;
  let connectionState = 'disconnected';
  let disconnectPromise = null;

  function configuredConnection() {
    const port = Number.parseInt(env.MINECRAFT_PORT || '25565', 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('MINECRAFT_PORT must be a valid TCP port (1-65535).');
    }
    const auth = env.MINECRAFT_AUTH || 'offline';
    if (!['offline', 'microsoft'].includes(auth)) {
      throw new Error('MINECRAFT_AUTH must be either "offline" or "microsoft".');
    }
    return {
      host: env.MINECRAFT_HOST || 'localhost',
      port,
      username: env.MINECRAFT_USERNAME || 'VirtualPal',
      auth,
    };
  }

  function requireBot({ spawned = true } = {}) {
    if (!bot) throw new Error('The Minecraft bot is not connected. The main server process manages its game connection.');
    if (spawned && !bot.entity) {
      throw new Error('The Minecraft bot has not spawned yet. Wait for it to join the world.');
    }
    return bot;
  }

  function recordChatMessage(channel, username, message) {
    const entry = {
      id: nextChatMessageId++,
      channel,
      username,
      message,
      receivedAt: new Date().toISOString(),
    };
    chatMessages.push(entry);
    if (chatMessages.length > maxChatMessages) chatMessages.shift();
    for (const listener of incomingListeners) {
      Promise.resolve(listener(entry)).catch((error) => {
        logEvent('error', 'chat.handler.failed', {
          parameters: { channel, username },
          error: errorDetails(error),
        });
      });
    }
  }

  function releaseControls(client = bot) {
    if (client) {
      for (const control of activeControls) client.setControlState(control, false);
    }
    activeControls.clear();
  }

  function connect() {
    if (bot) throw new Error(`The bot is already ${connectionState}. Disconnect it before reconnecting.`);
    const settings = configuredConnection();
    let client;
    try {
      client = createBot(settings);
    } catch (error) {
      connectionState = 'disconnected';
      throw new Error(`Could not create the Minecraft connection: ${error.message}`);
    }
    connectionState = 'connecting';
    bot = client;
    const hasPathfinderPlugin = typeof client.loadPlugin === 'function';
    try {
      if (typeof client.setControlState === 'function') {
        const setControlState = client.setControlState.bind(client);
        client.setControlState = (control, state) => {
          if (bot !== client || connectionState === 'disconnected') {
            activeControls.delete(control);
            return undefined;
          }
          const result = setControlState(control, state);
          if (state) activeControls.add(control);
          else activeControls.delete(control);
          return result;
        };
      }
      if (hasPathfinderPlugin) client.loadPlugin(pathfinder);
    } catch (error) {
      connectionState = 'disconnected';
      bot = null;
      try {
        client.quit('Could not initialize Minecraft plugins');
      } catch (cleanupError) {
        logEvent('error', 'minecraft.plugin_cleanup.failed', { error: errorDetails(cleanupError) });
      }
      throw new Error(`Could not initialize Minecraft movement tools: ${error.message}`);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        connectionState = 'disconnected';
        if (bot === client) bot = null;
        client.quit('MCP connection timed out');
        reject(new Error(`Timed out after ${connectTimeoutMs}ms waiting for the Minecraft bot to spawn.`));
      }, connectTimeoutMs);

      client.on('spawn', () => {
        if (bot !== client) {
          client.quit('MCP connection was superseded');
          return;
        }
        if (hasPathfinderPlugin) {
          try {
            const mcData = minecraftData(client.version);
            if (!mcData || !client.pathfinder) {
              throw new Error(`Pathfinding data is unavailable for Minecraft ${client.version || 'unknown'}.`);
            }
            client.pathfinder.setMovements(new Movements(client, mcData));
          } catch (error) {
            connectionState = 'disconnected';
            bot = null;
            client.quit('Could not initialize Minecraft movement data');
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(new Error(`Could not initialize Minecraft movement tools: ${error.message}`));
            }
            return;
          }
        }
        connectionState = 'spawned';
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          connected: true,
          spawned: true,
          username: client.username,
          host: settings.host,
          port: settings.port,
        });
      });
      client.on('chat', (username, message) => {
        if (username !== client.username) recordChatMessage('public', username, message);
      });
      client.on('whisper', (username, message) => {
        if (username !== client.username) recordChatMessage('whisper', username, message);
      });
      client.on('error', (error) => {
        logEvent('error', 'minecraft.connection.failed', { error: errorDetails(error) });
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (bot === client) {
          connectionState = 'disconnected';
          bot = null;
        }
        reject(new Error(`Minecraft connection failed: ${error.message}`));
      });
      client.on('end', (reason) => {
        if (bot === client) {
          connectionState = 'disconnected';
          activeControls.clear();
          bot = null;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Minecraft disconnected before spawning${reason ? `: ${String(reason)}` : '.'}`));
      });
    });
  }

  function disconnectedResult() {
    return { connected: false, spawned: false, disconnected: true, state: 'disconnected' };
  }

  function disconnect(reason = 'MCP requested shutdown') {
    if (disconnectPromise) return disconnectPromise;
    if (!bot) return Promise.resolve(disconnectedResult());

    const client = bot;
    connectionState = 'disconnecting';
    disconnectPromise = (async () => {
      let timeout;
      try {
        releaseControls(client);
        const ended = new Promise((resolve) => client.once('end', resolve));
        client.quit(reason);
        await Promise.race([
          ended,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('The bot did not confirm disconnection before the timeout.')),
              10000,
            );
          }),
        ]);
        if (bot === client) {
          throw new Error('The Minecraft connection did not emit its end event after quit was requested.');
        }
        return disconnectedResult();
      } catch (error) {
        if (bot === client) connectionState = client.entity ? 'spawned' : 'connecting';
        throw error;
      } finally {
        clearTimeout(timeout);
        disconnectPromise = null;
      }
    })();
    return disconnectPromise;
  }

  function status() {
    if (!bot) return { connected: false, spawned: false, state: connectionState };
    return {
      connected: connectionState !== 'disconnected',
      spawned: Boolean(bot.entity),
      state: connectionState,
      username: bot.username,
      position: bot.entity ? {
        x: bot.entity.position.x,
        y: bot.entity.position.y,
        z: bot.entity.position.z,
      } : null,
      yaw: bot.entity?.yaw ?? null,
      pitch: bot.entity?.pitch ?? null,
      health: bot.health,
      food: bot.food,
      oxygen: bot.oxygenLevel,
    };
  }

  return {
    get bot() { return bot; },
    get connectionState() { return connectionState; },
    get maxChatMessages() { return maxChatMessages; },
    get activeControls() { return activeControls; },
    get chatMessages() { return chatMessages; },
    addIncomingChatListener(listener) {
      incomingListeners.add(listener);
      return () => incomingListeners.delete(listener);
    },
    configuredConnection,
    requireBot,
    releaseControls,
    connect,
    disconnect,
    status,
  };
}

module.exports = { createRuntime, positiveIntegerEnv };
