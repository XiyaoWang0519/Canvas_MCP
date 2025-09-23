import { loadEnv } from './core/env.js';
import { log } from './core/logger.js';
import { CanvasClient } from './canvas/client.js';
import { startServer } from './mcp/server.js';

async function main(): Promise<void> {
  const env = loadEnv();

  const client = new CanvasClient({
    baseUrl: env.canvasBaseUrl,
    pat: env.CANVAS_PAT,
    clientId: env.CANVAS_CLIENT_ID,
    clientSecret: env.CANVAS_CLIENT_SECRET,
    accessToken: env.CANVAS_ACCESS_TOKEN,
    refreshToken: env.CANVAS_REFRESH_TOKEN
  });

  const port = parsePort(process.env.PORT) ?? 3333;
  const enableStdio = process.argv.includes('--stdio') || process.env.MCP_STDIO === '1';

  log('info', 'Starting Canvas MCP server', { port, enable_stdio: enableStdio });

  await startServer({
    canvasClient: client,
    bearerToken: env.MCP_BEARER,
    port,
    enableStdio
  });
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

main().catch((error) => {
  log('error', 'Fatal error starting server', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
