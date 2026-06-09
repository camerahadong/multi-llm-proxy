import { existsSync } from 'node:fs';
import path from 'node:path';

/** Mot tai khoan Claude = 1 thu muc config (CLAUDE_CONFIG_DIR) co .credentials.json. */
export interface ClaudeAccount {
  label: string;
  /** Duong dan CLAUDE_CONFIG_DIR; undefined = mac dinh ~/.claude (khong set env). */
  dir: string;
  /** Epoch ms tai khoan het quota toi luc nay. 0 = dang OK. */
  limitedUntil: number;
}

let cache: ClaudeAccount[] | null = null;

/**
 * Tu dong phat hien cac tai khoan: ~/.claude, ~/.claude2, ~/.claude3...
 * Chi nhan account nao co .credentials.json that su.
 */
export function getClaudeAccounts(): ClaudeAccount[] {
  if (cache) return cache;
  const home = process.env.HOME ?? '';
  const candidates: Array<{ label: string; dir: string }> = [
    { label: 'claude', dir: path.join(home, '.claude') },
    { label: 'claude2', dir: path.join(home, '.claude2') },
    { label: 'claude3', dir: path.join(home, '.claude3') },
    { label: 'claude4', dir: path.join(home, '.claude4') },
  ];
  const found = candidates
    .filter((c) => existsSync(path.join(c.dir, '.credentials.json')))
    .map((c) => ({ ...c, limitedUntil: 0 }));
  cache = found.length
    ? found
    : [{ label: 'claude', dir: path.join(home, '.claude'), limitedUntil: 0 }];
  return cache;
}

/** Cac account chua bi gioi han (limitedUntil da qua hoac = 0). */
export function availableAccounts(now: number): ClaudeAccount[] {
  return getClaudeAccounts().filter((a) => a.limitedUntil <= now);
}

/**
 * Doc thoi diem reset tu thong bao quota cua Claude.
 * Vi du: "You've hit your weekly limit · resets 3am (Asia/Ho_Chi_Minh)".
 * Tra ve epoch ms cua lan "Nam" gio do tiep theo (gio local server = Asia/Ho_Chi_Minh).
 * Khong doc duoc -> null (caller tu dat fallback).
 */
export function parseResetTime(msg: string, now = Date.now()): number | null {
  const m = msg.match(/resets?\s+(\d{1,2})\s*([ap]m)/i);
  if (!m) return null;
  let hr = parseInt(m[1], 10) % 12;
  if (m[2].toLowerCase() === 'pm') hr += 12;
  const reset = new Date(now);
  reset.setHours(hr, 0, 0, 0);
  if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1);
  return reset.getTime();
}
