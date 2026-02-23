import { fetch, type Response } from 'undici';

import { sleep } from '../core/async.js';
import { USER_AGENT } from '../core/meta.js';
import { stripHtml } from './course-materials.js';
import type {
  ExternalDownloadResolutionLink,
  ExternalDownloadResolutionStatus,
  ResolveExternalDownloadsMaterialResult
} from './schemas.js';

const DOWNLOAD_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'zip',
  'rar',
  '7z',
  'mp4',
  'mov',
  'm4v',
  'avi',
  'mkv',
  'mp3',
  'wav',
  'csv',
  'txt',
  'rtf',
  'epub'
]);

const FILE_PATH_REGEX = /\/files?\//i;
const DOWNLOAD_QUERY_REGEX = /[?&](?:download|dl|attachment|export|raw)(?:=|&|$)/i;
const JAVASCRIPT_REQUIRED_REGEX =
  /(?:enable|turn\s+on|requires?)\s+javascript|javascript\s+(?:is\s+)?required/i;
const LOGIN_GATE_REGEX =
  /\b(?:sign\s*in|log\s*in|single\s*sign[- ]?on|sso|authentication\s+required)\b/i;

export type ExternalFetchLike = typeof fetch;

export interface ExternalFetchOptions {
  timeoutMs: number;
  maxRetries?: number;
}

export interface ExternalFetchResult {
  requestedUrl: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  html?: string;
  directLink?: ExternalDownloadResolutionLink;
  error?: string;
}

export interface ExtractLinksOptions {
  baseUrl: string;
  maxLinks: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

function readAttribute(attributes: string, attribute: string): string | undefined {
  const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escapedAttribute}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  const match = attributes.match(regex);
  if (!match) {
    return undefined;
  }

  const value = decodeHtmlEntities(match[2]).trim();
  return value.length > 0 ? value : undefined;
}

export function toAbsoluteHttpUrl(
  rawUrl: string | undefined,
  baseUrl: string
): string | undefined {
  if (!rawUrl) {
    return undefined;
  }

  try {
    const normalized = new URL(rawUrl, baseUrl);
    if (normalized.protocol !== 'http:' && normalized.protocol !== 'https:') {
      return undefined;
    }
    return normalized.toString();
  } catch (error) {
    return undefined;
  }
}

function inferExtension(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split('/').pop() ?? '';
    const extension = lastSegment.includes('.')
      ? lastSegment.slice(lastSegment.lastIndexOf('.') + 1).toLowerCase()
      : '';

    if (!extension || !DOWNLOAD_EXTENSIONS.has(extension)) {
      return undefined;
    }

    return extension;
  } catch (error) {
    return undefined;
  }
}

function classifyConfidence(input: {
  url?: string;
  ext?: string;
  apiEndpoint?: string;
  apiReturnType?: string;
}): ExternalDownloadResolutionLink['confidence'] {
  const isFilePath = Boolean(input.url && FILE_PATH_REGEX.test(input.url));
  const hasDownloadQuery = Boolean(input.url && DOWNLOAD_QUERY_REGEX.test(input.url));
  const returnType = input.apiReturnType?.toLowerCase();

  if (input.ext || isFilePath || hasDownloadQuery || returnType === 'file') {
    return 'high';
  }

  if (input.apiEndpoint) {
    return 'medium';
  }

  return 'low';
}

function isCandidateLink(input: {
  url?: string;
  ext?: string;
  apiEndpoint?: string;
}): boolean {
  if (input.apiEndpoint) {
    return true;
  }

  if (!input.url) {
    return false;
  }

  if (input.ext) {
    return true;
  }

  if (FILE_PATH_REGEX.test(input.url)) {
    return true;
  }

  return DOWNLOAD_QUERY_REGEX.test(input.url);
}

function buildDedupeKey(link: ExternalDownloadResolutionLink): string {
  return `${link.url}|${link.api_endpoint ?? ''}|${link.api_returntype ?? ''}`;
}

