import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Response } from 'undici';

import { AppError } from '../core/errors.js';
import {
  dedupeResolvedLinks,
  extractExternalDownloadLinksFromHtml,
  fetchExternalResource,
  validateOutboundHttpUrl
} from '../tools/external-downloads.js';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

async function loadResolveExternalDownloadsHandler(deps: {
  canvas: {
    getAll: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  fetchImpl?: (url: string) => Promise<Response>;
}) {
  const tools = new Map<string, unknown>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: unknown) => {
      tools.set(name, handler);
    }
  };

  const { registerCanvasTools } = await import('../tools/index.js');
  registerCanvasTools(server as never, {
    canvas: deps.canvas as never,
    fetchImpl: deps.fetchImpl as never
  });

  const handler = tools.get('resolve_external_downloads');
  if (!handler || typeof handler !== 'function') {
    throw new Error('resolve_external_downloads not registered');
  }

  return handler as (args: {
    course_id: number;
    material_keys?: string[];
    max_pages?: number;
    max_links_per_page?: number;
    timeout_ms?: number;
  }) => Promise<{
    structuredContent: {
      course_id: number;
      processed_materials: number;
      results: Array<{
        key: string;
        status: 'ok' | 'partial' | 'blocked' | 'needs_browser_fallback' | 'error';
        links: Array<{ url: string; confidence: 'high' | 'medium' | 'low' }>;
      }>;
      total_links: number;
      truncated: boolean;
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
});

afterEach(() => {
  vi.resetModules();
  restoreEnv();
});

