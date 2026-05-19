import { logger } from '../../lib/logger.js';
import { BackendPool, type PoolOptions } from '../pool.js';
import type { BackendAdapter, CallInput, CallResult, PoolStats } from '../types.js';
import { callCodexCli } from './cli.js';
import { refreshCodexToken, startCodexTokenManager } from './oauth.js';

export class CodexAdapter implements BackendAdapter {
  readonly name = 'codex' as const;
  private readonly pool: BackendPool;

  constructor(opts: Omit<PoolOptions, 'name'>) {
    this.pool = new BackendPool({ name: 'codex', ...opts });
    startCodexTokenManager();
  }

  async call(input: CallInput, signal: AbortSignal): Promise<CallResult> {
    const result = await this.pool.submit((sig) => callCodexCli(input, sig), signal);
    this.pool.markStatus('ok');
    return result;
  }

  stats(): PoolStats {
    return this.pool.stats();
  }

  async healthCheck(): Promise<PoolStats> {
    try {
      const abort = new AbortController();
      await this.call({ userPrompt: 'Reply only OK', model: 'gpt-5', timeoutMs: 60_000 }, abort.signal);
    } catch (err) {
      this.pool.markStatus('error', (err as Error).message);
      logger.warn({ err: (err as Error).message }, 'codex health check failed');
    }
    return this.pool.stats();
  }

  async forceRefresh(): Promise<boolean> {
    return refreshCodexToken();
  }

  resize(size: number, maxQueue: number): void {
    this.pool.resize(size, maxQueue);
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }
}
