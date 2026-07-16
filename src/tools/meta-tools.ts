// Lazy tool discovery + dispatch meta-tools.
//
// Instead of sending every registered tool on every request (which inflates
// the prompt by tens of thousands of tokens), agents get three meta-tools:
//
//   search_tools(query, limit?)   → [{name, description}]
//   get_tool_schema(name)         → {name, description, parameters}
//   call_tool(name, args_json)    → result (same as calling the tool directly)
//
// All other tools remain available — agents just have to ask for them first.

import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources';
import { getAllTools, findTool, isToolBlockedForSubAgent } from './registry';
import { getMcpBackedAgentTools, findMcpBackedAgentTool, type SynthesizedBackedAgentTool } from './adapters/mcp-backed-agent-adapter';
import { getMcpRegistryTools, findMcpRegistryTool, type SynthesizedMcpTool } from './adapters/mcp-registry-adapter';
import { dispatchComposioTool, getCachedComposioToolSummaries } from './adapters/composio';
import type { ToolContext } from './context';
import { logToolCall } from '../system/hive-mind';
import { maybeCompressToolResult } from './tool-middleware';

// ── schemas ────────────────────────────────────────────────────────────────

const searchToolsSchema = z.object({
  query: z.string().describe('Keywords describing what you need to do (2-6 words). Searched against tool names and descriptions.'),
  limit: z.number().int().min(1).max(20).optional().describe('Max results to return (default 10).'),
});

const getToolSchemaSchema = z.object({
  name: z.string().describe('Exact tool name to inspect (use search_tools to find it). Returns the full parameter schema so you know what to pass to call_tool.'),
});

// args_json accepts a plain object (preferred) OR a JSON-encoded string.
// Object form avoids double-encoding: pass {"key":"value"} directly instead of
// the string '{"key":"value"}'. Use get_tool_schema(name) to see the expected
// parameters before calling an unfamiliar tool.
const callToolSchema = z.object({
  name:      z.string().describe('Exact tool name from search_tools results.'),
  // z.any() → generates {} (no constraints). Using z.union([z.record(...), z.string()])
  // generates anyOf with additionalProperties:{} (empty object, not a boolean) which
  // Anthropic's API rejects, causing VoidAI to return an error text in the stream.
  args_json: z.any().optional().describe(
    'Tool arguments as a plain object (preferred) or a JSON string. ' +
    'Object example: {"skill_name":"humanize-text","script":"humanize.py","args":["your text here"]}. ' +
    'String example: \'{"query":"test","limit":5}\'. ' +
    'Pass {} or "{}" for tools with no required arguments. ' +
    'Use get_tool_schema(name) first if you are unsure of the parameter format.'
  ),
});

// ── helpers ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripMeta(schema: any, _seen = new WeakSet()): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (_seen.has(schema)) return {};   // break circular reference — returns empty object
  _seen.add(schema);
  const copy = { ...schema };
  delete copy.$schema; delete copy.title; delete copy.default;
  // additionalProperties:{} (empty object) is not a valid boolean — some providers
  // (Anthropic via VoidAI) reject it. Normalize to true (same semantic: allow anything).
  if (copy.additionalProperties !== undefined
      && typeof copy.additionalProperties === 'object'
      && !Array.isArray(copy.additionalProperties)
      && Object.keys(copy.additionalProperties).length === 0) {
    copy.additionalProperties = true;
  }
  if (copy.properties) {
    copy.properties = Object.fromEntries(
      Object.entries(copy.properties).map(([k, v]) => [k, stripMeta(v, _seen)])
    );
  }
  // Recurse into union/intersection/array sub-schemas (same as openai.ts sanitizeSchemaNode)
  if (Array.isArray(copy.anyOf))  copy.anyOf  = copy.anyOf.map((s: any) => stripMeta(s, _seen));
  if (Array.isArray(copy.oneOf))  copy.oneOf  = copy.oneOf.map((s: any) => stripMeta(s, _seen));
  if (Array.isArray(copy.allOf))  copy.allOf  = copy.allOf.map((s: any) => stripMeta(s, _seen));
  if (copy.items)                 copy.items  = stripMeta(copy.items, _seen);
  return copy;
}

