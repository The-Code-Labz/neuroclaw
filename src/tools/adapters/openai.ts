// OpenAI function-calling adapter. Reshapes the registry into
// ChatCompletionTool[] for the OpenAI/VoidAI chat path, and provides a single
// dispatch entry that the alfred chat loop calls when the model emits a
// tool_call.

import type { ChatCompletionTool } from 'openai/resources';
import { z } from 'zod';
import { visibleCoreTools, findTool, isToolBlockedForSubAgent } from '../registry';
import { findMcpBackedAgentTool } from './mcp-backed-agent-adapter';
import { findMcpRegistryTool } from './mcp-registry-adapter';
import { dispatchComposioTool, buildComposioOpenAiTools } from './composio';
import { META_TOOL_NAMES, buildMetaChatCompletionTools, dispatchMetaTool } from '../meta-tools';
import type { ToolContext } from '../context';
import { logger } from '../../utils/logger';
import { logAnalytics } from '../../db';
import { isRunSuperseded } from '../../system/run-ownership';
import { invokeTool, type ToolCategory } from '../tool-middleware';

export function buildOpenAiTools(ctx: ToolContext): ChatCompletionTool[] {
  // Only core tools ship upfront; everything else is reachable via
  // search_tools + call_tool to keep the tool payload small.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coreTools = visibleCoreTools(ctx).map(t => ({
    type: 'function' as const,
    function: {
      name:        t.name,
      description: t.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters:  stripSchemaMeta(z.toJSONSchema(t.schema as any, { target: 'draft-7' })),
    },
  }));
  return [...coreTools, ...buildMetaChatCompletionTools()];
}

/**
 * Strip `enum` constraints whose values contain '/' — Grok/xAI rejects them
 * ("'/' in 'enum' string value is currently not supported", HTTP 400) and 400s
 * the whole request. Dropping the constraint is safe: the model still picks a
 * sensible value; it just isn't API-validated. Used by both the legacy OpenAI
 * loop and the Agents-SDK backbone for the `hermes` provider.
 */
/**
 * Component C (preload_tools) resolver. Given a list of tool names a parent
 * knows its sub-agent will need, mint their OpenAI tool schemas so they can be
 * offered UPFRONT — the sub-agent calls them on turn 1 instead of burning
 * turns on search_tools → get_tool_schema per page.
 *
 * Resolution paths (spec §3.3 / ASAGI C5):
 *   - static registry + MCP-registry names → findTool (covers both; MCP tools
 *     use a synchronous passthrough schema), converted like buildOpenAiTools.
 *   - COMPOSIO_* names → buildComposioOpenAiTools(ctx) once (async, TTL-cached
 *     against the parent's Composio config), filtered by name.
 * Names that resolve to nothing are silently dropped (a typo doesn't error the
 * spawn). Dispatch-gating (isToolBlockedForSubAgent) is applied by the CALLER
 * before offering — a preloaded blocked tool is dropped, not advertised.
 */
export async function buildPreloadOpenAiTools(
  names: string[],
  ctx: ToolContext,
): Promise<ChatCompletionTool[]> {
  const out: ChatCompletionTool[] = [];
  const composioNames = names.filter(n => n.startsWith('COMPOSIO_'));
  const staticNames   = names.filter(n => !n.startsWith('COMPOSIO_'));

  for (const name of staticNames) {
    const tool = findTool(name); // static registry OR MCP-registry passthrough
    if (!tool) continue;
    try {
      out.push({
        type: 'function' as const,
        function: {
          name:        tool.name,
          description: tool.description,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parameters:  stripSchemaMeta(z.toJSONSchema(tool.schema as any, { target: 'draft-7' })),
        },
      });
    } catch (err) {
      logger.warn('buildPreloadOpenAiTools: unconvertible schema, dropping', { name, err: (err as Error).message });
    }
  }

  if (composioNames.length > 0) {
    try {
      const wanted = new Set(composioNames);
      const all    = await buildComposioOpenAiTools(ctx);
      for (const t of all) if (wanted.has(t.function.name)) out.push(t);
    } catch (err) {
      logger.warn('buildPreloadOpenAiTools: composio resolve failed, dropping', { err: (err as Error).message });
    }
  }

  return out;
}

export function sanitizeToolSchemasForGrok(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function scrubSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(scrubSchema);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k === 'enum' && Array.isArray(v) && v.some((e: unknown) => typeof e === 'string' && e.includes('/'))) {
        continue; // drop the enum constraint entirely
      }
      out[k] = scrubSchema(v);
    }
    return out;
  }
  return tools.map(t => ({
    ...t,
    function: { ...t.function, parameters: scrubSchema(t.function.parameters) },
  }));
}

