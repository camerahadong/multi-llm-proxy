import { describe, expect, it, vi } from 'vitest';
import { callWithFallback } from '../../src/lib/pipeline.js';
import type { CallInput, CallResult } from '../../src/backends/types.js';

const ok = (content: string, model: string): CallResult => ({
  content, model, cost: 0, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheCreation: 0, durationMs: 1,
});

function makeCtx(claude: (i: CallInput) => Promise<CallResult>, codex: (i: CallInput) => Promise<CallResult>, fallbackModel?: string) {
  const backends = { claude: { call: vi.fn(claude) }, codex: { call: vi.fn(codex) } };
  const ctx: any = {
    backends: { get: (n: 'claude' | 'codex') => backends[n] },
    runtime: { get: () => ({ fallbackModel }) },
  };
  return { ctx, backends };
}

const params = (extra: Record<string, unknown> = {}) => ({
  normalised: { userPrompt: 'hi', systemPrompt: '', imagePaths: [] } as any,
  model: 'claude-sonnet-5-5',
  backendName: 'claude' as const,
  thinking: false,
  timeoutMs: 1000,
  signal: new AbortController().signal,
  ...extra,
});

describe('callWithFallback', () => {
  it('sends a GPT model (not the Claude id) to codex when claude fails', async () => {
    const { ctx, backends } = makeCtx(
      async () => { throw new Error('claude down'); },
      async (i) => ok('from gpt', i.model),
    );
    const r = await callWithFallback(ctx, params());
    expect(backends.codex.call.mock.calls[0][0].model).toBe('gpt-6-sol');
    expect(r.content).toBe('from gpt');
  });

  it('honours configured fallbackModel', async () => {
    const { ctx, backends } = makeCtx(async () => { throw new Error('x'); }, async (i) => ok('ok', i.model), 'gpt-6-luna');
    await callWithFallback(ctx, params());
    expect(backends.codex.call.mock.calls[0][0].model).toBe('gpt-6-luna');
  });

  it('falls back on quota message too', async () => {
    const { ctx, backends } = makeCtx(async () => ({ ...ok("You've hit your limit · resets 3am", 'c'), isError: true }), async (i) => ok('ok', i.model));
    await callWithFallback(ctx, params());
    expect(backends.codex.call).toHaveBeenCalledTimes(1);
  });

  it('does NOT treat a normal answer that mentions quota/rate limit as a quota failure', async () => {
    const article = 'Bài viết: cách xử lý rate limit và quota API, hệ thống resets 2 lần mỗi ngày.';
    const { ctx, backends } = makeCtx(async () => ok(article, 'claude-sonnet-5-5'), async (i) => ok('gpt', i.model));
    const r = await callWithFallback(ctx, params());
    expect(r.content).toBe(article);
    expect(backends.codex.call).not.toHaveBeenCalled();
  });

  it('does not fall back after text was already streamed', async () => {
    const { ctx, backends } = makeCtx(
      async (i) => { i.onDelta?.('partial'); throw new Error('mid-stream'); },
      async (i) => ok('dup', i.model),
    );
    await expect(callWithFallback(ctx, params({ onDelta: () => {} }))).rejects.toThrow('mid-stream');
    expect(backends.codex.call).not.toHaveBeenCalled();
  });

  it('does not fall back when the client cancelled', async () => {
    const ac = new AbortController();
    const { ctx, backends } = makeCtx(async () => { ac.abort(); throw new Error('cancel'); }, async (i) => ok('x', i.model));
    await expect(callWithFallback(ctx, params({ signal: ac.signal }))).rejects.toThrow();
    expect(backends.codex.call).not.toHaveBeenCalled();
  });
});
