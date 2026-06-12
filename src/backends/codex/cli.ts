import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { killSubprocess } from '../../lib/kill-process.js';
import { logger } from '../../lib/logger.js';
import { BackendCancelledError, BackendError, BackendTimeoutError } from '../errors.js';
import type { CallInput, CallResult } from '../types.js';

const CODEX_BIN = path.join(process.env.HOME ?? '', '.npm-global', 'bin', 'codex');

export function callCodexCli(input: CallInput, signal: AbortSignal): Promise<CallResult> {
  return new Promise<CallResult>((resolve, reject) => {
    const { userPrompt, systemPrompt, imagePaths = [], timeoutMs } = input;

    const fullPrompt = systemPrompt
      ? `[System instructions]\n${systemPrompt}\n\n[User]\n${userPrompt}`
      : userPrompt;

    const promptWithoutAtRefs = imagePaths.length > 0
      ? fullPrompt.replace(/@\/tmp\/(?:claude-vision|gemini-work)\/[^\s]+/g, '').replace(/\n{3,}/g, '\n\n').trim()
      : fullPrompt;

    // ChatGPT-account Codex rejects every `--model NAME` (gpt-5, gpt-5-codex, o3 …)
    // with HTTP 400 "model is not supported when using Codex with a ChatGPT account".
    // Omitting `-m` lets the CLI fall back to the account's default model, which works.
    const args = [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      promptWithoutAtRefs,
      ...imagePaths.flatMap((p) => ['-i', p]),
    ];

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
    proc.stdin.write('\n');
    proc.stdin.end();

    const jsonLines: string[] = [];
    let stderr = '';
    let settled = false;

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
        model: 'codex',
        inputTokens,
        outputTokens,
        cacheRead: 0,
        cacheCreation: 0,
        durationMs: 0,
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
