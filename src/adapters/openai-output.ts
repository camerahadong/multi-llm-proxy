import type { CallResult } from '../backends/types.js';
import type { ParsedToolCalls } from './tool-calls.js';

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ParsedToolCalls['toolCalls'];
    };
    finish_reason: 'stop' | 'tool_calls';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  _meta?: { cost_usd: number; duration_ms: number; app: string };
}

export function buildChatResponse(
  result: CallResult,
  parsed: ParsedToolCalls,
  appName: string,
  durationMs: number,
): ChatCompletionResponse {
  const finishReason: 'stop' | 'tool_calls' = parsed.isToolCall ? 'tool_calls' : 'stop';
  const message: ChatCompletionResponse['choices'][number]['message'] = {
    role: 'assistant',
    content: parsed.isToolCall ? null : result.content,
  };
  if (parsed.isToolCall && parsed.toolCalls) message.tool_calls = parsed.toolCalls;

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: result.inputTokens,
      completion_tokens: result.outputTokens,
      total_tokens: result.inputTokens + result.outputTokens,
      cache_read_tokens: result.cacheRead,
      cache_creation_tokens: result.cacheCreation,
    },
    _meta: { cost_usd: result.cost, duration_ms: durationMs, app: appName },
  };
}