export function dedupeResolvedLinks(
  links: ExternalDownloadResolutionLink[],
  globalSeen?: Set<string>
): ExternalDownloadResolutionLink[] {
  const localSeen = new Set<string>();
  const deduped: ExternalDownloadResolutionLink[] = [];

  for (const link of links) {
    const key = buildDedupeKey(link);
    if (localSeen.has(key)) {
      continue;
    }
    if (globalSeen?.has(key)) {
      continue;
    }

    localSeen.add(key);
    globalSeen?.add(key);
    deduped.push(link);
  }

  return deduped;
}

export function extractExternalDownloadLinksFromHtml(
  html: string | null | undefined,
  options: ExtractLinksOptions
): { links: ExternalDownloadResolutionLink[]; truncated: boolean } {
  if (!html) {
    return { links: [], truncated: false };
  }

  const maxLinks = clamp(Math.floor(options.maxLinks), 1, 200);
  const links: ExternalDownloadResolutionLink[] = [];

  const pushCandidate = (link: ExternalDownloadResolutionLink): void => {
    links.push(link);
  };

  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRegex)) {
    const attributes = match[1];
    const href = toAbsoluteHttpUrl(readAttribute(attributes, 'href'), options.baseUrl);
    const apiEndpoint = toAbsoluteHttpUrl(readAttribute(attributes, 'data-api-endpoint'), options.baseUrl);
    const apiReturnType = readAttribute(attributes, 'data-api-returntype');
    const ext = inferExtension(href);

    if (
      !isCandidateLink({
        url: href,
        ext,
        apiEndpoint
      })
    ) {
      continue;
    }

    const url = href ?? apiEndpoint;
    if (!url) {
      continue;
    }

    const text = stripHtml(match[2]) || undefined;

    pushCandidate({
      url,
      text,
      ext,
      api_endpoint: apiEndpoint,
      api_returntype: apiReturnType,
      confidence: classifyConfidence({
        url,
        ext,
        apiEndpoint,
        apiReturnType
      })
    });
  }

  const endpointRegex = /<([a-z0-9]+)\b([^>]*\bdata-api-endpoint\s*=\s*(["'])[\s\S]*?\3[^>]*)>/gi;
  for (const match of html.matchAll(endpointRegex)) {
    const attributes = match[2];
    const apiEndpoint = toAbsoluteHttpUrl(readAttribute(attributes, 'data-api-endpoint'), options.baseUrl);
    if (!apiEndpoint) {
      continue;
    }

    const href = toAbsoluteHttpUrl(readAttribute(attributes, 'href'), options.baseUrl);
    const apiReturnType = readAttribute(attributes, 'data-api-returntype');
    const url = href ?? apiEndpoint;
    const ext = inferExtension(url);

    pushCandidate({
      url,
      ext,
      api_endpoint: apiEndpoint,
      api_returntype: apiReturnType,
      confidence: classifyConfidence({
        url,
        ext,
        apiEndpoint,
        apiReturnType
      })
    });
  }

  const deduped = dedupeResolvedLinks(links);
  const truncated = deduped.length > maxLinks;

  return {
    links: deduped.slice(0, maxLinks),
    truncated
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function retryDelayMs(attempt: number): number {
  const base = 500 * Math.pow(2, attempt);
  const jitter = base * (0.5 + Math.random());
  return Math.min(4_000, Math.round(jitter));
}

function createTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId)
  };
}

function normalizeContentType(response: Response): string | undefined {
  const value = response.headers.get('content-type');
  if (!value) {
    return undefined;
  }
  return value.toLowerCase();
}

function contentTypeLooksHtml(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }

  return contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
}