// Resolve args_json — accept a pre-parsed object, a JSON string, or nothing.
// Enforces that the result is a plain object: args_json is z.any(), so a number
// or array (e.g. call_tool({name, args_json: 42})) would otherwise flow into the
// MCP-registry / MCP-agent branches (z.looseObject passthrough accepts it) and be
// silently coerced to {} — only the Composio branch guarded against it. Validate
// here so every dispatch path reports the bad shape instead of dropping it.
function resolveArgs(args_json: unknown): { ok: true; parsed: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  if (args_json == null) {
    parsed = {};
  } else if (typeof args_json === 'string') {
    try { parsed = JSON.parse(args_json || '{}'); }
    catch { return { ok: false, error: 'args_json must be a valid JSON object or string' }; }
  } else {
    parsed = args_json;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'args_json must be a JSON object (not an array or primitive)' };
  }
  return { ok: true, parsed: parsed as Record<string, unknown> };
}

// Build a compact parameter hint from a Zod schema to include in error responses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function paramHint(toolName: string, schema: z.ZodType): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = stripMeta(z.toJSONSchema(schema as any, { target: 'draft-7' })) as any;
    const props = s?.properties;
    if (!props) return '';
    const required = new Set<string>(s.required ?? []);
    const fields = Object.entries(props)
      .map(([k, v]: [string, any]) => {
        // v.type can be a string or an array (e.g. ["string","null"]) — join with " | "
        const typeName = Array.isArray(v.type) ? v.type.join(' | ') : (v.type ?? 'any');
        return `  "${k}": ${typeName}${required.has(k) ? ' (required)' : ' (optional)'}`;
      })
      .join('\n');
    return `\nExpected parameters for "${toolName}":\n${fields}\nTip: call get_tool_schema("${toolName}") for the full schema.`;
  } catch { return ''; }
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ── handlers ───────────────────────────────────────────────────────────────

export async function handleSearchTools(
  { query, limit = 10 }: z.infer<typeof searchToolsSchema>,
  ctx: ToolContext,
): Promise<unknown> {
  const q = query.toLowerCase().trim();
  const qNorm = normalizeSearchText(query);
  const qTokens = qNorm.split(/\s+/).filter(Boolean);
  // Gather candidates from all three sources before applying the limit so that
  // agent__ and Composio tools are never starved by a large static-registry match set.
  // Respect each static tool's gate so we never surface a tool the calling agent
  // cannot actually invoke (e.g. bash_run/fs_* to a non-exec agent, browser tools
  // when disabled) — otherwise the model finds it here, calls it, and gets a
  // gate-denied error, wasting a turn.
  const candidates: Array<{ name: string; description: string }> = [
    ...getAllTools()
      .filter(t => !t.gate || t.gate(ctx).allowed)
      .map(t => ({ name: t.name, description: t.description })),
    ...getMcpBackedAgentTools().map(t => ({ name: t.name, description: t.description })),
    ...getCachedComposioToolSummaries(),
  ];
  const seen = new Set<string>();
  const results: Array<{ name: string; description: string; score: number }> = [];
  for (const t of candidates) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    const rawName = t.name.toLowerCase();
    const rawDescription = t.description.toLowerCase();
    const normalizedName = normalizeSearchText(t.name);
    const normalizedDescription = normalizeSearchText(t.description);
    const normalizedHaystack = `${normalizedName} ${normalizedDescription}`;
    const directMatch = rawName.includes(q)
      || rawDescription.includes(q)
      || (qNorm.length > 0 && normalizedHaystack.includes(qNorm));
    const tokenMatch = qTokens.length > 0 && qTokens.every(token => normalizedHaystack.includes(token));
    if (directMatch || tokenMatch) {
      const nameTokenMatch = qTokens.length > 0 && qTokens.every(token => normalizedName.includes(token));
      const descriptionTokenMatch = qTokens.length > 0 && qTokens.every(token => normalizedDescription.includes(token));
      const score =
        (rawName.includes(q) ? 100 : 0)
        + (qNorm.length > 0 && normalizedName.includes(qNorm) ? 90 : 0)
        + (nameTokenMatch ? 70 : 0)
        + (rawDescription.includes(q) ? 40 : 0)
        + (qNorm.length > 0 && normalizedDescription.includes(qNorm) ? 30 : 0)
        + (descriptionTokenMatch ? 10 : 0);
      results.push({ name: t.name, description: t.description, score });
    }
  }
  return results
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name, description }) => ({ name, description }));
}

