import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientIp, clientUserAgent } from '../lib/client-info.js';
import { logger } from '../lib/logger.js';
import { authenticate } from '../middleware/auth.js';
import type { AppContext } from '../types/index.js';

const IMAGE_SIZE_MAP: Record<string, string> = {
  '1:1': '1024x1024', square: '1024x1024',
  '16:9': '1824x1024', landscape: '1824x1024',
  '9:16': '1024x1824', portrait: '1024x1824',
  '4:3': '1360x1024', '3:4': '1024x1360',
  '3:2': '1536x1024', '2:3': '1024x1536',
  '256x256': '1024x1024', '512x512': '1024x1024',
  '1792x1024': '1824x1024', '1024x1792': '1024x1824',
  '1024x1024': '1024x1024', '2048x2048': '2048x2048',
  '1536x1024': '1536x1024', '1024x1536': '1024x1536',
  '1360x1024': '1360x1024', '1024x1360': '1024x1360',
  '1824x1024': '1824x1024', '1024x1824': '1024x1824',
  '2048x1152': '2048x1152', '1152x2048': '1152x2048',
};
const IMAGE_QUALITY_MAP: Record<string, string> = { standard: 'low', hd: 'high' };

interface ImagesBody {
  prompt?: string;
  size?: string;
  quality?: string;
  n?: number;
  promptMode?: string;
  response_format?: 'url' | 'b64_json';
}

export async function imagesRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/v1/images/generations', async (req: FastifyRequest, reply: FastifyReply) => {
    const upstream = process.env.IMAGE_GEN_URL;
    if (!upstream) {
      reply.code(503);
      return { error: { message: 'Image generation disabled. Set IMAGE_GEN_URL.', type: 'service_unavailable' } };
    }
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

    const body = (req.body ?? {}) as ImagesBody;
    if (!body.prompt) {
      reply.code(400);
      return { error: { message: 'prompt is required', type: 'invalid_request_error', code: 'invalid_value' } };
    }
    const size = IMAGE_SIZE_MAP[body.size ?? ''] ?? body.size ?? '1024x1024';
    const quality = IMAGE_QUALITY_MAP[body.quality ?? ''] ?? body.quality ?? 'low';
    const n = Math.min(body.n ?? 1, 4);
    const promptMode = body.promptMode ?? 'auto';
    const timeoutMs = ctx.runtime.get().timeoutSeconds * 1000;
    const appName = auth.context.app;

    try {
      const fetchOne = () =>
        fetch(upstream, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: body.prompt, quality, size, provider: 'oauth', promptMode }),
          signal: AbortSignal.timeout(timeoutMs),
        })
          .then((r) => r.json() as Promise<{ image?: string; error?: string; revisedPrompt?: string }>)
          .then((r) => {
            if (!r.image) throw new Error(r.error ?? 'image-gen upstream returned no image');
            return r;
          });

      const results = await Promise.all(Array.from({ length: n }, fetchOne));
      const data = results.map((r) => {
        const base64 = (r.image ?? '').replace(/^data:[^;]+;base64,/, '');
        return body.response_format === 'url'
          ? { url: r.image, revised_prompt: r.revisedPrompt ?? body.prompt }
          : { b64_json: base64, revised_prompt: r.revisedPrompt ?? body.prompt };
      });

      ctx.stats.track({ app: appName, model: 'gpt-image-1', duration: 0, success: true, inputTokens: 0, outputTokens: 0, cost: 0, ip: clientIp(req), userAgent: clientUserAgent(req) });
      logger.info({ app: appName, n, size, quality }, 'image gen ok');
      return { created: Math.floor(Date.now() / 1000), data };
    } catch (err) {
      ctx.stats.track({ app: appName, model: 'gpt-image-1', duration: 0, success: false, inputTokens: 0, outputTokens: 0, cost: 0, ip: clientIp(req), userAgent: clientUserAgent(req) });
      reply.code(500);
      return { error: { message: (err as Error).message, type: 'server_error', code: 'internal_error' } };
    }
  });
}
