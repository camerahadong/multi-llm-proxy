import type { FastifyReply, FastifyRequest } from 'fastify';
import { isClaudeQuotaMessage } from '../backends/claude/cli.js';
import type { BackendName, CallResult } from '../backends/types.js';
import { resolveModel } from '../backends/registry.js';
import type { NormalisedInput } from '../adapters/openai-input.js';
import { clientIp, clientUserAgent } from './client-info.js';
import { logger } from './logger.js';
import { authenticate, type AuthContext } from '../middleware/auth.js';
import type { AppContext } from '../types/index.js';

/**
 * Shared request pipeline for the LLM routes (chat / messages / completions /
 * vision). Each route keeps only its protocol translation (OpenAI vs Anthropic
 * request/response shapes); auth, rate limiting, model routing, the
 * Claude→Codex fallback chain and stats/metrics recording live here so the
 * behaviours cannot drift between endpoints.
 */

export type ApiShape = 'openai' | 'anthropic';

export interface GuardOk {
  ok: true;
  context: AuthContext;
  appName: string;
}
export interface GuardFail {
  ok: false;
  payload: unknown;
}

/** Auth + rate limit + denied-logging. On failure the reply code/headers are
 * already set — the route just returns `payload`. */
export function guardRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: AppContext,
  shape: ApiShape,
  opts?: { defaultApp?: string; rateLimit?: boolean },
): GuardOk | GuardFail {
  const auth = authenticate(req, ctx.runtime);
  if (!auth.ok) {
    ctx.stats.logDenied({ ip: clientIp(req), userAgent: clientUserAgent(req), status: 401, reason: auth.error });
    reply.code(401);
    const payload =
      shape === 'anthropic'
        ? { type: 'error', error: { type: 'authentication_error', message: auth.error } }
        : { error: { message: auth.error, type: 'invalid_request_error', code: 'invalid_api_key' } };
    return { ok: false, payload };
  }

  if (opts?.rateLimit !== false) {
    const rate = ctx.rate.check(auth.context);
    if (!rate.ok) {
      ctx.stats.logDenied({
        app: auth.context.app,
        ip: clientIp(req),
        userAgent: clientUserAgent(req),
        status: 429,
        reason: 'rate_limit',
      });
      reply.code(429).header('Retry-After', String(rate.retryAfter));
      const message = `Rate limit exceeded: max ${rate.limit} req/min`;
      const payload =
        shape === 'anthropic'
          ? { type: 'error', error: { type: 'rate_limit_error', message } }
          : { error: { message, type: 'requests', code: 'rate_limit_exceeded' } };
      return { ok: false, payload };
    }
  }

  const appName = auth.context.app || ((req.headers['x-app-name'] as string) ?? opts?.defaultApp ?? 'unknown');
  return { ok: true, context: auth.context, appName };
}

export interface RouteResolution {
  backendName: BackendName;
  model: string;
  thinking: boolean;
  routeReason: string;
}

/** Model routing shared by chat/messages: `auto`/`smart` → Sonnet, otherwise
 * alias resolution via MODEL_MAP (which also picks the backend and may turn on
 * thinking via the `-thinking` suffix). */
export function resolveRequestedModel(
  requested: string | undefined,
  defaultModel: string,
  wantThinking: boolean,
): RouteResolution {
  let backendName: BackendName = 'claude';
  let model = requested ?? defaultModel;
  let thinking = wantThinking;
  let routeReason = '';

  if (model === 'auto' || model === 'smart') {
    model = 'claude-sonnet-4-6';
    routeReason = ' [auto]';
  } else {
    const resolved = resolveModel(model);
    backendName = resolved.backend;
    model = resolved.model;
    if (resolved.thinking) thinking = true;
    routeReason = ` [${backendName}]`;
  }
  if (thinking) routeReason += ' [thinking]';

  return { backendName, model, thinking, routeReason };
}

/**
 * Call the chosen backend; on Claude failure or quota-message response, fall
 * back once to Codex (unless the client already cancelled). Fallback results
 * get `model` rewritten to `codex:fallback-from-<model>` so callers can see it.
 */
export async function callWithFallback(
  ctx: AppContext,
  params: {
    normalised: NormalisedInput;
    model: string;
    backendName: BackendName;
    thinking: boolean;
    timeoutMs: number;
    signal: AbortSignal;
  },
): Promise<CallResult> {
  const { normalised, model, backendName, thinking, timeoutMs, signal } = params;

  const call = (target: BackendName) =>
    ctx.backends.get(target).call(
      {
        userPrompt: normalised.userPrompt,
        systemPrompt: normalised.systemPrompt || undefined,
        imagePaths: normalised.imagePaths,
        model,
        visionMode: normalised.imagePaths.length > 0 && target === 'claude',
        thinking,
        timeoutMs,
      },
      signal,
    );

  try {
    const result = await call(backendName);
    if (backendName === 'claude' && isClaudeQuotaMessage(result.content)) {
      logger.warn({ snippet: result.content.slice(0, 160) }, 'claude quota detected — falling back to codex');
      throw new Error(result.content);
    }
    return result;
  } catch (err) {
    if (backendName !== 'claude') throw err;
    // Client cancelled mid-call: stop the fallback chain.
    if (signal.aborted) throw err;
    const result = await call('codex');
    result.model = `codex:fallback-from-${model}`;
    return result;
  }
}

/** Stats + Prometheus recording for both outcomes. Error rows keep
 * model 'unknown' in billing stats (historical format) but the real model in
 * Prometheus labels. */
export function recordOutcome(
  ctx: AppContext,
  req: FastifyRequest,
  params: {
    appName: string;
    backendName: BackendName;
    model: string;
    elapsed: number;
    success: boolean;
    result?: CallResult;
  },
): void {
  const { appName, backendName, model, elapsed, success, result } = params;
  ctx.stats.track({
    app: appName,
    model: success ? model : 'unknown',
    duration: elapsed,
    success,
    inputTokens: result?.inputTokens ?? 0,
    outputTokens: result?.outputTokens ?? 0,
    cost: result?.cost ?? 0,
    ip: clientIp(req),
    userAgent: clientUserAgent(req),
  });
  ctx.metrics.requestsTotal.inc({ backend: backendName, model, status: success ? 'ok' : 'error' });
  if (success) ctx.metrics.requestDuration.observe({ backend: backendName, model }, elapsed);
}
