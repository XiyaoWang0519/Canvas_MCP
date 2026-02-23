import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildCourseMaterialKey,
  extractDiscoveredLinksFromHtml,
  mapModuleItemRef,
  upsertCourseMaterial
} from '../tools/course-materials.js';
import type { CourseMaterial } from '../tools/schemas.js';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

async function loadListCourseMaterialsHandler(canvas: {
  getAll: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}) {
  const tools = new Map<string, unknown>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: unknown) => {
      tools.set(name, handler);
    }
  };

  const { registerCanvasTools } = await import('../tools/index.js');
  registerCanvasTools(server as never, { canvas: canvas as never });

  const handler = tools.get('list_course_materials');
  if (!handler || typeof handler !== 'function') {
    throw new Error('list_course_materials not registered');
  }

  return handler as (args: {
    course_id: number;
    include_types?: Array<'File' | 'Page' | 'Assignment' | 'Discussion' | 'Quiz' | 'ExternalUrl' | 'ExternalTool'>;
    include_html_link_extraction?: boolean;
    limit?: number;
  }) => Promise<{ structuredContent: { materials: CourseMaterial[]; scanned_modules: number; scanned_items: number; truncated: boolean } }>;
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

describe('course material helpers', () => {
  it('maps module items and builds deterministic keys', () => {
    const ref = mapModuleItemRef(
      { id: 11, name: 'Week 1' },
      {
        id: 101,
        type: 'Page',
        title: 'Syllabus',
        page_url: 'syllabus',
        html_url: 'https://canvas.example.com/courses/1/pages/syllabus'
      }
    );

    expect(ref).toMatchObject({
      module_id: 11,
      module_name: 'Week 1',
      item_id: 101,
      type: 'Page',
      page_url: 'syllabus'
    });

    expect(ref ? buildCourseMaterialKey(ref) : '').toBe('Page:syllabus');
    expect(mapModuleItemRef({ id: 99, name: 'x' }, { id: 1, type: 'UnknownType' })).toBeNull();
  });

  it('deduplicates repeated material placements while preserving refs', () => {
    const map = new Map<string, CourseMaterial>();

    const firstRef = mapModuleItemRef(
      { id: 10, name: 'Module A' },
      { id: 100, type: 'File', title: 'Lecture', content_id: 500 }
    );
    const secondRef = mapModuleItemRef(
      { id: 20, name: 'Module B' },
      { id: 200, type: 'File', title: 'Lecture Copy', content_id: 500 }
    );

    if (!firstRef || !secondRef) {
      throw new Error('Unexpected null ref in test');
    }

    const key = buildCourseMaterialKey(firstRef);
    upsertCourseMaterial(map, key, firstRef);
    upsertCourseMaterial(map, key, secondRef);

    expect(map.size).toBe(1);
    const material = map.get(key);
    expect(material).toBeDefined();
    expect(material?.source.module_ids).toEqual([10, 20]);
    expect(material?.source.module_item_ids).toEqual([100, 200]);
    expect(material?.item_refs).toHaveLength(2);
  });

  it('extracts and deduplicates Canvas API links from assignment HTML', () => {
    const html = `
      <div>
        <a href="https://canvas.example.com/courses/1/files/90"
           data-api-endpoint="https://canvas.example.com/api/v1/courses/1/files/90"
           data-api-returntype="File">Read <strong>handout</strong></a>
        <a href="https://canvas.example.com/courses/1/files/90"
           data-api-endpoint="https://canvas.example.com/api/v1/courses/1/files/90"
           data-api-returntype="File">Duplicate link</a>
      </div>
    `;

    const links = extractDiscoveredLinksFromHtml(html);

    expect(links).toEqual([
      {
        api_endpoint: 'https://canvas.example.com/api/v1/courses/1/files/90',
        api_returntype: 'File',
        href: 'https://canvas.example.com/courses/1/files/90',
        text: 'Read handout'
      }
    ]);
  });
});

describe('list_course_materials tool', () => {
  it('aggregates module items, enriches resources, deduplicates, and truncates deterministically', async () => {
    const canvas = {
      getAll: vi.fn(async (path: string) => {
        if (path === '/api/v1/courses/1/modules') {
          return {
            data: [
              { id: 11, name: 'Week 1' },
              { id: 12, name: 'Week 2' }
            ],
            status: 200,
            requestId: 'modules'
          };
        }

        if (path === '/api/v1/courses/1/modules/11/items') {
          return {
            data: [
              { id: 101, type: 'File', title: 'Lecture PDF', content_id: 9001 },
              { id: 102, type: 'Assignment', title: 'Essay', content_id: 5001 }
            ],
            status: 200,
            requestId: 'm11-items'
          };
        }

        if (path === '/api/v1/courses/1/modules/12/items') {
          return {
            data: [
              { id: 201, type: 'File', title: 'Lecture PDF copy', content_id: 9001 },
              {
                id: 202,
                type: 'ExternalUrl',
                title: 'Course website',
                external_url: 'https://example.com/course'
              }
            ],
            status: 200,
            requestId: 'm12-items'
          };
        }

        throw new Error(`Unexpected getAll path: ${path}`);
      }),
      get: vi.fn(async (path: string) => {
        if (path === '/api/v1/files/9001') {
          return {
            data: {
              id: 9001,
              display_name: 'Lecture 1.pdf',
              filename: 'lecture-1.pdf',
              url: 'https://canvas.example.com/files/9001/download'
            },
            status: 200,
            requestId: 'file-9001'
          };
        }

        if (path === '/api/v1/files/9001/public_url') {
          return {
            data: {
              public_url: 'https://cdn.canvas.example.com/files/9001?signature=abc'
            },
            status: 200,
            requestId: 'file-9001-public'
          };
        }

        if (path === '/api/v1/courses/1/assignments/5001') {
          return {
            data: {
              id: 5001,
              course_id: 1,
              name: 'Essay',
              due_at: '2025-09-01T23:59:00Z',
              html_url: 'https://canvas.example.com/courses/1/assignments/5001',
              description:
                '<a href="https://canvas.example.com/courses/1/files/42" data-api-endpoint="https://canvas.example.com/api/v1/courses/1/files/42" data-api-returntype="File">Rubric</a>'
            },
            status: 200,
            requestId: 'assignment-5001'
          };
        }

        throw new Error(`Unexpected get path: ${path}`);
      })
    };

    const handler = await loadListCourseMaterialsHandler(canvas);
    const result = await handler({
      course_id: 1,
      include_types: ['File', 'Assignment', 'ExternalUrl'],
      include_html_link_extraction: true,
      limit: 2
    });

    expect(result.structuredContent.scanned_modules).toBe(2);
    expect(result.structuredContent.scanned_items).toBe(4);
    expect(result.structuredContent.truncated).toBe(true);
    expect(result.structuredContent.materials).toHaveLength(2);

    const [fileMaterial, assignmentMaterial] = result.structuredContent.materials;

    expect(fileMaterial.key).toBe('File:9001');
    expect(fileMaterial.source.module_ids).toEqual([11, 12]);
    expect(fileMaterial.source.module_item_ids).toEqual([101, 201]);
    expect(fileMaterial.file?.download_url).toContain('signature=abc');

    expect(assignmentMaterial.type).toBe('Assignment');
    expect(assignmentMaterial.assignment?.id).toBe(5001);
    expect(assignmentMaterial.discovered_links).toEqual([
      {
        api_endpoint: 'https://canvas.example.com/api/v1/courses/1/files/42',
        api_returntype: 'File',
        href: 'https://canvas.example.com/courses/1/files/42',
        text: 'Rubric'
      }
    ]);
  });
});
