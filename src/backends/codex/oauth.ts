import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../../lib/logger.js';
import { clearAlertState, sendTelegramAlert } from '../../lib/telegram.js';

const CODEX_AUTH_FILE = path.join(process.env.HOME ?? '', '.codex', 'auth.json');
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

interface CodexAuth {
  tokens?: {
    access_token: string;
    refresh_token: string;
    id_token?: string;
  };
  last_refresh?: string;
}

export function getCodexAuth(): CodexAuth | null {
  try {
    return JSON.parse(readFileSync(CODEX_AUTH_FILE, 'utf-8')) as CodexAuth;
  } catch {
    return null;
  }
}

function saveCodexAuth(auth: CodexAuth): void {
  writeFileSync(CODEX_AUTH_FILE, JSON.stringify(auth, null, 2));
}

function parseExpiry(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    return decoded.exp ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function getCodexTokenExpiry(): number | null {
  const auth = getCodexAuth();
  if (!auth?.tokens?.access_token) return null;
  return parseExpiry(auth.tokens.access_token);
}

let refreshFailCount = 0;
let refreshTimer: NodeJS.Timeout | null = null;
let inFlightRefresh: Promise<boolean> | null = null;

export function refreshCodexToken(): Promise<boolean> {
  // Coalesce concurrent calls — a single refresh in flight at a time, so
  // we never interleave reads/writes against ~/.codex/auth.json.
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = doRefreshCodexToken().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function doRefreshCodexToken(): Promise<boolean> {
  const auth = getCodexAuth();
  if (!auth?.tokens?.refresh_token) {
    logger.error('codex: no refresh token. Run: codex login --device-auth');
    return false;
  }
  const expiresAt = parseExpiry(auth.tokens.access_token);
  if (expiresAt && expiresAt - Date.now() > CODEX_REFRESH_MARGIN_MS) return true;

  try {
    const resp = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: auth.tokens.refresh_token,
        client_id: CODEX_CLIENT_ID,
      }).toString(),
    });
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        await sendTelegramAlert('codex_revoked', 'incident',
          '🚨 <b>Codex proxy</b>\n\n❌ Refresh token bị thu hồi!\n\n👉 Chạy: <code>codex login --device-auth</code>');
        return false;
      }
      throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 100)}`);
    }
    const data = (await resp.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
    if (!data.access_token) throw new Error('No access_token in response');

    auth.tokens.access_token = data.access_token;
    if (data.refresh_token) auth.tokens.refresh_token = data.refresh_token;
    if (data.id_token) auth.tokens.id_token = data.id_token;
    auth.last_refresh = new Date().toISOString();
    saveCodexAuth(auth);

    refreshFailCount = 0;
    await sendTelegramAlert('codex_failure', 'recovery',
      '✅ <b>Codex proxy</b>\n\n🔑 Token refresh thành công.');
    clearAlertState('codex_revoked');
    scheduleCodexRefresh();
    return true;
  } catch (err) {
    refreshFailCount++;
    logger.error({ err: (err as Error).message, attempt: refreshFailCount }, 'codex refresh error');
    if (refreshFailCount >= 3) {
      await sendTelegramAlert('codex_failure', 'incident',
        `⚠️ <b>Codex proxy</b>\n\n❌ Token refresh thất bại ${refreshFailCount} lần: ${(err as Error).message}`);
    }
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshCodexToken(), 30 * 60_000);
    refreshTimer.unref?.();
    return false;
  }
}

export function scheduleCodexRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const expiresAt = getCodexTokenExpiry();
  if (!expiresAt) return;
  const refreshAt = expiresAt - CODEX_REFRESH_MARGIN_MS;
  const delay = Math.max(refreshAt - Date.now(), 60_000);
  refreshTimer = setTimeout(() => refreshCodexToken(), delay);
  refreshTimer.unref?.();
  logger.info({ nextRefreshAt: new Date(Date.now() + delay).toISOString() }, 'codex refresh scheduled');
}

export function startCodexTokenManager(): void {
  const expiresAt = getCodexTokenExpiry();
  if (!expiresAt) {
    logger.warn('codex: no token. Run: codex login --device-auth');
    return;
  }
  if (expiresAt - Date.now() < CODEX_REFRESH_MARGIN_MS) {
    void refreshCodexToken();
  } else {
    scheduleCodexRefresh();
  }
  setInterval(() => {
    const exp = getCodexTokenExpiry();
    if (exp && exp - Date.now() < CODEX_REFRESH_MARGIN_MS) void refreshCodexToken();
  }, 6 * 60 * 60_000).unref?.();
}
