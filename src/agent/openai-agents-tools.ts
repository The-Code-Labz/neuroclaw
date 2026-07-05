// In-code tool registration for the @openai/agents backbone. Reuses the exact
// tool selection + JSON-schema generation the legacy OpenAI loop uses
// (buildOpenAiTools) and routes execution back through dispatchOpenAiTool, so
// tool behavior + gating are identical — just driven by the SDK.
import { tool } from '@openai/agents';
import { config } from '../config';
import { buildOpenAiTools, dispatchOpenAiTool, sanitizeToolSchemasForGrok } from '../tools/adapters/openai';
import { buildComposioOpenAiTools, dispatchComposioTool } from '../tools/adapters/composio';
import type { ToolContext } from '../tools/context';

/** True when this provider key is routed to the Agents-SDK backbone. */
export function backboneEnabled(key: string): boolean {
  return config.openaiAgents.providers.includes(key);
}

/**
 * Map the registry's core+meta tools (plus the agent's Composio tools, if any)
 * onto @openai/agents `tool()` defs. For `hermes` (Grok/xAI), strip
 * '/'-containing enums first — Grok 400s the whole request otherwise (confirmed
 * live; mirrors the legacy loop).
 *
 * Async because Composio tool discovery mints/reuses a hosted MCP session. The
 * deleted legacy chatStreamOpenAI loop surfaced Composio via
 * buildComposioOpenAiTools; the backbone never re-wired it, so every
 * backbone-plane agent (provider=openai/venice/voidai/hermes/litellm/ollama)
 * silently lost all Composio access. Re-add it here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildAgentsSdkTools(
  ctx: ToolContext,
  providerKey?: string,
  // Called with every tool's name + raw result string after it executes. The
  // backbone uses this to count failed tool calls for its give-up condition —
  // dispatchers never throw, they return JSON error envelopes, so this is the
  // only place failures are visible.
  onToolResult?: (name: string, result: string) => void,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const base = buildOpenAiTools(ctx);
  // Composio surfaces its lazy meta-tools (COMPOSIO_SEARCH_TOOLS,
  // COMPOSIO_MULTI_EXECUTE_TOOL, …) when the agent is opted-in; [] otherwise.
  // Minting also warms the session cache so search_tools can surface Composio.
  const composio = await buildComposioOpenAiTools(ctx);
  const combined = [...base, ...composio];
  const openAiTools = providerKey === 'hermes' ? sanitizeToolSchemasForGrok(combined) : combined;
  return openAiTools.map((t) =>
    tool({
      name:        t.function.name,
      description: t.function.description ?? '',
      // buildOpenAiTools already emits stripped JSON Schema via z.toJSONSchema.
      // Our tools are open-ended (optional fields, additionalProperties:true,
      // z.any() args), so strict mode is disabled.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters:  t.function.parameters as any,
      strict:      false,
      // JSON-schema params ⇒ execute receives a parsed object; the dispatchers
      // take a JSON string, so stringify before forwarding. Composio tools
      // (COMPOSIO_*) route through dispatchComposioTool (hosted MCP); everything
      // else through dispatchOpenAiTool (registry + meta-tools, incl. call_tool
      // which itself can reach Composio).
      execute: async (args: unknown) => {
        const argsStr = JSON.stringify(args ?? {});
        const result = await (t.function.name.startsWith('COMPOSIO_')
          ? dispatchComposioTool(t.function.name, argsStr, ctx)
          : dispatchOpenAiTool(t.function.name, argsStr, ctx));
        try { onToolResult?.(t.function.name, result); } catch { /* observer must never break the tool */ }
        return result;
      },
    }),
  );
}
