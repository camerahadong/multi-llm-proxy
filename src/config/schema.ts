import { z } from 'zod';

export const apiKeyEntrySchema = z.union([
  z.string(),
  z.object({
    key: z.string().min(8),
    app: z.string().optional(),
    rpm: z.number().int().positive().optional(),
    admin: z.boolean().optional(),
  }),
]);

export const poolConfigSchema = z.object({
  size: z.number().int().min(1).max(32).default(4),
  maxQueue: z.number().int().min(0).max(256).default(8),
});

export const agentConfigSchema = z.object({
  enabled: z.boolean().default(false),
  codexCommand: z.string().min(1).max(1024).default('codex'),
  defaultModel: z.string().min(1).max(128).default('gpt-5.6-terra'),
  allowedModels: z.array(z.string().min(1).max(128)).min(1).max(32).default([
    'gpt-6.1-sol',
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
  ]),
  defaultCwd: z.string().min(1).max(4096).default('.'),
  allowedRoots: z.array(z.string().min(1).max(4096)).max(64).default([]),
  writableRoots: z.array(z.string().min(1).max(4096)).max(64).default([]),
  defaultSandbox: z.enum(['read-only', 'workspace-write']).default('read-only'),
  allowNetwork: z.boolean().default(false),
  maxSessions: z.number().int().min(1).max(32).default(4),
  sessionTtlSeconds: z.number().int().min(60).max(86_400).default(3600),
  maxEventsPerSession: z.number().int().min(100).max(10_000).default(2000),
  rpcTimeoutSeconds: z.number().int().min(5).max(300).default(30),
}).default({
  enabled: false,
  codexCommand: 'codex',
  defaultModel: 'gpt-5.6-terra',
  allowedModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'],
  defaultCwd: '.',
  allowedRoots: [],
  writableRoots: [],
  defaultSandbox: 'read-only',
  allowNetwork: false,
  maxSessions: 4,
  sessionTtlSeconds: 3600,
  maxEventsPerSession: 2000,
  rpcTimeoutSeconds: 30,
});

export const configSchema = z.object({
  defaultModel: z.string().default('claude-sonnet-5-5'),
  /** GPT model used when Claude fails (quota/auth/error). Must be a Codex model. */
  fallbackModel: z.string().default('gpt-6-sol'),
  /** Only allow API access from these countries (via Cloudflare CF-IPCountry). LAN/localhost always allowed. */
  geoBlock: z
    .object({
      enabled: z.boolean().default(true),
      allowCountries: z.array(z.string()).default(['VN']),
      /** Public IPs allowed regardless of country (e.g. own VPS reaching us without Cloudflare). */
      allowIps: z.array(z.string()).default([]),
    })
    .default({ enabled: true, allowCountries: ['VN'], allowIps: [] }),
  timeoutSeconds: z.number().int().min(30).max(3600).default(900),
  bodyLimitMb: z.number().int().min(1).max(100).default(50),
  allowedOrigins: z.array(z.string()).default(['*']),
  enableLogging: z.boolean().default(true),

  pools: z
    .object({
      claude: poolConfigSchema.default({ size: 4, maxQueue: 8 }),
      codex: poolConfigSchema.default({ size: 4, maxQueue: 8 }),
    })
    .default({
      claude: { size: 4, maxQueue: 8 },
      codex: { size: 4, maxQueue: 8 },
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

  agent: agentConfigSchema,

  apiKeys: z.array(apiKeyEntrySchema).default([]),
});

export type ApiKeyEntry = z.infer<typeof apiKeyEntrySchema>;
export type PoolConfig = z.infer<typeof poolConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AppConfig = z.infer<typeof configSchema>;

export function normalizeApiKey(entry: ApiKeyEntry): { key: string; app: string | null; rpm: number | null; admin: boolean } {
  if (typeof entry === 'string') return { key: entry, app: null, rpm: null, admin: false };
  return { key: entry.key, app: entry.app ?? null, rpm: entry.rpm ?? null, admin: entry.admin === true };
}
