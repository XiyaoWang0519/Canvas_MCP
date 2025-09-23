import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { CanvasClient } from '../canvas/client.js';
import { log } from '../core/logger.js';
import { registerCanvasTools } from '../tools/index.js';
import { APP_NAME, APP_VERSION } from '../core/meta.js';

export interface HttpServerConfig {
  canvasClient: CanvasClient;
  bearerToken: string;
  port: number;
  enableStdio?: boolean;
}

interface SessionTransport {
  transport: SSEServerTransport;
  server: McpServer;
}

export async function startServer(config: HttpServerConfig): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const sessions = new Map<string, SessionTransport>();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: APP_NAME, version: APP_VERSION });
  });

  app.get('/mcp', async (req, res) => {
    if (!authorize(req, res, config.bearerToken)) {
      return;
    }

    try {
      const transport = new SSEServerTransport('/messages', res);
      const server = createMcpServer(config.canvasClient);

      sessions.set(transport.sessionId, { transport, server });

      transport.onclose = () => {
        sessions.delete(transport.sessionId);
        log('info', 'SSE transport closed', { session_id: transport.sessionId });
      };

      await server.connect(transport);
      log('info', 'SSE transport established', { session_id: transport.sessionId });
    } catch (error) {
      log('error', 'Failed to establish SSE transport', {
        error: error instanceof Error ? error.message : String(error)
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to establish SSE transport' });
      }
    }
  });

  app.post('/messages', async (req, res) => {
    if (!authorize(req, res, config.bearerToken)) {
      return;
    }

    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId parameter' });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    try {
      await session.transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      log('error', 'Error handling /messages request', {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to handle request' });
      }
    }
  });

  const serverInstance = app.listen(config.port, () => {
    log('info', 'HTTP server listening', { port: config.port });
  });

  const shutdown = async () => {
    log('info', 'Shutting down server', { active_sessions: sessions.size });
    serverInstance.close();

    for (const [sessionId, { transport }] of sessions.entries()) {
      try {
        await transport.close();
        log('info', 'Closed SSE transport', { session_id: sessionId });
      } catch (error) {
        log('error', 'Failed to close SSE transport', {
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (config.enableStdio) {
    await startStdio(config.canvasClient);
  }
}

function createMcpServer(canvasClient: CanvasClient): McpServer {
  const server = new McpServer({
    name: APP_NAME,
    version: APP_VERSION
  });

  registerCanvasTools(server, { canvas: canvasClient });
  return server;
}

async function startStdio(canvasClient: CanvasClient): Promise<void> {
  const server = createMcpServer(canvasClient);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', 'STDIO transport ready', {});
}

function authorize(req: Request, res: Response, token: string): boolean {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return false;
  }

  const provided = header.slice('Bearer '.length).trim();
  if (provided !== token) {
    res.status(403).json({ error: 'Invalid bearer token' });
    return false;
  }

  return true;
}
