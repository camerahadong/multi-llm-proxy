import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../lib/logger.js';

/**
 * One-shot file download (port of legacy /dl/<token>). Disabled unless both
 * DOWNLOAD_TOKEN and DOWNLOAD_FILE env vars are set. After a successful
 * download a flag file is written to /tmp and subsequent requests return 410.
 *
 * The route is intentionally kept outside the auth/rate-limit middleware: it
 * gates access on the URL token instead, matching v1.x behavior.
 */
// Tokens currently being streamed. Closes the gap where two concurrent
// requests both pass the flag-file check before the first one finishes.
const inFlight = new Set<string>();

export async function downloadRoute(app: FastifyInstance): Promise<void> {
  app.get('/dl/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = process.env.DOWNLOAD_TOKEN;
    const file = process.env.DOWNLOAD_FILE;
    if (!token || !file) {
      reply.code(404);
      return { error: 'not found' };
    }
    const flagPath = `/tmp/.dl-served-${token}`;

    // Strip optional extension suffix: /dl/<token>.bin → <token>
    const raw = req.url.replace(/^\/dl\//, '').replace(/\.[a-z]+$/, '');
    if (raw !== token) {
      reply.code(404);
      return { error: 'not found' };
    }
    if (existsSync(flagPath) || inFlight.has(token)) {
      reply.code(410);
      return { error: 'gone (already downloaded)' };
    }
    inFlight.add(token);
    try {
      const stat = statSync(file);
      reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${path.basename(file)}"`)
        .header('Content-Length', stat.size);
      const stream = createReadStream(file);
      stream.on('end', () => {
        try {
          writeFileSync(flagPath, '1');
        } catch {
          /* ignore */
        }
        inFlight.delete(token);
      });
      // Failed/aborted stream: release the token so the download can be retried.
      stream.on('error', () => inFlight.delete(token));
      reply.raw.on('close', () => {
        if (!existsSync(flagPath)) inFlight.delete(token);
      });
      return reply.send(stream);
    } catch (err) {
      inFlight.delete(token);
      reply.code(500);
      logger.error({ err: (err as Error).message }, 'download error');
      return { error: 'download failed' };
    }
  });
}
