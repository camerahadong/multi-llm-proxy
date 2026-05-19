import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BackendBusyError } from '../backends/errors.js';
import { resolveModel } from '../backends/registry.js';
import { clientIp, clientUserAgent } from '../lib/client-info.js';
import { cleanupTempFiles, fetchImageToTmp, saveBase64Image } from '../lib/image-store.js';
import { logger } from '../lib/logger.js';
import { authenticate } from '../middleware/auth.js';
import { bindCancelController } from '../middleware/cancel.js';
import type { AppContext } from '../types/index.js';

interface VisionBody {
  prompt?: string;
  system?: string;
  image?: string;
  image_url?: string;
  images?: Array<string | { url?: string; data?: string; mime_type?: string; media_type?: string }>;
  model?: string;
  timeout?: number;
}

async function runVision(
  body: VisionBody,
  ctx: AppContext,
  reply: FastifyReply,
  req: FastifyRequest,
  appName: string,
): Promise<unknown> {
  if (!body.prompt?.trim()) {
    reply.code(400);
    return { error: { message: 'Missing "prompt" field', type: 'invalid_request' } };
  }

  const inputs: Array<{ url?: string; data?: string; mime?: string }> = [];
  if (body.image) inputs.push({ data: body.image });
  if (body.image_url) inputs.push({ url: body.image_url });
  if (Array.isArray(body.images)) {
    for (const it of body.images) {
      if (typeof it === 'string') inputs.push(it.startsWith('http') ? { url: it } : { data: it });
      else if (it) inputs.push({ url: it.url, data: it.data, mime: it.mime_type ?? it.media_type });
    }
  }
  if (inputs.length === 0) {
    reply.code(400);
    return { error: { message: 'No images provided. Use "image", "image_url", or "images".', type: 'invalid_request' } };
  }

  const tmpPaths: string[] = [];
  try {
    for (const it of inputs) {
      const p = it.url ? await fetchImageToTmp(it.url) : saveBase64Image(it.data!, it.mime);
      tmpPaths.push(p);
    }

    const resolved = resolveModel(body.model ?? 'claude-haiku-4-5-20251001');
    const cfg = ctx.runtime.get();
    const timeoutMs = (body.timeout ?? cfg.timeoutSeconds) * 1000;
    const controller = bindCancelController(req, reply);

    const fullPrompt = `${body.prompt}\n\n${tmpPaths.map((p) => `@${p}`).join('\n')}`;
    const adapter = ctx.backends.get(resolved.backend);

    const start = Date.now();
    logger.info({ app: appName, model: resolved.model, backend: resolved.backend, images: tmpPaths.length }, 'vision ←');

    const result = await adapter.call(
      {
        userPrompt: resolved.backend === 'codex' ? body.prompt : fullPrompt,
        systemPrompt: body.system,
        imagePaths: tmpPaths,
        model: resolved.model,
        visionMode: resolved.backend === 'claude',
        timeoutMs,
      },
      controller.signal,
    );

    const elapsed = Date.now() - start;
    ctx.stats.track({
      app: appName,
      model: resolved.model,
      duration: elapsed,
      success: true,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cost: result.cost,
      ip: clientIp(req),
      userAgent: clientUserAgent(req),
    });
    ctx.metrics.requestsTotal.inc({ backend: resolved.backend, model: resolved.model, status: 'ok' });
    ctx.metrics.requestDuration.observe({ backend: resolved.backend, model: resolved.model }, elapsed);

    return {
      content: result.content,
      model: result.model,
      usage: {
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cache_read_tokens: result.cacheRead,
        cache_creation_tokens: result.cacheCreation,
      },
      images_processed: tmpPaths.length,
      duration_ms: elapsed,
      cost_usd: result.cost,
    };
  } catch (err) {
    if (err instanceof BackendBusyError) {
      ctx.metrics.backendBusyTotal.inc({ backend: err.backend });
      reply.code(429).header('Retry-After', String(err.retryAfterSec));
      return { error: { message: err.message, type: 'backend_busy', code: 'backend_busy' } };
    }
    reply.code(500);
    return { error: { message: (err as Error).message, type: 'server_error' } };
  } finally {
    cleanupTempFiles(tmpPaths);
  }
}

export async function visionRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = authenticate(req, ctx.runtime);
    if (!auth.ok) {
      reply.code(401);
      return { error: { message: auth.error, type: 'invalid_request_error', code: 'invalid_api_key' } };
    }
    const rate = ctx.rate.check(auth.context);
    if (!rate.ok) {
      reply.code(429).header('Retry-After', String(rate.retryAfter));
      return { error: { message: `Rate limit exceeded: max ${rate.limit} req/min`, type: 'requests', code: 'rate_limit_exceeded' } };
    }
    const appName = auth.context.app || ((req.headers['x-app-name'] as string) ?? 'unknown');
    return runVision((req.body ?? {}) as VisionBody, ctx, reply, req, appName);
  };

  app.post('/v1/vision', handler);
  app.post('/v1/vision/pick', handler);
}
