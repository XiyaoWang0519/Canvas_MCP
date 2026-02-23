import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../core/errors.js';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

async function loadListUpcomingHandler(canvas: { getAll: ReturnType<typeof vi.fn> }) {
  const tools = new Map<string, unknown>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: unknown) => {
      tools.set(name, handler);
    }
  };

  const { registerCanvasTools } = await import('../tools/index.js');
  registerCanvasTools(server as never, { canvas: canvas as never });

  const handler = tools.get('list_upcoming');
  if (!handler || typeof handler !== 'function') {
    throw new Error('list_upcoming not registered');
  }

  return handler as (args: {
    days?: number;
    max_courses?: number;
  }) => Promise<{ structuredContent: { upcoming: Array<{ id: number }> } }>;
}

beforeEach(() => {
  vi.resetModules();
  restoreEnv();
  process.env.CANVAS_BASE_URL = 'https://canvas.example.com';
  process.env.MCP_BEARER = 'test-bearer';
  process.env.CANVAS_PAT = 'test-pat';
  process.env.CANVAS_TIMEZONE = 'UTC';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  restoreEnv();
});

describe('list_upcoming', () => {
  it('orders upcoming items by due date and respects max_courses', async () => {
    const canvas = {
      getAll: vi.fn(async (path: string) => {
        if (path === '/api/v1/users/self/todo') {
          return {
            data: [
              {
                type: 'grading',
                assignment: {
                  id: 10,
                  course_id: 1,
                  name: 'Todo',
                  due_at: '2025-01-03T00:00:00Z',
                  points_possible: 5,
                  html_url: 'https://canvas.example.com/courses/1/assignments/10'
                }
              }
            ],
            status: 200,
            requestId: 'todo'
          };
        }

        if (path === '/api/v1/users/self/courses') {
          return {
            data: [
              { id: 1, name: 'Course 1' },
              { id: 2, name: 'Course 2' }
            ],
            status: 200,
            requestId: 'courses'
          };
        }

        if (path === '/api/v1/courses/1/assignments') {
          return {
            data: [
              {
                id: 20,
                course_id: 1,
                name: 'Assignment A',
                due_at: '2025-01-02T00:00:00Z',
                points_possible: 10,
                html_url: 'https://canvas.example.com/courses/1/assignments/20'
              }
            ],
            status: 200,
            requestId: 'a1'
          };
        }

        if (path === '/api/v1/courses/2/assignments') {
          return {
            data: [
              {
                id: 30,
                course_id: 2,
                name: 'Assignment B',
                due_at: '2025-01-05T00:00:00Z',
                points_possible: 10,
                html_url: 'https://canvas.example.com/courses/2/assignments/30'
              }
            ],
            status: 200,
            requestId: 'a2'
          };
        }

        throw new Error(`Unexpected path ${path}`);
      })
    };

    const handler = await loadListUpcomingHandler(canvas);
    const result = await handler({ days: 7, max_courses: 1 });

    expect(result.structuredContent.upcoming.map((item) => item.id)).toEqual([20, 10]);
    expect(canvas.getAll.mock.calls.some(([path]) => path === '/api/v1/courses/2/assignments'))
      .toBe(false);
  });

  it('skips courses that fail assignment fetches', async () => {
    const canvas = {
      getAll: vi.fn(async (path: string) => {
        if (path === '/api/v1/users/self/todo') {
          return {
            data: [
              {
                type: 'grading',
                assignment: {
                  id: 10,
                  course_id: 1,
                  name: 'Todo',
                  due_at: '2025-01-03T00:00:00Z',
                  points_possible: 5,
                  html_url: 'https://canvas.example.com/courses/1/assignments/10'
                }
              }
            ],
            status: 200,
            requestId: 'todo'
          };
        }

        if (path === '/api/v1/users/self/courses') {
          return {
            data: [
              { id: 1, name: 'Course 1' },
              { id: 2, name: 'Course 2' }
            ],
            status: 200,
            requestId: 'courses'
          };
        }

        if (path === '/api/v1/courses/1/assignments') {
          return {
            data: [
              {
                id: 20,
                course_id: 1,
                name: 'Assignment A',
                due_at: '2025-01-02T00:00:00Z',
                points_possible: 10,
                html_url: 'https://canvas.example.com/courses/1/assignments/20'
              }
            ],
            status: 200,
            requestId: 'a1'
          };
        }

        if (path === '/api/v1/courses/2/assignments') {
          throw new AppError('CANVAS_UNAVAILABLE', 'Canvas down', 503, {
            canvasStatus: 503
          });
        }

        throw new Error(`Unexpected path ${path}`);
      })
    };

    const handler = await loadListUpcomingHandler(canvas);
    const result = await handler({ days: 7 });

    expect(result.structuredContent.upcoming.map((item) => item.id)).toEqual([20, 10]);
    expect(canvas.getAll.mock.calls.some(([path]) => path === '/api/v1/courses/2/assignments'))
      .toBe(true);
  });

  it('throws when all assignment fetches fail with non-auth errors', async () => {
    const canvas = {
      getAll: vi.fn(async (path: string) => {
        if (path === '/api/v1/users/self/todo') {
          return {
            data: [],
            status: 200,
            requestId: 'todo'
          };
        }

        if (path === '/api/v1/users/self/courses') {
          return {
            data: [
              { id: 1, name: 'Course 1' },
              { id: 2, name: 'Course 2' }
            ],
            status: 200,
            requestId: 'courses'
          };
        }

        if (path === '/api/v1/courses/1/assignments') {
          throw new AppError('CANVAS_UNAVAILABLE', 'Canvas down', 503, {
            canvasStatus: 503
          });
        }

        if (path === '/api/v1/courses/2/assignments') {
          throw new AppError('CANVAS_UNAVAILABLE', 'Canvas down', 503, {
            canvasStatus: 503
          });
        }

        throw new Error(`Unexpected path ${path}`);
      })
    };

    const handler = await loadListUpcomingHandler(canvas);

    await expect(handler({ days: 7 })).rejects.toThrow(
      'Failed to fetch upcoming assignments for all courses.'
    );
  });
});
