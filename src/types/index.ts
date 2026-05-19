import type { BackendRegistry } from '../backends/registry.js';
import type { RuntimeConfig } from '../config/runtime.js';
import type { MetricsRegistry } from '../lib/metrics.js';
import type { StatsStore } from '../lib/stats-store.js';
import type { IdempotencyStore } from '../middleware/idempotency.js';
import type { RateLimiter } from '../middleware/rate-limit.js';

export interface AppContext {
  runtime: RuntimeConfig;
  backends: BackendRegistry;
  stats: StatsStore;
  rate: RateLimiter;
  idempotency: IdempotencyStore;
  metrics: MetricsRegistry;
}
