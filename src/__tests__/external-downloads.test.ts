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

  it('blocks localhost, private, metadata, and unspecified addresses from outbound fetches', () => {
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
    expect(validateOutboundHttpUrl('http://0.12.34.56/resource', 'http://0.12.34.56').allowed).toBe(
      false
    );
    expect(validateOutboundHttpUrl('http://[::]/resource', 'http://[::]').allowed).toBe(false);
  });

  it('cancels body and blocks redirect hops to unsafe hosts before following', async () => {
    const cancel = vi.fn(async () => undefined);
    const redirectResponse = {
      status: 302,
      ok: false,
      url: 'https://example.com/start',
      headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data' }),
      body: { cancel },
      text: vi.fn(async () => '')
    } as unknown as Response;

    const fetchImpl = vi.fn(async () => redirectResponse);
    const dnsLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);

    const result = await fetchExternalResource(
      'https://example.com/start',
      { timeoutMs: 2_000, maxRetries: 0, dnsLookup },
      fetchImpl
    );

    expect(result.blockedReason).toContain('Blocked outbound URL target');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects hostnames that resolve to disallowed addresses', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch should not run when DNS resolves to blocked IPs');
    });

    const dnsLookup = vi.fn(async () => [
      { address: '203.0.113.10', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ]);

    const result = await fetchExternalResource(
      'https://evil.example/path',
      { timeoutMs: 2_000, maxRetries: 0, dnsLookup },
      fetchImpl
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.blockedReason).toContain('hostname resolved to disallowed address 127.0.0.1');
  });

  it('maps OOXML content types to the correct extension', async () => {
    const dnsLookup = vi.fn(async () => [{ address: '203.0.113.10', family: 4 }]);

    const cases = [
      {
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        expected: 'pptx'
      },
      {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        expected: 'xlsx'
      },
      {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        expected: 'docx'
      }
    ] as const;

    for (const testCase of cases) {
      const result = await fetchExternalResource(
        'https://downloads.example/download',
        { timeoutMs: 2_000, maxRetries: 0, dnsLookup },
        vi.fn(async () =>
          new Response('binary', {
            status: 200,
            headers: { 'content-type': testCase.contentType }
          })
        )
      );

      expect(result.directLink?.ext).toBe(testCase.expected);
    }
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
