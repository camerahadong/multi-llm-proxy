import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../types/index.js';
import { authGuard } from '../middleware/require-auth.js';

export async function metricsRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/metrics', async (req: FastifyRequest, reply: FastifyReply) => {
    const denied = authGuard(req, ctx.runtime);
    if (denied) { reply.code(denied.code); return denied.body; }
    reply.header('Content-Type', ctx.metrics.registry.contentType);
    return ctx.metrics.render();
  });
}
