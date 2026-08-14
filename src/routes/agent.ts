import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentApiError, type AgentEvent, type AgentInput } from '../agent/service.js';
import { authGuard } from '../middleware/require-auth.js';
import type { AppContext } from '../types/index.js';

const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const detailSchema = z.enum(['auto', 'low', 'high', 'original']);

const remoteMediaUrl = (kind: 'image' | 'audio') => z.string().min(1).max(50 * 1024 * 1024).refine((value) => {
  if (value.startsWith(`data:${kind}/`)) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, `${kind} URL must be HTTPS or a matching data URL`);

const agentInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(200_000) }),
  z.object({ type: z.literal('image'), url: remoteMediaUrl('image'), detail: detailSchema.optional() }),
  z.object({ type: z.literal('localImage'), path: z.string().min(1).max(4096), detail: detailSchema.optional() }),
  z.object({ type: z.literal('audio'), url: remoteMediaUrl('audio') }),
  z.object({ type: z.literal('localAudio'), path: z.string().min(1).max(4096) }),
]);

const inputListSchema = z.array(agentInputSchema).min(1).max(20);

const createSessionSchema = z.object({
  cwd: z.string().min(1).max(4096).optional(),
  model: z.string().min(1).max(128).optional(),
  sandbox: z.enum(['read-only', 'workspace-write']).optional(),
  networkAccess: z.boolean().optional(),
  effort: effortSchema.optional(),
  resumeThreadId: z.string().min(8).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();

const turnSchema = z.object({ input: inputListSchema, effort: effortSchema.optional() }).strict();
const steerSchema = z.object({ input: inputListSchema }).strict();
const responseSchema = z.object({
  decision: z.enum(['accept', 'decline', 'cancel']).optional(),
  result: z.unknown().optional(),
}).strict();

const querySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { message: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), code: 'invalid_agent_request' } };
  }
  if (error instanceof AgentApiError) {
    reply.code(error.statusCode);
    return { error: { message: error.message, code: error.code } };
  }
  reply.code(502);
  return { error: { message: (error as Error).message, code: 'agent_backend_error' } };
}

function checkAuth(req: FastifyRequest, reply: FastifyReply, ctx: AppContext): boolean {
  const denied = authGuard(req, ctx.runtime);
  if (!denied) return true;
  reply.code(denied.code).send(denied.body);
  return false;
}

export async function agentRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/v1/agent/sessions', async (req, reply) => {
    if (!checkAuth(req, reply, ctx)) return;
    return { data: ctx.agent.listSessions() };
  });

  app.post('/v1/agent/sessions', async (req, reply) => {
    if (!checkAuth(req, reply, ctx)) return;
    try {
      const body = createSessionSchema.parse(req.body ?? {});
      const session = await ctx.agent.createSession(body);
      reply.code(201);
      return session;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/v1/agent/sessions/:sessionId', async (req, reply) => {
    if (!checkAuth(req, reply, ctx)) return;
    try {
      const { sessionId } = req.params as { sessionId: string };
      return ctx.agent.getSession(sessionId);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/v1/agent/sessions/:sessionId', async (req, reply) => {
    if (!checkAuth(req, reply, ctx)) return;
    try {
      const { sessionId } = req.params as { sessionId: string };
      await ctx.agent.deleteSession(sessionId);
      reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/v1/agent/sessions/:sessionId/turns', async (req, reply) => {
    if (!checkAuth(req, reply, ctx)) return;
    try {
      const { sessionId } = req.params as { sessionId: string };
      const body = turnSchema.parse(req.body);
      const turn = await ctx.agent.startTurn(sessionId, body as { input: AgentInput[]; effort?: typeof body.effort });
      reply.code(202);
      return turn;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/v1/agent/sessions/:sessionId/steer', async (req, reply) => {
    if (!checkAuth(req, reply, ctx)) return;
    try {
      const { sessionId } = req.params as { sessionId: string };
      const body = steerSchema.parse(req.body);
      return await ctx.agent.steer(sessionId, body.input as AgentInput[]);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/v1/agent/sessions/:sessionId/interrupt', async (req, reply) => {
    if (!checkAuth(req, reply, ctx)) return;
    try {
      const { sessionId } = req.params as { sessionId: string };
      return await ctx.agent.interrupt(sessionId);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/v1/agent/sessions/:sessionId/events', async (req, reply) => {
    if (!checkAuth(req, reply, ctx)) return;
    try {
      const { sessionId } = req.params as { sessionId: string };
      const query = querySchema.parse(req.query);
      return ctx.agent.getEvents(sessionId, query.after, query.limit);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/v1/agent/sessions/:sessionId/events/stream', async (req, reply) => {
    if (!checkAuth(req, reply, ctx)) return;
    try {
      const { sessionId } = req.params as { sessionId: string };
      const query = querySchema.parse(req.query);
      const initial = ctx.agent.getEvents(sessionId, query.after, query.limit);

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const writeEvent = (event: AgentEvent) => {
        reply.raw.write(`id: ${event.seq}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`);
      };
      for (const event of initial.events) writeEvent(event);
      const unsubscribe = ctx.agent.subscribe(sessionId, writeEvent);
      const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);
      heartbeat.unref?.();
      req.raw.once('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    } catch (error) {
      if (!reply.sent) return sendError(reply, error);
    }
  });

  const respondHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(req, reply, ctx)) return;
    try {
      const { sessionId, requestId } = req.params as { sessionId: string; requestId: string };
      const body = responseSchema.parse(req.body);
      await ctx.agent.respondToRequest(sessionId, requestId, body);
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  };
  app.post('/v1/agent/sessions/:sessionId/requests/:requestId/respond', respondHandler);
  app.post('/v1/agent/sessions/:sessionId/approvals/:requestId', respondHandler);
}
