/**
 * Copy config.json + data/ from ../claude-app into this project, mapping the
 * old flat config shape onto the new nested schema.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HERE = path.resolve(__dirname, '..');
const OLD = path.resolve(HERE, '..', 'claude-app');

if (!existsSync(OLD)) {
  console.error(`No legacy claude-app found at ${OLD}`);
  process.exit(1);
}

const oldConfigPath = path.join(OLD, 'config.json');
const newConfigPath = path.join(HERE, 'config.json');
const oldDataDir = path.join(OLD, 'data');
const newDataDir = path.join(HERE, 'data');

interface LegacyConfig {
  maxConcurrent?: number;
  defaultModel?: string;
  timeout?: number;
  rateLimitPerMinute?: number;
  apiKeys?: Array<string | { key: string; app?: string }>;
  allowedOrigins?: string[];
  enableLogging?: boolean;
}

if (existsSync(oldConfigPath)) {
  const legacy = JSON.parse(readFileSync(oldConfigPath, 'utf-8')) as LegacyConfig;
  const next = {
    defaultModel: legacy.defaultModel ?? 'claude-sonnet-4-6',
    timeoutSeconds: legacy.timeout ?? 900,
    allowedOrigins: legacy.allowedOrigins ?? ['*'],
    enableLogging: legacy.enableLogging ?? true,
    pools: {
      claude: { size: 4, maxQueue: 8 },
      codex: { size: 2, maxQueue: 4 },
      gemini: { size: 4, maxQueue: 8 },
    },
    rateLimit: { defaultRpm: legacy.rateLimitPerMinute ?? 60, perKey: {} },
    idempotency: { ttlSeconds: 300, maxEntries: 1000 },
    imageCache: { ttlSeconds: 600, maxEntries: 200 },
    apiKeys: (legacy.apiKeys ?? []).map((k) =>
      typeof k === 'string' ? k : { key: k.key, app: k.app, rpm: legacy.rateLimitPerMinute },
    ),
  };
  writeFileSync(newConfigPath, JSON.stringify(next, null, 2));
  console.log(`✓ config migrated: ${newConfigPath}`);
}

if (existsSync(oldDataDir)) {
  mkdirSync(newDataDir, { recursive: true });
  for (const f of ['stats.json', 'requests.log']) {
    const src = path.join(oldDataDir, f);
    if (existsSync(src)) {
      copyFileSync(src, path.join(newDataDir, f));
      console.log(`✓ data file copied: ${f}`);
    }
  }
}

const oldEnv = path.join(OLD, '.env');
const newEnv = path.join(HERE, '.env');
if (existsSync(oldEnv) && !existsSync(newEnv)) {
  copyFileSync(oldEnv, newEnv);
  console.log(`✓ .env copied`);
}

const oldGuide = path.join(OLD, 'API_GUIDE.md');
const newGuide = path.join(HERE, 'API_GUIDE.md');
if (existsSync(oldGuide) && !existsSync(newGuide)) {
  copyFileSync(oldGuide, newGuide);
  console.log(`✓ API_GUIDE.md copied`);
}

console.log('Migration complete.');
