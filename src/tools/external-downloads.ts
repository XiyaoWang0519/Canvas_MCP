import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
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

  if (a === 0) {
    return 'unspecified IPv4 address';
  }

  if (a === 127) {
    return 'loopback address';
  }

  if (a === 0) {
    return 'unspecified/current-network address';
  }

  if (a === 169 && b === 254) {
    return 'link-local address';
  }

  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return 'private RFC1918 address';
  }
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

        if (contentTypeLooksHtml(contentType) || !contentType) {
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

        const ext = inferExtension(finalUrl) ?? contentTypeToExtension(contentType);
        const directLink: ExternalDownloadResolutionLink = {
          url: finalUrl,
          ext,
          confidence: ext ? 'high' : 'medium'
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
