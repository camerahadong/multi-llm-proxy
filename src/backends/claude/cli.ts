import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { killSubprocess } from '../../lib/kill-process.js';
import { logger } from '../../lib/logger.js';
import { BackendCancelledError, BackendError, BackendTimeoutError } from '../errors.js';
import type { CallInput, CallResult } from '../types.js';

export const CLAUDE_QUOTA_PATTERNS = [
  "you've hit your limit",
  'you have reached your limit',
  'usage limit',
  'rate limit',
  'quota',
];

export function isClaudeQuotaMessage(content: string): boolean {
  const text = content.toLowerCase();
  return CLAUDE_QUOTA_PATTERNS.some((p) => text.includes(p)) || /resets?\s+\d/.test(text);
}

export function callClaudeCli(
  input: CallInput,
  signal: AbortSignal,
  configDir?: string,
): Promise<CallResult> {
  return new Promise<CallResult>((resolve, reject) => {
    const { userPrompt, systemPrompt, model, visionMode, thinking, timeoutMs } = input;
    const effectiveMaxTurns = visionMode ? 3 : 1;

    const args = [
      '-p', userPrompt,
      '--output-format', 'json',
      '--max-turns', String(effectiveMaxTurns),
      '--model', model,
      // No user/project settings: keeps hooks/plugins (e.g. statusline banners)
      // out of API responses. OAuth credentials still load from the config dir.
      '--setting-sources', '',
    ];

    if (thinking) args.push('--think');

    if (visionMode) {
      args.push('--allowedTools', 'Read');
      if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    } else {
      const noTools =
        '\n\nIMPORTANT: Do NOT use any built-in tools (WebSearch, WebFetch, Read, Edit, Bash, etc). Respond with text only.';
      args.push('--append-system-prompt', (systemPrompt ?? '') + noTools);
    }

    const proc = spawn('claude', args, {
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Neutral cwd: running in the proxy repo leaks its git status/file list
      // into the model's context (and wastes tokens) on every request.
      cwd: tmpdir(),
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
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
      reject(new BackendCancelledError('claude'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;

      try {
        const json = JSON.parse(stdout);
        if (json.result !== undefined) {
          resolve({
            content: String(json.result ?? ''),
            cost: json.total_cost_usd ?? 0,
            model: Object.keys(json.modelUsage ?? {})[0] ?? model,
            inputTokens: json.usage?.input_tokens ?? 0,
            outputTokens: json.usage?.output_tokens ?? 0,
            cacheRead: json.usage?.cache_read_input_tokens ?? 0,
            cacheCreation: json.usage?.cache_creation_input_tokens ?? 0,
            durationMs: json.duration_ms ?? 0,
          });
          return;
        }
      } catch {
        /* not JSON */
      }

      if (code !== 0) {
        logger.debug(
          { code, stdout: stdout.slice(0, 300), stderr: stderr.slice(0, 300), promptLen: userPrompt.length },
          'claude cli non-zero exit',
        );
        const isTimeout = code === null && proc.killed;
        reject(
          isTimeout
            ? new BackendTimeoutError('claude', timeoutMs)
            : new BackendError(`Claude CLI exited ${code}: ${stderr.slice(0, 500)}`, 'claude'),
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
      reject(new BackendError(`Claude CLI spawn failed: ${err.message}`, 'claude', err));
    });
  });
}
