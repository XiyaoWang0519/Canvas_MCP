import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetch, type Response } from 'undici';

import { sleep } from '../core/async.js';
import { USER_AGENT } from '../core/meta.js';
import {
  collectCourseMaterialsFromModules,
  stripHtml,
  type MetaAccumulator
} from './course-materials.js';
import {
  resolveExternalDownloadsInputSchema,
  resolveExternalDownloadsOutputSchema,
  type CourseMaterial,
  type MaterialType,
  type ExternalDownloadResolutionLink,
  type ResolveExternalDownloadsMaterialResult
} from './schemas.js';
import { wrapTool, type ToolDependencies } from './shared.js';

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

const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.google.internal.',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.aliyun.com'
]);

const METADATA_IP_ADDRESSES = new Set([
  '169.254.169.254',
  '100.100.100.200',
  '192.0.0.192',
  '169.254.170.2',
  'fd00:ec2::254'
]);

export interface OutboundUrlValidationResult {
  allowed: boolean;
  normalizedUrl?: string;
  reason?: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type ExternalFetchLike = typeof fetch;

export type DnsLookupLike = (
  hostname: string,
  options: { all: true; verbatim?: boolean }
) => Promise<LookupAddress[]>;

export interface ExternalFetchOptions {
  timeoutMs: number;
  maxRetries?: number;
  maxRedirects?: number;
  dnsLookup?: DnsLookupLike;
}

export interface ExternalFetchResult {
  requestedUrl: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  html?: string;
  directLink?: ExternalDownloadResolutionLink;
  error?: string;
  blockedReason?: string;
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

function normalizeHostname(hostname: string): string {
  const withoutBrackets = hostname.replace(/^\[/, '').replace(/\]$/, '');
  const lower = withoutBrackets.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

function parseIpv4Octets(hostname: string): number[] | undefined {
  const parts = hostname.split('.');
  if (parts.length !== 4) {
    return undefined;
  }

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }

    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return undefined;
    }

    octets.push(value);
  }

  return octets;
}

function classifyIpv4Address(hostname: string): string | undefined {
  const octets = parseIpv4Octets(hostname);
  if (!octets) {
    return undefined;
  }

  const [a, b] = octets;

  if (METADATA_IP_ADDRESSES.has(hostname)) {
    return 'cloud metadata endpoint';
  }

  // 0.0.0.0/8 ("this network")
  if (a === 0) {
    return 'unspecified IPv4 address';
  }

  // 127.0.0.0/8
  if (a === 127) {
    return 'loopback address';
  }

  // 169.254.0.0/16
  if (a === 169 && b === 254) {
    return 'link-local address';
  }

  // RFC1918 private ranges: 10/8, 172.16/12, 192.168/16
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return 'private RFC1918 address';
  }

  return undefined;
}

function parseIpv6Address(hostname: string): bigint | undefined {
  const scoped = hostname.split('%')[0];
  const [headRaw, tailRaw, extra] = scoped.split('::');
  if (extra !== undefined) {
    return undefined;
  }

  const parseSegmentList = (input: string): number[] | undefined => {
    if (!input) {
      return [];
    }

    const segments: number[] = [];
    const tokens = input.split(':');

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token) {
        return undefined;
      }

      if (token.includes('.')) {
        if (index !== tokens.length - 1) {
          return undefined;
        }

        const octets = parseIpv4Octets(token);
        if (!octets) {
          return undefined;
        }

        segments.push((octets[0] << 8) | octets[1]);
        segments.push((octets[2] << 8) | octets[3]);
        continue;
      }

      if (!/^[0-9a-f]{1,4}$/i.test(token)) {
        return undefined;
      }

      const value = Number.parseInt(token, 16);
      if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        return undefined;
      }

      segments.push(value);
    }

    return segments;
  };

  const head = parseSegmentList(headRaw ?? '');
  const tail = parseSegmentList(tailRaw ?? '');

  if (!head || !tail) {
    return undefined;
  }

  const hasCompression = scoped.includes('::');

  let segments: number[];
  if (hasCompression) {
    const zerosToInsert = 8 - (head.length + tail.length);
    if (zerosToInsert < 1) {
      return undefined;
    }

    segments = [...head, ...new Array<number>(zerosToInsert).fill(0), ...tail];
  } else {
    segments = head;
    if (segments.length !== 8) {
      return undefined;
    }
  }

  if (segments.length !== 8) {
    return undefined;
  }

  let packed = 0n;
  for (const segment of segments) {
    packed = (packed << 16n) + BigInt(segment);
  }

  return packed;
}

