import type { FastifyReply } from 'fastify';
import type { CallResult } from '../backends/types.js';
import type { ParsedToolCalls } from './tool-calls.js';

const CHUNK_SIZE = 20;

export function writeChatStream(reply: FastifyReply, result: CallResult, parsed: ParsedToolCalls): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const completionId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const finishReason: 'stop' | 'tool_calls' = parsed.isToolCall ? 'tool_calls' : 'stop';

  if (parsed.isToolCall && parsed.toolCalls) {
    const roleChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: result.model,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: null,
            tool_calls: parsed.toolCalls.map((tc, i) => ({
              index: i,
              id: tc.id,
              type: 'function',
              function: { name: tc.function.name, arguments: '' },
            })),
          },
          finish_reason: null,
        },
      ],
    };
    reply.raw.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
    for (let i = 0; i < parsed.toolCalls.length; i++) {
      const chunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: result.model,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: i, function: { arguments: parsed.toolCalls[i].function.arguments } }] },
            finish_reason: null,
          },
        ],
      };
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
  } else {
    reply.raw.write(
      `data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: result.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })}\n\n`,
    );
    const content = result.content;
    for (let i = 0; i < content.length; i += CHUNK_SIZE) {
      reply.raw.write(
        `data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: result.model,
          choices: [{ index: 0, delta: { content: content.slice(i, i + CHUNK_SIZE) }, finish_reason: null }],
        })}\n\n`,
      );
    }
  }

  reply.raw.write(
    `data: ${JSON.stringify({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: result.model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: {
        prompt_tokens: result.inputTokens,
        completion_tokens: result.outputTokens,
        total_tokens: result.inputTokens + result.outputTokens,
      },
    })}\n\n`,
  );
  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
}
