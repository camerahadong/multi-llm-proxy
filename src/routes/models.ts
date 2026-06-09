import type { FastifyInstance } from 'fastify';

export async function modelsRoute(app: FastifyInstance): Promise<void> {
  app.get('/v1/models', async () => ({
    object: 'list',
    data: [
      { id: 'auto', object: 'model', owned_by: 'proxy', description: 'Auto-route: simple→Sonnet, complex→Opus (Claude)' },
      { id: 'claude-opus-4-8', object: 'model', owned_by: 'anthropic', description: 'Best quality Claude (Jun 2026), latest Opus' },
      { id: 'claude-opus-4-7', object: 'model', owned_by: 'anthropic', description: 'Opus 4.7 (Feb 2026), higher cost' },
      { id: 'claude-opus-4-6', object: 'model', owned_by: 'anthropic', description: 'Opus 4.6 stable (Nov 2025), ~40% cheaper than 4.7, premium quality' },
      { id: 'claude-sonnet-4-6', object: 'model', owned_by: 'anthropic', description: 'Good quality Claude, lower cost' },
      { id: 'claude-haiku-4-5-20251001', object: 'model', owned_by: 'anthropic', description: 'Fastest Claude, lowest cost' },
      { id: 'gpt-5.5', object: 'model', owned_by: 'openai', description: 'GPT-5.5 — ChatGPT Plus OAuth' },
      { id: 'gpt-5', object: 'model', owned_by: 'openai', description: 'GPT-5 stable' },
      { id: 'o3', object: 'model', owned_by: 'openai', description: 'OpenAI o3 reasoning' },
      { id: 'o4-mini', object: 'model', owned_by: 'openai', description: 'OpenAI o4-mini reasoning' },
      { id: 'gpt-4o', object: 'model', owned_by: 'openai', description: 'GPT-4o multimodal' },
    ],
    aliases: {
      'auto/smart': 'Auto-route Opus or Sonnet (Claude)',
      'opus/best': 'claude-opus-4-8',
      'opus-4-7': 'claude-opus-4-7 (Feb 2026)',
      'opus-4-6': 'claude-opus-4-6 (Nov 2025 stable, ~40% cheaper than 4.7)',
      'sonnet/fast/cheap': 'claude-sonnet-4-6',
      haiku: 'claude-haiku-4-5-20251001',
      'o3/o4-mini/gpt-4o/codex': 'OpenAI via Codex CLI',
      thinking: 'Append -thinking to any Claude model, or pass body.thinking=true',
    },
  }));
}
