import { fetch, type Response } from 'undici';

import { sleep } from '../core/async.js';
import { canvasError, unknownError } from '../core/errors.js';
import { USER_AGENT } from '../core/meta.js';
import {
  CanvasAuthStrategy,
  createAuthStrategy
} from './auth.js';

export interface CanvasClientOptions {
  baseUrl: string;
  pat?: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  maxRetries?: number;
  defaultPerPage?: number;
}

export interface CanvasRequestOptions {
  signal?: AbortSignal;
}

export interface CanvasResult<T> {
  data: T;
  status: number;
  requestId?: string;
  requestIds?: string[];
}

export class CanvasClient {
  private readonly baseUrl: string;
  private readonly auth: CanvasAuthStrategy;
  private readonly maxRetries: number;
  private readonly defaultPerPage: number;

  constructor(options: CanvasClientOptions) {
    this.baseUrl = options.baseUrl;
    this.maxRetries = options.maxRetries ?? 3;
    this.defaultPerPage = options.defaultPerPage ?? 100;

    this.auth = createAuthStrategy({
      baseUrl: this.baseUrl,
      pat: options.pat,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      accessToken: options.accessToken,
      refreshToken: options.refreshToken
    });
  }

  async get<T>(
    path: string,
    params?: Record<string, unknown>,
    options?: CanvasRequestOptions
  ): Promise<CanvasResult<T>> {
    const url = this.buildUrl(path, params);
    const response = await this.fetchWithRetry(url, {
      method: 'GET',
      signal: options?.signal
    });

    return this.handleResponse<T>(response);
  }

  async getAll<T>(
    path: string,
    params?: Record<string, unknown>,
    options?: CanvasRequestOptions
  ): Promise<CanvasResult<T[]>> {
    const results: T[] = [];
    const requestIds: string[] = [];
    let status = 200;

    let nextUrl: URL | null = this.buildUrl(path, {
      per_page: this.defaultPerPage,
      ...params
    });

    while (nextUrl) {
      const response = await this.fetchWithRetry(nextUrl, {
        method: 'GET',
        signal: options?.signal
      });

      status = response.status;
      const requestId = response.headers.get('x-request-id') ?? undefined;
      if (requestId) {
        requestIds.push(requestId);
      }

      const { ok, payload } = await this.parsePayload(response);

      if (!ok) {
        const message = extractCanvasMessage(payload);
        throw canvasError(response.status, requestId, message, payload);
      }

      if (!Array.isArray(payload)) {
        throw unknownError('Expected a list response from Canvas.', payload);
      }

      results.push(...(payload as T[]));

      const links = parseLinkHeader(response.headers.get('link'));
      nextUrl = links.next ? new URL(links.next) : null;
    }

    return {
      data: results,
      status,
      requestId: requestIds.at(-1),
      requestIds: requestIds.length ? requestIds : undefined
    };
  }

  private buildUrl(path: string, params?: Record<string, unknown>): URL {
    const url = new URL(path, this.baseUrl);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) {
          continue;
        }

        if (Array.isArray(value)) {
          for (const entry of value) {
            url.searchParams.append(key, String(entry));
          }
        } else if (value instanceof Date) {
          url.searchParams.set(key, value.toISOString());
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url;
  }

  private async fetchWithRetry(
    url: URL,
    init: { method: string; signal?: AbortSignal },
    attempt = 0
  ): Promise<Response> {
    const headers = new Headers();
    headers.set('Accept', 'application/json');
    headers.set('User-Agent', USER_AGENT);
    headers.set('Authorization', await this.auth.getAuthorizationHeader());

    try {
      const response = await fetch(url, {
        ...init,
        headers
      });

      if (response.status === 401) {
        const refreshed = await this.auth.handleUnauthorized();
        if (refreshed && attempt < this.maxRetries) {
          return this.fetchWithRetry(url, init, attempt + 1);
        }
      }

      if (shouldRetry(response.status) && attempt < this.maxRetries) {
        await sleep(this.retryDelay(attempt, response.headers.get('retry-after')));
        return this.fetchWithRetry(url, init, attempt + 1);
      }

      return response;
    } catch (error) {
      if (attempt >= this.maxRetries) {
        throw error;
      }

      await sleep(this.retryDelay(attempt));
      return this.fetchWithRetry(url, init, attempt + 1);
    }
  }

  private async handleResponse<T>(response: Response): Promise<CanvasResult<T>> {
    const { ok, payload } = await this.parsePayload(response);
    const requestId = response.headers.get('x-request-id') ?? undefined;

    if (!ok) {
      const message = extractCanvasMessage(payload);
      throw canvasError(response.status, requestId, message, payload);
    }

    return {
      data: payload as T,
      status: response.status,
      requestId
    };
  }

  private async parsePayload(
    response: Response
  ): Promise<{ ok: boolean; payload: unknown }> {
    const text = await response.text();

    if (!text) {
      return { ok: response.ok, payload: null };
    }

    try {
      return { ok: response.ok, payload: JSON.parse(text) };
    } catch (error) {
      if (response.ok) {
        throw unknownError('Canvas returned an unexpected payload format.', {
          contentType: response.headers.get('content-type'),
          body: text
        });
      }

      return { ok: response.ok, payload: text };
    }
  }

  private retryDelay(attempt: number, retryAfter?: string | null): number {
    const parsedRetryAfter = parseRetryAfter(retryAfter);

    if (parsedRetryAfter !== null) {
      return parsedRetryAfter;
    }

    const base = 500 * Math.pow(2, attempt);
    const jitter = base * (0.5 + Math.random());
    return Math.min(5000, jitter);
  }
}

function shouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) {
    return null;
  }

  const seconds = Number(header);
  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }

  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }

  return null;
}

function parseLinkHeader(header: string | null): Record<string, string> {
  if (!header) {
    return {};
  }

  const entries: Record<string, string> = {};

  for (const part of header.split(',')) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      const [, url, rel] = match;
      entries[rel] = url;
    }
  }

  return entries;
}

function extractCanvasMessage(payload: unknown): string | undefined {
  if (!payload) {
    return undefined;
  }

  if (typeof payload === 'string') {
    return payload;
  }

  if (Array.isArray(payload)) {
    const [first] = payload;
    return extractCanvasMessage(first);
  }

  if (typeof payload !== 'object') {
    return undefined;
  }

  const anyPayload = payload as Record<string, unknown>;

  if (typeof anyPayload.message === 'string') {
    return anyPayload.message;
  }

  if (anyPayload.errors) {
    const errors = anyPayload.errors;

    if (typeof errors === 'string') {
      return errors;
    }

    if (Array.isArray(errors) && errors.length > 0) {
      const [first] = errors;
      if (typeof first === 'string') {
        return first;
      }
      if (first && typeof first === 'object') {
        const normalized = first as Record<string, unknown>;
        if (typeof normalized.message === 'string') {
          return normalized.message;
        }
        if (typeof normalized.detail === 'string') {
          return normalized.detail;
        }
      }
    }

    if (errors && typeof errors === 'object') {
      for (const value of Object.values(errors as Record<string, unknown>)) {
        const message = extractCanvasMessage(value);
        if (message) {
          return message;
        }
      }
    }
  }

  return undefined;
}
