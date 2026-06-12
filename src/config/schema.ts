import { z } from 'zod';

export const apiKeyEntrySchema = z.union([
  z.string(),
  z.object({
    key: z.string().min(8),
    app: z.string().optional(),
    rpm: z.number().int().positive().optional(),
  }),
]);

export const poolConfigSchema = z.object({
  size: z.number().int().min(1).max(32).default(4),
  maxQueue: z.number().int().min(0).max(256).default(8),
});

export const configSchema = z.object({
  defaultModel: z.string().default('claude-sonnet-4-6'),
  timeoutSeconds: z.number().int().min(30).max(3600).default(900),
  bodyLimitMb: z.number().int().min(1).max(100).default(50),
  allowedOrigins: z.array(z.string()).default(['*']),
  enableLogging: z.boolean().default(true),

  pools: z
    .object({
      claude: poolConfigSchema.default({ size: 4, maxQueue: 8 }),
      codex: poolConfigSchema.default({ size: 2, maxQueue: 4 }),
    })
    .default({
      claude: { size: 4, maxQueue: 8 },
      codex: { size: 2, maxQueue: 4 },
    }),

  rateLimit: z
    .object({
      defaultRpm: z.number().int().positive().default(60),
      perKey: z.record(z.string(), z.number().int().positive()).default({}),
    })
    .default({ defaultRpm: 60, perKey: {} }),

  idempotency: z
    .object({
      ttlSeconds: z.number().int().min(10).max(3600).default(300),
      maxEntries: z.number().int().min(10).max(10000).default(1000),
    })
    .default({ ttlSeconds: 300, maxEntries: 1000 }),

  imageCache: z
    .object({
      ttlSeconds: z.number().int().min(10).max(3600).default(600),
      maxEntries: z.number().int().min(10).max(10000).default(200),
    })
    .default({ ttlSeconds: 600, maxEntries: 200 }),

  apiKeys: z.array(apiKeyEntrySchema).default([]),
});

export type ApiKeyEntry = z.infer<typeof apiKeyEntrySchema>;
export type PoolConfig = z.infer<typeof poolConfigSchema>;
export type AppConfig = z.infer<typeof configSchema>;

export function normalizeApiKey(entry: ApiKeyEntry): { key: string; app: string | null; rpm: number | null } {
  if (typeof entry === 'string') return { key: entry, app: null, rpm: null };
  return { key: entry.key, app: entry.app ?? null, rpm: entry.rpm ?? null };
}
