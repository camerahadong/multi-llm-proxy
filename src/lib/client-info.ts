import type { FastifyRequest } from 'fastify';

/**
 * Return the best-guess client IP. Trusts `X-Real-IP` first (set by nginx/cloudflare),
 * then the first non-private entry of `X-Forwarded-For`, finally the raw socket peer.
 */
export function clientIp(req: FastifyRequest): string {
  const xreal = req.headers['x-real-ip'];
  if (typeof xreal === 'string' && xreal.trim()) return xreal.trim();

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }

  return req.socket.remoteAddress ?? '-';
}

export function clientUserAgent(req: FastifyRequest): string {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : '-';
}
