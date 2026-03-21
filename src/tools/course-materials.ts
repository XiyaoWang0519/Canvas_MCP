import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { type CanvasResult } from '../canvas/client.js';
import {
  CanvasAssignment,
  CanvasFile,
  CanvasFilePublicUrl,
  CanvasModule,
  CanvasModuleItem,
  CanvasPage
} from '../canvas/types.js';
import { AppError } from '../core/errors.js';
import { log } from '../core/logger.js';
import { toCanvasTimezone } from '../core/timezone.js';
import { mapFile } from './mappers.js';
import {
  CourseMaterial,
  CourseMaterialItemRef,
  DiscoveredLink,
  listCourseMaterialsOutputSchema,
  MaterialType,
  materialTypeValues
} from './schemas.js';
import {
  createConcurrencyLimiter,
  wrapTool,
  type ToolDependencies
} from './shared.js';

const MATERIAL_TYPE_SET = new Set<string>(materialTypeValues);
const HTML_TAG_REGEX = /<[^>]+>/g;
const HTML_WHITESPACE_REGEX = /\s+/g;
const MAX_SNIPPET_LENGTH = 240;
const COURSE_MATERIALS_LIMIT_DEFAULT = 200;
const COURSE_MATERIALS_LIMIT_MAX = 1000;
const COURSE_MATERIALS_DETAIL_CONCURRENCY = 5;

