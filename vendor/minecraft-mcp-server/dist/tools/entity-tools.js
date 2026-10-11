import { z } from "zod";
export function registerEntityTools(factory, getBot) {
    factory.registerTool("find-entity", "Find the nearest entity of a specific type", {
        type: z.string().optional().describe("Type of entity to find (empty for any entity)"),
        maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)")
    }, async ({ type = '', maxDistance = 16 }) => {
        const bot = getBot();
        const entityFilter = (entity) => {
            if (!type)
                return true;
            if (type === 'player')
                return entity.type === 'player';
            if (type === 'mob')
                return entity.type === 'mob';
            return Boolean(entity.name && entity.name.includes(type.toLowerCase()));
        };
        const entity = bot.nearestEntity(entityFilter);
        if (!entity || bot.entity.position.distanceTo(entity.position) > maxDistance) {
            return factory.createResponse(`No ${type || 'entity'} found within ${maxDistance} blocks`);
        }
        const entityName = entity.name || entity.username || entity.type;
        return factory.createResponse(`Found ${entityName} at position (${Math.floor(entity.position.x)}, ${Math.floor(entity.position.y)}, ${Math.floor(entity.position.z)})`);
    });
}
