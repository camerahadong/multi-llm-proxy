import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../../lib/logger.js';
import { clearAlertState, sendTelegramAlert } from '../../lib/telegram.js';

const CREDENTIALS_FILE = path.join(process.env.HOME ?? '', '.claude', '.credentials.json');
const REFRESH_MARGIN_MS = 60 * 60 * 1000;
const TOKEN_REFRESH_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
];

interface ClaudeCreds {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    subscriptionType?: string;
  };
}

export function getClaudeCredentials(): ClaudeCreds | null {
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8')) as ClaudeCreds;
  } catch {
    return null;
  }
}

function saveClaudeCredentials(creds: ClaudeCreds): void {
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
}

async function directRefresh(refreshToken: string): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; revoked?: boolean } | null> {
  const formats = [
    (url: string) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
      }),
    (url: string) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'cli' }).toString(),
      }),
    (url: string) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'cli' }),
      }),
  ];

  for (const url of TOKEN_REFRESH_URLS) {
    for (const fetcher of formats) {
      try {
        const resp = await fetcher(url);
        if (resp.ok) {
          const data = (await resp.json()) as { access_token?: string };
          if (data.access_token) {
            logger.info({ url }, 'claude oauth direct refresh ok');
            return data;
          }
        }
        if (resp.status === 401 || resp.status === 403) {
          return { revoked: true };
        }
      } catch (err) {
        logger.debug({ url, err: (err as Error).message }, 'claude direct refresh error');
      }
    }
  }
  return null;
}

function cliRefresh(): Promise<boolean> {
  return new Promise((resolve) => {
    const before = getClaudeCredentials()?.claudeAiOauth?.expiresAt ?? 0;
    const proc = spawn(
      'claude',
      ['-p', 'ping', '--output-format', 'json', '--max-turns', '1', '--model', 'claude-haiku-4-5-20251001'],
      { timeout: 30000, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' } },
    );
    proc.on('close', (code) => {
      if (code === 0) {
        const after = getClaudeCredentials()?.claudeAiOauth?.expiresAt ?? 0;
        resolve(after > before);
        return;
      }
      resolve(false);
    });
    proc.on('error', () => resolve(false));
  });
}

let refreshFailCount = 0;
let refreshTimer: NodeJS.Timeout | null = null;
let inFlightRefresh: Promise<boolean> | null = null;

export function refreshClaudeToken(): Promise<boolean> {
  // Coalesce concurrent calls — a single refresh in flight at a time, so
  // we never interleave reads/writes against ~/.claude/.credentials.json.
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = doRefreshClaudeToken().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function doRefreshClaudeToken(): Promise<boolean> {
  const creds = getClaudeCredentials();
  if (!creds?.claudeAiOauth?.refreshToken) {
    logger.error('claude: no refresh token. Run: claude /login');
    return false;
  }

  const oauth = creds.claudeAiOauth;
  const remaining = oauth.expiresAt - Date.now();
  if (remaining > REFRESH_MARGIN_MS) return true;

  try {
    if (await cliRefresh()) {
      const updated = getClaudeCredentials();
      if (updated?.claudeAiOauth) {
        logger.info({ expiresAt: new Date(updated.claudeAiOauth.expiresAt).toISOString() }, 'claude token refreshed via cli');
      }
      refreshFailCount = 0;
      await sendTelegramAlert('claude_failure', 'recovery',
        '✅ <b>Claude proxy</b>\n\n🔑 Token refresh thành công.');
      clearAlertState('claude_revoked');
      scheduleClaudeRefresh();
      return true;
    }

    const direct = await directRefresh(oauth.refreshToken);
    if (direct?.access_token) {
      creds.claudeAiOauth = {
        ...oauth,
        accessToken: direct.access_token,
        refreshToken: direct.refresh_token ?? oauth.refreshToken,
        expiresAt: Date.now() + ((direct.expires_in ?? 3600) * 1000),
      };
      saveClaudeCredentials(creds);
      refreshFailCount = 0;
      await sendTelegramAlert('claude_failure', 'recovery',
        '✅ <b>Claude proxy</b>\n\n🔑 Token refresh (direct API) thành công.');
      clearAlertState('claude_revoked');
      scheduleClaudeRefresh();
      return true;
    }

    if (direct?.revoked) {
      await sendTelegramAlert('claude_revoked', 'incident',
        '🚨 <b>Claude proxy - KHẨN CẤP</b>\n\n❌ Refresh token bị thu hồi!\n\n👉 SSH chạy: <code>claude /login</code>');
      refreshFailCount = 0;
      return false;
    }

    refreshFailCount++;
    if (refreshFailCount >= 3) {
      await sendTelegramAlert('claude_failure', 'incident',
        `⚠️ <b>Claude proxy</b>\n\n❌ Token refresh thất bại ${refreshFailCount} lần. Proxy sẽ tự retry.`);
    }
    return false;
  } catch (err) {
    refreshFailCount++;
    logger.error({ err: (err as Error).message, attempt: refreshFailCount }, 'claude refresh error');
    if (refreshFailCount >= 3) {
      await sendTelegramAlert('claude_failure', 'incident',
        `⚠️ <b>Claude proxy</b>\n\n❌ Token refresh error: ${(err as Error).message}`);
    }
    return false;
  }
}

export function scheduleClaudeRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const creds = getClaudeCredentials();
  if (!creds?.claudeAiOauth?.expiresAt) return;
  const refreshAt = creds.claudeAiOauth.expiresAt - REFRESH_MARGIN_MS;
  const delay = Math.max(refreshAt - Date.now(), 60_000);
  refreshTimer = setTimeout(async () => {
    const ok = await refreshClaudeToken();
    if (!ok) refreshTimer = setTimeout(() => refreshClaudeToken(), 5 * 60_000).unref?.() ?? null;
  }, delay);
  refreshTimer.unref?.();
  logger.info({ nextRefreshAt: new Date(Date.now() + delay).toISOString() }, 'claude refresh scheduled');
}

export function startClaudeTokenManager(): void {
  const creds = getClaudeCredentials();
  if (!creds?.claudeAiOauth) {
    logger.warn('claude: no credentials. Run: claude /login');
    return;
  }
  const remaining = creds.claudeAiOauth.expiresAt - Date.now();
  if (remaining < REFRESH_MARGIN_MS) {
    void refreshClaudeToken();
  } else {
    scheduleClaudeRefresh();
  }
  setInterval(() => {
    const c = getClaudeCredentials();
    if (c?.claudeAiOauth && c.claudeAiOauth.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      void refreshClaudeToken();
    }
  }, 30 * 60_000).unref?.();
}
