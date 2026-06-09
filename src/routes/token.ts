import type { FastifyInstance, FastifyReply } from 'fastify';
import { getClaudeCredentials, refreshClaudeToken } from '../backends/claude/oauth.js';
import { getCodexAuth, getCodexTokenExpiry, refreshCodexToken } from '../backends/codex/oauth.js';
import type { AppContext } from '../types/index.js';

export async function tokenRoute(app: FastifyInstance, _ctx: AppContext): Promise<void> {
  app.get('/token', async () => {
    const creds = getClaudeCredentials();
    if (!creds?.claudeAiOauth) return { status: 'no_credentials' };
    const oauth = creds.claudeAiOauth;
    const remaining = oauth.expiresAt - Date.now();
    return {
      status: remaining > 0 ? 'valid' : 'expired',
      expiresAt: new Date(oauth.expiresAt).toISOString(),
      remainingHours: +(remaining / 3600_000).toFixed(2),
      hasRefreshToken: !!oauth.refreshToken,
      subscriptionType: oauth.subscriptionType,
    };
  });

  app.post('/token/refresh', async (_req, reply: FastifyReply) => {
    const ok = await refreshClaudeToken();
    if (!ok) {
      reply.code(500);
      return { ok: false, error: 'Token refresh failed. May need: claude /login' };
    }
    const creds = getClaudeCredentials();
    const exp = creds?.claudeAiOauth?.expiresAt ?? 0;
    return { ok: true, expiresAt: new Date(exp).toISOString(), remainingHours: +((exp - Date.now()) / 3600_000).toFixed(2) };
  });

  app.get('/token/codex', async () => {
    const expiresAt = getCodexTokenExpiry();
    if (!expiresAt) return { status: 'no_token' };
    const auth = getCodexAuth();
    return {
      status: expiresAt > Date.now() ? 'valid' : 'expired',
      expiresAt: new Date(expiresAt).toISOString(),
      remainingDays: +((expiresAt - Date.now()) / 86_400_000).toFixed(2),
      hasRefreshToken: !!auth?.tokens?.refresh_token,
      lastRefresh: auth?.last_refresh ?? null,
    };
  });

  app.post('/token/codex/refresh', async (_req, reply: FastifyReply) => {
    const ok = await refreshCodexToken();
    if (!ok) {
      reply.code(500);
      return { ok: false, error: 'Codex token refresh failed. Run: codex login --device-auth' };
    }
    const expiresAt = getCodexTokenExpiry() ?? 0;
    return { ok: true, expiresAt: new Date(expiresAt).toISOString(), remainingDays: +((expiresAt - Date.now()) / 86_400_000).toFixed(2) };
  });

}
