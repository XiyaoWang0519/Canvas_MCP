import { describe, expect, it, vi } from 'vitest';

vi.mock('../tools/index.js', () => ({
  registerCanvasTools: () => {}
}));

vi.mock('../mcp/prompts.js', () => ({
  registerCanvasPrompts: () => {}
}));

import { createRateLimiter, getExpiredSessionIds } from '../mcp/server.js';

describe('createRateLimiter', () => {
  it('blocks after exceeding the max within window', () => {
    const limiter = createRateLimiter({ windowMs: 1_000, max: 2 });
    const req = {
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis()
    } as any;
    const next = vi.fn();

    limiter(req, res, next);
    limiter(req, res, next);
    limiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('allows requests when disabled', () => {
    const limiter = createRateLimiter({ windowMs: 0, max: 0 });
    const req = {
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis()
    } as any;
    const next = vi.fn();

    limiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('prunes expired entries on the next request', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const store = new Map<string, { count: number; resetAt: number }>();
    const limiter = createRateLimiter(
      { windowMs: 1_000, max: 1 },
      {
        store,
        keyFn: (req) => req.ip ?? req.socket.remoteAddress ?? 'unknown'
      }
    );
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis()
    } as any;
    const next = vi.fn();

    limiter({ ip: '1.1.1.1', socket: { remoteAddress: '1.1.1.1' } } as any, res, next);
    limiter({ ip: '2.2.2.2', socket: { remoteAddress: '2.2.2.2' } } as any, res, next);
    expect(store.size).toBe(2);

    vi.setSystemTime(new Date('2025-01-01T00:00:02Z'));
    limiter({ ip: '3.3.3.3', socket: { remoteAddress: '3.3.3.3' } } as any, res, next);

    expect(store.size).toBe(1);
    vi.useRealTimers();
  });
});

describe('getExpiredSessionIds', () => {
  it('returns session ids exceeding TTL', () => {
    const now = Date.now();
    const sessions = new Map<string, any>();
    sessions.set('fresh', {
      lastSeen: now - 1_000,
      createdAt: now - 2_000,
      transport: {},
      server: {}
    });
    sessions.set('expired', {
      lastSeen: now - 10_000,
      createdAt: now - 10_000,
      transport: {},
      server: {}
    });

    const expired = getExpiredSessionIds(sessions, 5_000, now);
    expect(expired).toEqual(['expired']);
  });
});