function classifyIpv6Address(hostname: string): string | undefined {
  const packed = parseIpv6Address(hostname);
  if (packed === undefined) {
    return undefined;
  }

  if (METADATA_IP_ADDRESSES.has(hostname)) {
    return 'cloud metadata endpoint';
  }

  if (packed === 0n) {
    return 'unspecified IPv6 address';
  }

  if (packed === 1n) {
    return 'loopback address';
  }

  const firstHextet = Number((packed >> 112n) & 0xffffn);

  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) {
    return 'link-local address';
  }

  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) {
    return 'private IPv6 address';
  }

  const mappedPrefix = packed >> 32n;
  if (mappedPrefix === 0xffffn) {
    const mappedIpv4 = Number(packed & 0xffffffffn);
    const octets = [
      (mappedIpv4 >>> 24) & 0xff,
      (mappedIpv4 >>> 16) & 0xff,
      (mappedIpv4 >>> 8) & 0xff,
      mappedIpv4 & 0xff
    ];
    const mapped = octets.join('.');
    return classifyIpv4Address(mapped);
  }

  return undefined;
}

function classifyBlockedHost(hostname: string): string | undefined {
  const normalized = normalizeHostname(hostname);

  if (!normalized) {
    return 'invalid host';
  }

  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return 'localhost';
  }

  if (METADATA_HOSTNAMES.has(normalized)) {
    return 'cloud metadata endpoint';
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return classifyIpv4Address(normalized);
  }

  if (ipVersion === 6) {
    return classifyIpv6Address(normalized);
  }

  return undefined;
}

export function validateOutboundHttpUrl(
  rawUrl: string | undefined,
  baseUrl: string
): OutboundUrlValidationResult {
  const normalizedUrl = toAbsoluteHttpUrl(rawUrl, baseUrl);
  if (!normalizedUrl) {
    return {
      allowed: false,
      reason: 'Invalid or unsupported URL protocol.'
    };
  }

  try {
    const parsed = new URL(normalizedUrl);
    const blockedHostReason = classifyBlockedHost(parsed.hostname);

    if (blockedHostReason) {
      return {
        allowed: false,
        normalizedUrl,
        reason: `Blocked outbound URL target (${blockedHostReason}).`
      };
    }

    return {
      allowed: true,
      normalizedUrl
    };
  } catch (error) {
    return {
      allowed: false,
      reason: 'Invalid URL.'
    };
  }
}

async function validateHostnameResolution(
  hostname: string,
  dnsLookup: DnsLookupLike,
  cache: Map<string, string | null>
): Promise<string | undefined> {
  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname || isIP(normalizedHostname) !== 0) {
    return undefined;
  }

  if (cache.has(normalizedHostname)) {
    const cached = cache.get(normalizedHostname);
    return cached === null ? undefined : cached;
  }

  let resolved: LookupAddress[];
  try {
    resolved = await dnsLookup(normalizedHostname, { all: true, verbatim: true });
  } catch (error) {
    cache.set(normalizedHostname, null);
    return undefined;
  }

  if (!resolved.length) {
    cache.set(normalizedHostname, null);
    return undefined;
  }

  for (const address of resolved) {
    const normalizedAddress = normalizeHostname(address.address);
    const blockedReason = classifyBlockedHost(normalizedAddress);
    if (blockedReason) {
      const reason = `hostname resolved to disallowed address ${normalizedAddress} (${blockedReason})`;
      cache.set(normalizedHostname, reason);
      return reason;
    }
  }

  cache.set(normalizedHostname, null);
  return undefined;
}