export async function handleGetToolSchema(
  { name }: z.infer<typeof getToolSchemaSchema>,
  _ctx: ToolContext,
): Promise<unknown> {
  const staticTool = findTool(name);
  if (staticTool) {
    return {
      name: staticTool.name,
      description: staticTool.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: stripMeta(z.toJSONSchema(staticTool.schema as any, { target: 'draft-7' })),
    };
  }
  // For MCP-backed agent and registry tools, prefer the rawInputSchema (the actual
  // remote JSON Schema) over the passthrough Zod schema which carries no field info.
  const mcpAgentTool = findMcpBackedAgentTool(name);
  if (mcpAgentTool) {
    return {
      name:        mcpAgentTool.name,
      description: mcpAgentTool.description,
      parameters:  (mcpAgentTool as SynthesizedBackedAgentTool).rawInputSchema
                   // eslint-disable-next-line @typescript-eslint/no-explicit-any
                   ?? stripMeta(z.toJSONSchema(mcpAgentTool.schema as any, { target: 'draft-7' })),
    };
  }
  const mcpRegTool = findMcpRegistryTool(name);
  if (mcpRegTool) {
    return {
      name:        mcpRegTool.name,
      description: mcpRegTool.description,
      parameters:  (mcpRegTool as SynthesizedMcpTool).rawInputSchema
                   // eslint-disable-next-line @typescript-eslint/no-explicit-any
                   ?? stripMeta(z.toJSONSchema(mcpRegTool.schema as any, { target: 'draft-7' })),
    };
  }
  return { ok: false, error: `Unknown tool: ${name}. Use search_tools to find available tools.` };
}

export async function handleCallTool(
  { name, args_json }: z.infer<typeof callToolSchema>,
  ctx: ToolContext,
): Promise<unknown> {
  if (name === 'search_tools' || name === 'call_tool' || name === 'get_tool_schema') {
    return { error: 'Cannot call meta-tools recursively.' };
  }

  // Sub-agent lockdown applied to EVERY resolution path below (registry,
  // agent-delegation, MCP-registry, Composio) — call_tool must not be a
  // backdoor around the restrictions. MCP research tools pass (not blocked).
  if (isToolBlockedForSubAgent(name, ctx, ctx.allowedToolOverrides)) {
    return {
      error: `Tool '${name}' is not available inside a sub-agent. ` +
             `Return your result as text — the parent agent handles writes, external actions, and delegation.`,
    };
  }

  const resolved = resolveArgs(args_json);
  if (!resolved.ok) {
    return { error: `${resolved.error} — use get_tool_schema("${name}") to see expected parameters` };
  }
  const parsed = resolved.parsed;

  // Trace: record the real tool behind a call_tool dispatch. This is the single
  // point that covers every call_tool'd tool on BOTH planes (backbone via
  // dispatchMetaTool, Claude SDK via the call_tool wrapper), across all four
  // resolution paths below.
  logToolCall(name, parsed, ctx);

  // 1. Static registry
  const staticTool = findTool(name);
  if (staticTool) {
    if (staticTool.gate) {
      const g = staticTool.gate(ctx);
      if (!g.allowed) return { error: g.reason ?? 'tool gated' };
    }
    const v = staticTool.schema.safeParse(parsed);
    if (!v.success) {
      return { error: `Invalid args for ${name}: ${v.error.message}${paramHint(name, staticTool.schema)}` };
    }
    // Output compression w/ retrieval exemption — the single boundary, applied
    // here for the call_tool path (trace already emitted above). Dynamic classes
    // (agent__*, mcp__*, COMPOSIO_*) below are exempt-by-default, so only the
    // static-registry path needs the wrap.
    return maybeCompressToolResult(name, staticTool.category, await staticTool.handler(v.data, ctx), ctx);
  }

  // 2. MCP-backed agents (agent__<name> tools)
  const mcpAgentTool = findMcpBackedAgentTool(name);
  if (mcpAgentTool) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = mcpAgentTool.schema.safeParse(parsed);
    if (!v.success) {
      return { error: `Invalid args for ${name}: ${v.error.message}${paramHint(name, mcpAgentTool.schema)}` };
    }
    return await mcpAgentTool.handler(v.data, ctx);
  }

  // 3. MCP registry (mcp__<server>__<tool> tools)
  const mcpRegTool = findMcpRegistryTool(name);
  if (mcpRegTool) {
    const v = mcpRegTool.schema.safeParse(parsed);
    if (!v.success) {
      return { error: `Invalid args for ${name}: ${v.error.message}${paramHint(name, mcpRegTool.schema)}` };
    }
    return await mcpRegTool.handler(v.data, ctx);
  }

  // 4. Composio (COMPOSIO_* tools)
  if (name.startsWith('COMPOSIO_')) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: `args_json for Composio tool "${name}" must be a plain object` };
    }
    const argsStr = typeof args_json === 'string' ? args_json : JSON.stringify(args_json);
    return JSON.parse(await dispatchComposioTool(name, argsStr, ctx));
  }

  return { error: `Unknown tool: ${name}. Use search_tools to find available tools.` };
}

