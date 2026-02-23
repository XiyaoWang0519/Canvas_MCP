import { CanvasModule, CanvasModuleItem } from '../canvas/types.js';
import {
  CourseMaterial,
  CourseMaterialItemRef,
  DiscoveredLink,
  MaterialType,
  materialTypeValues
} from './schemas.js';

const MATERIAL_TYPE_SET = new Set<string>(materialTypeValues);
const HTML_TAG_REGEX = /<[^>]+>/g;
const HTML_WHITESPACE_REGEX = /\s+/g;
const MAX_SNIPPET_LENGTH = 240;

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
