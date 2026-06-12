import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isClaudeQuotaMessage } from '../backends/claude/cli.js';
import { BackendBusyError, publicErrorMessage } from '../backends/errors.js';
import { resolveModel } from '../backends/registry.js';
import { normaliseOpenAiMessages, type OpenAiMessage } from '../adapters/openai-input.js';
import { buildChatResponse } from '../adapters/openai-output.js';
import { writeChatStream } from '../adapters/openai-stream.js';
import { buildToolSystemPrompt, parseToolCalls, type ToolChoice, type ToolDefinition } from '../adapters/tool-calls.js';
import { clientIp, clientUserAgent } from '../lib/client-info.js';
import { cleanupTempFiles } from '../lib/image-store.js';
import { logger } from '../lib/logger.js';
import { authenticate } from '../middleware/auth.js';
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
    const auth = authenticate(req, ctx.runtime);
    if (!auth.ok) {
      ctx.stats.logDenied({ ip: clientIp(req), userAgent: clientUserAgent(req), status: 401, reason: auth.error });
      reply.code(401);
      return { error: { message: auth.error, type: 'invalid_request_error', code: 'invalid_api_key' } };
    }

    const rate = ctx.rate.check(auth.context);
    if (!rate.ok) {
      ctx.stats.logDenied({ app: auth.context.app, ip: clientIp(req), userAgent: clientUserAgent(req), status: 429, reason: 'rate_limit' });
      reply.code(429).header('Retry-After', String(rate.retryAfter));
      return { error: { message: `Rate limit exceeded: max ${rate.limit} req/min`, type: 'requests', code: 'rate_limit_exceeded' } };
    }

    const idemKey = req.headers['idempotency-key'] as string | undefined;
    if (idemKey) {
      const cached = ctx.idempotency.get(idemKey, '/v1/chat/completions', req.body);
      if (cached) {
        reply.code(cached.status).header('Idempotent-Replay', 'true');
        return cached.body;
      }
    }

    const start = Date.now();
    const appName = auth.context.app || ((req.headers['x-app-name'] as string) ?? 'unknown');
    const body = (req.body ?? {}) as ChatBody;
    const controller = bindCancelController(req, reply);

    const tools = body.tools ?? null;
    const toolChoice: ToolChoice = body.tool_choice ?? 'auto';
    const toolPrompt = buildToolSystemPrompt(tools, toolChoice);

    const cfg = ctx.runtime.get();
    const wantStream = !!body.stream;
    const hasTools = !!(tools && tools.length > 0);

    let backendName: 'claude' | 'codex' = 'claude';
    let model = body.model ?? cfg.defaultModel;
    let routeReason = '';
    let enableThinking = !!body.thinking;

    if (model === 'auto' || model === 'smart') {
      model = 'claude-sonnet-4-6';
      routeReason = ' [auto]';
    } else {
      const resolved = resolveModel(model);
      backendName = resolved.backend;
      model = resolved.model;
      if (resolved.thinking) enableThinking = true;
      routeReason = ` [${backendName}]`;
    }
    if (enableThinking) routeReason += ' [thinking]';

    const normalised = await normaliseOpenAiMessages(body.messages ?? [], toolPrompt);
    const timeoutMs = (body.timeout ?? cfg.timeoutSeconds) * 1000;

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
      `chat ← ${appName} | ${model}${routeReason}`,
    );

    ctx.metrics.backendQueueDepth.observe({ backend: backendName }, ctx.backends.get(backendName).stats().queueDepth);

    try {
      const call = (target: typeof backendName) => {
        const adapter = ctx.backends.get(target);
        return adapter.call(
          {
            userPrompt: normalised.userPrompt,
            systemPrompt: normalised.systemPrompt || undefined,
            imagePaths: normalised.imagePaths,
            model,
            visionMode: normalised.imagePaths.length > 0 && target === 'claude',
            thinking: enableThinking,
            timeoutMs,
          },
          controller.signal,
        );
      };

      let result;
      try {
        result = await call(backendName);
        if (backendName === 'claude' && isClaudeQuotaMessage(result.content)) {
          logger.warn({ snippet: result.content.slice(0, 160) }, 'claude quota detected — falling back to codex');
          throw new Error(result.content);
        }
      } catch (err) {
        if (backendName !== 'claude') throw err;
        // Client cancelled mid-call: stop the fallback chain.
        if (controller.signal.aborted) throw err;
        // Single fallback: Claude → Codex. Gemini backend was removed (CLI unstable).
        result = await call('codex');
        result.model = `codex:fallback-from-${model}`;
      }

      const elapsed = Date.now() - start;
      const parsed = hasTools ? parseToolCalls(result.content) : { isToolCall: false, toolCalls: null, textContent: result.content };

      ctx.stats.track({
        app: appName,
        model,
        duration: elapsed,
        success: true,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cost: result.cost,
        ip: clientIp(req),
        userAgent: clientUserAgent(req),
      });
      ctx.metrics.requestsTotal.inc({ backend: backendName, model, status: 'ok' });
      ctx.metrics.requestDuration.observe({ backend: backendName, model }, elapsed);

      if (wantStream) {
        writeChatStream(reply, result, parsed);
        cleanupTempFiles(normalised.imagePaths);
        return reply;
      }

      const response = buildChatResponse(result, parsed, appName, elapsed);
      if (idemKey) ctx.idempotency.set(idemKey, '/v1/chat/completions', req.body, { status: 200, body: response });
      cleanupTempFiles(normalised.imagePaths);
      return response;
    } catch (err) {
      cleanupTempFiles(normalised.imagePaths);
      const elapsed = Date.now() - start;
      ctx.stats.track({ app: appName, model: 'unknown', duration: elapsed, success: false, inputTokens: 0, outputTokens: 0, cost: 0, ip: clientIp(req), userAgent: clientUserAgent(req) });
      ctx.metrics.requestsTotal.inc({ backend: backendName, model, status: 'error' });

      if (err instanceof BackendBusyError) {
        ctx.metrics.backendBusyTotal.inc({ backend: err.backend });
        reply.code(429).header('Retry-After', String(err.retryAfterSec));
        return { error: { message: err.message, type: 'backend_busy', code: 'backend_busy' } };
      }
      reply.code(500);
      logger.error({ err: (err as Error).message, app: appName }, 'chat error');
      return { error: { message: publicErrorMessage(err), type: 'server_error' } };
    }
  });
}
