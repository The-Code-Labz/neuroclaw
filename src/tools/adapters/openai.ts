// OpenAI function-calling adapter. Reshapes the registry into
// ChatCompletionTool[] for the OpenAI/VoidAI chat path, and provides a single
// dispatch entry that the alfred chat loop calls when the model emits a
// tool_call.

import type { ChatCompletionTool } from 'openai/resources';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { visibleTools, findTool } from '../registry';
import type { ToolContext } from '../context';

export function buildOpenAiTools(ctx: ToolContext): ChatCompletionTool[] {
  // zodToJsonSchema's generic inference on `z.ZodTypeAny` triggers a deep
  // type instantiation that blows tsc's depth budget when iterating the full
  // 16-tool registry. Cast to `any` at the call site — the runtime contract
  // is unchanged.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return visibleTools(ctx).map(t => {
    // Synthesized MCP-registry tools carry a `rawInputSchema` (the cached
    // JSON Schema from the remote server). Use it verbatim instead of
    // round-tripping through the passthrough zod object.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: unknown = (t as any).rawInputSchema;
    const params = raw && typeof raw === 'object'
      ? stripSchemaMeta(raw)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : stripSchemaMeta(zodToJsonSchema(t.schema as any));
    return {
      type: 'function' as const,
      function: {
        name:        t.name,
        description: t.description,
        parameters:  params,
      },
    };
  });
}

export async function dispatchOpenAiTool(
  name: string,
  argsStr: string,
  ctx: ToolContext,
): Promise<string> {
  const tool = findTool(name);
  if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });

  if (tool.gate) {
    const g = tool.gate(ctx);
    if (!g.allowed) return JSON.stringify({ error: g.reason ?? 'tool gated' });
  }

  let parsed: unknown;
  try { parsed = JSON.parse(argsStr || '{}'); }
  catch { return JSON.stringify({ error: `Invalid ${name} arguments` }); }

  const validation = tool.schema.safeParse(parsed);
  if (!validation.success) {
    return JSON.stringify({ error: `Invalid ${name} arguments`, details: validation.error.message });
  }

  try {
    const result = await tool.handler(validation.data, ctx);
    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ ok: false, error: (err as Error).message });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripSchemaMeta(schema: any): any {
  if (schema && typeof schema === 'object') {
    const copy = { ...schema };
    delete copy.$schema;
    delete copy.$ref;
    delete copy.definitions;
    return copy;
  }
  return schema;
}
