# Virtual Minecraft Pal

The main server owns one Mineflayer connection, handles in-game public chat through Langflow, and serves the upstream `minecraft-mcp-server` tools over Streamable HTTP. There is no separate MCP process or second bot connection.

## Requirements

- Node.js 20.10 or newer
- A Minecraft Java server reachable from the machine running the bot
- Minecraft 1.21.11 (the upstream tool implementation's currently supported version)
- Langflow and a flow configured to handle chat input

## Install and run

Install dependencies:

```powershell
npm install
```

Copy the environment template and set `LANGFLOW_FLOW_ID`:

```powershell
Copy-Item .env.example .env
```

Start the Minecraft server, then start the bot application:

```powershell
npm start
```

Wait for the bot to join and the MCP endpoint to report ready, then start Langflow. The bot can then receive in-game messages and send them to Langflow; Langflow can call back to the same bot through the MCP endpoint. By default, the bot connects to `localhost:25565` using offline authentication as `VirtualPal`.

### Configuration

Set these values in `.env` or in the process environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MINECRAFT_HOST` | `localhost` | Minecraft server hostname or IP |
| `MINECRAFT_PORT` | `25565` | Minecraft server port |
| `MINECRAFT_USERNAME` | `VirtualPal` | Bot username |
| `MINECRAFT_AUTH` | `offline` | Mineflayer authentication: `offline` or `microsoft` |
| `MCP_CONNECT_TIMEOUT_MS` | `60000` | Maximum time to wait for the bot to spawn |
| `MCP_MAX_CHAT_MESSAGES` | `200` | Number of incoming messages retained for `read-chat` |
| `LANGFLOW_BASE_URL` | `http://127.0.0.1:7860` | Langflow API base URL |
| `LANGFLOW_FLOW_ID` | Required | Flow invoked for each public player message |
| `LANGFLOW_API_KEY` | Unset | Optional API key sent in the `x-api-key` header |
| `LANGFLOW_TIMEOUT_MS` | `60000` | Timeout for each Langflow request |
| `MCP_HTTP_HOST` | `127.0.0.1` | MCP HTTP listener address; non-loopback addresses require a token |
| `MCP_HTTP_PORT` | `3001` | MCP HTTP listener port |
| `MCP_HTTP_TOKEN` | Unset | Bearer token for remote MCP clients; required for non-loopback binding |
| `MCP_HTTP_MAX_SESSIONS` | `20` | Maximum concurrent HTTP MCP sessions |

For an online-mode server, set `MINECRAFT_AUTH=microsoft` and complete Mineflayer's Microsoft authentication. The account must be allowed to join the server.

The MCP tools are vendored from [yuniko-software/minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server), version 2.0.4 at commit `240c8cec337ce152cc9e058ebdef511055808406`, under Apache-2.0; see [the vendored license](./vendor/minecraft-mcp-server/LICENSE). The upstream stdio entry point is adapted to run its tools against this app's single bot and Streamable HTTP transport.

## Connect Langflow

The MCP endpoint is `http://127.0.0.1:3001/mcp`. In Langflow:

1. Open **Settings → MCP Servers → Add MCP Server → JSON**.
2. Add the MCP server using the URL above. The same configuration is in [langflow.mcp.json](./langflow.mcp.json).
3. Add the **MCP Tools** component to the flow, enable **Tool Mode**, and connect its **Toolset** output to the Agent's **Tools** input.
4. Set `LANGFLOW_FLOW_ID` to the flow ID.

The ready-to-use VS Code HTTP MCP configuration is in [.vscode/mcp.json](./.vscode/mcp.json). If Langflow or another client runs in a container or on another machine, bind the endpoint to a reachable interface with `MCP_HTTP_HOST` and configure the same `MCP_HTTP_TOKEN` as a bearer token. Do not expose the endpoint to an untrusted network without authentication. When Langflow runs in a container, `127.0.0.1` refers to the container itself.

## In-game chat

Public chat from other players is sent to the configured Langflow flow as plain text. Incoming whispers are not forwarded. Langflow's plain-text response is posted as public Minecraft chat by the bot, split into Minecraft-sized messages as needed. A fresh Langflow session ID is created each time the main server starts.

There is no command prefix or per-player controller allowlist; configure access in the Minecraft server and Langflow flow. The upstream `send-chat` tool is intentionally not exposed. Stop the main server to disconnect the bot; normal shutdown also releases active movement controls. Run only one main server per Minecraft account.

## MCP tools

The upstream tool set is exposed over Streamable HTTP:

- **Movement:** `get-position`, `move-to-position`, `look-at`, `jump`, `move-in-direction`, `fly-to`
- **Inventory:** `list-inventory`, `find-item`, `equip-item`
- **Blocks:** `place-block`, `dig-block`, `get-block-info`, `find-blocks`
- **Entities:** `find-entity`
- **Crafting and smelting:** `list-recipes`, `craft-item`, `get-recipe`, `can-craft`, `smelt-item`
- **Game and chat:** `detect-gamemode`, `read-chat`

## Tests

Run the tests with:

```powershell
npm test
```

The suite uses a fake Mineflayer bot and does not require a live Minecraft server or Langflow instance.
