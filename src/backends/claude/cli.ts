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

export const CLAUDE_AUTH_PATTERNS = [
  'failed to authenticate',
  'oauth session expired',
  'authentication failed',
  'invalid oauth token',
  'please run /login',
];

export function isClaudeQuotaMessage(content: string): boolean {
  const text = content.toLowerCase();
  return CLAUDE_QUOTA_PATTERNS.some((p) => text.includes(p)) || /resets?\s+\d/.test(text);
}

// Phrases only the CLI itself emits when an account is blocked.
const CLAUDE_HARD_FAILURE_PATTERNS = ["you've hit your limit", 'you have reached your limit', 'please run /login', 'oauth session expired'];

/**
 * Is this CLI result a quota/auth failure (vs. a normal answer that merely
 * talks about quotas)? Pattern-matching every answer misfired on articles
 * mentioning "rate limit"/"quota": accounts got locked for an hour and the
 * request was rerouted to GPT. Require the CLI error flag, or a short message
 * with an unambiguous CLI phrase.
 */
export function isClaudeFailureResult(result: { content: string; isError?: boolean }): 'quota' | 'auth' | null {
  const text = result.content;
  const hard = text.length < 400 && CLAUDE_HARD_FAILURE_PATTERNS.some((p) => text.toLowerCase().includes(p));
  if (!result.isError && !hard) return null;
  if (isClaudeAuthMessage(text)) return 'auth';
  if (isClaudeQuotaMessage(text)) return 'quota';
  return null;
}

export function isClaudeAuthMessage(content: string): boolean {
  const text = content.toLowerCase();
  return CLAUDE_AUTH_PATTERNS.some((pattern) => text.includes(pattern));
}

/**
 * Chon model that su tu json.modelUsage. CLI ghi ca cac lenh haiku nen
 * (title/classify) vao modelUsage nen Object.keys()[0] co the tra ve haiku
 * du cau tra loi chay tren model khac. Uu tien model duoc yeu cau; neu khong
 * co thi lay key ton nhieu token nhat; cuoi cung fallback ve `requested`.
 */
export function pickUsedModel(
  modelUsage: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }> | undefined,
  requested: string,
): string {
  const keys = Object.keys(modelUsage ?? {});
  if (keys.length === 0) return requested;
  if (keys.includes(requested)) return requested;
  let best = keys[0];
  let bestTokens = -1;
  for (const k of keys) {
    const u = modelUsage![k];
    const tok =
      (u?.inputTokens ?? 0) +
      (u?.outputTokens ?? 0) +
      (u?.cacheReadInputTokens ?? 0) +
      (u?.cacheCreationInputTokens ?? 0);
    if (tok > bestTokens) {
      bestTokens = tok;
      best = k;
    }
  }
  return best;
}

export function callClaudeCli(
  input: CallInput,
  signal: AbortSignal,
  configDir?: string,
): Promise<CallResult> {
  return new Promise<CallResult>((resolve, reject) => {
    const { userPrompt, systemPrompt, model, visionMode, thinking, timeoutMs, onDelta } = input;
    // Real streaming: only for text mode (vision needs multi-turn Read).
    const streaming = !!onDelta && !visionMode;
    const imagePaths = input.imagePaths ?? [];
    // Vision needs one Read turn per image plus a turn to answer. Give a little
    // headroom so multi-image montages don't run out of turns mid-read.
    const effectiveMaxTurns = visionMode ? Math.max(3, imagePaths.length + 2) : 1;

    const args = [
      '-p', userPrompt,
      '--output-format', streaming ? 'stream-json' : 'json',
      ...(streaming ? ['--verbose', '--include-partial-messages'] : []),
      '--max-turns', String(effectiveMaxTurns),
      '--model', model,
      // No user/project settings: keeps hooks/plugins (e.g. statusline banners)
      // out of API responses. OAuth credentials still load from the config dir.
      '--setting-sources', '',
    ];

    // CLI removed --think; extended thinking is now driven by effort level.
    if (thinking) args.push('--effort', 'high');

    if (visionMode) {
      // SECURITY: scope Read to the request's own temp image dirs. A bare
      // `--allowedTools Read` let any API-key holder make the model read and
      // print arbitrary host files (e.g. config.json with all API keys).
      const readDirs = [...new Set(imagePaths.map((p) => path.dirname(p)))];
      for (const dir of readDirs) args.push('--allowedTools', `Read(/${dir}/**)`);
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
      // Lean vision: replace the default Claude Code prompt (~30k tokens) and
      // expose only the Read tool needed to load the images. ~35k -> ~4k tokens.
      args.push(
        '--system-prompt',
        visionSystem || 'You are a helpful assistant.',
        '--tools', 'Read',
        '--strict-mcp-config',
      );
    } else {
      // Lean mode: REPLACE Claude Code's default system prompt (~20k tokens of
      // coding-agent instructions + tool schemas) and disable built-in tools.
      // Text-only chat doesn't need them; dropping them cuts input ~20k -> ~0.5k
      // tokens per request and ~1s latency. (Vision uses its own lean prompt above.)
      const leanSystem = systemPrompt && systemPrompt.trim()
        ? systemPrompt
        : 'You are a helpful assistant. Respond with text only.';
      args.push('--system-prompt', leanSystem, '--tools', '', '--strict-mcp-config');
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
    // stream-json: one JSON event per line. Forward model text deltas live and
    // keep the final `result` event (same shape as --output-format json).
    let lineBuf = '';
    let streamResult: any = null;
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'result') { streamResult = ev; return; }
      const d = ev.type === 'stream_event' ? ev.event?.delta : null;
      if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text) {
        try { onDelta!(d.text); } catch { /* client gone */ }
      }
    };
    // Decode as a UTF-8 stream: a multi-byte char (Vietnamese) split across
    // two chunks would otherwise turn into U+FFFD garbage.
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (!streaming) return;
      lineBuf += s;
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        handleLine(lineBuf.slice(0, nl));
        lineBuf = lineBuf.slice(nl + 1);
      }
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

      if (streaming && lineBuf) { handleLine(lineBuf); lineBuf = ''; }
      try {
        const json = streaming ? streamResult ?? {} : JSON.parse(stdout);
        // The CLI reports API/model errors as a "successful" result with
        // is_error=true (exit code 0). Surface them as errors so the caller can
        // fall back — except quota/auth, which the account-rotation path
        // detects from the content.
        if (json.is_error && json.result !== undefined) {
          const msg = String(json.result ?? '');
          if (!isClaudeQuotaMessage(msg) && !isClaudeAuthMessage(msg)) {
            reject(new BackendError(`Claude CLI error: ${msg.slice(0, 300)}`, 'claude'));
            return;
          }
        }
        if (json.result !== undefined) {
          resolve({
            content: String(json.result ?? ''),
            cost: json.total_cost_usd ?? 0,
            model: pickUsedModel(json.modelUsage, model),
            inputTokens: json.usage?.input_tokens ?? 0,
            outputTokens: json.usage?.output_tokens ?? 0,
            cacheRead: json.usage?.cache_read_input_tokens ?? 0,
            cacheCreation: json.usage?.cache_creation_input_tokens ?? 0,
            durationMs: json.duration_ms ?? 0,
            isError: !!json.is_error,
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
