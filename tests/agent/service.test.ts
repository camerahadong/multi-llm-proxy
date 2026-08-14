import { describe, expect, it } from 'vitest';
import { AgentApiError, AgentService } from '../../src/agent/service.js';
import { configSchema } from '../../src/config/schema.js';
import { RuntimeConfig } from '../../src/config/runtime.js';

function createService(overrides: Record<string, unknown> = {}): AgentService {
  const config = configSchema.parse({
    agent: {
      enabled: true,
      defaultCwd: '/tmp',
      allowedRoots: ['/tmp'],
      writableRoots: [],
      ...overrides,
    },
  });
  return new AgentService(new RuntimeConfig(config));
}

describe('AgentService security boundary', () => {
  it('rejects a cwd outside configured roots before starting Codex', async () => {
    const service = createService();
    await expect(service.createSession({ cwd: '/home' })).rejects.toMatchObject<Partial<AgentApiError>>({
      statusCode: 403,
      code: 'agent_path_not_allowed',
    });
    await service.shutdown();
  });

  it('requires a separate writable-root allowlist for workspace-write', async () => {
    const service = createService();
    await expect(service.createSession({ cwd: '/tmp', sandbox: 'workspace-write' })).rejects.toMatchObject<Partial<AgentApiError>>({
      statusCode: 403,
      code: 'agent_path_not_allowed',
    });
    await service.shutdown();
  });

  it('rejects network access and unapproved models from config policy', async () => {
    const service = createService({ allowedModels: ['gpt-5.6-terra'], allowNetwork: false });
    await expect(service.createSession({ cwd: '/tmp', networkAccess: true })).rejects.toMatchObject({
      code: 'agent_network_disabled',
    });
    await expect(service.createSession({ cwd: '/tmp', model: 'not-allowed' })).rejects.toMatchObject({
      code: 'agent_model_not_allowed',
    });
    await service.shutdown();
  });
});
