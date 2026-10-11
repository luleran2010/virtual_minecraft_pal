import { z, ZodError, ZodType } from "zod";
export class ToolFactory {
    server;
    connection;
    constructor(server, connection) {
        this.server = server;
        this.connection = connection;
    }
    registerTool(name, description, schema, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor) {
        this.server.tool(name, description, schema, async (args) => {
            const connectionCheck = await this.connection.checkConnectionAndReconnect();
            if (!connectionCheck.connected) {
                return {
                    content: [{ type: "text", text: connectionCheck.message }],
                    isError: true
                };
            }
            try {
                const parsedArgs = this.shouldValidateSchema(schema)
                    ? this.parseArgs(schema, args)
                    : args;
                return await executor(parsedArgs);
            }
            catch (error) {
                return this.createErrorResponse(error);
            }
        });
    }
    createResponse(text) {
        return {
            content: [{ type: "text", text }]
        };
    }
    createErrorResponse(error) {
        const errorMessage = error instanceof Error ? error.message : error;
        return {
            content: [{ type: "text", text: `Failed: ${errorMessage}` }],
            isError: true
        };
    }
    shouldValidateSchema(schema) {
        const values = Object.values(schema);
        if (values.length === 0) {
            return true;
        }
        return values.every((value) => value instanceof ZodType);
    }
    parseArgs(schema, args) {
        try {
            return z.object(schema).passthrough().parse(args ?? {});
        }
        catch (error) {
            if (error instanceof ZodError) {
                throw new Error(this.formatZodError(error));
            }
            throw error;
        }
    }
    formatZodError(error) {
        const details = error.issues
            .map((issue) => {
            const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
            return `${path}${issue.message}`;
        })
            .join('; ');
        return `Invalid tool arguments: ${details}`;
    }
}
