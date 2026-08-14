import type { BackendRegistry } from '../backends/registry.js';
import type { AgentService } from '../agent/service.js';
import type { RuntimeConfig } from '../config/runtime.js';
import type { MetricsRegistry } from '../lib/metrics.js';
import type { StatsStore } from '../lib/stats-store.js';
import type { IdempotencyStore } from '../middleware/idempotency.js';
import type { RateLimiter } from '../middleware/rate-limit.js';

export interface AppContext {
  agent: AgentService;
  runtime: RuntimeConfig;
  backends: BackendRegistry;
  stats: StatsStore;
  rate: RateLimiter;
  idempotency: IdempotencyStore;
  metrics: MetricsRegistry;
}
