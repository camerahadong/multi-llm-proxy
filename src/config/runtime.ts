import { writeFileSync } from 'node:fs';
import { logger } from '../lib/logger.js';
import { CONFIG_FILE } from './load.js';
import { configSchema, type AppConfig } from './schema.js';

/**
 * Holds the current mutable config. Routes/middleware should read via `get()`
 * so PUT /config updates take effect immediately without re-importing.
 */
export class RuntimeConfig {
  constructor(private state: AppConfig) {}

  get(): AppConfig {
    return this.state;
  }

  /** Merge a partial update, re-validate, persist. Returns the new config. */
  update(patch: Partial<AppConfig>): AppConfig {
    const merged = { ...this.state, ...patch };
    const parsed = configSchema.safeParse(merged);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Invalid config update: ${msg}`);
    }
    this.state = parsed.data;
    try {
      writeFileSync(CONFIG_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'failed to persist config.json');
    }
    return this.state;
  }

  /** Safe view: redacts API keys. */
  safeView(): AppConfig {
    return {
      ...this.state,
      apiKeys: this.state.apiKeys.map((k) =>
        typeof k === 'string' ? '***' : { ...k, key: '***' },
      ) as AppConfig['apiKeys'],
    };
  }
}
