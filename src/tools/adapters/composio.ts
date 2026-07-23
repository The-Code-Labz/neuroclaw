// Composio tool adapter for the OpenAI/Anthropic-API chat path.
//
// At chat-turn start, if the active agent has Composio enabled + a user_id,
// we mint (or reuse) a hosted MCP session, list its tools, and return them
// as ChatCompletionTool[]. The dispatch helper routes calls back through
// the same MCP client. The Composio MCP URL/headers are session-scoped, so
// list/call must use the same session — we cache them here per agent for
// the lifetime of the chat turn.

import type { ChatCompletionTool } from 'openai/resources';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { getAgentById } from '../../db';
import { getComposioMcp, parseAgentToolkits, executeComposioTool, type ComposioMcpEndpoint } from '../../composio/client';
import { listTools as mcpListTools, callTool as mcpCallTool } from '../../mcp/mcp-client';
import type { ToolContext } from '../context';

// Session-scoped tool list cache — keyed by Composio MCP endpoint URL.
// Survives across chat turns as long as the underlying Composio session
// hasn't been re-minted (which changes the URL). TTL matches the
// Composio session TTL so entries expire naturally with the session.
interface CachedToolList {
  tools: ChatCompletionTool[];
  expiresAt: number;
}

const sessionToolCache = new Map<string, CachedToolList>();

function sessionCacheKey(endpoint: ComposioMcpEndpoint): string {
  return endpoint.url;
}

function cleanExpiredToolCache(): void {
  const now = Date.now();
  for (const [key, entry] of sessionToolCache) {
    if (entry.expiresAt <= now) sessionToolCache.delete(key);
  }
}

function shouldUseComposio(ctx: ToolContext): boolean {
  if (!config.composio.enabled || !ctx.agentId) return false;
  const agent = getAgentById(ctx.agentId);
  return !!(agent?.composio_enabled && agent.composio_user_id);
}

async function getEndpoint(ctx: ToolContext): Promise<ComposioMcpEndpoint | null> {
  if (!shouldUseComposio(ctx)) return null;
  const agent = getAgentById(ctx.agentId!);
  if (!agent?.composio_user_id) return null;
  try {
    const endpoint = await getComposioMcp(agent.composio_user_id, parseAgentToolkits(agent.composio_toolkits));
    return endpoint;
  } catch (err) {
    logger.warn('Composio session mint failed', { agentId: ctx.agentId, err: (err as Error).message });
    return null;
  }
}

/**
 * Returns the Composio tool surface as OpenAI ChatCompletionTool[]. Empty
 * when Composio is disabled, the agent isn't opted-in, or the session
 * couldn't be minted. Caches the result for the lifetime of the Composio
 * session (same TTL) so we do not re-list from the MCP endpoint on every
 * new chat turn.
 */
export async function buildComposioOpenAiTools(ctx: ToolContext): Promise<ChatCompletionTool[]> {
  const endpoint = await getEndpoint(ctx);
  if (!endpoint) return [];

  const key = sessionCacheKey(endpoint);
  const cached = sessionToolCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    logger.debug('Composio tools served from session cache', { agentId: ctx.agentId, count: cached.tools.length });
    return cached.tools;
  }

  try {
    const maxTools = config.composio.maxToolsPerAgent;
    const rawTools = (await mcpListTools(endpoint.url, endpoint.headers)).slice(0, maxTools);
    // Composio tool names are already namespace-prefixed (e.g. GITHUB_CREATE_ISSUE)
    // so collisions with our registry are unlikely.
    const tools: ChatCompletionTool[] = rawTools.map(t => ({
      type: 'function' as const,
      function: {
        name:        t.name,
        description: t.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters:  (t.inputSchema as any) ?? { type: 'object', properties: {} },
      },
    }));
    sessionToolCache.set(key, {
      tools,
      expiresAt: Date.now() + config.composio.sessionTtlSec * 1000,
    });
    logger.debug('Composio tools loaded (session cache populated)', { agentId: ctx.agentId, count: tools.length, max: maxTools });
    return tools;
  } catch (err) {
    logger.warn('Composio listTools failed', { agentId: ctx.agentId, err: (err as Error).message });
    return [];
  }
}

/** Returns name+description for every Composio tool in the warm session cache.
 *  No network call — used by search_tools to include Composio in results. */
export function getCachedComposioToolSummaries(): Array<{ name: string; description: string }> {
  const now = Date.now();
  const seen = new Set<string>();
  const out: Array<{ name: string; description: string }> = [];
  for (const entry of sessionToolCache.values()) {
    if (entry.expiresAt <= now) continue;
    for (const t of entry.tools) {
      if (!seen.has(t.function.name)) {
        seen.add(t.function.name);
        out.push({ name: t.function.name, description: t.function.description ?? '' });
      }
    }
  }
  return out;
}

