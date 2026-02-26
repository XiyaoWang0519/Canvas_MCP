import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { AppError } from '../core/errors.js';
import { logToolEvent } from '../core/logger.js';
import { CanvasClient } from '../canvas/client.js';

export interface ToolDependencies {
  canvas: CanvasClient;
}

export interface ToolMeta {
  status?: number;
  requestId?: string;
  requestIds?: string[];
}

export type ToolHandler<TArgs, TResult extends Record<string, unknown>> = (
  args: TArgs
) => Promise<{
  payload: TResult;
  meta: ToolMeta;
}>;

export function toMcpError(error: AppError | Error): McpError {
  if (error instanceof AppError) {
    return new McpError(ErrorCode.InternalError, error.message, {
      code: error.code,
      ...error.data
    });
  }

  return new McpError(ErrorCode.InternalError, error.message ?? 'Unexpected error');
}

export function wrapTool<TArgs, TResult extends Record<string, unknown>>(
  name: string,
  handler: ToolHandler<TArgs, TResult>
): (args: TArgs) => Promise<{ content: []; structuredContent: TResult }> {
  return async (args: TArgs) => {
    const start = Date.now();
    try {
      const { payload, meta } = await handler(args);
      logToolEvent('tool.completed', {
        tool: name,
        status: 'success',
        durationMs: Date.now() - start,
        canvasStatus: meta.status,
        requestId: meta.requestId,
        extraRequestIds: meta.requestIds
      });

      return {
        content: [],
        structuredContent: payload
      };
    } catch (error) {
      const duration = Date.now() - start;
      if (error instanceof AppError || error instanceof Error) {
        const wrapped = toMcpError(error);
        logToolEvent('tool.failed', {
          tool: name,
          status: 'error',
          durationMs: duration,
          canvasStatus: (error instanceof AppError && error.data?.canvasStatus) || undefined,
          requestId: (error instanceof AppError && error.data?.requestId) || undefined,
          error
        });
        throw wrapped;
      }

      logToolEvent('tool.failed', {
        tool: name,
        status: 'error',
        durationMs: duration,
        error: String(error)
      });
      throw new McpError(ErrorCode.InternalError, 'Unexpected error');
    }
  };
}

export function createConcurrencyLimiter(maxConcurrent: number) {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  let active = 0;
  const queue: Array<() => void> = [];

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const execute = () => {
        active += 1;
        fn()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            active -= 1;
            const next = queue.shift();
            if (next) {
              next();
            }
          });
      };

      if (active < limit) {
        execute();
      } else {
        queue.push(execute);
      }
    });
  };
}

export const fileToolInputSchema = {
  search_term: z.string().optional(),
  content_types: z
    .preprocess((value) => {
      if (Array.isArray(value)) {
        return value.join(',');
      }
      return value ?? undefined;
    }, z.string().optional()),
  sort: z.enum(['name', 'size', 'created_at', 'updated_at', 'content_type']).optional(),
  order: z.enum(['asc', 'desc']).optional()
} satisfies Record<string, z.ZodTypeAny>;

export type FileToolCommonArgs = {
  search_term?: string;
  content_types?: string;
  sort?: 'name' | 'size' | 'created_at' | 'updated_at' | 'content_type';
  order?: 'asc' | 'desc';
};

export function normalizeContentTypes(value: string | string[] | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const values = Array.isArray(value) ? value : value.split(',');

  const normalized = values
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

export function buildFileParams(args: FileToolCommonArgs): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  if (args.search_term) {
    params.search_term = args.search_term;
  }
  const contentTypes = normalizeContentTypes(args.content_types);
  if (contentTypes && contentTypes.length > 0) {
    params['content_types[]'] = contentTypes;
  }
  if (args.sort) {
    params.sort = args.sort;
  }
  if (args.order) {
    params.order = args.order;
  }

  return params;
}
