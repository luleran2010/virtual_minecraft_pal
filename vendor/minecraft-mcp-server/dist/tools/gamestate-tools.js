export function registerGameStateTools(factory, getBot) {
    factory.registerTool("detect-gamemode", "Detect the gamemode on game", {}, async () => {
        const bot = getBot();
        return factory.createResponse(`Bot gamemode: "${bot.game.gameMode}"`);
    });
}
