import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../types/index.js';
import { authGuard } from '../middleware/require-auth.js';

export async function statsRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/stats', async (req: FastifyRequest, reply) => {
    const denied = authGuard(req, ctx.runtime);
    if (denied) { reply.code(denied.code); return denied.body; }
    const snap = ctx.stats.snapshot();
    const today = new Date().toISOString().slice(0, 10);
    const todayStats = snap.daily[today] ?? { requests: 0, tokens: 0, cost: 0, errors: 0 };
    const last7: Record<string, typeof todayStats> = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      last7[key] = snap.daily[key] ?? { requests: 0, tokens: 0, cost: 0, errors: 0 };
    }
    let activeJobs = 0;
    let queueLength = 0;
    for (const adapter of ctx.backends.all()) {
      const s = adapter.stats();
      activeJobs += s.inFlight;
      queueLength += s.queueDepth;
    }
    return {
      today: todayStats,
      last7days: last7,
      byApp: snap.apps,
      total: snap.total,
      backends: Object.fromEntries(ctx.backends.all().map((b) => [b.name, b.stats()])),
      // Legacy aliases (v1.x compat).
      activeJobs,
      queueLength,
    };
  });

  app.delete('/stats', async (req: FastifyRequest, reply) => {
    const denied = authGuard(req, ctx.runtime);
    if (denied) { reply.code(denied.code); return denied.body; }
    ctx.stats.reset();
    return { ok: true, message: 'Stats reset' };
  });

  app.get('/logs', async (req: FastifyRequest, reply) => {
    const denied = authGuard(req, ctx.runtime);
    if (denied) { reply.code(denied.code); return denied.body; }
    const url = new URL(req.url, 'http://x');
    const n = parseInt(url.searchParams.get('n') ?? '50', 10);
    return ctx.stats.readLogs(n);
  });
}
