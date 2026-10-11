function logEvent(level, event, details = {}) {
  const fields = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  console.error(`[${new Date().toISOString()}] ${level} ${event}${fields.length ? ` ${fields.join(' ')}` : ''}`);
}

function formatValue(value) {
  if (typeof value === 'string') return JSON.stringify(value.replace(/[\r\n]+/g, ' '));
  if (value === null || typeof value !== 'object') return String(value);
  return JSON.stringify(value);
}

function errorDetails(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = { errorDetails, logEvent };
