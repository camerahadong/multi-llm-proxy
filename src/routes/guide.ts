import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GUIDE_FILE, USER_GUIDE_VI_FILE } from '../config/load.js';
import { renderMarkdown } from '../lib/markdown.js';

export async function guideRoute(app: FastifyInstance): Promise<void> {
  const createHandler = (file: string, fileLabel: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    let md: string;
    try {
      md = readFileSync(file, 'utf-8');
    } catch {
      reply.code(500);
      return { error: { message: `${fileLabel} not found on server`, type: 'server_error' } };
    }
    const url = new URL(req.url, 'http://x');
    const format = url.searchParams.get('format') ?? 'markdown';
    if (format === 'json') {
      const sections = md
        .split(/^## /m)
        .slice(1)
        .map((s) => {
          const firstLine = s.split('\n', 1)[0].trim();
          return { title: firstLine, body: '## ' + s };
        });
      return { content: md, lines: md.split('\n').length, sections };
    }
    if (format === 'html') {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return renderMarkdown(md);
    }
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    return md;
  };

  const apiGuideHandler = createHandler(GUIDE_FILE, 'API_GUIDE.md');
  const userGuideViHandler = createHandler(USER_GUIDE_VI_FILE, 'HUONG_DAN_SU_DUNG.md');

  app.get('/guide', apiGuideHandler);
  app.get('/docs', apiGuideHandler);
  app.get('/help', apiGuideHandler);
  app.get('/huong-dan', userGuideViHandler);
  app.get('/huong-dan-su-dung', userGuideViHandler);
}
