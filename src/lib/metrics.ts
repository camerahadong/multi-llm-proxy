import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { BackendRegistry } from '../backends/registry.js';

export class MetricsRegistry {
  readonly registry = new Registry();
  readonly requestsTotal: Counter<'backend' | 'model' | 'status'>;
  readonly requestDuration: Histogram<'backend' | 'model'>;
  readonly backendQueueDepth: Histogram<'backend'>;
  readonly backendBusyTotal: Counter<'backend'>;
  readonly backendState: Gauge<'backend' | 'kind'>;

  constructor(backends: BackendRegistry) {
    collectDefaultMetrics({ register: this.registry });

    this.requestsTotal = new Counter({
      name: 'proxy_requests_total',
      help: 'Total proxy requests by backend, model, and outcome.',
      labelNames: ['backend', 'model', 'status'] as const,
      registers: [this.registry],
    });

    this.requestDuration = new Histogram({
      name: 'proxy_request_duration_ms',
      help: 'Proxy request duration (ms) by backend and model.',
      labelNames: ['backend', 'model'] as const,
      buckets: [100, 250, 500, 1000, 2000, 5000, 10_000, 20_000, 40_000, 90_000],
      registers: [this.registry],
    });

    this.backendQueueDepth = new Histogram({
      name: 'proxy_backend_queue_depth',
      help: 'Snapshot of backend queue depth on request arrival.',
      labelNames: ['backend'] as const,
      buckets: [0, 1, 2, 4, 8, 16, 32],
      registers: [this.registry],
    });

    this.backendBusyTotal = new Counter({
      name: 'proxy_backend_busy_total',
      help: 'Number of 429 responses caused by full backend queues.',
      labelNames: ['backend'] as const,
      registers: [this.registry],
    });

    // Live snapshot. `collect` is invoked on every /metrics scrape.
    this.backendState = new Gauge({
      name: 'proxy_backend_state',
      help: 'Live snapshot of backend pool state (kind = pool_size | in_flight | queue_depth | p50_latency_ms | p95_latency_ms).',
      labelNames: ['backend', 'kind'] as const,
      registers: [this.registry],
      collect() {
        for (const adapter of backends.all()) {
          const s = adapter.stats();
          this.set({ backend: adapter.name, kind: 'pool_size' }, s.poolSize);
          this.set({ backend: adapter.name, kind: 'in_flight' }, s.inFlight);
          this.set({ backend: adapter.name, kind: 'queue_depth' }, s.queueDepth);
          this.set({ backend: adapter.name, kind: 'p50_latency_ms' }, s.p50LatencyMs);
          this.set({ backend: adapter.name, kind: 'p95_latency_ms' }, s.p95LatencyMs);
        }
      },
    });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