async function validateOutboundRequestUrl(
  rawUrl: string,
  baseUrl: string,
  options: {
    dnsLookup: DnsLookupLike;
    dnsCache: Map<string, string | null>;
  }
): Promise<OutboundUrlValidationResult> {
  const validation = validateOutboundHttpUrl(rawUrl, baseUrl);
  if (!validation.allowed || !validation.normalizedUrl) {
    return validation;
  }

  try {
    const parsed = new URL(validation.normalizedUrl);
    const dnsBlockedReason = await validateHostnameResolution(
      parsed.hostname,
      options.dnsLookup,
      options.dnsCache
    );

    if (dnsBlockedReason) {
      return {
        allowed: false,
        normalizedUrl: validation.normalizedUrl,
        reason: `Blocked outbound URL target (${dnsBlockedReason}).`
      };
    }

    return validation;
  } catch (error) {
    return {
      allowed: false,
      normalizedUrl: validation.normalizedUrl,
      reason: 'Invalid URL.'
    };
  }
}

function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

function resolveRedirectLocation(response: Response, requestUrl: string): string | undefined {
  const location = response.headers.get('location');
  if (!location) {
    return undefined;
  }

  try {
    return new URL(location, requestUrl).toString();
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

function inferExtensionFromContentDisposition(contentDisposition: string | undefined): string | undefined {
  if (!contentDisposition) {
    return undefined;
  }

  const filenameMatch =
    contentDisposition.match(/filename\*=UTF-8''([^;]+)/i) ??
    contentDisposition.match(/filename\s*=\s*"?([^";]+)"?/i);

  if (!filenameMatch) {
    return undefined;
  }

  let filename = filenameMatch[1].trim();
  if (!filename) {
    return undefined;
  }

  try {
    filename = decodeURIComponent(filename);
  } catch (error) {
    // Keep original value when decoding fails.
  }

  const extension = filename.includes('.')
    ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
    : '';

  if (!extension || !DOWNLOAD_EXTENSIONS.has(extension)) {
    return undefined;
  }

  return extension;
}

function responseLooksLikeDownload(response: Response, finalUrl: string): boolean {
  const contentDisposition = response.headers.get('content-disposition')?.toLowerCase() ?? '';

  if (contentDisposition.includes('attachment')) {
    return true;
  }

  if (inferExtension(finalUrl)) {
    return true;
  }

  return FILE_PATH_REGEX.test(finalUrl) || DOWNLOAD_QUERY_REGEX.test(finalUrl);
}

function classifyDirectLinkConfidence(
  url: string,
  ext: string | undefined
): ExternalDownloadResolutionLink['confidence'] {
  if (ext || FILE_PATH_REGEX.test(url) || DOWNLOAD_QUERY_REGEX.test(url)) {
    return 'high';
  }

  return 'medium';
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

  const normalized = contentType.toLowerCase();

  if (normalized.includes('pdf')) {
    return 'pdf';
  }

  if (
    normalized.includes('spreadsheetml') ||
    normalized.includes('ms-excel') ||
    normalized.includes('excel') ||
    normalized.includes('spreadsheet')
  ) {
    return 'xlsx';
  }

  if (
    normalized.includes('presentationml') ||
    normalized.includes('ms-powerpoint') ||
    normalized.includes('powerpoint') ||
    normalized.includes('presentation')
  ) {
    return 'pptx';
  }

  if (
    normalized.includes('wordprocessingml') ||
    normalized.includes('msword') ||
    normalized.includes('application/rtf') ||
    normalized.includes('text/rtf') ||
    normalized.includes('opendocument.text')
  ) {
    return 'docx';
  }

  if (normalized.includes('zip') || normalized.includes('compressed')) {
    return 'zip';
  }
  if (normalized.includes('video/')) {
    return 'mp4';
  }
  if (normalized.includes('audio/')) {
    return 'mp3';
  }

  return undefined;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (error) {
    // Ignore cleanup errors.
  }
}

export async function fetchExternalResource(
  url: string,
  options: ExternalFetchOptions,
  fetchImpl: ExternalFetchLike = fetch
): Promise<ExternalFetchResult> {
  const timeoutMs = clamp(Math.floor(options.timeoutMs), 2_000, 60_000);
  const maxRetries = clamp(Math.floor(options.maxRetries ?? 2), 0, 5);
  const maxRedirects = clamp(Math.floor(options.maxRedirects ?? 5), 0, 10);
  const dnsLookupImpl = options.dnsLookup ?? lookup;
  const dnsCache = new Map<string, string | null>();

  const initialValidation = await validateOutboundRequestUrl(url, url, {
    dnsLookup: dnsLookupImpl,
    dnsCache
  });
  if (!initialValidation.allowed) {
    return {
      requestedUrl: url,
      error: initialValidation.reason ?? 'Blocked outbound URL target.',
      blockedReason: initialValidation.reason ?? 'Blocked outbound URL target.'
    };
  }

  const requestedUrl = initialValidation.normalizedUrl ?? url;
  let lastError: unknown;

  attemptLoop: for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const timeout = createTimeoutSignal(timeoutMs);

    try {
      let currentUrl = requestedUrl;
      const seenRedirects = new Set<string>([requestedUrl]);

      for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
        const currentValidation = await validateOutboundRequestUrl(currentUrl, currentUrl, {
          dnsLookup: dnsLookupImpl,
          dnsCache
        });
        if (!currentValidation.allowed) {
          return {
            requestedUrl,
            finalUrl: currentValidation.normalizedUrl ?? currentUrl,
            error: currentValidation.reason ?? 'Blocked outbound URL target.',
            blockedReason: currentValidation.reason ?? 'Blocked outbound URL target.'
          };
        }

        const safeCurrentUrl = currentValidation.normalizedUrl ?? currentUrl;

        const response = await fetchImpl(safeCurrentUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'User-Agent': USER_AGENT
          },
          signal: timeout.signal
        });

        if (isRedirectStatus(response.status)) {
          const nextLocation = resolveRedirectLocation(response, safeCurrentUrl);
          await cancelResponseBody(response);

          if (!nextLocation) {
            return {
              requestedUrl,
              finalUrl: safeCurrentUrl,
              status: response.status,
              error: 'Received redirect response without a valid Location header.'
            };
          }

          const nextValidation = await validateOutboundRequestUrl(nextLocation, safeCurrentUrl, {
            dnsLookup: dnsLookupImpl,
            dnsCache
          });
          if (!nextValidation.allowed) {
            return {
              requestedUrl,
              finalUrl: nextValidation.normalizedUrl ?? nextLocation,
              status: response.status,
              error: nextValidation.reason ?? 'Blocked outbound URL target.',
              blockedReason: nextValidation.reason ?? 'Blocked outbound URL target.'
            };
          }

          const nextUrl = nextValidation.normalizedUrl ?? nextLocation;
          if (seenRedirects.has(nextUrl)) {
            return {
              requestedUrl,
              finalUrl: nextUrl,
              status: response.status,
              error: 'Redirect loop detected.'
            };
          }

          if (redirectCount >= maxRedirects) {
            return {
              requestedUrl,
              finalUrl: nextUrl,
              status: response.status,
              error: `Too many redirects (max ${maxRedirects}).`
            };
          }

          seenRedirects.add(nextUrl);
          currentUrl = nextUrl;
          continue;
        }

        const responseUrl = response.url && response.url.length > 0 ? response.url : safeCurrentUrl;
        const finalValidation = await validateOutboundRequestUrl(responseUrl, safeCurrentUrl, {
          dnsLookup: dnsLookupImpl,
          dnsCache
        });
        if (!finalValidation.allowed) {
          await cancelResponseBody(response);

          return {
            requestedUrl,
            finalUrl: finalValidation.normalizedUrl ?? responseUrl,
            status: response.status,
            error: finalValidation.reason ?? 'Blocked outbound URL target.',
            blockedReason: finalValidation.reason ?? 'Blocked outbound URL target.'
          };
        }

        const finalUrl = finalValidation.normalizedUrl ?? responseUrl;
        const contentType = normalizeContentType(response);

        if (isRetryableStatus(response.status) && attempt < maxRetries) {
          await cancelResponseBody(response);
          await sleep(retryDelayMs(attempt));
          continue attemptLoop;
        }

        if (!response.ok) {
          let bodyText: string | undefined;
          if (contentTypeLooksHtml(contentType)) {
            bodyText = await response.text();
          } else {
            await cancelResponseBody(response);
          }

          return {
            requestedUrl,
            finalUrl,
            status: response.status,
            contentType,
            html: bodyText
          };
        }

        if (contentTypeLooksHtml(contentType)) {
          const html = await response.text();

          return {
            requestedUrl,
            finalUrl,
            status: response.status,
            contentType,
            html
          };
        }

        if (!contentType && !responseLooksLikeDownload(response, finalUrl)) {
          const html = await response.text();

          return {
            requestedUrl,
            finalUrl,
            status: response.status,
            contentType,
            html
          };
        }

        await cancelResponseBody(response);

        const ext =
          inferExtension(finalUrl) ??
          inferExtensionFromContentDisposition(response.headers.get('content-disposition') ?? undefined) ??
          contentTypeToExtension(contentType);
        const directLink: ExternalDownloadResolutionLink = {
          url: finalUrl,
          ext,
          confidence: classifyDirectLinkConfidence(finalUrl, ext)
        };

        return {
          requestedUrl,
          finalUrl,
          status: response.status,
          contentType,
          directLink
        };
      }
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
    requestedUrl,
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

