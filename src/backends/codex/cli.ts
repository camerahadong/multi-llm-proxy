import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { killSubprocess } from '../../lib/kill-process.js';
import { logger } from '../../lib/logger.js';
import { BackendCancelledError, BackendError, BackendTimeoutError } from '../errors.js';
import type { CallInput, CallResult } from '../types.js';

const CODEX_BIN = path.join(process.env.HOME ?? '', '.npm-global', 'bin', 'codex');
const DEFAULT_MODEL_ALIASES = new Set(['codex', 'codex-mini', 'codex-default']);

/** Build a non-interactive, read-only Codex invocation. Explicit OpenAI model
 * IDs are forwarded to the CLI; legacy `codex*` aliases retain the account's
 * configured default for backwards compatibility. */
export function buildCodexArgs(input: CallInput, prompt: string): string[] {
  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--ignore-user-config',
    '--ignore-rules',
    '--json',
  ];
  if (!DEFAULT_MODEL_ALIASES.has(input.model)) args.push('--model', input.model);
  for (const imagePath of input.imagePaths ?? []) args.push('--image', imagePath);
  args.push(prompt);
  return args;
}

export function callCodexCli(input: CallInput, signal: AbortSignal): Promise<CallResult> {
  return new Promise<CallResult>((resolve, reject) => {
    const { userPrompt, systemPrompt, imagePaths = [], timeoutMs } = input;

    const fullPrompt = systemPrompt
      ? `[System instructions]\n${systemPrompt}\n\n[User]\n${userPrompt}`
      : userPrompt;

    const promptWithoutAtRefs = imagePaths.length > 0
      ? fullPrompt.replace(/@\/tmp\/(?:claude-vision|gemini-work)\/[^\s]+/g, '').replace(/\n{3,}/g, '\n\n').trim()
      : fullPrompt;

    const noToolsPrompt =
      `${promptWithoutAtRefs}\n\n` +
      'IMPORTANT: Do not use shell, filesystem, network, web, or other tools. Return the answer as text only.';
    const args = buildCodexArgs(input, noToolsPrompt);
    const startedAt = Date.now();

    const proc = spawn(CODEX_BIN, args, {
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Neutral cwd — same reason as claude/cli.ts: don't leak the proxy repo
      // into the model's workspace context.
      cwd: tmpdir(),
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.npm-global/bin:${process.env.PATH}`,
      },
    });
    proc.stdin.end();

    const jsonLines: string[] = [];
    let stderr = '';
    let settled = false;

    // Decode as a UTF-8 stream: a multi-byte char (Vietnamese) split across
    // two chunks would otherwise turn into U+FFFD garbage.
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      jsonLines.push(...d.toString().split('\n').filter((l: string) => l.trim()));
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    const onAbort = () => {
      if (settled) return;
      settled = true;
      killSubprocess(proc);
      reject(new BackendCancelledError('codex'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;

      let content = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let errorMsg: string | null = null;

      for (const line of jsonLines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
            content = ev.item.text ?? '';
          }
          if (ev.type === 'turn.completed' && ev.usage) {
            inputTokens = ev.usage.input_tokens ?? 0;
            outputTokens = ev.usage.output_tokens ?? 0;
          }
          if (ev.type === 'error' && !content) {
            errorMsg = typeof ev.message === 'string' ? ev.message : JSON.stringify(ev.message);
          }
        } catch {
          /* skip non-JSON line */
        }
      }

      if (errorMsg && !content) {
        reject(new BackendError(`Codex error: ${errorMsg.slice(0, 300)}`, 'codex'));
        return;
      }

      if (code !== 0 && !content) {
        const isTimeout = code === null && proc.killed;
        logger.debug({ code, stderr: stderr.slice(0, 300) }, 'codex non-zero exit');
        reject(
          isTimeout
            ? new BackendTimeoutError('codex', timeoutMs)
            : new BackendError(`Codex CLI exited ${code}: ${stderr.slice(0, 300)}`, 'codex'),
        );
        return;
      }

      resolve({
        content: content ?? '',
        cost: 0,
        model: DEFAULT_MODEL_ALIASES.has(input.model) ? 'codex' : input.model,
        inputTokens,
        outputTokens,
        cacheRead: 0,
        cacheCreation: 0,
        durationMs: Date.now() - startedAt,
      });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new BackendError(`Codex CLI spawn failed: ${err.message}`, 'codex', err));
    });
  });
}
