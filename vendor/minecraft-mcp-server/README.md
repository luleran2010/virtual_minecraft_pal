# Vendored Minecraft MCP Server tools

This directory contains the tool factory and tool modules from
[yuniko-software/minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server),
version 2.0.4, commit `240c8cec337ce152cc9e058ebdef511055808406`, licensed under
Apache-2.0. The upstream license is included in [LICENSE](./LICENSE).

The upstream stdio entry point and its Minecraft connection manager are not
included. The application registers these upstream tools on its Streamable HTTP
server and supplies the main server's existing Mineflayer bot.