const EXTERNAL_DOWNLOADS_DEFAULT_MAX_PAGES = 20;
const EXTERNAL_DOWNLOADS_MAX_PAGES = 100;
const EXTERNAL_DOWNLOADS_DEFAULT_MAX_LINKS_PER_PAGE = 50;
const EXTERNAL_DOWNLOADS_MAX_LINKS_PER_PAGE = 200;
const EXTERNAL_DOWNLOADS_DEFAULT_TIMEOUT_MS = 15_000;
const EXTERNAL_DOWNLOADS_MIN_TIMEOUT_MS = 2_000;
const EXTERNAL_DOWNLOADS_MAX_TIMEOUT_MS = 60_000;

type ExternalDownloadToolDependencies = ToolDependencies & {
  fetchImpl?: ExternalFetchLike;
};

function clampInteger(value: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.min(max, Math.max(min, normalized));
}

function getMaterialSourceUrl(material: CourseMaterial): string | undefined {
  const preferredRef =
    material.item_refs.find((entry) => entry.external_url || entry.url || entry.html_url) ??
    material.item_refs[0];

  const rawSource =
    material.external?.url ??
    material.external?.html_url ??
    preferredRef?.external_url ??
    preferredRef?.url ??
    preferredRef?.html_url;

  if (!rawSource) {
    return undefined;
  }

  const baseCandidates = [
    preferredRef?.html_url,
    preferredRef?.url,
    preferredRef?.external_url,
    process.env.CANVAS_BASE_URL
  ];

  const direct = toAbsoluteHttpUrl(rawSource, rawSource);
  if (direct) {
    return direct;
  }

  for (const base of baseCandidates) {
    if (!base) {
      continue;
    }

    const normalized = toAbsoluteHttpUrl(rawSource, base);
    if (normalized) {
      return normalized;
    }
  }

  return rawSource;
}

