import { describe, expect, it } from 'vitest';
import { resolveModel } from '../../src/backends/registry.js';

describe('resolveModel', () => {
  it('routes claude aliases', () => {
    expect(resolveModel('opus').backend).toBe('claude');
    expect(resolveModel('sonnet').model).toBe('claude-sonnet-5-5');
    expect(resolveModel('claude-sonnet-5').model).toBe('claude-sonnet-5');
  });

  it('routes codex models', () => {
    expect(resolveModel('gpt-5.6').model).toBe('gpt-5.6-sol');
    expect(resolveModel('gpt-5.6-terra').backend).toBe('codex');
    expect(resolveModel('o3').backend).toBe('codex');
  });

  it('routes GPT-6 family to codex (not claude passthrough)', () => {
    expect(resolveModel('gpt-6.1-sol')).toMatchObject({ backend: 'codex', model: 'gpt-6.1-sol' });
    expect(resolveModel('gpt-6-luna').backend).toBe('codex');
    expect(resolveModel('chatgpt').model).toBe('gpt-6.1-sol');
    expect(resolveModel('gpt-6').model).toBe('gpt-6.1-sol');
  });

  it('routes opus aliases to opus-5-5 while preserving pinned versions', () => {
    expect(resolveModel('opus').model).toBe('claude-opus-5-5');
    expect(resolveModel('best').model).toBe('claude-opus-5-5');
    expect(resolveModel('claude-opus-5').model).toBe('claude-opus-5');
    expect(resolveModel('opus-4-8').model).toBe('claude-opus-4-8');
    expect(resolveModel('opus-4-6').model).toBe('claude-opus-4-6');
  });

  it('strips -thinking suffix and flags thinking', () => {
    const r = resolveModel('claude-opus-4-7-thinking');
    expect(r.model).toBe('claude-opus-4-7');
    expect(r.thinking).toBe(true);
  });
});
