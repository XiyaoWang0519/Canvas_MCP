import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

beforeEach(() => {
  vi.resetModules();
  restoreEnv();
  process.env.CANVAS_BASE_URL = 'https://canvas.example.com';
  process.env.MCP_BEARER = 'test-bearer';
  process.env.CANVAS_PAT = 'test-pat';
  delete process.env.CANVAS_TIMEZONE;
});

afterEach(() => {
  vi.resetModules();
  restoreEnv();
});

describe('loadEnv', () => {
  it('defaults CANVAS_TIMEZONE to UTC when unset', async () => {
    const envModule = await import('../core/env.js');
    envModule.resetEnvCacheForTesting();
    const env = envModule.loadEnv();
    expect(env.canvasTimezone).toBe('UTC');
  });

  it('throws for invalid CANVAS_TIMEZONE', async () => {
    process.env.CANVAS_TIMEZONE = 'Invalid/Zone';
    const envModule = await import('../core/env.js');
    envModule.resetEnvCacheForTesting();
    expect(() => envModule.loadEnv()).toThrowError(
      /CANVAS_TIMEZONE must be a valid IANA time zone name\./
    );
  });
});

describe('toCanvasTimezone', () => {
  it('converts ISO timestamps into the configured time zone', async () => {
    process.env.CANVAS_TIMEZONE = 'America/Toronto';
    const envModule = await import('../core/env.js');
    envModule.resetEnvCacheForTesting();
    const timezoneModule = await import('../core/timezone.js');
    const result = timezoneModule.toCanvasTimezone('2024-07-01T15:00:00Z');
    expect(result).toBe('2024-07-01T11:00:00-04:00');
  });

  it('preserves nullish or invalid inputs', async () => {
    const envModule = await import('../core/env.js');
    envModule.resetEnvCacheForTesting();
    const timezoneModule = await import('../core/timezone.js');
    expect(timezoneModule.toCanvasTimezone(null)).toBeNull();
    expect(timezoneModule.toCanvasTimezone(undefined)).toBeUndefined();
    expect(timezoneModule.toCanvasTimezone('not-a-date')).toBe('not-a-date');
  });
});

describe('mappers', () => {
  it('localizes assignment and file timestamps', async () => {
    process.env.CANVAS_TIMEZONE = 'America/Los_Angeles';
    const envModule = await import('../core/env.js');
    envModule.resetEnvCacheForTesting();
    const mappers = await import('../tools/mappers.js');

    const assignment = mappers.mapAssignment({
      id: 1,
      course_id: 2,
      name: 'Test',
      due_at: '2024-12-01T08:00:00Z',
      points_possible: 10,
      html_url: 'https://canvas.example.com/courses/2/assignments/1'
    });

    expect(assignment.due_at).toBe('2024-12-01T00:00:00-08:00');

    const file = mappers.mapFile({
      id: 3,
      uuid: 'uuid',
      folder_id: 4,
      display_name: 'File',
      filename: 'file.txt',
      'content-type': 'text/plain',
      url: 'https://canvas.example.com/files/3',
      size: 100,
      created_at: '2024-07-01T00:00:00Z',
      updated_at: '2024-07-01T01:00:00Z',
      locked: false,
      hidden: false,
      locked_for_user: false,
      thumbnail_url: null,
      mime_class: 'text'
    });

    expect(file.created_at).toBe('2024-06-30T17:00:00-07:00');
    expect(file.updated_at).toBe('2024-06-30T18:00:00-07:00');
  });
});