function getSessionlessLaunchBaseUrls(): string[] {
  const candidates: string[] = [];

  const canvasBase = process.env.CANVAS_BASE_URL;
  if (canvasBase) {
    const normalizedCanvasBase = toAbsoluteHttpUrl(canvasBase, canvasBase);
    if (normalizedCanvasBase) {
      candidates.push(normalizedCanvasBase);

      try {
        candidates.push(new URL(normalizedCanvasBase).origin);
      } catch (error) {
        // Ignore malformed base URL fallback.
      }
    }
  }

  if (candidates.length === 0) {
    candidates.push('https://canvas.invalid/');
  }

  return Array.from(new Set(candidates));
}

function parseLaunchUrl(payload: unknown, baseUrls: string[]): string | undefined {
  const candidates: unknown[] = [];

  if (typeof payload === 'string') {
    candidates.push(payload);
  } else if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>;
    candidates.push(
      value.url,
      value.launch_url,
      value.sessionless_launch_url,
      value.html_url,
      value.target_link_uri
    );
  }

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const direct = toAbsoluteHttpUrl(candidate, candidate);
    if (direct) {
      return direct;
    }

    for (const baseUrl of baseUrls) {
      const normalized = toAbsoluteHttpUrl(candidate, baseUrl);
      if (normalized) {
        return normalized;
      }
    }
  }

  return undefined;
}

