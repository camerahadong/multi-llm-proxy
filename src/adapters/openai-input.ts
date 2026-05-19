import { fetchImageToTmp, saveBase64Image } from '../lib/image-store.js';
import { logger } from '../lib/logger.js';

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
}

export interface NormalisedInput {
  systemPrompt: string;
  userPrompt: string;
  imagePaths: string[];
}

async function extractContent(content: unknown, imagePaths: string[]): Promise<string> {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');

  const pieces: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' || !b.type) {
      pieces.push((b.text as string) ?? (b.content as string) ?? '');
      continue;
    }
    if (b.type === 'image_url') {
      const url = (b.image_url as { url?: string } | undefined)?.url ?? '';
      try {
        const p = url.startsWith('data:') ? saveBase64Image(url) : await fetchImageToTmp(url);
        imagePaths.push(p);
        pieces.push(`@${p}`);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'failed to save image_url');
      }
      continue;
    }
    if (b.type === 'image') {
      try {
        const src = (b.source as { type?: string; data?: string; media_type?: string; url?: string }) ?? {};
        let p: string | null = null;
        if (src.type === 'base64' && src.data) p = saveBase64Image(src.data, src.media_type);
        else if (src.type === 'url' && src.url) p = await fetchImageToTmp(src.url);
        if (p) {
          imagePaths.push(p);
          pieces.push(`@${p}`);
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'failed to save image block');
      }
    }
  }
  return pieces.join('\n');
}

export async function normaliseOpenAiMessages(
  messages: OpenAiMessage[],
  toolSystemPrompt: string,
): Promise<NormalisedInput> {
  const imagePaths: string[] = [];
  const systemParts: string[] = [];
  for (const m of messages.filter((m) => m.role === 'system')) {
    systemParts.push(await extractContent(m.content, imagePaths));
  }
  let systemPrompt = systemParts.join('\n');
  if (toolSystemPrompt) systemPrompt = systemPrompt ? `${systemPrompt}\n${toolSystemPrompt}` : toolSystemPrompt;

  const promptParts: string[] = [];
  for (const m of messages.filter((m) => m.role !== 'system')) {
    if (m.role === 'tool') {
      promptParts.push(`[tool_result for ${m.name ?? m.tool_call_id ?? 'unknown'}]: ${await extractContent(m.content, imagePaths)}`);
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls) {
      const calls = m.tool_calls.map((tc) => {
        const fn = tc.function;
        return `{"name":"${fn.name}","arguments":${fn.arguments || '{}'}}`;
      });
      const text = await extractContent(m.content, imagePaths);
      promptParts.push(`[assistant]: ${text}\n[tool_calls]: {"tool_calls":[${calls.join(',')}]}`);
      continue;
    }
    promptParts.push(`[${m.role}]: ${await extractContent(m.content, imagePaths)}`);
  }

  return {
    systemPrompt,
    userPrompt: promptParts.join('\n\n'),
    imagePaths,
  };
}
