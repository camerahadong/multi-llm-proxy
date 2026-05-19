import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BackendBusyError } from '../backends/errors.js';
import { resolveModel } from '../backends/registry.js';
import { authenticate } from '../middleware/auth.js';
import { bindCancelController } from '../middleware/cancel.js';
import type { AppContext } from '../types/index.js';

interface CompletionsBody {
  prompt?: string;
  model?: string;
  timeout?: number;
}

export async function completionsRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/v1/completions', async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = authenticate(req, ctx.runtime);
    if (!auth.ok) {
      reply.code(401);
      return { error: { message: auth.error, type: 'invalid_request_error', code: 'invalid_api_key' } };
    }
    const rate = ctx.rate.check(auth.context);
    if (!rate.ok) {
      reply.code(429).header('Retry-After', String(rate.retryAfter));
      return { error: { message: 'Rate limit exceeded', type: 'requests', code: 'rate_limit_exceeded' } };
    }
    const body = (req.body ?? {}) as CompletionsBody;
    const resolved = resolveModel(body.model ?? ctx.runtime.get().defaultModel);
    const timeoutMs = (body.timeout ?? ctx.runtime.get().timeoutSeconds) * 1000;
    const controller = bindCancelController(req, reply);
    try {
      const result = await ctx.backends.get(resolved.backend).call(
        { userPrompt: body.prompt ?? '', model: resolved.model, timeoutMs },
        controller.signal,
      );
      return {
        id: `cmpl-${Date.now()}`,
        object: 'text_completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        choices: [{ text: result.content, index: 0, finish_reason: 'stop' }],
        usage: { prompt_tokens: result.inputTokens, completion_tokens: result.outputTokens, total_tokens: result.inputTokens + result.outputTokens },
      };
    } catch (err) {
      if (err instanceof BackendBusyError) {
        reply.code(429).header('Retry-After', String(err.retryAfterSec));
        return { error: { message: err.message, type: 'backend_busy', code: 'backend_busy' } };
      }
      reply.code(500);
      return { error: { message: (err as Error).message, type: 'server_error', code: 'internal_error' } };
    }
  });
}
