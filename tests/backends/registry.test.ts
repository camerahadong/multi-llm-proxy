import { describe, expect, it } from 'vitest';
import { resolveModel } from '../../src/backends/registry.js';

describe('resolveModel', () => {
  it('routes claude aliases', () => {
    expect(resolveModel('opus').backend).toBe('claude');
    expect(resolveModel('sonnet').model).toBe('claude-sonnet-4-6');
  });

  it('routes codex models', () => {
    expect(resolveModel('gpt-5.5').backend).toBe('codex');
    expect(resolveModel('o3').backend).toBe('codex');
  });

  it('routes opus aliases to opus-4-8', () => {
    expect(resolveModel('opus').model).toBe('claude-opus-4-8');
    expect(resolveModel('best').model).toBe('claude-opus-4-8');
    expect(resolveModel('opus-4-6').model).toBe('claude-opus-4-6');
  });

  it('strips -thinking suffix and flags thinking', () => {
    const r = resolveModel('claude-opus-4-7-thinking');
    expect(r.model).toBe('claude-opus-4-7');
    expect(r.thinking).toBe(true);
  });
});
