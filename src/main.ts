import { loadConfig } from './config/load.js';
import { logger } from './lib/logger.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, ctx } = await buildServer({ config });

  const port = parseInt(process.env.PORT ?? '3456', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });

  logger.info(
    { port, host, defaultModel: config.defaultModel, pools: config.pools },
    `multi-llm-proxy listening on http://${host}:${port}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown initiated');
    // Hard-exit safety net if graceful close stalls.
    const forceExit = setTimeout(() => {
      logger.warn('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 15_000);
    forceExit.unref?.();
    try {
      // Stop accepting new requests and wait for in-flight handlers to finish.
      await app.close();
      // After requests drained, flush stats (in-flight calls have already
      // posted their `track()` updates).
      ctx.stats.flushSync();
      // Finally release pool workers + clear timers.
      await ctx.backends.shutdown();
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'shutdown error');
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'fatal startup error');
  process.exit(1);
});
