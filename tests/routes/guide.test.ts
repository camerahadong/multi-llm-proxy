import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { guideRoute } from '../../src/routes/guide.js';

describe('guide routes', () => {
  it('serves the Vietnamese usage guide as HTML', async () => {
    const app = Fastify();
    await guideRoute(app);

    const response = await app.inject({ method: 'GET', url: '/huong-dan?format=html' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('HƯỚNG DẪN SỬ DỤNG MULTI LLM PROXY TỪ XA');
    expect(response.body).toContain('thanhcctv.bestmarathon.vn');

    await app.close();
  });
});
