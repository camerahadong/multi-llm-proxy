import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { normalizeApiKey } from '../config/schema.js';
import type { RuntimeConfig } from '../config/runtime.js';

/** Constant-time key comparison. Hashing first equalises lengths so
 * timingSafeEqual never throws and length itself leaks nothing. */
function safeKeyCompare(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface AuthContext {
  app: string;
  apiKey: string | null;
  rpmOverride: number | null;
  isAdmin: boolean;
  isLocal: boolean;
}

export interface AuthOk {
  ok: true;
  context: AuthContext;
}

export interface AuthError {
  ok: false;
  error: string;
}

export function authenticate(req: FastifyRequest, runtime: RuntimeConfig): AuthOk | AuthError {
  const cfg = runtime.get();
  const directIp = req.socket.remoteAddress ?? '';
  const isLocal = directIp === '127.0.0.1' || directIp === '::1' || directIp === '::ffff:127.0.0.1';
  // A tunnel/reverse proxy connects from loopback, so loopback alone must not
  // grant admin privileges when any standard forwarding marker is present.
  const viaProxy = Boolean(
    req.headers['x-real-ip']
    || req.headers['x-forwarded-for']
    || req.headers['cf-connecting-ip']
    || req.headers.forwarded,
  );

  if (isLocal && !viaProxy) {
    return {
      ok: true,
      context: {
        app: (req.headers['x-app-name'] as string) ?? 'local',
        apiKey: null,
        rpmOverride: null,
        isAdmin: true,
        isLocal: true,
      },
    };
  }

  if (cfg.apiKeys.length === 0) {
    return { ok: false, error: 'Remote access disabled (no API keys configured)' };
  }

  const authHeader = (req.headers['authorization'] as string) ?? '';
  const xApiKey = (req.headers['x-api-key'] as string) ?? '';
  // Accept both OpenAI-style `Authorization: Bearer` and Anthropic-style `x-api-key`.
  const token = authHeader.replace('Bearer ', '').trim() || xApiKey.trim();
  if (!token) return { ok: false, error: 'Missing Authorization or x-api-key header' };

  for (const entry of cfg.apiKeys) {
    const norm = normalizeApiKey(entry);
    if (safeKeyCompare(norm.key, token)) {
      return {
        ok: true,
        context: {
          app: norm.app ?? 'unknown',
          apiKey: token,
          rpmOverride: norm.rpm,
          isAdmin: norm.admin,
          isLocal: false,
        },
      };
    }
  }
  return { ok: false, error: 'Invalid API key' };
}
