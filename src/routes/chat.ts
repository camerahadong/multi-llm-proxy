import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BackendBusyError, publicErrorMessage } from '../backends/errors.js';
import { normaliseOpenAiMessages, type NormalisedInput, type OpenAiMessage } from '../adapters/openai-input.js';
import { buildChatResponse } from '../adapters/openai-output.js';
import { writeChatStream } from '../adapters/openai-stream.js';
import { buildToolSystemPrompt, parseToolCalls, type ToolChoice, type ToolDefinition } from '../adapters/tool-calls.js';
import { cleanupTempFiles } from '../lib/image-store.js';
import { logger } from '../lib/logger.js';
import { callWithFallback, guardRequest, recordOutcome, resolveRequestedModel } from '../lib/pipeline.js';
import { bindCancelController } from '../middleware/cancel.js';
import type { AppContext } from '../types/index.js';

interface ChatBody {
  messages: OpenAiMessage[];
  model?: string;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  stream?: boolean;
  thinking?: boolean;
  timeout?: number;
}

export async function chatRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/v1/chat/completions', async (req: FastifyRequest, reply: FastifyReply) => {
    const guard = guardRequest(req, reply, ctx, 'openai');
    if (!guard.ok) return guard.payload;
    const appName = guard.appName;

    const idemKey = req.headers['idempotency-key'] as string | undefined;
    if (idemKey) {
      const cached = ctx.idempotency.get(idemKey, '/v1/chat/completions', req.body);
      if (cached) {
        reply.code(cached.status).header('Idempotent-Replay', 'true');
        return cached.body;
      }
    }

    const start = Date.now();
    const body = (req.body ?? {}) as ChatBody;
    const controller = bindCancelController(req, reply);

    const tools = body.tools ?? null;
    const toolChoice: ToolChoice = body.tool_choice ?? 'auto';
    const toolPrompt = buildToolSystemPrompt(tools, toolChoice);

    const cfg = ctx.runtime.get();
    const wantStream = !!body.stream;
    const hasTools = !!(tools && tools.length > 0);

    const route = resolveRequestedModel(body.model, cfg.defaultModel, !!body.thinking);
    const { backendName, model } = route;
    const timeoutMs = (body.timeout ?? cfg.timeoutSeconds) * 1000;

    let normalised: NormalisedInput | undefined;
    try {
      normalised = await normaliseOpenAiMessages(body.messages ?? [], toolPrompt);

      logger.info(
        {
          app: appName,
          model,
          backend: backendName,
          msgCount: body.messages?.length ?? 0,
          tools: hasTools ? tools!.length : 0,
          images: normalised.imagePaths.length,
          stream: wantStream,
          idemKey: idemKey ?? null,
        },
        `chat ← ${appName} | ${model}${route.routeReason}`,
      );
      ctx.metrics.backendQueueDepth.observe({ backend: backendName }, ctx.backends.get(backendName).stats().queueDepth);

      const result = await callWithFallback(ctx, {
        normalised,
        model,
        backendName,
        thinking: route.thinking,
        timeoutMs,
        signal: controller.signal,
      });

      const elapsed = Date.now() - start;
      const parsed = hasTools ? parseToolCalls(result.content) : { isToolCall: false, toolCalls: null, textContent: result.content };
      recordOutcome(ctx, req, { appName, backendName, model, elapsed, success: true, result });

      if (wantStream) {
        writeChatStream(reply, result, parsed);
        return reply;
      }

      const response = buildChatResponse(result, parsed, appName, elapsed);
      if (idemKey) ctx.idempotency.set(idemKey, '/v1/chat/completions', req.body, { status: 200, body: response });
      return response;
    } catch (err) {
      const elapsed = Date.now() - start;
      recordOutcome(ctx, req, { appName, backendName, model, elapsed, success: false });

      if (err instanceof BackendBusyError) {
        ctx.metrics.backendBusyTotal.inc({ backend: err.backend });
        reply.code(429).header('Retry-After', String(err.retryAfterSec));
        return { error: { message: err.message, type: 'backend_busy', code: 'backend_busy' } };
      }
      reply.code(500);
      logger.error({ err: (err as Error).message, app: appName }, 'chat error');
      return { error: { message: publicErrorMessage(err), type: 'server_error' } };
    } finally {
      if (normalised) cleanupTempFiles(normalised.imagePaths);
    }
  });
}
