import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    const imagePaths = input.imagePaths ?? [];
    // Vision needs one Read turn per image plus a turn to answer. Give a little
    // headroom so multi-image montages don't run out of turns mid-read.
    const effectiveMaxTurns = visionMode ? Math.max(3, imagePaths.length + 2) : 1;

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
      // The images live outside cwd (tmpdir). In headless `-p` mode, `@path`
      // mentions are NOT auto-expanded, so the model would otherwise reply
      // "no image attached". Grant Read access to each image's directory and
      // explicitly instruct the model to Read every absolute path BEFORE
      // answering — this is what actually feeds the pixels into the context.
      const imageDirs = [...new Set(imagePaths.map((p) => path.dirname(p)))];
      for (const dir of imageDirs) args.push('--add-dir', dir);

      let visionSystem = systemPrompt ?? '';
      if (imagePaths.length > 0) {
        const list = imagePaths.map((p) => `- ${p}`).join('\n');
        const directive =
          `You have been given ${imagePaths.length} image file(s) to analyse. ` +
          `BEFORE answering, you MUST use the Read tool to open EACH of these absolute file paths:\n${list}\n` +
          `Treat the file contents as the image(s) the user is asking about. Do not claim no image was attached.`;
        visionSystem = visionSystem ? `${visionSystem}\n\n${directive}` : directive;
      }
      if (visionSystem) args.push('--append-system-prompt', visionSystem);
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
