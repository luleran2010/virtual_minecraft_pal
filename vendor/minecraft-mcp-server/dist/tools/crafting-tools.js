import { z } from "zod";
import minecraftData from 'minecraft-data';
import { log } from '../logger.js';
function normalizeItemName(value) {
    return value.trim().toLowerCase();
}
function classifyNameMatch(resultName, query) {
    const resultNorm = normalizeItemName(resultName);
    const queryNorm = normalizeItemName(query);
    return {
        exact: resultNorm === queryNorm,
        partial: resultNorm.includes(queryNorm)
    };
}
function resolveItemNames(value, itemsById) {
    if (!value)
        return [];
    if (Array.isArray(value)) {
        const out = [];
        for (const v of value) {
            const name = resolveItemName(v, itemsById);
            if (name)
                out.push(name);
        }
        return Array.from(new Set(out));
    }
    const single = resolveItemName(value, itemsById);
    return single ? [single] : [];
}
function parseRecipeIngredientOptions(recipe, itemsById) {
    if (!recipe)
        return [];
    const r = recipe;
    const addOptions = (counts, options) => {
        if (options.length === 0)
            return;
        const key = [...options].sort().join('|');
        const existing = counts.get(key);
        if (existing)
            existing.count += 1;
        else
            counts.set(key, { options: [...options], count: 1 });
    };
    if (Array.isArray(r.inShape)) {
        const counts = new Map();
        for (const row of r.inShape) {
            if (!Array.isArray(row))
                continue;
            for (const cell of row) {
                const options = resolveItemNames(cell, itemsById);
                addOptions(counts, options);
            }
        }
        return Array.from(counts.values());
    }
    if (Array.isArray(r.ingredients)) {
        const counts = new Map();
        for (const ingredient of r.ingredients) {
            const options = resolveItemNames(ingredient, itemsById);
            addOptions(counts, options);
        }
        return Array.from(counts.values());
    }
    return [];
}
function formatOptionsLabel(options) {
    if (options.length === 0)
        return 'unresolved ingredient (no options found)';
    if (options.length === 1)
        return options[0];
    const shown = options.slice(0, 3).join(', ');
    const suffix = options.length > 3 ? ', …' : '';
    return `one of: ${shown}${suffix}`;
}
function evaluateRecipeMissing(recipe, inventory, itemsById) {
    const ingredients = parseRecipeIngredientOptions(recipe, itemsById);
    const missing = [];
    let missingTotal = 0;
    for (const { options, count } of ingredients) {
        const have = inventory
            .filter(i => options.includes(i.name))
            .reduce((sum, i) => sum + i.count, 0);
        if (have < count) {
            const deficit = count - have;
            missingTotal += deficit;
            missing.push({ name: formatOptionsLabel(options), count: deficit });
        }
    }
    return { canCraft: missingTotal === 0, missingTotal, missing };
}
function collectCandidateRecipes(recipes, query, itemsById) {
    const exact = [];
    const partial = [];
    for (const recipe of recipes) {
        const result = getRecipeResult(recipe, itemsById);
        if (!result)
            continue;
        const match = classifyNameMatch(result.name, query);
        if (!match.partial)
            continue;
        const candidate = {
            recipe,
            resultName: result.name,
            resultCount: result.count,
            exactMatch: match.exact
        };
        if (match.exact)
            exact.push(candidate);
        else
            partial.push(candidate);
    }
    return exact.length > 0 ? exact : partial;
}
function resolveItemName(value, itemsById) {
    if (!value)
        return null;
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number') {
        if (value === 0)
            return null;
        const item = itemsById[String(value)];
        return typeof item?.name === 'string' ? item.name : null;
    }
    if (typeof value === 'object') {
        const v = value;
        if (typeof v.name === 'string')
            return v.name;
        if (typeof v.id === 'number') {
            if (v.id === 0)
                return null;
            const item = itemsById[String(v.id)];
            return typeof item?.name === 'string' ? item.name : null;
        }
    }
    return null;
}
function parseRecipeIngredients(recipe, itemsById) {
    const ingredients = [];
    if (!recipe)
        return ingredients;
    const r = recipe;
    if (Array.isArray(r.inShape)) {
        const countMap = {};
        for (const row of r.inShape) {
            if (Array.isArray(row)) {
                for (const item of row) {
                    const options = resolveItemNames(item, itemsById);
                    if (options.length === 0)
                        continue;
                    const label = formatOptionsLabel(options);
                    countMap[label] = (countMap[label] || 0) + 1;
                }
            }
        }
        for (const [name, count] of Object.entries(countMap)) {
            ingredients.push({ name, count });
        }
        if (ingredients.length > 0)
            return ingredients;
    }
    if (Array.isArray(r.ingredients)) {
        const countMap = {};
        for (const ingredient of r.ingredients) {
            const options = resolveItemNames(ingredient, itemsById);
            if (options.length === 0)
                continue;
            const label = formatOptionsLabel(options);
            countMap[label] = (countMap[label] || 0) + 1;
        }
        for (const [name, count] of Object.entries(countMap)) {
            ingredients.push({ name, count });
        }
    }
    return ingredients;
}
function getRecipeResult(recipe, itemsById) {
    if (!recipe)
        return null;
    const r = recipe;
    const result = r.result;
    if (!result)
        return null;
    if (typeof result === 'string') {
        return { name: result, count: 1 };
    }
    if (typeof result === 'number') {
        const name = resolveItemName(result, itemsById);
        return name ? { name, count: 1 } : null;
    }
    if (result && typeof result === 'object') {
        const resultObj = result;
        const name = resolveItemName(resultObj, itemsById);
        const count = typeof resultObj.count === 'number' && Number.isFinite(resultObj.count) ? resultObj.count : 1;
        return name ? { name, count } : null;
    }
    return null;
}
function canCraftRecipe(recipe, inventory, itemsById) {
    return evaluateRecipeMissing(recipe, inventory, itemsById).canCraft;
}
function collectCandidateRecipesFromBot(bot, mcData, query, itemsById, craftingTable) {
    const data = mcData;
    const itemsByName = data.itemsByName;
    if (!itemsByName)
        return [];
    const q = normalizeItemName(query);
    const exact = [];
    const partial = [];
    const pushRecipesFor = (name, id, exactMatch) => {
        const recipesFor = bot.recipesFor;
        if (typeof recipesFor !== 'function')
            return;
        const recipes = recipesFor(id, null, 1, craftingTable);
        for (const recipe of recipes) {
            const result = getRecipeResult(recipe, itemsById);
            const resultName = result?.name ?? name;
            const resultCount = result?.count ?? 1;
            const candidate = { recipe, resultName, resultCount, exactMatch, craftingTable: craftingTable ?? undefined };
            if (exactMatch)
                exact.push(candidate);
            else
                partial.push(candidate);
        }
    };
    const exactEntry = itemsByName[q];
    if (exactEntry && typeof exactEntry.id === 'number') {
        pushRecipesFor(q, exactEntry.id, true);
        return exact;
    }
    for (const [name, meta] of Object.entries(itemsByName)) {
        const match = classifyNameMatch(name, q);
        if (!match.partial)
            continue;
        if (typeof meta?.id === 'number')
            pushRecipesFor(name, meta.id, false);
    }
    return partial;
}
function findNearbyCraftingTable(bot, mcData) {
    const data = mcData;
    const blocksByName = data.blocksByName;
    const craftingTableId = blocksByName?.crafting_table?.id;
    if (typeof craftingTableId !== 'number')
        return null;
    const findBlock = bot.findBlock;
    if (typeof findBlock !== 'function')
        return null;
    try {
        return findBlock({ matching: craftingTableId, maxDistance: 16, count: 1 });
    }
    catch {
        return null;
    }
}
function getAllRecipes(mcData) {
    const data = mcData;
    const recipes = data.recipes;
    if (Array.isArray(recipes)) {
        return recipes;
    }
    if (typeof recipes === 'object' && recipes !== null) {
        const recipeObj = recipes;
        const allRecipes = [];
        for (const recipeList of Object.values(recipeObj)) {
            if (Array.isArray(recipeList)) {
                allRecipes.push(...recipeList);
            }
        }
        return allRecipes;
    }
    return [];
}
export function registerCraftingTools(factory, getBot) {
    factory.registerTool("list-recipes", "List all available crafting recipes the bot can make with current inventory", {
        outputItem: z.string().trim().min(1).optional().describe("Optional: filter recipes by output item name")
    }, async ({ outputItem }) => {
        const bot = getBot();
        const mcData = minecraftData(bot.version);
        const itemsById = mcData.items;
        const recipes = getAllRecipes(mcData);
        const inventory = bot.inventory.items().map(item => ({ name: item.name, count: item.count }));
        if (!recipes || recipes.length === 0) {
            return factory.createResponse("No recipes available for this Minecraft version");
        }
        const availableRecipes = [];
        for (const recipe of recipes) {
            const result = getRecipeResult(recipe, itemsById);
            if (!result)
                continue;
            const match = outputItem ? classifyNameMatch(result.name, outputItem) : { exact: false, partial: true };
            if (outputItem && !match.partial)
                continue;
            if (canCraftRecipe(recipe, inventory, itemsById)) {
                const ingredients = parseRecipeIngredients(recipe, itemsById);
                availableRecipes.push({
                    name: result.name,
                    count: result.count,
                    ingredients,
                    exactMatch: outputItem ? match.exact : undefined
                });
            }
        }
        if (outputItem) {
            const hasExact = availableRecipes.some(r => r.exactMatch);
            if (hasExact) {
                for (let i = availableRecipes.length - 1; i >= 0; i--) {
                    if (!availableRecipes[i].exactMatch)
                        availableRecipes.splice(i, 1);
                }
            }
        }
        if (availableRecipes.length === 0) {
            return factory.createResponse(`No craftable recipes found${outputItem ? ` for ${outputItem}` : ''} with current inventory`);
        }
        let output = `Found ${availableRecipes.length} craftable recipe(s):\n\n`;
        availableRecipes.forEach((recipe, index) => {
            output += `${index + 1}. ${recipe.name} (x${recipe.count})\n`;
            output += `   Ingredients: ${recipe.ingredients.map(i => `${i.name} x${i.count}`).join(", ")}\n\n`;
        });
        return factory.createResponse(output);
    });
    factory.registerTool("craft-item", "Craft an item using a crafting recipe", {
        outputItem: z.string().trim().min(1).describe("Name of the item to craft"),
        amount: z.number().int().min(1).optional().describe("Number of times to craft (default: 1)")
    }, async ({ outputItem, amount = 1 }) => {
        const outputQuery = normalizeItemName(outputItem);
        const bot = getBot();
        const mcData = minecraftData(bot.version);
        const itemsById = mcData.items;
        const recipes = getAllRecipes(mcData);
        if (!recipes || recipes.length === 0) {
            return factory.createErrorResponse("No recipes available");
        }
        let craftedCount = 0;
        let lastError = "";
        const table = findNearbyCraftingTable(bot, mcData);
        const candidatesFromBotNoTable = collectCandidateRecipesFromBot(bot, mcData, outputQuery, itemsById, null);
        const candidatesFromBotWithTable = table ? collectCandidateRecipesFromBot(bot, mcData, outputQuery, itemsById, table) : [];
        const candidatesFromBot = candidatesFromBotNoTable.length > 0 ? candidatesFromBotNoTable : candidatesFromBotWithTable;
        const candidates = candidatesFromBot.length > 0 ? candidatesFromBot : collectCandidateRecipes(recipes, outputQuery, itemsById);
        for (let attempt = 0; attempt < amount; attempt++) {
            const currentInventory = bot.inventory.items().map(item => ({ name: item.name, count: item.count }));
            let craftedThisAttempt = false;
            let bestCannotCraft = null;
            for (const candidate of candidates) {
                const evaluation = evaluateRecipeMissing(candidate.recipe, currentInventory, itemsById);
                if (!evaluation.canCraft) {
                    let msg = `Cannot craft ${candidate.resultName}. Missing:\n`;
                    for (const { name, count } of evaluation.missing) {
                        msg += `- ${name} x${count}\n`;
                    }
                    if (!bestCannotCraft || evaluation.missingTotal < bestCannotCraft.missingTotal) {
                        bestCannotCraft = { missingTotal: evaluation.missingTotal, message: msg };
                    }
                    continue;
                }
                try {
                    if (candidate.craftingTable) {
                        await bot.craft(candidate.recipe, 1, candidate.craftingTable);
                    }
                    else {
                        await bot.craft(candidate.recipe, 1);
                    }
                    craftedCount++;
                    craftedThisAttempt = true;
                    log('info', `Crafted ${candidate.resultName}`);
                    break;
                }
                catch (err) {
                    lastError = err instanceof Error ? err.message : String(err);
                    log('warn', `Failed to craft ${outputItem}: ${lastError}`);
                }
            }
            if (!craftedThisAttempt && attempt === 0) {
                if (bestCannotCraft) {
                    return factory.createErrorResponse(bestCannotCraft.message);
                }
                return factory.createErrorResponse(`Failed to craft ${outputItem}: ${lastError || 'Recipe not found or missing ingredients'}`);
            }
            if (!craftedThisAttempt) {
                break;
            }
        }
        if (craftedCount === 0) {
            return factory.createErrorResponse(`Failed to craft ${outputItem}: ${lastError || "Missing ingredients or recipe not found"}`);
        }
        return factory.createResponse(`Successfully crafted ${outputItem} ${craftedCount} time(s)`);
    });
    factory.registerTool("get-recipe", "Get detailed information about a specific recipe", {
        itemName: z.string().trim().min(1).describe("Name of the item to get recipe for")
    }, async ({ itemName }) => {
        const bot = getBot();
        const mcData = minecraftData(bot.version);
        const itemsById = mcData.items;
        const recipes = getAllRecipes(mcData);
        const inventory = bot.inventory.items().map(item => ({ name: item.name, count: item.count }));
        if (!recipes || recipes.length === 0) {
            return factory.createErrorResponse("No recipes available");
        }
        const table = findNearbyCraftingTable(bot, mcData);
        const candidatesFromBotNoTable = collectCandidateRecipesFromBot(bot, mcData, itemName, itemsById, null);
        const candidatesFromBotWithTable = table ? collectCandidateRecipesFromBot(bot, mcData, itemName, itemsById, table) : [];
        const candidatesFromBot = candidatesFromBotNoTable.length > 0 ? candidatesFromBotNoTable : candidatesFromBotWithTable;
        const candidates = candidatesFromBot.length > 0 ? candidatesFromBot : collectCandidateRecipes(recipes, itemName, itemsById);
        const matchingRecipes = candidates
            .map((c) => {
            const ingredients = parseRecipeIngredients(c.recipe, itemsById);
            const evaluation = evaluateRecipeMissing(c.recipe, inventory, itemsById);
            return {
                result: c.resultName,
                resultCount: c.resultCount,
                ingredients,
                canCraft: evaluation.canCraft,
                missingTotal: evaluation.missingTotal
            };
        })
            .sort((a, b) => {
            if (a.canCraft !== b.canCraft)
                return a.canCraft ? -1 : 1;
            return a.missingTotal - b.missingTotal;
        });
        if (matchingRecipes.length === 0) {
            return factory.createResponse(`No recipes found for ${itemName}`);
        }
        let output = `Recipe(s) for ${itemName}:\n\n`;
        matchingRecipes.forEach((recipe, index) => {
            output += `${index + 1}. Output: ${recipe.result} (x${recipe.resultCount})`;
            output += recipe.canCraft ? ' [craftable]\n' : ` [missing: ${recipe.missingTotal}]\n`;
            output += `   Ingredients:\n`;
            for (const ingredient of recipe.ingredients) {
                output += `   - ${ingredient.name} x${ingredient.count}\n`;
            }
            output += '\n';
        });
        return factory.createResponse(output);
    });
    factory.registerTool("can-craft", "Check if the bot can craft a specific item with current inventory", {
        itemName: z.string().trim().min(1).describe("Name of the item to check")
    }, async ({ itemName }) => {
        const bot = getBot();
        const mcData = minecraftData(bot.version);
        const itemsById = mcData.items;
        const recipes = getAllRecipes(mcData);
        const inventory = bot.inventory.items().map(item => ({ name: item.name, count: item.count }));
        if (!recipes || recipes.length === 0) {
            return factory.createErrorResponse("No recipes available");
        }
        const table = findNearbyCraftingTable(bot, mcData);
        const candidatesFromBotNoTable = collectCandidateRecipesFromBot(bot, mcData, itemName, itemsById, null);
        const candidatesFromBotWithTable = table ? collectCandidateRecipesFromBot(bot, mcData, itemName, itemsById, table) : [];
        const candidatesFromBot = candidatesFromBotNoTable.length > 0 ? candidatesFromBotNoTable : candidatesFromBotWithTable;
        const candidates = candidatesFromBot.length > 0 ? candidatesFromBot : collectCandidateRecipes(recipes, itemName, itemsById);
        if (candidates.length === 0)
            return factory.createResponse(`No recipe found for ${itemName}`);
        let bestCannotCraft = null;
        for (const candidate of candidates) {
            const evaluation = evaluateRecipeMissing(candidate.recipe, inventory, itemsById);
            if (evaluation.canCraft) {
                return factory.createResponse(`Yes, can craft ${candidate.resultName}. Have all required ingredients.`);
            }
            let output = `Cannot craft ${candidate.resultName}. Missing:\n`;
            for (const { name, count } of evaluation.missing) {
                output += `- ${name} x${count}\n`;
            }
            if (!bestCannotCraft || evaluation.missingTotal < bestCannotCraft.missingTotal) {
                bestCannotCraft = { missingTotal: evaluation.missingTotal, message: output };
            }
        }
        return factory.createResponse(bestCannotCraft?.message ?? `No recipe found for ${itemName}`);
    });
}
