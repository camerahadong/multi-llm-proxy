import { logger } from '../../lib/logger.js';
import { BackendPool, type PoolOptions } from '../pool.js';
import type { BackendAdapter, CallInput, CallResult, PoolStats } from '../types.js';
import { getClaudeAccounts, parseResetTime } from './accounts.js';
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
    return this.pool.submit((sig) => this.callWithFailover(input, sig), signal);
  }

  /**
   * Goi Claude, tu xoay sang tai khoan khac khi gap quota.
   * Het tat ca account -> tra ve thong bao quota cuoi (caller fallback sang codex).
   */
  private async callWithFailover(input: CallInput, sig: AbortSignal): Promise<CallResult> {
    const accounts = getClaudeAccounts();
    const now = Date.now();
    // Uu tien account dang OK; neu tat ca dang limited van thu lai (co the da reset).
    const ready = accounts.filter((a) => a.limitedUntil <= now);
    const order = ready.length ? ready : accounts;

    let lastQuota: CallResult | null = null;
    for (const acc of order) {
      const result = await callClaudeCli(input, sig, acc.dir);
      if (isClaudeQuotaMessage(result.content)) {
        acc.limitedUntil = parseResetTime(result.content, now) ?? now + 60 * 60 * 1000;
        logger.warn(
          { account: acc.label, resetAt: new Date(acc.limitedUntil).toISOString() },
          'claude account het quota — xoay sang account khac',
        );
        lastQuota = result;
        continue;
      }
      // Thanh cong: account nay OK tro lai.
      acc.limitedUntil = 0;
      this.pool.markStatus('ok');
      return result;
    }

    // Tat ca account het quota.
    const msg = lastQuota?.content ?? 'all claude accounts limited';
    this.pool.markStatus('limited', msg);
    return lastQuota ?? { content: msg, cost: 0, model: input.model, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, durationMs: 0 };
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
