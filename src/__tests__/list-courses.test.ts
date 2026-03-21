import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

async function loadListCoursesHandler(canvas: { getAll: ReturnType<typeof vi.fn> }) {
  const tools = new Map<string, unknown>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: unknown) => {
      tools.set(name, handler);
    }
  };

  const { registerCanvasTools } = await import('../tools/index.js');
  registerCanvasTools(server as never, { canvas: canvas as never });

  const handler = tools.get('list_courses');
  if (!handler || typeof handler !== 'function') {
    throw new Error('list_courses not registered');
  }

  return handler as (args: {
    enrollment_state?: 'active' | 'completed';
    include_past?: boolean;
    limit?: number;
  }) => Promise<{
    structuredContent: {
      courses: Array<{ id: number; name: string; course_code: string; term: string }>;
    };
  }>;
}

beforeEach(() => {
  vi.resetModules();
  restoreEnv();
  process.env.CANVAS_BASE_URL = 'https://canvas.example.com';
  process.env.MCP_BEARER = 'test-bearer';
  process.env.CANVAS_PAT = 'test-pat';
  process.env.CANVAS_TIMEZONE = 'UTC';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-21T07:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  restoreEnv();
});

describe('list_courses', () => {
  it('filters placeholder ghost courses while keeping recent real courses', async () => {
    const canvas = {
      getAll: vi.fn(async (path: string) => {
        if (path === '/api/v1/users/self/courses') {
          return {
            data: [
              { id: 999, name: '', course_code: '', term: { name: '' } },
              {
                id: 1,
                name: 'ECE496Y1 Y LEC0101 20259:Design Project',
                course_code: 'ECE496Y1 Y LEC0101',
                term: { name: '2025 Fall-Winter' }
              },
              {
                id: 2,
                name: 'ECE437H1 S LEC0101',
                course_code: 'ECE437H1 S LEC0101',
                term: { name: '2024 Fall' }
              }
            ],
            status: 200,
            requestId: 'courses'
          };
        }

        throw new Error(`Unexpected path ${path}`);
      })
    };

    const handler = await loadListCoursesHandler(canvas);
    const result = await handler({});
    const withPast = await handler({ include_past: true });

    expect(result.structuredContent.courses.map((course) => course.id)).toEqual([1]);
    expect(withPast.structuredContent.courses.map((course) => course.id)).toEqual([1, 2]);
    expect(result.structuredContent.courses.some((course) => course.id === 999)).toBe(false);
    expect(withPast.structuredContent.courses.some((course) => course.id === 999)).toBe(false);
  });
});
