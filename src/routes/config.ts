import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../types/index.js';

export async function configRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/config', async () => ctx.runtime.safeView());

  app.put('/config', async (req: FastifyRequest, reply) => {
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
