import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BackendBusyError, publicErrorMessage } from '../backends/errors.js';
import { resolveModel } from '../backends/registry.js';

import { cleanupTempFiles, fetchImageToTmp, saveBase64Image } from '../lib/image-store.js';
import { logger } from '../lib/logger.js';
import { guardRequest, recordOutcome } from '../lib/pipeline.js';
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
  const resolved = resolveModel(body.model ?? 'claude-haiku-4-5-20251001');
  const start = Date.now();
  try {
    for (const it of inputs) {
      const p = it.url ? await fetchImageToTmp(it.url) : saveBase64Image(it.data!, it.mime);
      tmpPaths.push(p);
    }

    const cfg = ctx.runtime.get();
    const timeoutMs = (body.timeout ?? cfg.timeoutSeconds) * 1000;
    const controller = bindCancelController(req, reply);

    const fullPrompt = `${body.prompt}\n\n${tmpPaths.map((p) => `@${p}`).join('\n')}`;
    logger.info({ app: appName, model: resolved.model, backend: resolved.backend, images: tmpPaths.length }, 'vision ←');

    // Mirror chat.ts fallback: Claude vision dies often (CLI exit 143) → fall through
    // to Codex with the same images. Without this the caller (vision-pick / anti-copy)
    // gets a hard 500 every time Claude pool is degraded.
    const callBackend = (target: typeof resolved.backend) => {
      const ad = ctx.backends.get(target);
      return ad.call(
        {
          userPrompt: target === 'codex' ? body.prompt! : fullPrompt,
          systemPrompt: body.system,
          imagePaths: tmpPaths,
          model: resolved.model,
          visionMode: target === 'claude',
          timeoutMs,
        },
        controller.signal,
      );
    };

    let result;
    try {
      result = await callBackend(resolved.backend);
    } catch (err) {
      if (resolved.backend !== 'claude') throw err;
      if (controller.signal.aborted) throw err;
      logger.warn({ err: (err as Error).message }, 'claude vision failed → codex fallback');
      result = await callBackend('codex');
      result.model = `codex:fallback-from-${resolved.model}`;
    }

    const elapsed = Date.now() - start;
    recordOutcome(ctx, req, {
      appName,
      backendName: resolved.backend,
      model: resolved.model,
      elapsed,
      success: true,
      result,
    });

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
    recordOutcome(ctx, req, {
      appName,
      backendName: resolved.backend,
      model: resolved.model,
      elapsed: Date.now() - start,
      success: false,
    });
    if (err instanceof BackendBusyError) {
      ctx.metrics.backendBusyTotal.inc({ backend: err.backend });
      reply.code(429).header('Retry-After', String(err.retryAfterSec));
      return { error: { message: err.message, type: 'backend_busy', code: 'backend_busy' } };
    }
    reply.code(500);
    logger.error({ err: (err as Error).message }, 'vision error');
    return { error: { message: publicErrorMessage(err), type: 'server_error' } };
  } finally {
    cleanupTempFiles(tmpPaths);
  }
}

export async function visionRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const guard = guardRequest(req, reply, ctx, 'openai');
    if (!guard.ok) return guard.payload;
    return runVision((req.body ?? {}) as VisionBody, ctx, reply, req, guard.appName);
  };

  app.post('/v1/vision', handler);
  app.post('/v1/vision/pick', handler);
}
