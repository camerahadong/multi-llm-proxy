import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../../src/backends/codex/cli.js';
import type { CallInput } from '../../src/backends/types.js';

function input(model: string): CallInput {
  return { userPrompt: 'hello', model, timeoutMs: 60_000 };
}

describe('Codex CLI invocation', () => {
  it('forwards an explicit GPT-5.6 model and keeps the worker sandboxed', () => {
    const args = buildCodexArgs(input('gpt-5.6-terra'), 'hello');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.6-terra');
    expect(args).toContain('read-only');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('retains the account default for the legacy codex alias', () => {
    expect(buildCodexArgs(input('codex'), 'hello')).not.toContain('--model');
  });

  it('passes images through the native image flag', () => {
    const call = { ...input('gpt-5.6-sol'), imagePaths: ['/tmp/example.png'] };
    expect(buildCodexArgs(call, 'describe')).toEqual(expect.arrayContaining(['--image', '/tmp/example.png']));
    // Prompt must follow `--` so the variadic --image flag cannot swallow it.
    expect(buildCodexArgs(call, 'describe').slice(-2)).toEqual(['--', 'describe']);
  });
});