// ── dispatch entry point ───────────────────────────────────────────────────

export const META_TOOL_NAMES = new Set(['search_tools', 'get_tool_schema', 'call_tool']);

export async function dispatchMetaTool(
  name: string,
  argsStr: string,
  ctx: ToolContext,
): Promise<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(argsStr || '{}'); }
  catch { return JSON.stringify({ error: `Invalid ${name} arguments` }); }

  try {
    if (name === 'search_tools') {
      const v = searchToolsSchema.safeParse(parsed);
      if (!v.success) return JSON.stringify({ error: `Invalid search_tools args: ${v.error.message}` });
      return JSON.stringify(await handleSearchTools(v.data, ctx));
    }
    if (name === 'get_tool_schema') {
      const v = getToolSchemaSchema.safeParse(parsed);
      if (!v.success) return JSON.stringify({ error: `Invalid get_tool_schema args: ${v.error.message}` });
      return JSON.stringify(await handleGetToolSchema(v.data, ctx));
    }
    if (name === 'call_tool') {
      const v = callToolSchema.safeParse(parsed);
      if (!v.success) return JSON.stringify({ error: `Invalid call_tool args: ${v.error.message}` });
      return JSON.stringify(await handleCallTool(v.data, ctx));
    }
    return JSON.stringify({ error: `Unknown meta-tool: ${name}` });
  } catch (err) {
    return JSON.stringify({ ok: false, error: (err as Error).message });
  }
}

// ── Shared meta-tool definitions (consumed by all adapters) ───────────────

export const META_TOOL_DEFS = {
  search_tools: {
    description: 'Search the full tool registry by keyword. Returns a list of {name, description} for matching tools. Call this when you need a capability that is not already in your tool list, then use get_tool_schema() to inspect parameters, and call_tool() to invoke it.',
    shape:  searchToolsSchema.shape,
    schema: searchToolsSchema,
  },
  get_tool_schema: {
    description: 'Get the full parameter schema for any registered tool by name. Use this before call_tool() when you are unsure of the expected arguments — it returns the exact field names, types, and which are required.',
    shape:  getToolSchemaSchema.shape,
    schema: getToolSchemaSchema,
  },
  call_tool: {
    description: 'Invoke any registered tool by name. Use search_tools() to find the tool, get_tool_schema() to inspect its parameters, then call it here. args_json accepts a plain object (preferred) or a JSON string.',
    shape:  callToolSchema.shape,
    schema: callToolSchema,
  },
} as const;

// ── ChatCompletionTool definitions (for buildOpenAiTools) ──────────────────

export function buildMetaChatCompletionTools(): ChatCompletionTool[] {
  return (Object.entries(META_TOOL_DEFS) as [string, typeof META_TOOL_DEFS[keyof typeof META_TOOL_DEFS]][]).map(([name, def]) => ({
    type: 'function' as const,
    function: {
      name,
      description: def.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters:  stripMeta(z.toJSONSchema(def.schema as any, { target: 'draft-7' })),
    },
  }));
}
