import { spawn } from 'node:child_process';
import path from 'node:path';
import { killSubprocess } from '../../lib/kill-process.js';
import { logger } from '../../lib/logger.js';
import { BackendCancelledError, BackendError, BackendTimeoutError } from '../errors.js';
import type { CallInput, CallResult } from '../types.js';

const GEMINI_BIN = path.join(process.env.HOME ?? '', '.npm-global', 'bin', 'gemini');
const GEMINI_WORK_DIR = '/tmp';
export const GEMINI_DEFAULT_MODEL = 'gemini-3-pro';

export function callGeminiCli(input: CallInput, signal: AbortSignal): Promise<CallResult> {
  return new Promise<CallResult>((resolve, reject) => {
    const { userPrompt, systemPrompt, model, timeoutMs } = input;

    const fullPrompt = systemPrompt
      ? `[System instructions]\n${systemPrompt}\n\n[User]\n${userPrompt}`
      : userPrompt;

    const args = ['-p', fullPrompt, '-o', 'json', '-y', '--model', model];

    const proc = spawn(GEMINI_BIN, args, {
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: GEMINI_WORK_DIR,
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.npm-global/bin:${process.env.PATH}`,
        GOOGLE_GENAI_USE_GCA: 'true',
        GEMINI_CLI_TRUST_WORKSPACE: 'true',
      },
    });
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let settled = false;
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    const onAbort = () => {
      if (settled) return;
      settled = true;
      killSubprocess(proc);
      reject(new BackendCancelledError('gemini'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;

      const jsonStart = stdout.indexOf('{');
      const jsonStr = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;

      try {
        const json = JSON.parse(jsonStr);
        if (json.error) {
          reject(new BackendError(`Gemini error: ${json.error.message ?? JSON.stringify(json.error)}`, 'gemini'));
          return;
        }
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheRead = 0;
        const modelsObj = (json.stats?.models ?? {}) as Record<string, { tokens?: { prompt?: number; candidates?: number; cached?: number } }>;
        for (const m of Object.values(modelsObj)) {
          inputTokens += m.tokens?.prompt ?? 0;
          outputTokens += m.tokens?.candidates ?? 0;
          cacheRead += m.tokens?.cached ?? 0;
        }
        const usedModel = Object.keys(modelsObj)[0] ?? model;
        resolve({
          content: json.response ?? '',
          cost: 0,
          model: usedModel,
          inputTokens,
          outputTokens,
          cacheRead,
          cacheCreation: 0,
          durationMs: 0,
        });
        return;
      } catch {
        /* not JSON */
      }

      if (code !== 0) {
        const isTimeout = code === null && proc.killed;
        logger.debug({ code, stdout: stdout.slice(0, 300), stderr: stderr.slice(0, 300) }, 'gemini non-zero exit');
        reject(
          isTimeout
            ? new BackendTimeoutError('gemini', timeoutMs)
            : new BackendError(`Gemini CLI exited ${code}: ${(stderr || stdout).slice(0, 300)}`, 'gemini'),
        );
        return;
      }
      resolve({
        content: stdout.trim(),
        cost: 0,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheCreation: 0,
        durationMs: 0,
      });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new BackendError(`Gemini CLI spawn failed: ${err.message}`, 'gemini', err));
    });
  });
}
