import { logger } from '../../lib/logger.js';
import { BackendPool, type PoolOptions } from '../pool.js';
import type { BackendAdapter, CallInput, CallResult, PoolStats } from '../types.js';
import { callClaudeCli, isClaudeQuotaMessage } from './cli.js';
import { refreshClaudeToken, startClaudeTokenManager } from './oauth.js';

export class ClaudeAdapter implements BackendAdapter {
  readonly name = 'claude' as const;
  private readonly pool: BackendPool;

  constructor(opts: Omit<PoolOptions, 'name'>) {
    this.pool = new BackendPool({ name: 'claude', ...opts });
    startClaudeTokenManager();
  }

  async call(input: CallInput, signal: AbortSignal): Promise<CallResult> {
    const result = await this.pool.submit((sig) => callClaudeCli(input, sig), signal);
    if (isClaudeQuotaMessage(result.content)) {
      this.pool.markStatus('limited', result.content);
    } else {
      this.pool.markStatus('ok');
    }
    return result;
  }

  stats(): PoolStats {
    return this.pool.stats();
  }

  async healthCheck(): Promise<PoolStats> {
    try {
      const abort = new AbortController();
      const ping = await this.call(
        {
          userPrompt: 'Reply only OK',
          model: 'claude-haiku-4-5-20251001',
          timeoutMs: 30_000,
        },
        abort.signal,
      );
      this.pool.markStatus(isClaudeQuotaMessage(ping.content) ? 'limited' : 'ok', ping.content);
    } catch (err) {
      const msg = (err as Error).message;
      this.pool.markStatus(isClaudeQuotaMessage(msg) ? 'limited' : 'error', msg);
      logger.warn({ err: msg }, 'claude health check failed');
    }
    return this.pool.stats();
  }

  async forceRefresh(): Promise<boolean> {
    return refreshClaudeToken();
  }

  resize(size: number, maxQueue: number): void {
    this.pool.resize(size, maxQueue);
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }
}
