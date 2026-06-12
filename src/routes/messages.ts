import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isClaudeQuotaMessage } from '../backends/claude/cli.js';
import { BackendBusyError, publicErrorMessage } from '../backends/errors.js';
import { resolveModel } from '../backends/registry.js';
import { normaliseOpenAiMessages, type OpenAiMessage } from '../adapters/openai-input.js';
import {
  buildToolSystemPrompt,
  parseToolCalls,
  type ParsedToolCalls,
  type ToolChoice,
  type ToolDefinition,
} from '../adapters/tool-calls.js';
import type { CallResult } from '../backends/types.js';
import { clientIp, clientUserAgent } from '../lib/client-info.js';
import { cleanupTempFiles } from '../lib/image-store.js';
import { logger } from '../lib/logger.js';
import { authenticate } from '../middleware/auth.js';
import { bindCancelController } from '../middleware/cancel.js';
import type { AppContext } from '../types/index.js';

/**
 * Anthropic-native `/v1/messages` endpoint.
 *
 * Lets Anthropic-protocol clients (Claude Code, the Anthropic SDK, etc.) talk to
 * the same backend pool the OpenAI `/v1/chat/completions` route uses. Anthropic
 * request shape is translated into the internal pipeline and the result is
 * translated back into Anthropic message / SSE format. Vision works because
 * `normaliseOpenAiMessages` already understands Anthropic `image` blocks.
 */

interface AnthropicTextBlock {
  type: 'text';
  text?: string;
}
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}
interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
}
type AnthropicToolChoice =
  | { type: 'auto' | 'any' | 'tool' | 'none'; name?: string }
  | undefined;

interface MessagesBody {
  model?: string;
  max_tokens?: number;
  system?: string | AnthropicTextBlock[];
  messages?: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stream?: boolean;
  thinking?: unknown;
}

function systemToString(system: MessagesBody['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => (typeof b === 'string' ? b : (b.text ?? ''))).join('\n');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const b = c as Record<string, unknown>;
        if (b.type === 'text') return String(b.text ?? '');
        if (b.type === 'image' || b.type === 'image_url') return '[image]';
        return typeof c === 'string' ? c : JSON.stringify(c);
      })
      .join('\n');
  }
  return JSON.stringify(content ?? '');
}

/** Translate Anthropic messages into OpenAiMessage[] understood by `normaliseOpenAiMessages`. */
function toOpenAiMessages(system: string, messages: AnthropicMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    const passthrough: Array<Record<string, unknown>> = []; // text / image / image_url
    const toolCalls: NonNullable<OpenAiMessage['tool_calls']> = [];
    const toolResults: OpenAiMessage[] = [];

    for (const blk of m.content) {
      const b = blk as Record<string, unknown>;
      if (b.type === 'tool_use') {
        toolCalls.push({
          id: String(b.id ?? `call_${toolCalls.length}`),
          type: 'function',
          function: { name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) },
        });
      } else if (b.type === 'tool_result') {
        const tid = String(b.tool_use_id ?? '');
        toolResults.push({
          role: 'tool',
          content: toolResultText(b.content),
          tool_call_id: tid,
          name: tid,
        });
      } else {
        passthrough.push(b); // text / image / image_url -> handled by extractContent
      }
    }

    if (m.role === 'assistant') {
      const msg: OpenAiMessage = { role: 'assistant', content: passthrough };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      if (passthrough.length) out.push({ role: 'user', content: passthrough });
      for (const tr of toolResults) out.push(tr);
    }
  }
  return out;
}

function toToolDefs(tools?: AnthropicTool[]): ToolDefinition[] | null {
  if (!tools || tools.length === 0) return null;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema ?? {},
  }));
}

function toToolChoice(tc: AnthropicToolChoice): ToolChoice {
  if (!tc) return 'auto';
  if (tc.type === 'tool' && tc.name) return { function: { name: tc.name } };
  if (tc.type === 'any') return 'any';
  if (tc.type === 'none') return 'none';
  return 'auto';
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

function buildContentBlocks(result: CallResult, parsed: ParsedToolCalls): {
  blocks: AnthropicContentBlock[];
  stopReason: 'end_turn' | 'tool_use';
} {
  if (parsed.isToolCall && parsed.toolCalls) {
    const blocks: AnthropicContentBlock[] = parsed.toolCalls.map((tc) => {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch {
        input = {};
      }
      return { type: 'tool_use', id: tc.id, name: tc.function.name, input };
    });
    return { blocks, stopReason: 'tool_use' };
  }
  return { blocks: [{ type: 'text', text: result.content }], stopReason: 'end_turn' };
}

function buildAnthropicResponse(result: CallResult, parsed: ParsedToolCalls) {
  const { blocks, stopReason } = buildContentBlocks(result, parsed);
  return {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: result.model,
    content: blocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
  };
}

const TEXT_CHUNK = 60;

function writeAnthropicStream(reply: FastifyReply, result: CallResult, parsed: ParsedToolCalls): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const id = `msg_${Date.now()}`;
  const send = (event: string, data: unknown): void => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: result.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: result.inputTokens, output_tokens: 0 },
    },
  });

  const { blocks, stopReason } = buildContentBlocks(result, parsed);

  blocks.forEach((block, index) => {
    if (block.type === 'tool_use') {
      send('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      send('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
      });
      send('content_block_stop', { type: 'content_block_stop', index });
      return;
    }

    send('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    });
    send('ping', { type: 'ping' });
    const text = block.text ?? '';
    for (let i = 0; i < text.length; i += TEXT_CHUNK) {
      send('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: text.slice(i, i + TEXT_CHUNK) },
      });
    }
    send('content_block_stop', { type: 'content_block_stop', index });
  });

  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: result.outputTokens },
  });
  send('message_stop', { type: 'message_stop' });
  reply.raw.end();
}

