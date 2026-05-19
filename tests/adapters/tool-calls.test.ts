import { describe, expect, it } from 'vitest';
import { buildToolSystemPrompt, parseToolCalls } from '../../src/adapters/tool-calls.js';

describe('tool-calls', () => {
  it('returns empty for no tools', () => {
    expect(buildToolSystemPrompt(null, 'auto')).toBe('');
  });

  it('builds prompt with required choice', () => {
    const p = buildToolSystemPrompt([{ function: { name: 'get_weather' } }], 'required');
    expect(p).toContain('get_weather');
    expect(p).toContain('CRITICAL REQUIREMENT');
  });

  it('parses direct tool_calls JSON', () => {
    const r = parseToolCalls('{"tool_calls":[{"name":"foo","arguments":{"x":1}}]}');
    expect(r.isToolCall).toBe(true);
    expect(r.toolCalls?.[0].function.name).toBe('foo');
  });

  it('parses tool_calls from code block', () => {
    const r = parseToolCalls('```json\n{"tool_calls":[{"name":"bar","arguments":"{}"}]}\n```');
    expect(r.isToolCall).toBe(true);
    expect(r.toolCalls?.[0].function.name).toBe('bar');
  });

  it('returns text content when no tool call', () => {
    const r = parseToolCalls('hello world');
    expect(r.isToolCall).toBe(false);
    expect(r.textContent).toBe('hello world');
  });
});
