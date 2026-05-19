import { logger } from './logger.js';

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

type Mode = 'incident' | 'recovery' | 'always';

interface AlertState {
  fired: boolean;
  lastSent: number;
}

const state = new Map<string, AlertState>();

function getState(category: string): AlertState {
  let s = state.get(category);
  if (!s) {
    s = { fired: false, lastSent: 0 };
    state.set(category, s);
  }
  return s;
}

export async function sendTelegramAlert(
  category: string,
  mode: Mode,
  message: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const now = Date.now();
  const s = getState(category);

  if (mode === 'incident' && s.fired) return;
  if (mode === 'recovery' && !s.fired) return;
  if (mode !== 'recovery' && now - s.lastSent < ALERT_COOLDOWN_MS) return;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
    if (!resp.ok) {
      logger.error({ status: resp.status }, 'telegram send failed');
      return;
    }
    s.lastSent = now;
    if (mode === 'incident') s.fired = true;
    if (mode === 'recovery') s.fired = false;
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'telegram error');
  }
}

export function clearAlertState(category: string): void {
  const s = state.get(category);
  if (s) s.fired = false;
}
