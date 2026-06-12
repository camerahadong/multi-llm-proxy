import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../types/index.js';
import { authGuard } from '../middleware/require-auth.js';

export async function configRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/config', async (req: FastifyRequest, reply) => {
    const denied = authGuard(req, ctx.runtime);
    if (denied) { reply.code(denied.code); return denied.body; }
    return ctx.runtime.safeView();
  });

  app.put('/config', async (req: FastifyRequest, reply) => {
    const denied = authGuard(req, ctx.runtime);
    if (denied) { reply.code(denied.code); return denied.body; }
    try {
      const patch = (req.body ?? {}) as Parameters<typeof ctx.runtime.update>[0];
      const updated = ctx.runtime.update(patch);
      return { ok: true, config: ctx.runtime.safeView() ?? updated };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });
}
