import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BackendName, PoolStats } from '../backends/types.js';
import { authenticate } from '../middleware/auth.js';
import type { AppContext } from '../types/index.js';

const FALLBACK_ORDER: BackendName[] = ['claude', 'codex', 'gemini'];

function recommendedModel(ctx: AppContext): string {
  const claude = ctx.backends.get('claude').stats();
  const codex = ctx.backends.get('codex').stats();
  if (claude.status === 'limited' || claude.status === 'error') {
    if (codex.status !== 'error') return 'gpt-5';
    return 'gemini-3-pro';
  }
  return 'auto';
}

export async function healthRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const handler = async (req: FastifyRequest) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('check') === '1') {
      const auth = authenticate(req, ctx.runtime);
      if (!auth.ok) return { error: { message: auth.error, type: 'invalid_request_error', code: 'invalid_api_key' } };
      await Promise.allSettled(ctx.backends.all().map((b) => b.healthCheck()));
    }

    const cfg = ctx.runtime.get();
    const backendsView: Record<string, PoolStats & { label: string }> = {};
    let totalInFlight = 0;
    let totalQueue = 0;
    let totalPoolSize = 0;
    for (const adapter of ctx.backends.all()) {
      const label = adapter.name === 'claude' ? 'OAuth Max subscription' :
                    adapter.name === 'codex'  ? 'ChatGPT Plus OAuth' :
                                                'Google OAuth GCA';
      const stats = adapter.stats();
      backendsView[adapter.name] = { label, ...stats };
      totalInFlight += stats.inFlight;
      totalQueue += stats.queueDepth;
      totalPoolSize += stats.poolSize;
    }

    return {
      status: 'ok',
      service: 'Claude + Codex + Gemini API Proxy',
      version: '2.0.0',
      guide: '/guide (markdown) | /guide?format=html (browser) | /guide?format=json (JSON)',
      backends: backendsView,
      defaultModel: cfg.defaultModel,
      recommendedModel: recommendedModel(ctx),
      fallbackOrder: FALLBACK_ORDER,
      // Backwards-compat aliases for clients written against v1.x. New code should
      // read per-backend `backends.<name>.{inFlight,queueDepth,poolSize}` instead.
      activeJobs: totalInFlight,
      queueLength: totalQueue,
      maxConcurrent: totalPoolSize,
      uptime: Math.floor(process.uptime()),
    };
  };
  app.get('/', handler);
  app.get('/health', handler);
}