/**
 * True when the named tool was sourced from Composio.
 * With lazy loading the MCP surface only exposes meta-tools
 * (COMPOSIO_SEARCH_TOOLS, COMPOSIO_MULTI_EXECUTE_TOOL, …) so we
 * match by the Composio prefix directly — no cache lookup needed.
 */
export async function isComposioTool(name: string, ctx: ToolContext): Promise<boolean> {
  if (!shouldUseComposio(ctx)) return false;
  return name.startsWith('COMPOSIO_');
}

// ── $text nested-JSON unwrap (defense-in-depth) ────────────────────────────
// Composio's hosted MCP shim exposes a `tools[].arguments` slot typed as a
// free-form object. When a weaker model (observed: MiniMax-M3 on sub-agent
// tier, via COMPOSIO_MULTI_EXECUTE_TOOL) can't structure that slot as a clean
// object, Composio's *own server* falls back to its NL-mode field and stuffs
// the raw stringified JSON in as `{"$text": "<json>"}` — so required params
// (e.g. playlistId) never reach the underlying tool. `$text` is never a real
// Composio arg key (leading `$`), so it's safe to unwrap: wherever we see a
// node shaped EXACTLY `{"$text": <string>}` whose string parses to an
// object/array, replace the wrapper with the parsed value (recursing into it,
// since Composio can nest this at any depth). Plain-text `$text` (string that
// doesn't parse to structured JSON) is left untouched. This only covers the
// backbone/sub-agent plane (our dispatch); it is a net, not the cure — see
// .planning/specs/2026-07-18-composio-text-wrap-fix.md.
export function normalizeComposioArgs<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => normalizeComposioArgs(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === '$text' && typeof obj.$text === 'string') {
      try {
        const parsed = JSON.parse(obj.$text);
        if (parsed && typeof parsed === 'object') return normalizeComposioArgs(parsed) as unknown as T;
      } catch { /* not structured JSON — leave the plain-text $text as-is below */ }
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = normalizeComposioArgs(obj[k]);
    return out as unknown as T;
  }
  return value;
}

/** Dispatch a Composio tool call. Returns a JSON string for parity with dispatchOpenAiTool. */
export async function dispatchComposioTool(name: string, argsStr: string, ctx: ToolContext): Promise<string> {
  const endpoint = await getEndpoint(ctx);
  if (!endpoint) return JSON.stringify({ ok: false, error: 'Composio is not available for this agent' });

  let args: Record<string, unknown>;
  try { args = JSON.parse(argsStr || '{}'); }
  catch { return JSON.stringify({ ok: false, error: `Invalid ${name} arguments` }); }
  args = normalizeComposioArgs(args);

  try {
    const result = await mcpCallTool(endpoint.url, name, args, endpoint.headers);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ ok: false, error: (err as Error).message });
  }
}

/**
 * `composio_execute` registry-tool handler — the plane-agnostic CURE for the
 * `$text` corruption. Unlike the hosted MCP meta-tool (whose nested
 * `tools[].arguments` slot Composio collapses into `{"$text":...}`), this drives
 * the SDK's structured `arguments` channel directly, so required params always
 * arrive. Exposed via the registry ⇒ reaches ALL planes (backbone, Claude SDK,
 * sub-agents) uniformly — a transport patch could only cover one plane.
 * See .planning/specs/2026-07-18-composio-text-wrap-fix.md.
 */
export async function runComposioExecute(
  args: { tool_slug?: string; arguments?: Record<string, unknown>; connected_account_id?: string },
  ctx: ToolContext,
): Promise<unknown> {
  const agent = ctx.agentId ? getAgentById(ctx.agentId) : null;
  if (!agent?.composio_enabled || !agent.composio_user_id) {
    return { ok: false, error: 'Composio is not enabled for this agent.' };
  }
  const slug = String(args.tool_slug ?? '').trim().toUpperCase();
  if (!slug) return { ok: false, error: 'tool_slug is required (e.g. YOUTUBE_LIST_PLAYLIST_ITEMS).' };

  // Q2 — toolkit-scope parity via allowlist MEMBERSHIP (not prefix-derivation).
  // Check the agent's OWN allowlist; trailing '_' blocks YOUTUBE_ vs YOUTUBEMUSIC_
  // false matches. Empty/null allowlist = all-connected (matches MCP behaviour).
  // Local fail-closed first — no out-of-scope attempt leaked to Composio.
  const allow = parseAgentToolkits(agent.composio_toolkits);
  if (allow && allow.length > 0) {
    const inScope = allow.some((tk) => slug.startsWith(tk.toUpperCase() + '_'));
    if (!inScope) {
      return { ok: false, error: `Tool ${slug} is outside this agent's allowed Composio toolkits (${allow.join(', ')}).` };
    }
  }

  // Defense-in-depth: heal any `$text` the model may have emitted into arguments.
  const cleanArgs = normalizeComposioArgs((args.arguments ?? {}) as Record<string, unknown>);
  try {
    return await executeComposioTool(slug, {
      userId:            agent.composio_user_id,
      arguments:         cleanArgs,
      connectedAccountId: args.connected_account_id,
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
