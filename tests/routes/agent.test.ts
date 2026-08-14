import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import { RuntimeConfig } from '../../src/config/runtime.js';
import { agentRoute } from '../../src/routes/agent.js';
import type { AppContext } from '../../src/types/index.js';

function buildContext() {
  const runtime = new RuntimeConfig(configSchema.parse({
    apiKeys: [
      { key: 'normal-key-12345678', admin: false },
      { key: 'admin-key-12345678', admin: true },
    ],
  }));
  const fakeAgent = {
    listSessions: () => [{ id: 'session-1' }],
    getSession: () => ({ id: 'session-1' }),
    createSession: async () => ({ id: 'session-1' }),
    deleteSession: async () => undefined,
    startTurn: async () => ({ turnId: 'turn-1', status: 'inProgress' }),
    steer: async () => ({ turnId: 'turn-1' }),
    interrupt: async () => ({ interrupted: true, turnId: 'turn-1' }),
    getEvents: () => ({ events: [], nextSeq: 0, replayGap: false }),
    subscribe: () => () => undefined,
    respondToRequest: async () => undefined,
  };
  return { runtime, agent: fakeAgent } as unknown as AppContext;
}

describe('agent API routes', () => {
  it('requires an admin key for remote access', async () => {
    const app = Fastify();
    await agentRoute(app, buildContext());

    const denied = await app.inject({
      method: 'GET',
      url: '/v1/agent/sessions',
      headers: { authorization: 'Bearer normal-key-12345678' },
      remoteAddress: '203.0.113.10',
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('admin_required');

    const allowed = await app.inject({
      method: 'GET',
      url: '/v1/agent/sessions',
      headers: { authorization: 'Bearer admin-key-12345678' },
      remoteAddress: '203.0.113.10',
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().data).toEqual([{ id: 'session-1' }]);
    await app.close();
  });

  it('accepts structured text, image and audio inputs', async () => {
    const app = Fastify();
    await agentRoute(app, buildContext());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/sessions/session-1/turns',
      remoteAddress: '127.0.0.1',
      payload: {
        input: [
          { type: 'text', text: 'Kiểm tra dự án' },
          { type: 'image', url: 'data:image/png;base64,AA==' },
          { type: 'audio', url: 'data:audio/wav;base64,AA==' },
        ],
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ turnId: 'turn-1' });
    await app.close();
  });

  it('blocks file URLs and non-HTTPS remote media', async () => {
    const app = Fastify();
    await agentRoute(app, buildContext());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/sessions/session-1/turns',
      remoteAddress: '127.0.0.1',
      payload: { input: [{ type: 'image', url: 'file:///etc/passwd' }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_agent_request');
    await app.close();
  });
});