export async function messagesRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Rough token estimate so Anthropic clients that pre-flight `count_tokens` don't 404.
  app.post('/v1/messages/count_tokens', async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = authenticate(req, ctx.runtime);
    if (!auth.ok) {
      reply.code(401);
      return { type: 'error', error: { type: 'authentication_error', message: auth.error } };
    }
    const body = (req.body ?? {}) as MessagesBody;
    const text = systemToString(body.system) + ' ' + JSON.stringify(body.messages ?? []);
    return { input_tokens: Math.max(1, Math.ceil(text.length / 4)) };
  });

  app.post('/v1/messages', async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = authenticate(req, ctx.runtime);
    if (!auth.ok) {
      reply.code(401);
      return { type: 'error', error: { type: 'authentication_error', message: auth.error } };
    }

    const rate = ctx.rate.check(auth.context);
    if (!rate.ok) {
      reply.code(429).header('Retry-After', String(rate.retryAfter));
      return {
        type: 'error',
        error: { type: 'rate_limit_error', message: `Rate limit exceeded: max ${rate.limit} req/min` },
      };
    }

    const start = Date.now();
    const appName = auth.context.app || ((req.headers['x-app-name'] as string) ?? 'anthropic');
    const body = (req.body ?? {}) as MessagesBody;
    const controller = bindCancelController(req, reply);

    const tools = toToolDefs(body.tools);
    const toolChoice = toToolChoice(body.tool_choice);
    const toolPrompt = buildToolSystemPrompt(tools, toolChoice);

    const cfg = ctx.runtime.get();
    const wantStream = !!body.stream;
    const hasTools = !!(tools && tools.length > 0);

    let backendName: 'claude' | 'codex' = 'claude';
    let model = body.model ?? cfg.defaultModel;
    let routeReason = '';
    let enableThinking = !!body.thinking;

    if (model === 'auto' || model === 'smart') {
      model = 'claude-sonnet-4-6';
      routeReason = ' [auto]';
    } else {
      const resolved = resolveModel(model);
      backendName = resolved.backend;
      model = resolved.model;
      if (resolved.thinking) enableThinking = true;
      routeReason = ` [${backendName}]`;
    }
    if (enableThinking) routeReason += ' [thinking]';

    const system = systemToString(body.system);
    const oaMessages = toOpenAiMessages(system, body.messages ?? []);
    const normalised = await normaliseOpenAiMessages(oaMessages, toolPrompt);
    const timeoutMs = cfg.timeoutSeconds * 1000;

    logger.info(
      {
        app: appName,
        model,
        backend: backendName,
        msgCount: body.messages?.length ?? 0,
        tools: hasTools ? tools!.length : 0,
        images: normalised.imagePaths.length,
        stream: wantStream,
        api: 'anthropic',
      },
      `messages ← ${appName} | ${model}${routeReason}`,
    );

    ctx.metrics.backendQueueDepth.observe({ backend: backendName }, ctx.backends.get(backendName).stats().queueDepth);

    try {
      const call = (target: typeof backendName) => {
        const adapter = ctx.backends.get(target);
        return adapter.call(
          {
            userPrompt: normalised.userPrompt,
            systemPrompt: normalised.systemPrompt || undefined,
            imagePaths: normalised.imagePaths,
            model,
            visionMode: normalised.imagePaths.length > 0 && target === 'claude',
            thinking: enableThinking,
            timeoutMs,
          },
          controller.signal,
        );
      };

      let result;
      try {
        result = await call(backendName);
        if (backendName === 'claude' && isClaudeQuotaMessage(result.content)) {
          logger.warn({ snippet: result.content.slice(0, 160) }, 'claude quota detected — falling back to codex');
          throw new Error(result.content);
        }
      } catch (err) {
        if (backendName !== 'claude') throw err;
        if (controller.signal.aborted) throw err;
        result = await call('codex');
        result.model = `codex:fallback-from-${model}`;
      }

      const elapsed = Date.now() - start;
      const parsed = hasTools
        ? parseToolCalls(result.content)
        : { isToolCall: false, toolCalls: null, textContent: result.content };

      ctx.stats.track({
        app: appName,
        model,
        duration: elapsed,
        success: true,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cost: result.cost,
        ip: clientIp(req),
        userAgent: clientUserAgent(req),
      });
      ctx.metrics.requestsTotal.inc({ backend: backendName, model, status: 'ok' });
      ctx.metrics.requestDuration.observe({ backend: backendName, model }, elapsed);

      if (wantStream) {
        writeAnthropicStream(reply, result, parsed);
        cleanupTempFiles(normalised.imagePaths);
        return reply;
      }

      const response = buildAnthropicResponse(result, parsed);
      cleanupTempFiles(normalised.imagePaths);
      return response;
    } catch (err) {
      cleanupTempFiles(normalised.imagePaths);
      const elapsed = Date.now() - start;
      ctx.stats.track({ app: appName, model: 'unknown', duration: elapsed, success: false, inputTokens: 0, outputTokens: 0, cost: 0, ip: clientIp(req), userAgent: clientUserAgent(req) });
      ctx.metrics.requestsTotal.inc({ backend: backendName, model, status: 'error' });

      if (err instanceof BackendBusyError) {
        ctx.metrics.backendBusyTotal.inc({ backend: err.backend });
        reply.code(429).header('Retry-After', String(err.retryAfterSec));
        return { type: 'error', error: { type: 'overloaded_error', message: err.message } };
      }
      reply.code(500);
      logger.error({ err: (err as Error).message, app: appName }, 'messages error');
      return { type: 'error', error: { type: 'api_error', message: publicErrorMessage(err) } };
    }
  });
}