describe('external download helpers', () => {
  it('normalizes relative links and deduplicates repeated candidates', () => {
    const html = `
      <div>
        <a href="/courses/1/files/90/download?download=1" data-api-endpoint="/api/v1/courses/1/files/90" data-api-returntype="File">Handout</a>
        <a href="/courses/1/files/90/download?download=1" data-api-endpoint="/api/v1/courses/1/files/90" data-api-returntype="File">Duplicate</a>
      </div>
    `;

    const extracted = extractExternalDownloadLinksFromHtml(html, {
      baseUrl: 'https://canvas.example.com/courses/1/modules',
      maxLinks: 50
    });

    expect(extracted.truncated).toBe(false);
    expect(extracted.links).toEqual([
      {
        url: 'https://canvas.example.com/courses/1/files/90/download?download=1',
        text: 'Handout',
        ext: undefined,
        api_endpoint: 'https://canvas.example.com/api/v1/courses/1/files/90',
        api_returntype: 'File',
        confidence: 'high'
      }
    ]);
  });

  it('deduplicates globally when combining multiple material results', () => {
    const global = new Set<string>();

    const first = dedupeResolvedLinks(
      [{ url: 'https://cdn.example.com/file.pdf', confidence: 'high' }],
      global
    );
    const second = dedupeResolvedLinks(
      [{ url: 'https://cdn.example.com/file.pdf', confidence: 'high' }],
      global
    );

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('blocks localhost, private, and metadata endpoints from outbound fetches', () => {
    expect(validateOutboundHttpUrl('http://localhost:3000/file', 'http://localhost:3000').allowed).toBe(
      false
    );
    expect(validateOutboundHttpUrl('http://10.0.0.20/report', 'http://10.0.0.20').allowed).toBe(
      false
    );
    expect(
      validateOutboundHttpUrl('http://169.254.169.254/latest/meta-data', 'http://169.254.169.254')
        .allowed
    ).toBe(false);
  });

  it('cancels body and blocks when redirected to unsafe hosts', async () => {
    const cancel = vi.fn(async () => undefined);
    const redirected = {
      status: 200,
      ok: true,
      url: 'http://169.254.169.254/latest/meta-data',
      headers: new Headers({ 'content-type': 'text/html' }),
      body: { cancel },
      text: vi.fn(async () => 'metadata')
    } as unknown as Response;

    const result = await fetchExternalResource(
      'https://example.com/start',
      { timeoutMs: 2_000, maxRetries: 0 },
      vi.fn(async () => redirected)
    );

    expect(result.blockedReason).toContain('Blocked outbound URL target');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('resolve_external_downloads tool', () => {
  it('returns ok links for ExternalUrl and browser fallback for JS-only ExternalTool pages', async () => {
    const canvas = {
      getAll: vi.fn(async (path: string) => {
        if (path === '/api/v1/courses/1/modules') {
          return {
            data: [{ id: 11, name: 'Week 1' }],
            status: 200,
            requestId: 'modules'
          };
        }

        if (path === '/api/v1/courses/1/modules/11/items') {
          return {
            data: [
              {
                id: 101,
                type: 'ExternalUrl',
                title: 'Publisher handout',
                external_url: 'https://example.com/handout'
              },
              {
                id: 102,
                type: 'ExternalTool',
                title: 'LTI launch',
                external_url: 'https://tool.example.com/start',
                content_id: 99
              }
            ],
            status: 200,
            requestId: 'module-items'
          };
        }

        throw new Error(`Unexpected getAll path: ${path}`);
      }),
      get: vi.fn(async (path: string, params?: Record<string, unknown>) => {
        if (
          path === '/api/v1/courses/1/external_tools/sessionless_launch' &&
          params?.id === 99
        ) {
          return {
            data: {
              url: 'https://tool.example.com/launch'
            },
            status: 200,
            requestId: 'launch-id-99'
          };
        }

        throw new Error(`Unexpected get path: ${path}`);
      })
    };

    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://example.com/handout') {
        return new Response('<a href="/downloads/guide.pdf">Guide</a>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        });
      }

      if (url === 'https://tool.example.com/launch') {
        return new Response('<div>Please enable JavaScript to continue</div>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        });
      }

      return new Response('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain' }
      });
    });

    const handler = await loadResolveExternalDownloadsHandler({ canvas, fetchImpl });
    const result = await handler({ course_id: 1 });

    expect(result.structuredContent.processed_materials).toBe(2);
    expect(result.structuredContent.total_links).toBe(1);

    const byKey = new Map(result.structuredContent.results.map((entry) => [entry.key, entry]));

    expect(byKey.get('ExternalUrl:https://example.com/handout')).toMatchObject({
      status: 'ok',
      links: [
        {
          url: 'https://example.com/downloads/guide.pdf',
          confidence: 'high'
        }
      ]
    });

    expect(byKey.get('ExternalTool:https://tool.example.com/start')).toMatchObject({
      status: 'needs_browser_fallback'
    });
  });

  it('resolves relative sessionless launch URLs against Canvas base origin', async () => {
    const canvas = {
      getAll: vi.fn(async (path: string) => {
        if (path === '/api/v1/courses/1/modules') {
          return {
            data: [{ id: 11, name: 'Week 1' }],
            status: 200,
            requestId: 'modules'
          };
        }

        if (path === '/api/v1/courses/1/modules/11/items') {
          return {
            data: [
              {
                id: 102,
                type: 'ExternalTool',
                title: 'Relative launch tool',
                external_url: 'https://tool.example.com/start',
                content_id: 99
              }
            ],
            status: 200,
            requestId: 'module-items'
          };
        }

        throw new Error(`Unexpected getAll path: ${path}`);
      }),
      get: vi.fn(async (path: string, params?: Record<string, unknown>) => {
        if (
          path === '/api/v1/courses/1/external_tools/sessionless_launch' &&
          params?.id === 99
        ) {
          return {
            data: {
              url: '/external_tools/retrieve?display=borderless'
            },
            status: 200,
            requestId: 'launch-id-99'
          };
        }

        throw new Error(`Unexpected get path: ${path}`);
      })
    };

    const fetchImpl = vi.fn(async () =>
      new Response('<div>Please enable JavaScript to continue</div>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })
    );

    const handler = await loadResolveExternalDownloadsHandler({ canvas, fetchImpl });
    const result = await handler({ course_id: 1 });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://canvas.example.com/external_tools/retrieve?display=borderless',
      expect.anything()
    );
    expect(result.structuredContent.results[0]).toEqual(
      expect.objectContaining({
        status: 'needs_browser_fallback'
      })
    );
  });

  it('classifies forbidden ExternalUrl fetches as blocked', async () => {
    const canvas = {
      getAll: vi.fn(async (path: string) => {
        if (path === '/api/v1/courses/1/modules') {
          return {
            data: [{ id: 11, name: 'Week 1' }],
            status: 200,
            requestId: 'modules'
          };
        }

        if (path === '/api/v1/courses/1/modules/11/items') {
          return {
            data: [
              {
                id: 101,
                type: 'ExternalUrl',
                title: 'Blocked link',
                external_url: 'https://blocked.example.com/private'
              }
            ],
            status: 200,
            requestId: 'module-items'
          };
        }

        throw new Error(`Unexpected getAll path: ${path}`);
      }),
      get: vi.fn()
    };

    const fetchImpl = vi.fn(async () =>
      new Response('forbidden', {
        status: 403,
        headers: { 'content-type': 'text/html' }
      })
    );

    const handler = await loadResolveExternalDownloadsHandler({ canvas, fetchImpl });
    const result = await handler({ course_id: 1 });

    expect(result.structuredContent.results).toEqual([
      expect.objectContaining({
        key: 'ExternalUrl:https://blocked.example.com/private',
        status: 'blocked'
      })
    ]);
  });

  it('blocks disallowed local ExternalUrl targets before fetching', async () => {
    const canvas = {
      getAll: vi.fn(async (path: string) => {
        if (path === '/api/v1/courses/1/modules') {
          return {
            data: [{ id: 11, name: 'Week 1' }],
            status: 200,
            requestId: 'modules'
          };
        }

        if (path === '/api/v1/courses/1/modules/11/items') {
          return {
            data: [
              {
                id: 101,
                type: 'ExternalUrl',
                title: 'Local-only link',
                external_url: 'http://127.0.0.1/private.pdf'
              }
            ],
            status: 200,
            requestId: 'module-items'
          };
        }

        throw new Error(`Unexpected getAll path: ${path}`);
      }),
      get: vi.fn()
    };

    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch should not be called for blocked local URLs');
    });

    const handler = await loadResolveExternalDownloadsHandler({ canvas, fetchImpl });
    const result = await handler({ course_id: 1 });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.structuredContent.results[0]).toEqual(
      expect.objectContaining({
        key: 'ExternalUrl:http://127.0.0.1/private.pdf',
        status: 'blocked',
        reason: expect.stringContaining('Blocked outbound URL target')
      })
    );
  });

  it('classifies ExternalTool authorization failures as needs_browser_fallback', async () => {
    const canvas = {
      getAll: vi.fn(async (path: string) => {
        if (path === '/api/v1/courses/1/modules') {
          return {
            data: [{ id: 11, name: 'Week 1' }],
            status: 200,
            requestId: 'modules'
          };
        }

        if (path === '/api/v1/courses/1/modules/11/items') {
          return {
            data: [
              {
                id: 102,
                type: 'ExternalTool',
                title: 'Locked tool',
                external_url: 'https://tool.example.com/start',
                content_id: 9
              }
            ],
            status: 200,
            requestId: 'module-items'
          };
        }

        throw new Error(`Unexpected getAll path: ${path}`);
      }),
      get: vi.fn(async () => {
        throw new AppError(
          'AUTHORIZATION_FAILED',
          'Authorization failed: check Canvas token/scopes.',
          403,
          { canvasStatus: 403, requestId: 'launch-denied' }
        );
      })
    };

    const handler = await loadResolveExternalDownloadsHandler({
      canvas,
      fetchImpl: vi.fn(async () => {
        throw new Error('fetch should not be called when launch resolution fails');
      })
    });

    const result = await handler({ course_id: 1 });

    expect(result.structuredContent.results).toEqual([
      expect.objectContaining({
        key: 'ExternalTool:https://tool.example.com/start',
        status: 'needs_browser_fallback'
      })
    ]);
  });
});
