import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as undici from 'undici';

import { CanvasClient } from '../canvas/client.js';

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof undici>('undici');
  return {
    ...actual,
    fetch: vi.fn()
  };
});

const fetchMock = vi.mocked(undici.fetch);

function createAbortableFetch(): any {
  return (_input: any, init?: any) =>
    new Promise((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        const error = new Error('aborted');
        (error as { name?: string }).name = 'AbortError';
        reject(error);
        return;
      }

      signal?.addEventListener(
        'abort',
        () => {
          const error = new Error('aborted');
          (error as { name?: string; code?: string }).name = 'AbortError';
          (error as { code?: string }).code = 'UND_ERR_ABORTED';
          reject(error);
        },
        { once: true }
      );
    });
}

describe('CanvasClient timeouts', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries on timeout and eventually succeeds', async () => {
    const response = new undici.Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });

    fetchMock
      .mockImplementationOnce(createAbortableFetch())
      .mockResolvedValueOnce(response);

    const client = new CanvasClient({
      baseUrl: 'https://canvas.example.com',
      pat: 'token',
      maxRetries: 1,
      httpTimeoutMs: 10
    });

    const resultPromise = client.get<{ ok: boolean }>('/api/v1/test');

    await vi.advanceTimersByTimeAsync(15);
    await vi.advanceTimersByTimeAsync(250);

    const result = await resultPromise;

    expect(result.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces timeout as AppError after retries are exhausted', async () => {
    fetchMock.mockImplementation(createAbortableFetch());

    const client = new CanvasClient({
      baseUrl: 'https://canvas.example.com',
      pat: 'token',
      maxRetries: 0,
      httpTimeoutMs: 5
    });

    const resultPromise = client.get('/api/v1/test');
    const rejectionAssertion = expect(resultPromise).rejects.toMatchObject({
      code: 'CANVAS_UNAVAILABLE',
      data: {
        details: {
          timeoutMs: 5
        }
      }
    });

    await vi.advanceTimersByTimeAsync(10);
    await rejectionAssertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