function contentTypeToExtension(contentType: string | undefined): string | undefined {
  if (!contentType) {
    return undefined;
  }

  if (contentType.includes('pdf')) {
    return 'pdf';
  }
  if (contentType.includes('word') || contentType.includes('doc')) {
    return 'docx';
  }
  if (contentType.includes('presentation') || contentType.includes('powerpoint')) {
    return 'pptx';
  }
  if (contentType.includes('excel') || contentType.includes('spreadsheet')) {
    return 'xlsx';
  }
  if (contentType.includes('zip') || contentType.includes('compressed')) {
    return 'zip';
  }
  if (contentType.includes('video/')) {
    return 'mp4';
  }
  if (contentType.includes('audio/')) {
    return 'mp3';
  }

  return undefined;
}

export async function fetchExternalResource(
  url: string,
  options: ExternalFetchOptions,
  fetchImpl: ExternalFetchLike = fetch
): Promise<ExternalFetchResult> {
  const timeoutMs = clamp(Math.floor(options.timeoutMs), 2_000, 60_000);
  const maxRetries = clamp(Math.floor(options.maxRetries ?? 2), 0, 5);

  const normalizedUrl = toAbsoluteHttpUrl(url, url);
  if (!normalizedUrl) {
    return {
      requestedUrl: url,
      error: 'Invalid or unsupported URL protocol.'
    };
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const timeout = createTimeoutSignal(timeoutMs);

    try {
      const response = await fetchImpl(normalizedUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': USER_AGENT
        },
        signal: timeout.signal
      });

      const responseUrl = response.url && response.url.length > 0 ? response.url : normalizedUrl;
      const finalUrl = toAbsoluteHttpUrl(responseUrl, normalizedUrl);
      if (!finalUrl) {
        return {
          requestedUrl: normalizedUrl,
          status: response.status,
          error: 'Redirected to an unsupported URL protocol.'
        };
      }

      const contentType = normalizeContentType(response);

      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        await sleep(retryDelayMs(attempt));
        continue;
      }

      if (!response.ok) {
        let bodyText: string | undefined;
        if (contentTypeLooksHtml(contentType)) {
          bodyText = await response.text();
        }

        return {
          requestedUrl: normalizedUrl,
          finalUrl,
          status: response.status,
          contentType,
          html: bodyText
        };
      }

      if (contentTypeLooksHtml(contentType) || !contentType) {
        const html = await response.text();

        return {
          requestedUrl: normalizedUrl,
          finalUrl,
          status: response.status,
          contentType,
          html
        };
      }

      const ext = inferExtension(finalUrl) ?? contentTypeToExtension(contentType);
      const directLink: ExternalDownloadResolutionLink = {
        url: finalUrl,
        ext,
        confidence: ext ? 'high' : 'medium'
      };

      return {
        requestedUrl: normalizedUrl,
        finalUrl,
        status: response.status,
        contentType,
        directLink
      };
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries) {
        break;
      }

      await sleep(retryDelayMs(attempt));
    } finally {
      timeout.clear();
    }
  }

  return {
    requestedUrl: normalizedUrl,
    error: lastError instanceof Error ? lastError.message : 'Request failed.'
  };
}

export function classifyBrowserFallbackReason(html: string | null | undefined): string | undefined {
  if (!html) {
    return undefined;
  }

  const text = stripHtml(html).toLowerCase();
  if (!text) {
    return undefined;
  }

  if (JAVASCRIPT_REQUIRED_REGEX.test(text)) {
    return 'External page appears to require JavaScript rendering.';
  }

  if (LOGIN_GATE_REGEX.test(text)) {
    return 'External page appears to require interactive sign-in.';
  }

  return undefined;
}

export function finalizeResultStatus(
  result: ResolveExternalDownloadsMaterialResult,
  options: { linksTruncated: boolean }
): ResolveExternalDownloadsMaterialResult {
  if (options.linksTruncated && result.status === 'ok') {
    return {
      ...result,
      status: 'partial',
      reason: result.reason ?? 'Link extraction was truncated by max_links_per_page.'
    };
  }

  return result;
}