async function resolveExternalToolLaunchUrl(args: {
  material: CourseMaterial;
  courseId: number;
  deps: ExternalDownloadToolDependencies;
  meta: MetaAccumulator;
}): Promise<{ launchUrl?: string; reason?: string }> {
  const sourceUrl = getMaterialSourceUrl(args.material);

  const strategies: Array<{ params: Record<string, unknown>; label: string }> = [];
  for (const itemRef of args.material.item_refs) {
    if (typeof itemRef.content_id === 'number') {
      strategies.push({
        params: { id: itemRef.content_id },
        label: `id=${itemRef.content_id}`
      });
    }
  }

  if (sourceUrl) {
    strategies.push({
      params: { url: sourceUrl },
      label: 'url=<source>'
    });
  }

  if (strategies.length === 0) {
    return {
      reason: 'No launch identifier was available for this external tool item.'
    };
  }

  let lastReason: string | undefined;
  const launchBaseUrls = getSessionlessLaunchBaseUrls();

  for (const strategy of strategies) {
    try {
      const launchResult = await args.deps.canvas.get<Record<string, unknown>>(
        `/api/v1/courses/${args.courseId}/external_tools/sessionless_launch`,
        strategy.params
      );
      args.meta.statuses.push(launchResult.status);
      if (launchResult.requestIds) {
        args.meta.requestIds.push(...launchResult.requestIds);
      } else if (launchResult.requestId) {
        args.meta.requestIds.push(launchResult.requestId);
      }

      const launchUrl = parseLaunchUrl(launchResult.data, launchBaseUrls);
      if (launchUrl) {
        return { launchUrl };
      }

      lastReason =
        'Canvas sessionless launch endpoint responded without a usable launch URL.';
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        const maybeCode = (error as { code?: string }).code;
        if (maybeCode === 'AUTHORIZATION_FAILED') {
          return {
            reason:
              'Canvas denied sessionless launch for this external tool. A browser-based launch is likely required.'
          };
        }

        if (maybeCode === 'NOT_FOUND' || maybeCode === 'BAD_REQUEST') {
          lastReason =
            'Canvas sessionless launch endpoint did not resolve this tool by id/url.';
          continue;
        }
      }

      lastReason =
        error instanceof Error
          ? `Failed to resolve external tool launch URL (${strategy.label}): ${error.message}`
          : `Failed to resolve external tool launch URL (${strategy.label}).`;
    }
  }

  return {
    reason:
      lastReason ??
      'Unable to resolve an API-based launch URL for this external tool; browser fallback is likely required.'
  };
}

function classifyHttpFailureStatus(
  status: number,
  type: 'ExternalUrl' | 'ExternalTool'
): ResolveExternalDownloadsMaterialResult['status'] {
  if (status === 401 || status === 403) {
    return type === 'ExternalTool' ? 'needs_browser_fallback' : 'blocked';
  }

  return status >= 500 ? 'partial' : 'error';
}

