import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import { RuntimeConfig } from '../../src/config/runtime.js';
import { authenticate } from '../../src/middleware/auth.js';
import { authGuard } from '../../src/middleware/require-auth.js';

const runtime = new RuntimeConfig(configSchema.parse({
  apiKeys: [
    { key: 'app-key-12345678', app: 'storyboard', admin: false },
    { key: 'admin-key-12345678', app: 'proxy-admin', admin: true },
  ],
}));

const request = (remoteAddress: string, token?: string): FastifyRequest => ({
  socket: { remoteAddress },
  headers: token ? { authorization: `Bearer ${token}` } : {},
} as unknown as FastifyRequest);

describe('remote API permissions', () => {
  it('allows an application key for normal authenticated API calls', () => {
    const result = authenticate(request('203.0.113.10', 'app-key-12345678'), runtime);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.app).toBe('storyboard');
      expect(result.context.isAdmin).toBe(false);
      expect(result.context.isLocal).toBe(false);
    }
  });

  it('blocks an application key from admin routes', () => {
    expect(authGuard(request('203.0.113.10', 'app-key-12345678'), runtime)).toMatchObject({
      code: 403,
      body: { error: { code: 'admin_required' } },
    });
  });

  it('allows an explicit admin key and localhost through the admin guard', () => {
    expect(authGuard(request('203.0.113.10', 'admin-key-12345678'), runtime)).toBeNull();
    expect(authGuard(request('127.0.0.1'), runtime)).toBeNull();
  });

  it('does not treat a loopback reverse-proxy connection as local admin', () => {
    const proxied = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'cf-connecting-ip': '203.0.113.10', 'x-forwarded-for': '203.0.113.10' },
    } as unknown as FastifyRequest;
    expect(authGuard(proxied, runtime)).toMatchObject({
      code: 401,
      body: { error: { code: 'invalid_api_key' } },
    });
  });
});
