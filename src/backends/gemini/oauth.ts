import { readFileSync } from 'node:fs';
import path from 'node:path';

const GEMINI_OAUTH_FILE = path.join(process.env.HOME ?? '', '.gemini', 'oauth_creds.json');

interface GeminiCreds {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
}

export function getGeminiCredentials(): GeminiCreds | null {
  try {
    return JSON.parse(readFileSync(GEMINI_OAUTH_FILE, 'utf-8')) as GeminiCreds;
  } catch {
    return null;
  }
}

/** Gemini CLI handles its own refresh on every invocation. Trigger one explicit ping
 * to force-refresh the OAuth credentials cached on disk. */
export async function pingGemini(call: (model: string) => Promise<string>): Promise<{ remainingHours: number | null }> {
  await call('gemini-2.5-flash');
  const creds = getGeminiCredentials();
  if (!creds?.expiry_date) return { remainingHours: null };
  return { remainingHours: +((creds.expiry_date - Date.now()) / 3600_000).toFixed(2) };
}
