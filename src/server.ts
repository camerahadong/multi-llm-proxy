import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { ClaudeAdapter } from './backends/claude/index.js';
import { CodexAdapter } from './backends/codex/index.js';
import { BackendRegistry } from './backends/registry.js';
import { DATA_DIR } from './config/load.js';
import { RuntimeConfig } from './config/runtime.js';
import { type AppConfig } from './config/schema.js';
import { configureImageCache, startVisionDirSweeper } from './lib/image-store.js';
import { logger } from './lib/logger.js';
import { MetricsRegistry } from './lib/metrics.js';
import { StatsStore } from './lib/stats-store.js';
import { IdempotencyStore } from './middleware/idempotency.js';
import { RateLimiter } from './middleware/rate-limit.js';
import { chatRoute } from './routes/chat.js';
import { completionsRoute } from './routes/completions.js';
import { configRoute } from './routes/config.js';
import { downloadRoute } from './routes/download.js';
import { guideRoute } from './routes/guide.js';
import { healthRoute } from './routes/health.js';
import { imagesRoute } from './routes/images.js';
import { messagesRoute } from './routes/messages.js';
import { metricsRoute } from './routes/metrics.js';
import { modelsRoute } from './routes/models.js';
import { statsRoute } from './routes/stats.js';
import { tokenRoute } from './routes/token.js';
import { visionRoute } from './routes/vision.js';
import path from 'node:path';
import type { AppContext } from './types/index.js';

export interface BuildOptions {
  config: AppConfig;
}

export async function buildServer({ config }: BuildOptions): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const runtime = new RuntimeConfig(config);

  const backends = new BackendRegistry();
  backends.register(new ClaudeAdapter(config.pools.claude));
  backends.register(new CodexAdapter(config.pools.codex));

  configureImageCache(config.imageCache);
  startVisionDirSweeper();

  const stats = new StatsStore(
    path.join(DATA_DIR, 'stats.json'),
    path.join(DATA_DIR, 'requests.log'),
    () => runtime.get().enableLogging,
  );
  const rate = new RateLimiter(runtime);
  const idempotency = new IdempotencyStore(runtime);
  const metrics = new MetricsRegistry(backends);

  const ctx: AppContext = { runtime, backends, stats, rate, idempotency, metrics };

  const app = Fastify({
    logger: false,
    bodyLimit: 50 * 1024 * 1024,
    trustProxy: true,
    requestTimeout: 0,
    keepAliveTimeout: 15 * 60_000,
    pluginTimeout: 30_000,
  });

  app.setErrorHandler((err: Error, req, reply) => {
    logger.error({ err: err.message, path: req.url }, 'unhandled error');
    if (!reply.sent) reply.code(500).send({ error: { message: err.message, type: 'server_error' } });
  });

  await app.register(cors, {
    origin: runtime.get().allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-App-Name', 'Idempotency-Key', 'x-api-key', 'anthropic-version', 'anthropic-beta'],
  });
  await app.register(sensible);

  await modelsRoute(app);
  await healthRoute(app, ctx);
  await statsRoute(app, ctx);
  await configRoute(app, ctx);
  await tokenRoute(app, ctx);
  await guideRoute(app);
  await metricsRoute(app, ctx);
  await downloadRoute(app);
  await chatRoute(app, ctx);
  await messagesRoute(app, ctx);
  await visionRoute(app, ctx);
  await completionsRoute(app, ctx);
  await imagesRoute(app, ctx);

  return { app, ctx };
}
