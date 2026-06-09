import type { FastifyRequest } from 'fastify';
import { normalizeApiKey } from '../config/schema.js';
import type { RuntimeConfig } from '../config/runtime.js';

export interface AuthContext {
  app: string;
  apiKey: string | null;
  rpmOverride: number | null;
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
  const viaProxy = !!req.headers['x-real-ip'];

  if (isLocal && !viaProxy) {
    return {
      ok: true,
      context: { app: (req.headers['x-app-name'] as string) ?? 'local', apiKey: null, rpmOverride: null },
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
    if (norm.key === token) {
      return {
        ok: true,
        context: { app: norm.app ?? 'unknown', apiKey: token, rpmOverride: norm.rpm },
      };
    }
  }
  return { ok: false, error: 'Invalid API key' };
}
