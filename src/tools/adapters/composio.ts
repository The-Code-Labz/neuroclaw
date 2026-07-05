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
import { getComposioMcp, parseAgentToolkits, type ComposioMcpEndpoint } from '../../composio/client';
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

/** Dispatch a Composio tool call. Returns a JSON string for parity with dispatchOpenAiTool. */
export async function dispatchComposioTool(name: string, argsStr: string, ctx: ToolContext): Promise<string> {
  const endpoint = await getEndpoint(ctx);
  if (!endpoint) return JSON.stringify({ ok: false, error: 'Composio is not available for this agent' });

  let args: Record<string, unknown>;
  try { args = JSON.parse(argsStr || '{}'); }
  catch { return JSON.stringify({ ok: false, error: `Invalid ${name} arguments` }); }

  try {
    const result = await mcpCallTool(endpoint.url, name, args, endpoint.headers);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ ok: false, error: (err as Error).message });
  }
}
