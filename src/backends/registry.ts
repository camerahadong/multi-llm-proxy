import type { BackendAdapter, BackendName } from './types.js';

/** Aliases that resolve to canonical model names. Codex/Gemini model names are NOT in here —
 * they're matched via `isCodexModel`/`isGeminiModel` directly. Keep aliases additive: a key
 * here must never collide with an entry of `CODEX_MODEL_SET` or `GEMINI_MODEL_SET`. */
export const MODEL_MAP: Record<string, string> = {
  'gpt-4': 'claude-opus-4-7',
  'gpt-3.5-turbo': 'claude-sonnet-4-6',
  'claude-opus': 'claude-opus-4-7',
  'claude-sonnet': 'claude-sonnet-4-6',
  'claude-haiku': 'claude-haiku-4-5-20251001',
  'anthropic/claude-opus-4-7': 'claude-opus-4-7',
  'anthropic/claude-opus-4-6': 'claude-opus-4-6',
  'anthropic/claude-sonnet-4-6': 'claude-sonnet-4-6',
  'anthropic/claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  opus: 'claude-opus-4-7',
  'opus-4-6': 'claude-opus-4-6',
  'opus-stable': 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
  best: 'claude-opus-4-7',
  fast: 'claude-sonnet-4-6',
  cheap: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-pro',
  'gemini-pro': 'gemini-2.5-pro',
  'gemini-flash': 'gemini-2.5-flash',
  pro: 'gemini-2.5-pro',
  flash: 'gemini-2.5-flash',
  'google/gemini-2.5-pro': 'gemini-2.5-pro',
  'google/gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-3.1': 'gemini-3.1-pro-preview',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  '3.1-pro': 'gemini-3.1-pro-preview',
  'pro-3.1': 'gemini-3.1-pro-preview',
  'google/gemini-3.1-pro': 'gemini-3.1-pro-preview',
};

const CODEX_MODEL_SET = new Set([
  'gpt-5.5', 'gpt-5.4', 'gpt-5',
  'gpt-4o', 'gpt-4o-mini',
  'o3', 'o3-mini', 'o4-mini',
  'codex', 'codex-mini',
]);

const GEMINI_MODEL_SET = new Set([
  'gemini-3.1-pro-preview',
  'gemini-3-pro', 'gemini-3-pro-preview',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
  'gemini-1.5-pro', 'gemini-1.5-flash',
]);

export function isCodexModel(model: string): boolean {
  return CODEX_MODEL_SET.has(model) || /^(o3|o4|gpt-4o|gpt-5)/.test(model);
}

export function isGeminiModel(model: string): boolean {
  return GEMINI_MODEL_SET.has(model) || /^gemini[-/]/i.test(model);
}

export interface ResolvedRoute {
  backend: BackendName;
  model: string;
  thinking: boolean;
}

export function resolveModel(input: string): ResolvedRoute {
  let model = input;
  let thinking = false;
  if (model.endsWith('-thinking')) {
    thinking = true;
    model = model.slice(0, -'-thinking'.length);
  }
  model = MODEL_MAP[model] ?? model;
  let backend: BackendName = 'claude';
  if (isCodexModel(model)) backend = 'codex';
  else if (isGeminiModel(model)) backend = 'gemini';
  return { backend, model, thinking };
}

export class BackendRegistry {
  private readonly map = new Map<BackendName, BackendAdapter>();

  register(adapter: BackendAdapter): void {
    this.map.set(adapter.name, adapter);
  }

  get(name: BackendName): BackendAdapter {
    const adapter = this.map.get(name);
    if (!adapter) throw new Error(`No backend adapter registered for "${name}"`);
    return adapter;
  }

  all(): BackendAdapter[] {
    return [...this.map.values()];
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.map.values()].map((a) => a.shutdown()));
  }
}
