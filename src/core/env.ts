import { config } from 'dotenv';
import { z } from 'zod';

config();

const envSchema = z
  .object({
    CANVAS_BASE_URL: z.string().url(),
    CANVAS_PAT: z.string().trim().optional(),
    CANVAS_CLIENT_ID: z.string().trim().optional(),
    CANVAS_CLIENT_SECRET: z.string().trim().optional(),
    CANVAS_ACCESS_TOKEN: z.string().trim().optional(),
    CANVAS_REFRESH_TOKEN: z.string().trim().optional(),
    CANVAS_HTTP_TIMEOUT_MS: z
      .preprocess(
        (value) => {
          if (value === undefined || value === null || value === '') {
            return undefined;
          }
          return value;
        },
        z.coerce.number().int().min(1000).max(120000).optional()
      )
      .transform((value) => value ?? 15000),
    MCP_BEARER: z.string().trim().min(1, 'MCP_BEARER is required'),
    MCP_RATE_LIMIT_WINDOW_MS: numberFromEnv(60_000),
    MCP_RATE_LIMIT_MAX: numberFromEnv(30),
    MCP_MESSAGES_RATE_LIMIT_WINDOW_MS: numberFromEnv(60_000),
    MCP_MESSAGES_RATE_LIMIT_MAX: numberFromEnv(120),
    MCP_SESSION_TTL_MS: numberFromEnv(15 * 60_000),
    MCP_SESSION_CLEANUP_INTERVAL_MS: numberFromEnv(60_000),
    MCP_MAX_SESSIONS: optionalPositiveInt(),
    MCP_SSE_HEARTBEAT_MS: numberFromEnv(25_000),
    CANVAS_TIMEZONE: z
      .string()
      .optional()
      .transform((value) => value?.trim() || 'UTC')
      .pipe(
        z
          .string()
          .trim()
          .refine((value) => isValidTimeZone(value), {
            message: 'CANVAS_TIMEZONE must be a valid IANA time zone name.'
          })
      )
  })
  .superRefine((value, ctx) => {
    const hasPat = Boolean(value.CANVAS_PAT);
    const hasOAuth =
      Boolean(value.CANVAS_CLIENT_ID) &&
      Boolean(value.CANVAS_CLIENT_SECRET) &&
      Boolean(value.CANVAS_REFRESH_TOKEN);

    if (!hasPat && !hasOAuth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Provide either CANVAS_PAT or full OAuth credentials (client id/secret and refresh token).',
        path: ['CANVAS_PAT']
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema> & {
  canvasBaseUrl: string;
  canvasTimezone: string;
  canvasHttpTimeoutMs: number;
};

function numberFromEnv(defaultValue: number): z.ZodType<number, z.ZodTypeDef, unknown> {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === '') {
        return defaultValue;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    },
    z.number().int().nonnegative()
  );
}

function optionalPositiveInt(): z.ZodType<number | undefined, z.ZodTypeDef, unknown> {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === '') {
        return undefined;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    },
    z.number().int().positive().optional()
  );
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch (error) {
    return false;
  }
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

let cachedEnv: AppEnv | null = null;

export function loadEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }

  const canvasBaseUrl = normalizeBaseUrl(parsed.data.CANVAS_BASE_URL);

  cachedEnv = {
    ...parsed.data,
    canvasBaseUrl,
    canvasTimezone: parsed.data.CANVAS_TIMEZONE,
    canvasHttpTimeoutMs: parsed.data.CANVAS_HTTP_TIMEOUT_MS
  };

  return cachedEnv;
}

export function resetEnvCacheForTesting(): void {
  cachedEnv = null;
}
