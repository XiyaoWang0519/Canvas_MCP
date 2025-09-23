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
    MCP_BEARER: z.string().trim().min(1, 'MCP_BEARER is required')
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
};

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
    canvasBaseUrl
  };

  return cachedEnv;
}