async function resolveExternalMaterialLinks(args: {
  material: CourseMaterial;
  courseId: number;
  timeoutMs: number;
  maxLinksPerPage: number;
  deps: ExternalDownloadToolDependencies;
  meta: MetaAccumulator;
}): Promise<{ result: ResolveExternalDownloadsMaterialResult; linksTruncated: boolean }> {
  const sourceUrl = getMaterialSourceUrl(args.material);

  const baseResult: ResolveExternalDownloadsMaterialResult = {
    key: args.material.key,
    type: args.material.type === 'ExternalTool' ? 'ExternalTool' : 'ExternalUrl',
    title: args.material.title,
    source_url: sourceUrl ?? '',
    status: 'error',
    links: []
  };

  if (!sourceUrl) {
    return {
      result: {
        ...baseResult,
        reason: 'No source URL was available for this material.'
      },
      linksTruncated: false
    };
  }

  let targetUrl = sourceUrl;
  if (args.material.type === 'ExternalTool') {
    const launchResolution = await resolveExternalToolLaunchUrl({
      material: args.material,
      courseId: args.courseId,
      deps: args.deps,
      meta: args.meta
    });

    if (!launchResolution.launchUrl) {
      return {
        result: {
          ...baseResult,
          status: 'needs_browser_fallback',
          reason:
            launchResolution.reason ??
            'Unable to resolve a sessionless launch URL for this external tool.',
          source_url: sourceUrl
        },
        linksTruncated: false
      };
    }

    targetUrl = launchResolution.launchUrl;
    baseResult.resolved_url = targetUrl;
  }

  const outboundValidation = validateOutboundHttpUrl(targetUrl, targetUrl);
  if (!outboundValidation.allowed) {
    return {
      result: {
        ...baseResult,
        status: args.material.type === 'ExternalTool' ? 'needs_browser_fallback' : 'blocked',
        source_url: sourceUrl,
        resolved_url: outboundValidation.normalizedUrl ?? baseResult.resolved_url,
        reason: outboundValidation.reason ?? 'Blocked outbound URL target.'
      },
      linksTruncated: false
    };
  }

  const validatedTargetUrl = outboundValidation.normalizedUrl ?? targetUrl;
  if (args.material.type === 'ExternalTool') {
    baseResult.resolved_url = validatedTargetUrl;
  }

  const fetched = await fetchExternalResource(
    validatedTargetUrl,
    {
      timeoutMs: args.timeoutMs,
      maxRetries: 2
    },
    args.deps.fetchImpl
  );

  if (fetched.blockedReason) {
    return {
      result: {
        ...baseResult,
        status: args.material.type === 'ExternalTool' ? 'needs_browser_fallback' : 'blocked',
        reason: fetched.blockedReason,
        source_url: sourceUrl,
        resolved_url: fetched.finalUrl ?? baseResult.resolved_url
      },
      linksTruncated: false
    };
  }

  if (fetched.error) {
    const status = args.material.type === 'ExternalTool' ? 'needs_browser_fallback' : 'error';
    return {
      result: {
        ...baseResult,
        status,
        reason: fetched.error,
        source_url: sourceUrl,
        resolved_url: fetched.finalUrl ?? baseResult.resolved_url
      },
      linksTruncated: false
    };
  }

  const responseStatus = fetched.status ?? 0;
  if (responseStatus >= 400) {
    const status = classifyHttpFailureStatus(responseStatus, baseResult.type);

    return {
      result: {
        ...baseResult,
        status,
        source_url: sourceUrl,
        resolved_url: fetched.finalUrl ?? baseResult.resolved_url,
        reason: `HTTP ${responseStatus} while fetching external content.`
      },
      linksTruncated: false
    };
  }

  if (fetched.directLink) {
    const deduped = dedupeResolvedLinks([fetched.directLink]);
    return {
      result: {
        ...baseResult,
        status: deduped.length > 0 ? 'ok' : 'partial',
        source_url: sourceUrl,
        resolved_url: fetched.finalUrl ?? baseResult.resolved_url,
        links: deduped,
        reason: deduped.length > 0 ? undefined : 'Direct download URL was already deduplicated.'
      },
      linksTruncated: false
    };
  }

  const extraction = extractExternalDownloadLinksFromHtml(fetched.html, {
    baseUrl: fetched.finalUrl ?? validatedTargetUrl,
    maxLinks: args.maxLinksPerPage
  });

  const links = dedupeResolvedLinks(extraction.links);

  if (links.length === 0) {
    const fallbackReason = classifyBrowserFallbackReason(fetched.html);

    if (args.material.type === 'ExternalTool' || fallbackReason) {
      return {
        result: {
          ...baseResult,
          status: 'needs_browser_fallback',
          source_url: sourceUrl,
          resolved_url: fetched.finalUrl ?? baseResult.resolved_url,
          reason:
            fallbackReason ??
            'No downloadable links were detected from the API-resolved external tool page.',
          links
        },
        linksTruncated: extraction.truncated
      };
    }

    return {
      result: {
        ...baseResult,
        status: 'partial',
        source_url: sourceUrl,
        resolved_url: fetched.finalUrl ?? baseResult.resolved_url,
        reason: 'No candidate download links were detected in the fetched HTML.',
        links
      },
      linksTruncated: extraction.truncated
    };
  }

  return {
    result: {
      ...baseResult,
      status: extraction.truncated ? 'partial' : 'ok',
      source_url: sourceUrl,
      resolved_url: fetched.finalUrl ?? baseResult.resolved_url,
      reason: extraction.truncated
        ? 'Link extraction was truncated by max_links_per_page.'
        : undefined,
      links
    },
    linksTruncated: extraction.truncated
  };
}

