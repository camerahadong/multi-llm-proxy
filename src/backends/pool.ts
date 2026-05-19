import { logger } from '../lib/logger.js';
import { LatencyRing } from '../lib/ring-buffer.js';
import { BackendBusyError, BackendCancelledError } from './errors.js';
import type { BackendName, PoolStats } from './types.js';

type Task<T> = {
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
  signal: AbortSignal;
  enqueuedAt: number;
};

export interface PoolOptions {
  name: BackendName;
  size: number;
  maxQueue: number;
}

/**
 * Generic backend pool. Caps concurrent in-flight calls at `size`. Excess calls
 * wait in a FIFO queue capped at `maxQueue`. When the queue is full, `submit`
 * rejects immediately with `BackendBusyError` (the route maps it to HTTP 429).
 *
 * Cancellation: the caller's AbortSignal is honoured both while queued
 * (dropped before running) and while running (passed to the task).
 */
export class BackendPool {
  private inFlight = 0;
  private readonly queue: Task<unknown>[] = [];
  private readonly latency = new LatencyRing(100);
  private lastErrorTs: number | null = null;
  private lastErrorMessage: string | null = null;
  private statusLabel: PoolStats['status'] = 'unknown';
  private lastCheckedAt: string | null = null;

  constructor(public readonly opts: PoolOptions) {}

  resize(size: number, maxQueue: number): void {
    this.opts.size = size;
    this.opts.maxQueue = maxQueue;
    this.drain();
  }

  submit<T>(run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(new BackendCancelledError(this.opts.name));
        return;
      }
      if (this.inFlight >= this.opts.size && this.queue.length >= this.opts.maxQueue) {
        const retry = Math.max(1, Math.ceil(Math.max(this.latency.p95(), 1000) / 1000));
        reject(new BackendBusyError(this.opts.name, retry));
        return;
      }
      const task: Task<T> = {
        run,
        resolve,
        reject,
        signal,
        enqueuedAt: Date.now(),
      };
      this.queue.push(task as Task<unknown>);
      signal.addEventListener(
        'abort',
        () => {
          const idx = this.queue.indexOf(task as Task<unknown>);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new BackendCancelledError(this.opts.name));
          }
        },
        { once: true },
      );
      // Re-check after wiring listener: signal may have aborted between line 47
      // and addEventListener — without this check the task could be drained before
      // the abort handler fires.
      if (signal.aborted) {
        const idx = this.queue.indexOf(task as Task<unknown>);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          reject(new BackendCancelledError(this.opts.name));
          return;
        }
      }
      this.drain();
    });
  }

  private drain(): void {
    while (this.queue.length > 0 && this.inFlight < this.opts.size) {
      const task = this.queue.shift()!;
      if (task.signal.aborted) {
        task.reject(new BackendCancelledError(this.opts.name));
        continue;
      }
      this.inFlight++;
      const startedAt = Date.now();
      task
        .run(task.signal)
        .then(
          (v) => {
            this.latency.push(Date.now() - startedAt);
            this.statusLabel = 'ok';
            task.resolve(v);
          },
          (err) => {
            this.lastErrorTs = Date.now();
            this.lastErrorMessage = err instanceof Error ? err.message : String(err);
            this.statusLabel = err?.name === 'BackendCancelledError' ? this.statusLabel : 'error';
            task.reject(err);
          },
        )
        .finally(() => {
          this.inFlight--;
          this.drain();
        });
    }
  }

  markStatus(status: PoolStats['status'], message?: string): void {
    this.statusLabel = status;
    this.lastCheckedAt = new Date().toISOString();
    if (message) this.lastErrorMessage = message.slice(0, 240);
  }

  stats(): PoolStats {
    return {
      status: this.statusLabel,
      poolSize: this.opts.size,
      inFlight: this.inFlight,
      queueDepth: this.queue.length,
      p50LatencyMs: this.latency.p50(),
      p95LatencyMs: this.latency.p95(),
      lastErrorTs: this.lastErrorTs,
      lastErrorMessage: this.lastErrorMessage,
      checkedAt: this.lastCheckedAt,
    };
  }

  async shutdown(): Promise<void> {
    for (const task of this.queue.splice(0)) {
      task.reject(new BackendCancelledError(this.opts.name));
    }
    logger.info({ backend: this.opts.name }, 'pool drained');
  }
}
