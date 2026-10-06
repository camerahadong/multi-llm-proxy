import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isPrivateAddress } from '../lib/image-store.js';
import { logger } from '../lib/logger.js';
import type { RuntimeConfig } from '../config/runtime.js';
import type { StatsStore } from '../lib/stats-store.js';

/** First non-empty header value as a trimmed string. */
function header(req: FastifyRequest, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v ?? '').trim();
}

/**
 * Real client IP. `CF-Connecting-IP` is set by Cloudflare itself (the tunnel),
 * `X-Real-IP` by our nginx; both overwrite anything the client sends.
 */
export function geoClientIp(req: FastifyRequest): string {
  return header(req, 'cf-connecting-ip')
    || header(req, 'x-real-ip')
    || header(req, 'x-forwarded-for').split(',')[0].trim()
    || (req.socket.remoteAddress ?? '');
}

export type GeoDecision = { allow: true } | { allow: false; reason: string; country: string; ip: string };

export function geoDecision(req: FastifyRequest, cfg: { enabled: boolean; allowCountries: string[]; allowIps: string[] }): GeoDecision {
  if (!cfg.enabled) return { allow: true };
  const ip = geoClientIp(req);
  // LAN / localhost / docker callers are trusted; they are not "foreign".
  if (!ip || isPrivateAddress(ip)) return { allow: true };
  if (cfg.allowIps.includes(ip)) return { allow: true };
  // Cloudflare adds CF-IPCountry to every request coming through the tunnel.
  const country = header(req, 'cf-ipcountry').toUpperCase();
  if (!country) {
    return { allow: false, ip, country: '??', reason: 'Truy cập bị từ chối: không xác định được quốc gia của IP. API chỉ cho phép truy cập từ Việt Nam.' };
  }
  if (!cfg.allowCountries.includes(country)) {
    return { allow: false, ip, country, reason: `Truy cập bị từ chối: API chỉ cho phép truy cập từ Việt Nam (IP ${ip} thuộc quốc gia ${country}).` };
  }
  return { allow: true };
}

/** Block API access from outside the allowed countries before any route runs. */
export function registerGeoBlock(app: FastifyInstance, runtime: RuntimeConfig, stats: StatsStore): void {
  app.addHook('onRequest', async (req, reply) => {
    const d = geoDecision(req, runtime.get().geoBlock);
    if (d.allow) return;
    stats.logDenied({ ip: d.ip, userAgent: header(req, 'user-agent') || '-', status: 403, reason: `geo_blocked:${d.country}` });
    logger.warn({ ip: d.ip, country: d.country, url: req.url }, 'geo blocked');
    const anthropic = req.url.startsWith('/v1/messages');
    reply.code(403).send(
      anthropic
        ? { type: 'error', error: { type: 'permission_error', message: d.reason } }
        : { error: { message: d.reason, type: 'access_denied', code: 'geo_blocked' } },
    );
  });
}