export function registerResolveExternalDownloads(
  server: McpServer,
  deps: ExternalDownloadToolDependencies
): void {
  server.registerTool(
    'resolve_external_downloads',
    {
      title: 'Resolve External Downloads',
      description:
        'Resolve ExternalUrl/ExternalTool module items and extract candidate downloadable links using API-first HTTP fetching.',
      inputSchema: resolveExternalDownloadsInputSchema.shape,
      outputSchema: resolveExternalDownloadsOutputSchema.shape
    },
    wrapTool(
      'resolve_external_downloads',
      async (args: {
        course_id: number;
        material_keys?: string[];
        max_pages?: number;
        max_links_per_page?: number;
        timeout_ms?: number;
      }) => {
        const maxPages = clampInteger(
          args.max_pages ?? EXTERNAL_DOWNLOADS_DEFAULT_MAX_PAGES,
          1,
          EXTERNAL_DOWNLOADS_MAX_PAGES
        );
        const maxLinksPerPage = clampInteger(
          args.max_links_per_page ?? EXTERNAL_DOWNLOADS_DEFAULT_MAX_LINKS_PER_PAGE,
          1,
          EXTERNAL_DOWNLOADS_MAX_LINKS_PER_PAGE
        );
        const timeoutMs = clampInteger(
          args.timeout_ms ?? EXTERNAL_DOWNLOADS_DEFAULT_TIMEOUT_MS,
          EXTERNAL_DOWNLOADS_MIN_TIMEOUT_MS,
          EXTERNAL_DOWNLOADS_MAX_TIMEOUT_MS
        );

        const meta: MetaAccumulator = {
          statuses: [],
          requestIds: []
        };

        const collected = await collectCourseMaterialsFromModules({
          courseId: args.course_id,
          includeTypes: new Set<MaterialType>(['ExternalUrl', 'ExternalTool']),
          deps,
          meta
        });

        const materialsByKey = new Map(collected.materials.map((material) => [material.key, material]));

        let candidates: CourseMaterial[];
        if (args.material_keys && args.material_keys.length > 0) {
          const seen = new Set<string>();
          candidates = [];

          for (const key of args.material_keys) {
            if (!key || seen.has(key)) {
              continue;
            }
            seen.add(key);

            const material = materialsByKey.get(key);
            if (material) {
              candidates.push(material);
            }
          }
        } else {
          candidates = [...collected.materials].sort((a, b) => a.key.localeCompare(b.key));
        }

        const truncatedByPages = candidates.length > maxPages;
        const processQueue = candidates.slice(0, maxPages);
        const globalSeenLinks = new Set<string>();

        let truncated = truncatedByPages;
        const results: ResolveExternalDownloadsMaterialResult[] = [];

        for (const material of processQueue) {
          const { result, linksTruncated } = await resolveExternalMaterialLinks({
            material,
            courseId: args.course_id,
            timeoutMs,
            maxLinksPerPage,
            deps,
            meta
          });

          const globallyDedupedLinks = dedupeResolvedLinks(result.links, globalSeenLinks);
          let normalizedResult: ResolveExternalDownloadsMaterialResult = {
            ...result,
            links: globallyDedupedLinks
          };

          if (
            result.status === 'ok' &&
            result.links.length > 0 &&
            globallyDedupedLinks.length === 0
          ) {
            normalizedResult = {
              ...normalizedResult,
              status: 'partial',
              reason: 'All discovered links were duplicates of earlier materials.'
            };
          }

          normalizedResult = finalizeResultStatus(normalizedResult, {
            linksTruncated
          });

          if (linksTruncated) {
            truncated = true;
          }

          results.push(normalizedResult);
        }

        const totalLinks = results.reduce((sum, entry) => sum + entry.links.length, 0);

        const payload = resolveExternalDownloadsOutputSchema.parse({
          course_id: args.course_id,
          processed_materials: results.length,
          results,
          total_links: totalLinks,
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
