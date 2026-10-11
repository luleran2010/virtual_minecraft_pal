export function log(level, message) {
    const timestamp = new Date().toISOString();
    process.stderr.write(`${timestamp} [minecraft] [mcp-server] [${level}] ${message}\n`);
}
