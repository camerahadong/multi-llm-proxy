import type { FastifyRequest } from 'fastify';
import type { RuntimeConfig } from '../config/runtime.js';
import { authenticate } from './auth.js';

export interface AuthDenied {
  code: number;
  body: { error: { message: string; type: string; code: string } };
}

/**
 * Guard for admin/sensitive routes. Returns null when the request is allowed
 * (localhost or valid API key), or an {code, body} pair to send on denial.
 *
 * Usage in a handler:
 *   const denied = authGuard(req, ctx.runtime);
 *   if (denied) { reply.code(denied.code); return denied.body; }
 */
export function authGuard(req: FastifyRequest, runtime: RuntimeConfig): AuthDenied | null {
  const auth = authenticate(req, runtime);
  if (!auth.ok) {
    return {
      code: 401,
      body: { error: { message: auth.error, type: 'invalid_request_error', code: 'invalid_api_key' } },
    };
  }
  return null;
}
