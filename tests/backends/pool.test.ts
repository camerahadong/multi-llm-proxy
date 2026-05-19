import { describe, expect, it } from 'vitest';
import { BackendPool } from '../../src/backends/pool.js';
import { BackendBusyError, BackendCancelledError } from '../../src/backends/errors.js';

function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('BackendPool', () => {
  it('caps concurrent in-flight at pool size', async () => {
    const pool = new BackendPool({ name: 'claude', size: 2, maxQueue: 10 });
    const gates = [defer(), defer(), defer()];
    const seen: number[] = [];
    const submit = (i: number) =>
      pool.submit(async () => {
        seen.push(pool.stats().inFlight);
        await gates[i].promise;
        return i;
      }, new AbortController().signal);

    const p0 = submit(0);
    const p1 = submit(1);
    const p2 = submit(2);
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.stats().inFlight).toBe(2);
    expect(pool.stats().queueDepth).toBe(1);
    gates[0].resolve();
    await p0;
    await new Promise((r) => setTimeout(r, 10));
    gates[1].resolve();
    gates[2].resolve();
    await Promise.all([p1, p2]);
    expect(seen[0]).toBeLessThanOrEqual(2);
  });

  it('rejects with BackendBusyError when queue is full', async () => {
    const pool = new BackendPool({ name: 'codex', size: 1, maxQueue: 1 });
    const gate = defer();
    void pool.submit(async () => gate.promise, new AbortController().signal);
    void pool.submit(async () => 'queued', new AbortController().signal);
    await expect(pool.submit(async () => 'rejected', new AbortController().signal)).rejects.toBeInstanceOf(BackendBusyError);
    gate.resolve();
  });

  it('honours AbortSignal before running', async () => {
    const pool = new BackendPool({ name: 'gemini', size: 1, maxQueue: 5 });
    const gate = defer();
    void pool.submit(async () => gate.promise, new AbortController().signal);
    const abort = new AbortController();
    const p = pool.submit(async () => 'never', abort.signal);
    abort.abort();
    await expect(p).rejects.toBeInstanceOf(BackendCancelledError);
    gate.resolve();
  });
});
