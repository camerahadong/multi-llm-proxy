import { createHash } from 'node:crypto';
import type { RuntimeConfig } from '../config/runtime.js';
import { TtlLruCache } from '../lib/lru-cache.js';

interface CachedResponse {
  status: number;
  body: unknown;
}

export class IdempotencyStore {
  private cache: TtlLruCache<CachedResponse>;
  private currentTtl: number;

  constructor(private readonly runtime: RuntimeConfig) {
    const cfg = runtime.get().idempotency;
    this.cache = new TtlLruCache<CachedResponse>(cfg.maxEntries, cfg.ttlSeconds * 1000);
    this.currentTtl = cfg.ttlSeconds;
  }

  private reconfigureIfChanged(): void {
    const cfg = this.runtime.get().idempotency;
    if (cfg.ttlSeconds !== this.currentTtl) {
      this.cache = new TtlLruCache<CachedResponse>(cfg.maxEntries, cfg.ttlSeconds * 1000);
      this.currentTtl = cfg.ttlSeconds;
    }
  }

  private buildKey(idemHeader: string, route: string, body: unknown): string {
    const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
    return `${route}:${idemHeader}:${bodyHash}`;
  }

  get(idemHeader: string, route: string, body: unknown): CachedResponse | null {
    this.reconfigureIfChanged();
    return this.cache.get(this.buildKey(idemHeader, route, body)) ?? null;
  }

  set(idemHeader: string, route: string, body: unknown, response: CachedResponse): void {
    this.reconfigureIfChanged();
    this.cache.set(this.buildKey(idemHeader, route, body), response);
  }
}
