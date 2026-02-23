import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { CanvasClient } from '../canvas/client.js';
import { log } from '../core/logger.js';
import { registerCanvasTools } from '../tools/index.js';
import { APP_NAME, APP_VERSION } from '../core/meta.js';
import { registerCanvasPrompts } from './prompts.js';

export interface HttpServerConfig {
  canvasClient: CanvasClient;
  bearerToken: string;
  port: number;
  enableStdio?: boolean;
  rateLimit?: {
    mcp: RateLimitConfig;
    messages: RateLimitConfig;
  };
  session?: {
    ttlMs: number;
    cleanupIntervalMs: number;
    maxSessions?: number;
    sseHeartbeatMs: number;
  };
}

interface SessionTransport {
  transport: SSEServerTransport;
  server: McpServer;
  createdAt: number;
  lastSeen: number;
  heartbeatTimer?: NodeJS.Timeout;
}

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export async function startServer(config: HttpServerConfig): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const sessions = new Map<string, SessionTransport>();
  const rateLimitConfig = config.rateLimit ?? {
    mcp: { windowMs: 60_000, max: 30 },
    messages: { windowMs: 60_000, max: 120 }
  };
  const sessionConfig = config.session ?? {
    ttlMs: 15 * 60_000,
    cleanupIntervalMs: 60_000,
    sseHeartbeatMs: 25_000
  };
  const mcpRateLimiter = createRateLimiter(rateLimitConfig.mcp, { name: 'mcp' });
  const messagesRateLimiter = createRateLimiter(rateLimitConfig.messages, { name: 'messages' });
  const cleanupTimer = startSessionCleanup(sessions, sessionConfig);

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: APP_NAME, version: APP_VERSION });
  });

  app.get('/mcp', mcpRateLimiter, async (req, res) => {
    if (!authorize(req, res, config.bearerToken)) {
      return;
    }

    if (
      typeof sessionConfig.maxSessions === 'number' &&
      sessionConfig.maxSessions > 0 &&
      sessions.size >= sessionConfig.maxSessions
    ) {
      res.status(429).json({ error: 'Too many active sessions' });
      return;
    }

    try {
      const transport = new SSEServerTransport('/messages', res);
      const server = createMcpServer(config.canvasClient);
      const now = Date.now();
      const session: SessionTransport = {
        transport,
        server,
        createdAt: now,
        lastSeen: now,
        heartbeatTimer: startHeartbeat(res, sessionConfig.sseHeartbeatMs)
      };

      sessions.set(transport.sessionId, session);

      transport.onclose = () => {
        if (!sessions.has(transport.sessionId)) {
          return;
        }
        clearHeartbeat(session);
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

  app.post('/messages', messagesRateLimiter, async (req, res) => {
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
      session.lastSeen = Date.now();
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
    stopSessionCleanup(cleanupTimer);

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
  registerCanvasPrompts(server);

  const previousOnInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    previousOnInitialized?.();
    server.sendToolListChanged();
    server.sendPromptListChanged();
  };
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

function startHeartbeat(res: Response, heartbeatMs: number): NodeJS.Timeout | undefined {
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
    return undefined;
  }

  const timer = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(timer);
      return;
    }
    res.write(`: keepalive ${Date.now()}\n\n`);
  }, heartbeatMs);
  timer.unref?.();
  return timer;
}

function clearHeartbeat(session: SessionTransport): void {
  if (session.heartbeatTimer) {
    clearInterval(session.heartbeatTimer);
  }
}

export function createRateLimiter(
  config: RateLimitConfig,
  options?: {
    keyFn?: (req: Request) => string;
    name?: string;
    store?: Map<string, { count: number; resetAt: number }>;
  }
): (req: Request, res: Response, next: () => void) => void {
  const store = options?.store ?? new Map<string, { count: number; resetAt: number }>();
  const keyFn =
    options?.keyFn ??
    ((req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown');
  let nextPruneAt = Date.now() + config.windowMs;

  return (req: Request, res: Response, next: () => void) => {
    if (!Number.isFinite(config.windowMs) || config.windowMs <= 0 || config.max <= 0) {
      next();
      return;
    }

    const key = keyFn(req);
    const now = Date.now();
    if (now >= nextPruneAt) {
      for (const [entryKey, entry] of store.entries()) {
        if (now >= entry.resetAt) {
          store.delete(entryKey);
        }
      }
      nextPruneAt = now + config.windowMs;
    }
    const existing = store.get(key);
    if (!existing || now >= existing.resetAt) {
      store.set(key, { count: 1, resetAt: now + config.windowMs });
      next();
      return;
    }

    existing.count += 1;
    if (existing.count > config.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.set('Retry-After', retryAfterSeconds.toString());
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }

    next();
  };
}

export function getExpiredSessionIds(
  sessions: Map<string, SessionTransport>,
  ttlMs: number,
  now: number
): string[] {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return [];
  }
  const expired: string[] = [];
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastSeen >= ttlMs) {
      expired.push(sessionId);
    }
  }
  return expired;
}

function startSessionCleanup(
  sessions: Map<string, SessionTransport>,
  sessionConfig: NonNullable<HttpServerConfig['session']>
): NodeJS.Timeout | undefined {
  if (
    !Number.isFinite(sessionConfig.cleanupIntervalMs) ||
    sessionConfig.cleanupIntervalMs <= 0 ||
    !Number.isFinite(sessionConfig.ttlMs) ||
    sessionConfig.ttlMs <= 0
  ) {
    return undefined;
  }

  const timer = setInterval(() => {
    const now = Date.now();
    const expiredSessionIds = getExpiredSessionIds(sessions, sessionConfig.ttlMs, now);
    if (expiredSessionIds.length === 0) {
      return;
    }

    for (const sessionId of expiredSessionIds) {
      const session = sessions.get(sessionId);
      if (!session) {
        continue;
      }
      clearHeartbeat(session);
      sessions.delete(sessionId);
      void session.transport.close().catch((error) => {
        log('error', 'Failed to close expired SSE transport', {
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      log('info', 'Expired SSE session cleaned up', { session_id: sessionId });
    }
  }, sessionConfig.cleanupIntervalMs);

  timer.unref?.();
  return timer;
}

function stopSessionCleanup(timer: NodeJS.Timeout | undefined): void {
  if (timer) {
    clearInterval(timer);
  }
}
