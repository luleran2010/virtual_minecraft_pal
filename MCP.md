# MCP integration

The main application connects the Mineflayer bot, forwards public in-game chat
to Langflow, and exposes the upstream Minecraft MCP tools over Streamable HTTP
at `http://127.0.0.1:3001/mcp`. The MCP tools and chat handling share the same
bot connection; no stdio child process or private bridge is used.

The upstream tool implementation is pinned to version 2.0.4, commit
`240c8cec337ce152cc9e058ebdef511055808406`, in
[`vendor/minecraft-mcp-server/`](./vendor/minecraft-mcp-server/). Its stdio
entry point and separate connection lifecycle are not used. The application
registers the upstream tool modules on its HTTP MCP server and supplies the
main runtime's bot. The upstream `send-chat` tool is not exposed; Langflow
responses are sent to public game chat by the in-game conversation handler.

See [README.md](./README.md) for installation, startup order, configuration,
and Langflow setup.
