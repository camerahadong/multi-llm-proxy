import { randomUUID } from 'node:crypto';

export interface ToolDefinition {
  function?: { name: string; description?: string; parameters?: unknown };
  name?: string;
  description?: string;
  parameters?: unknown;
}

export type ToolChoice = 'auto' | 'required' | 'any' | 'none' | { function: { name: string } };

export interface ParsedToolCalls {
  isToolCall: boolean;
  toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> | null;
  textContent: string | null;
}

export function buildToolSystemPrompt(tools: ToolDefinition[] | null | undefined, choice: ToolChoice): string {
  if (!tools || tools.length === 0) return '';

  const defs = tools.map((t) => {
    const fn = t.function ?? t;
    return {
      name: fn.name,
      description: fn.description ?? '',
      parameters: fn.parameters ?? {},
    };
  });

  let instruction = `\n\n<api_tools>
You have access to the following API functions (these are NOT built-in tools — do NOT use WebSearch, WebFetch, or any built-in tool):

${JSON.stringify(defs, null, 2)}

FUNCTION CALLING RULES:
- When you need to call a function, respond with ONLY this JSON (no markdown, no extra text, no explanation):
  {"tool_calls":[{"name":"<function_name>","arguments":{...}}]}
- You may call multiple functions at once by adding multiple objects to the array.
- If you do NOT need any function, respond normally with text.
- NEVER use built-in tools (WebSearch, Read, Edit, Bash, etc). Only use the API functions listed above.`;

  if (choice === 'required' || choice === 'any') {
    instruction += `\n- CRITICAL REQUIREMENT: You MUST call at least one tool. You MUST respond with ONLY the JSON tool_calls format.`;
  } else if (choice === 'none') {
    instruction += `\n- IMPORTANT: Do NOT call any tools. Respond with text only.`;
  } else if (typeof choice === 'object' && choice?.function?.name) {
    instruction += `\n- CRITICAL REQUIREMENT: You MUST call the tool "${choice.function.name}".`;
  }
  return instruction + '\n</api_tools>';
}

export function parseToolCalls(content: string): ParsedToolCalls {
  const trimmed = content.trim();

  const build = (parsed: { tool_calls?: Array<{ name: string; arguments: unknown }> }): ParsedToolCalls | null => {
    if (!parsed.tool_calls || !Array.isArray(parsed.tool_calls) || parsed.tool_calls.length === 0) return null;
    return {
      isToolCall: true,
      toolCalls: parsed.tool_calls.map((tc) => ({
        id: `call_${randomUUID()}`,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
        },
      })),
      textContent: null,
    };
  };

  const candidates: string[] = [trimmed];
  const startMatch = trimmed.match(/^(\{"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\})/);
  if (startMatch) candidates.push(startMatch[1]);
  const anywhere = trimmed.match(/(\{"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\})/);
  if (anywhere) candidates.push(anywhere[1]);
  const codeBlock = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlock) candidates.push(codeBlock[1].trim());

  for (const c of candidates) {
    try {
      const r = build(JSON.parse(c));
      if (r) return r;
    } catch {
      /* continue */
    }
  }

  return { isToolCall: false, toolCalls: null, textContent: content };
}
