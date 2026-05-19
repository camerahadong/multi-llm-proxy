import { logger } from '../../lib/logger.js';
import { BackendPool, type PoolOptions } from '../pool.js';
import type { BackendAdapter, CallInput, CallResult, PoolStats } from '../types.js';
import { callGeminiCli, GEMINI_DEFAULT_MODEL } from './cli.js';

export class GeminiAdapter implements BackendAdapter {
  readonly name = 'gemini' as const;
  private readonly pool: BackendPool;

  constructor(opts: Omit<PoolOptions, 'name'>) {
    this.pool = new BackendPool({ name: 'gemini', ...opts });
  }

  async call(input: CallInput, signal: AbortSignal): Promise<CallResult> {
    const result = await this.pool.submit((sig) => callGeminiCli(input, sig), signal);
    this.pool.markStatus('ok');
    return result;
  }

  stats(): PoolStats {
    return this.pool.stats();
  }

  async healthCheck(): Promise<PoolStats> {
    try {
      const abort = new AbortController();
      await this.call(
        { userPrompt: 'Reply only OK', model: 'gemini-2.5-flash', timeoutMs: 60_000 },
        abort.signal,
      );
    } catch (err) {
      this.pool.markStatus('error', (err as Error).message);
      logger.warn({ err: (err as Error).message }, 'gemini health check failed');
    }
    return this.pool.stats();
  }

  resize(size: number, maxQueue: number): void {
    this.pool.resize(size, maxQueue);
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }
}

export { GEMINI_DEFAULT_MODEL };