function asBooleanOrUndefined(value: boolean | null | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeModuleName(module: CanvasModule): string {
  const name = module.name?.trim();
  return name && name.length > 0 ? name : `Module ${module.id}`;
}

function normalizeTitle(item: CanvasModuleItem): string {
  const title = item.title?.trim();
  return title && title.length > 0 ? title : `Item ${item.id}`;
}

export function toMaterialType(value: string): MaterialType | null {
  return MATERIAL_TYPE_SET.has(value) ? (value as MaterialType) : null;
}

export function mapModuleItemRef(
  module: CanvasModule,
  item: CanvasModuleItem
): CourseMaterialItemRef | null {
  const materialType = toMaterialType(item.type);
  if (!materialType) {
    return null;
  }

  return {
    module_id: module.id,
    module_name: normalizeModuleName(module),
    item_id: item.id,
    title: normalizeTitle(item),
    type: materialType,
    content_id: typeof item.content_id === 'number' ? item.content_id : undefined,
    html_url: item.html_url,
    url: item.url,
    page_url: item.page_url,
    external_url: item.external_url,
    published: asBooleanOrUndefined(item.published),
    locked: asBooleanOrUndefined(item.locked)
  };
}

export function buildCourseMaterialKey(itemRef: CourseMaterialItemRef): string {
  const contentKey =
    itemRef.type === 'Page'
      ? itemRef.page_url ?? itemRef.content_id?.toString()
      : itemRef.type === 'ExternalUrl' || itemRef.type === 'ExternalTool'
      ? itemRef.external_url ?? itemRef.url ?? itemRef.html_url
      : itemRef.content_id?.toString();

  return `${itemRef.type}:${contentKey ?? `item-${itemRef.item_id}`}`;
}

function mergeUnique(values: number[], value: number): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function hasItemRef(material: CourseMaterial, itemId: number): boolean {
  return material.item_refs.some((entry) => entry.item_id === itemId);
}

function withExternalIfNeeded(material: CourseMaterial, itemRef: CourseMaterialItemRef): void {
  if (itemRef.type !== 'ExternalTool' && itemRef.type !== 'ExternalUrl') {
    return;
  }

  const url = itemRef.external_url ?? itemRef.url;
  if (!material.external) {
    material.external = {
      url,
      html_url: itemRef.html_url
    };
    return;
  }

  if (!material.external.url && url) {
    material.external.url = url;
  }
  if (!material.external.html_url && itemRef.html_url) {
    material.external.html_url = itemRef.html_url;
  }
}

export function upsertCourseMaterial(
  map: Map<string, CourseMaterial>,
  key: string,
  itemRef: CourseMaterialItemRef
): void {
  const existing = map.get(key);
  if (!existing) {
    const material: CourseMaterial = {
      key,
      type: itemRef.type,
      title: itemRef.title,
      source: {
        module_ids: [itemRef.module_id],
        module_item_ids: [itemRef.item_id]
      },
      item_refs: [itemRef]
    };

    withExternalIfNeeded(material, itemRef);
    map.set(key, material);
    return;
  }

  mergeUnique(existing.source.module_ids, itemRef.module_id);
  mergeUnique(existing.source.module_item_ids, itemRef.item_id);

  if (!hasItemRef(existing, itemRef.item_id)) {
    existing.item_refs.push(itemRef);
  }

  if (existing.title.startsWith('Item ') && !itemRef.title.startsWith('Item ')) {
    existing.title = itemRef.title;
  }

  withExternalIfNeeded(existing, itemRef);
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

export function stripHtml(input: string | null | undefined): string {
  if (!input) {
    return '';
  }

  const noScripts = input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');

  const plain = noScripts.replace(HTML_TAG_REGEX, ' ');
  return decodeHtmlEntities(plain).replace(HTML_WHITESPACE_REGEX, ' ').trim();
}

export function createBodySnippet(html: string | null | undefined): string | undefined {
  const plain = stripHtml(html);
  if (!plain) {
    return undefined;
  }

  if (plain.length <= MAX_SNIPPET_LENGTH) {
    return plain;
  }

  return `${plain.slice(0, MAX_SNIPPET_LENGTH - 1).trimEnd()}…`;
}

function readAttribute(attributes: string, attribute: string): string | undefined {
  const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escapedAttribute}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  const match = attributes.match(regex);
  if (!match) {
    return undefined;
  }

  return decodeHtmlEntities(match[2]).trim();
}

function pushDiscoveredLink(
  links: DiscoveredLink[],
  link: DiscoveredLink,
  dedupe: Set<string>
): void {
  const dedupeKey = `${link.api_endpoint}|${link.api_returntype ?? ''}|${link.href ?? ''}`;
  if (dedupe.has(dedupeKey)) {
    return;
  }
  dedupe.add(dedupeKey);
  links.push(link);
}

export function extractDiscoveredLinksFromHtml(html: string | null | undefined): DiscoveredLink[] {
  if (!html) {
    return [];
  }

  const links: DiscoveredLink[] = [];
  const dedupe = new Set<string>();

  const anchorRegex = /<a\b([^>]*\bdata-api-endpoint\s*=\s*(["'])[\s\S]*?\2[^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRegex)) {
    const attributes = match[1];
    const apiEndpoint = readAttribute(attributes, 'data-api-endpoint');
    if (!apiEndpoint) {
      continue;
    }

    const apiReturnType = readAttribute(attributes, 'data-api-returntype');
    const href = readAttribute(attributes, 'href');
    const text = stripHtml(match[3]) || undefined;

    pushDiscoveredLink(
      links,
      {
        api_endpoint: apiEndpoint,
        api_returntype: apiReturnType,
        href,
        text
      },
      dedupe
    );
  }

  const endpointRegex = /<([a-z0-9]+)\b([^>]*\bdata-api-endpoint\s*=\s*(["'])[\s\S]*?\3[^>]*)>/gi;
  for (const match of html.matchAll(endpointRegex)) {
    const attributes = match[2];
    const apiEndpoint = readAttribute(attributes, 'data-api-endpoint');
    if (!apiEndpoint) {
      continue;
    }

    const apiReturnType = readAttribute(attributes, 'data-api-returntype');
    const href = readAttribute(attributes, 'href');

    pushDiscoveredLink(
      links,
      {
        api_endpoint: apiEndpoint,
        api_returntype: apiReturnType,
        href
      },
      dedupe
    );
  }

  return links;
}

export interface MetaAccumulator {
  statuses: number[];
  requestIds: string[];
}

function collectMeta<T>(acc: MetaAccumulator, result: CanvasResult<T>): void {
  acc.statuses.push(result.status);

  if (result.requestIds) {
    acc.requestIds.push(...result.requestIds);
    return;
  }

  if (result.requestId) {
    acc.requestIds.push(result.requestId);
  }
}

function getFirstContentId(material: CourseMaterial): number | undefined {
  return material.item_refs.find((ref) => typeof ref.content_id === 'number')?.content_id;
}

function getFirstPageIdentifier(material: CourseMaterial): string | undefined {
  const ref = material.item_refs.find((entry) => entry.page_url) ?? material.item_refs[0];
  if (!ref) {
    return undefined;
  }

  if (ref.page_url) {
    return ref.page_url;
  }

  if (typeof ref.content_id === 'number') {
    return String(ref.content_id);
  }

  return undefined;
}

export async function collectCourseMaterialsFromModules(args: {
  courseId: number;
  includeTypes: Set<MaterialType>;
  deps: ToolDependencies;
  meta: MetaAccumulator;
}): Promise<{
  scannedModules: number;
  scannedItems: number;
  materials: CourseMaterial[];
}> {
  const modulesResult = await args.deps.canvas.getAll<CanvasModule>(
    `/api/v1/courses/${args.courseId}/modules`
  );
  collectMeta(args.meta, modulesResult);

  let scannedItems = 0;
  const materialMap = new Map<string, CourseMaterial>();

  for (const module of modulesResult.data) {
    const itemsResult = await args.deps.canvas.getAll<CanvasModuleItem>(
      `/api/v1/courses/${args.courseId}/modules/${module.id}/items`,
      {
        'include[]': ['content_details']
      }
    );
    collectMeta(args.meta, itemsResult);

    scannedItems += itemsResult.data.length;

    for (const item of itemsResult.data) {
      const itemRef = mapModuleItemRef(module, item);
      if (!itemRef || !args.includeTypes.has(itemRef.type)) {
        continue;
      }

      const key = buildCourseMaterialKey(itemRef);
      upsertCourseMaterial(materialMap, key, itemRef);
    }
  }

  const materials = Array.from(materialMap.values());
  for (const material of materials) {
    material.item_refs = material.item_refs.sort((a, b) => a.item_id - b.item_id);
    material.source.module_ids = material.source.module_ids.sort((a, b) => a - b);
    material.source.module_item_ids = material.source.module_item_ids.sort((a, b) => a - b);
  }

  return {
    scannedModules: modulesResult.data.length,
    scannedItems,
    materials
  };
}

function mapMaterialAssignment(raw: CanvasAssignment): NonNullable<CourseMaterial['assignment']> {
  return {
    id: raw.id,
    name: raw.name,
    html_url: raw.html_url,
    due_at: toCanvasTimezone(raw.due_at) ?? raw.due_at ?? null,
    unlock_at: toCanvasTimezone(raw.unlock_at) ?? raw.unlock_at ?? null,
    lock_at: toCanvasTimezone(raw.lock_at) ?? raw.lock_at ?? null,
    created_at: toCanvasTimezone(raw.created_at) ?? raw.created_at ?? null,
    updated_at: toCanvasTimezone(raw.updated_at) ?? raw.updated_at ?? null,
    points_possible: typeof raw.points_possible === 'number' ? raw.points_possible : null
  };
}

function mapMaterialPage(raw: CanvasPage): NonNullable<CourseMaterial['page']> {
  return {
    page_id: typeof raw.page_id === 'number' ? raw.page_id : undefined,
    url: raw.url,
    title: raw.title?.trim() || 'Untitled page',
    html_url: raw.html_url,
    body_snippet: createBodySnippet(raw.body),
    created_at: toCanvasTimezone(raw.created_at) ?? raw.created_at,
    updated_at: toCanvasTimezone(raw.updated_at) ?? raw.updated_at,
    published: typeof raw.published === 'boolean' ? raw.published : undefined,
    locked_for_user:
      typeof raw.locked_for_user === 'boolean' ? raw.locked_for_user : undefined
  };
}

async function enrichCourseMaterial(
  material: CourseMaterial,
  args: {
    courseId: number;
    includeHtmlLinkExtraction: boolean;
    deps: ToolDependencies;
    meta: MetaAccumulator;
  }
): Promise<void> {
  if (material.type === 'ExternalTool' || material.type === 'ExternalUrl') {
    const ref = material.item_refs.find((entry) => entry.external_url || entry.url) ?? material.item_refs[0];
    if (!ref) {
      return;
    }

    material.external = {
      url: ref.external_url ?? ref.url,
      html_url: ref.html_url
    };
    return;
  }

  if (material.type === 'File') {
    const fileId = getFirstContentId(material);
    if (!fileId) {
      return;
    }

    try {
      const fileResult = await args.deps.canvas.get<CanvasFile>(`/api/v1/files/${fileId}`);
      collectMeta(args.meta, fileResult);
      const file = mapFile(fileResult.data);

      let downloadUrl: string | undefined;
      try {
        const downloadResult = await args.deps.canvas.get<CanvasFilePublicUrl>(
          `/api/v1/files/${fileId}/public_url`
        );
        collectMeta(args.meta, downloadResult);
        downloadUrl = downloadResult.data.public_url;
      } catch (error) {
        log('warn', 'Unable to resolve temporary download URL for file material', {
          key: material.key,
          file_id: fileId,
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof AppError ? error.code : undefined
        });
      }

      material.file = {
        ...file,
        download_url: downloadUrl
      };
      material.title = material.title || file.display_name;
    } catch (error) {
      log('warn', 'Skipping file enrichment for course material', {
        key: material.key,
        file_id: fileId,
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof AppError ? error.code : undefined
      });
    }

    return;
  }

  if (material.type === 'Page') {
    const pageIdentifier = getFirstPageIdentifier(material);
    if (!pageIdentifier) {
      return;
    }

    try {
      const pageResult = await args.deps.canvas.get<CanvasPage>(
        `/api/v1/courses/${args.courseId}/pages/${encodeURIComponent(pageIdentifier)}`
      );
      collectMeta(args.meta, pageResult);
      material.page = mapMaterialPage(pageResult.data);
      material.title = material.page.title;
    } catch (error) {
      log('warn', 'Skipping page enrichment for course material', {
        key: material.key,
        page_identifier: pageIdentifier,
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof AppError ? error.code : undefined
      });
    }

    return;
  }

  if (material.type === 'Assignment') {
    const assignmentId = getFirstContentId(material);
    if (!assignmentId) {
      return;
    }

    try {
      const assignmentResult = await args.deps.canvas.get<CanvasAssignment>(
        `/api/v1/courses/${args.courseId}/assignments/${assignmentId}`,
        {
          'include[]': ['submission']
        }
      );
      collectMeta(args.meta, assignmentResult);
      material.assignment = mapMaterialAssignment(assignmentResult.data);
      material.title = assignmentResult.data.name;

      if (args.includeHtmlLinkExtraction) {
        const discoveredLinks = extractDiscoveredLinksFromHtml(assignmentResult.data.description);
        if (discoveredLinks.length > 0) {
          material.discovered_links = discoveredLinks;
        }
      }
    } catch (error) {
      log('warn', 'Skipping assignment enrichment for course material', {
        key: material.key,
        assignment_id: assignmentId,
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof AppError ? error.code : undefined
      });
    }
  }
}

export function registerListCourseMaterials(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative(),
    include_types: z.array(z.enum(materialTypeValues)).optional(),
    include_html_link_extraction: z.boolean().optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(COURSE_MATERIALS_LIMIT_MAX)
      .optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_course_materials',
    {
      title: 'List Course Materials',
      description:
        'Aggregate discoverable course-provided materials from module items (files, pages, assignments, links, and more).',
      inputSchema,
      outputSchema: listCourseMaterialsOutputSchema.shape
    },
    wrapTool(
      'list_course_materials',
      async (args: {
        course_id: number;
        include_types?: MaterialType[];
        include_html_link_extraction?: boolean;
        limit?: number;
      }) => {
        const includeTypes = new Set<MaterialType>(
          args.include_types && args.include_types.length > 0
            ? args.include_types
            : [...materialTypeValues]
        );
        const includeHtmlLinkExtraction = args.include_html_link_extraction ?? true;
        const limit = args.limit ?? COURSE_MATERIALS_LIMIT_DEFAULT;

        const meta: MetaAccumulator = {
          statuses: [],
          requestIds: []
        };

        const collected = await collectCourseMaterialsFromModules({
          courseId: args.course_id,
          includeTypes,
          deps,
          meta
        });

        const deduplicatedMaterials = collected.materials;
        const truncated = deduplicatedMaterials.length > limit;
        const materials = deduplicatedMaterials.slice(0, limit);

        const limitEnrichment = createConcurrencyLimiter(COURSE_MATERIALS_DETAIL_CONCURRENCY);
        await Promise.all(
          materials.map((material) =>
            limitEnrichment(() =>
              enrichCourseMaterial(material, {
                courseId: args.course_id,
                includeHtmlLinkExtraction,
                deps,
                meta
              })
            )
          )
        );

        const payload = listCourseMaterialsOutputSchema.parse({
          course_id: args.course_id,
          scanned_modules: collected.scannedModules,
          scanned_items: collected.scannedItems,
          materials,
          truncated
        });

        return {
          payload,
          meta: {
            status: meta.statuses.at(-1),
            requestId: meta.requestIds.at(-1),
            requestIds: meta.requestIds
          }
        };
      }
    )
  );
}
