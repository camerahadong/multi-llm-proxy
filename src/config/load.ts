import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';
import { configSchema, type AppConfig } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const CONFIG_FILE = path.join(PROJECT_ROOT, 'config.json');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const GUIDE_FILE = path.join(PROJECT_ROOT, 'API_GUIDE.md');

function loadEnvFile(): void {
  try {
    const text = readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf-8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env file is fine */
  }
}

export function loadConfig(): AppConfig {
  loadEnvFile();
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'config.json not found or invalid — using defaults');
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues }, 'config validation failed');
    throw new Error('Invalid config.json. See logged issues.');
  }
  return parsed.data;
}
