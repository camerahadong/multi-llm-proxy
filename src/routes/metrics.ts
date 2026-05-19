import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../types/index.js';

export async function metricsRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/metrics', async (_req, reply: FastifyReply) => {
    reply.header('Content-Type', ctx.metrics.registry.contentType);
    return ctx.metrics.render();
  });
}
