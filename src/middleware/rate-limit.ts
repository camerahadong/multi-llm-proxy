import type { RuntimeConfig } from '../config/runtime.js';
import type { AuthContext } from './auth.js';

interface Bucket {
  timestamps: number[];
}

/**
 * Per-key sliding-window rate limit. Each API key gets its own bucket. Local
 * (no-key) requests share a single "local" bucket. The limit is taken from
 * (in order): `apiKeys[].rpm` → `rateLimit.perKey[app]` → `rateLimit.defaultRpm`.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly runtime: RuntimeConfig) {}

  private bucketFor(ctx: AuthContext): { id: string; limit: number } {
    const cfg = this.runtime.get();
    const id = ctx.apiKey ?? `local:${ctx.app}`;
    const limit = ctx.rpmOverride ?? cfg.rateLimit.perKey[ctx.app] ?? cfg.rateLimit.defaultRpm;
    return { id, limit };
  }

  check(ctx: AuthContext): { ok: true } | { ok: false; limit: number; retryAfter: number } {
    const { id, limit } = this.bucketFor(ctx);
    const now = Date.now();
    const bucket = this.buckets.get(id) ?? { timestamps: [] };
    while (bucket.timestamps.length > 0 && bucket.timestamps[0] < now - 60_000) {
      bucket.timestamps.shift();
    }
    if (bucket.timestamps.length >= limit) {
      // floor+1 (not ceil): guarantees the oldest timestamp has left the window
      // when the client retries exactly Retry-After seconds later.
      const retryAfter = Math.max(1, Math.floor((bucket.timestamps[0] + 60_000 - now) / 1000) + 1);
      return { ok: false, limit, retryAfter };
    }
    bucket.timestamps.push(now);
    this.buckets.set(id, bucket);
    return { ok: true };
  }
}
