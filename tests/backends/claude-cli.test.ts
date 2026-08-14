import { describe, expect, it } from 'vitest';
import { isClaudeAuthMessage, isClaudeQuotaMessage, pickUsedModel } from '../../src/backends/claude/cli.js';

describe('Claude CLI failure classification', () => {
  it('recognizes expired OAuth responses returned as successful CLI output', () => {
    expect(isClaudeAuthMessage('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true);
  });

  it('keeps normal model output out of the failure path', () => {
    expect(isClaudeAuthMessage('{"ok":true}')).toBe(false);
    expect(isClaudeQuotaMessage('{"ok":true}')).toBe(false);
  });

  it('counts cached tokens when identifying the answer model', () => {
    expect(pickUsedModel({
      'claude-haiku-4-5-20251001': { inputTokens: 520, outputTokens: 12 },
      'claude-opus-5': { inputTokens: 2, outputTokens: 4, cacheCreationInputTokens: 3_596 },
    }, 'claude-fable-5')).toBe('claude-opus-5');
  });
});