export async function dispatchOpenAiTool(
  name: string,
  argsStr: string,
  ctx: ToolContext,
): Promise<string> {
  // Meta-tools (search_tools, call_tool) handle their own dispatch.
  if (META_TOOL_NAMES.has(name)) return dispatchMetaTool(name, argsStr, ctx);

  // Sub-agent tool lockdown — checked BEFORE resolution so it covers every
  // source uniformly (registry, agent-delegation, MCP-registry, Composio). MCP
  // research tools (mcp__*) are not in the block set and pass through.
  if (isToolBlockedForSubAgent(name, ctx, ctx.allowedToolOverrides)) {
    logger.warn('tool-gate: blocked for sub-agent', {
      tool:       name,
      spawnDepth: ctx.spawnDepth,
      agentId:    ctx.agentId,
    });
    try {
      logAnalytics('sub_agent_tool_blocked', { tool: name, spawnDepth: ctx.spawnDepth }, ctx.sessionId ?? undefined);
    } catch { /* non-critical */ }
    return JSON.stringify({
      error: `Tool '${name}' is not available inside a sub-agent. ` +
             `Return your result as text — the parent agent handles writes, external actions, and delegation.`,
    });
  }

  // All four tool sources, same as the call_tool meta-tool — direct calls to
  // an mcp__<server>__<tool> or COMPOSIO_* name must not bounce as "unknown"
  // when search_tools just advertised them.
  const tool = findTool(name) ?? findMcpBackedAgentTool(name) ?? findMcpRegistryTool(name);
  if (!tool) {
    if (name.startsWith('COMPOSIO_')) return dispatchComposioTool(name, argsStr, ctx);
    return JSON.stringify({ error: `Unknown tool: ${name}. Use search_tools to find available tools.` });
  }

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

  // Cooperative cancellation: if this run's task was reassigned (Sentinel) or
  // force-failed (wedged-job sweep), stop executing tools so its side effects
  // don't continue past the point it lost ownership. No-op for non-agent_task
  // runs (normal chat, background) — they aren't tracked.
  if (ctx.sessionId && ctx.agentId && isRunSuperseded(ctx.sessionId, ctx.agentId)) {
    return JSON.stringify({ ok: false, error: 'This task was reassigned to another agent or closed. Stop working on it and do not call further tools.' });
  }

  // Unified boundary: trace (once per real direct call — call_tool'd tools and
  // meta-tools are handled elsewhere) + output compression with retrieval
  // exemption, all in one choke point shared by every adapter.
  try {
    const result = await invokeTool({
      name,
      args: validation.data,
      ctx,
      category: (tool as { category?: ToolCategory }).category,
      run: () => tool.handler(validation.data, ctx),
    });
    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ ok: false, error: (err as Error).message });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeSchemaNode(node: any): any {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(sanitizeSchemaNode);

  const copy = { ...node };

  // Strip JSON Schema meta fields (incl. zod's $schema) that many providers reject.
  delete copy.$schema;
  delete copy.$ref;
  delete copy.definitions;
  delete copy.title;    // Python pydantic adds title to every field; xAI rejects it
  delete copy.format;   // xAI does not support format keywords (e.g. "uri", "email")
  delete copy.default;  // not part of OpenAI tool spec; some providers error on it

  // Normalize additionalProperties: {} → true. Some providers (e.g. strict
  // OpenAI schema validators) require additionalProperties to be a boolean;
  // z.toJSONSchema emits an empty object for z.record(z.string(), z.unknown()).
  if (copy.additionalProperties !== undefined
      && typeof copy.additionalProperties === 'object'
      && !Array.isArray(copy.additionalProperties)
      && Object.keys(copy.additionalProperties).length === 0) {
    copy.additionalProperties = true;
  }

  // Remove enum values containing '/' — xAI rejects MIME-type-style enum values
  // (e.g. ["image/png", "image/jpeg"]). If every value has '/', drop the enum
  // entirely so the model still receives valid schema.
  if (Array.isArray(copy.enum)) {
    const safe = copy.enum.filter((v: unknown) => typeof v !== 'string' || !v.includes('/'));
    if (safe.length === 0) delete copy.enum;
    else copy.enum = safe;
  }

  // Recurse into all child schema locations
  if (copy.properties && typeof copy.properties === 'object') {
    copy.properties = Object.fromEntries(
      Object.entries(copy.properties).map(([k, v]) => [k, sanitizeSchemaNode(v)])
    );
  }
  if (copy.items)                     copy.items = sanitizeSchemaNode(copy.items);
  if (Array.isArray(copy.anyOf))      copy.anyOf = copy.anyOf.map(sanitizeSchemaNode);
  if (Array.isArray(copy.oneOf))      copy.oneOf = copy.oneOf.map(sanitizeSchemaNode);
  if (Array.isArray(copy.allOf))      copy.allOf = copy.allOf.map(sanitizeSchemaNode);

  return copy;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripSchemaMeta(schema: any): any {
  return sanitizeSchemaNode(schema);
}
