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

// Per-agent endpoint cache for the duration of a chat turn. Wire this off the
// ToolContext.agentId — alfred re-enters this on every iteration, so the
// session reuse is implicit through the underlying composio.create() cache.
const endpointCache = new Map<string, ComposioMcpEndpoint>();

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
    endpointCache.set(ctx.agentId!, endpoint);
    return endpoint;
  } catch (err) {
    logger.warn('Composio session mint failed', { agentId: ctx.agentId, err: (err as Error).message });
    return null;
  }
}

/**
 * Returns the Composio tool surface as OpenAI ChatCompletionTool[]. Empty
 * when Composio is disabled, the agent isn't opted-in, or the session
 * couldn't be minted.
 */
export async function buildComposioOpenAiTools(ctx: ToolContext): Promise<ChatCompletionTool[]> {
  const endpoint = await getEndpoint(ctx);
  if (!endpoint) return [];

  try {
    const tools = await mcpListTools(endpoint.url, endpoint.headers);
    // Composio tool names are already namespace-prefixed (e.g. GITHUB_CREATE_ISSUE)
    // so collisions with our registry are unlikely. We still keep them visually
    // distinct in the tool list for debugging.
    return tools.map(t => ({
      type: 'function' as const,
      function: {
        name:        t.name,
        description: t.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters:  (t.inputSchema as any) ?? { type: 'object', properties: {} },
      },
    }));
  } catch (err) {
    logger.warn('Composio listTools failed', { agentId: ctx.agentId, err: (err as Error).message });
    return [];
  }
}

/**
 * True when the named tool was sourced from Composio for this agent's session.
 * Used by alfred's tool-call dispatch to decide between registry and Composio.
 */
export async function isComposioTool(name: string, ctx: ToolContext): Promise<boolean> {
  if (!shouldUseComposio(ctx)) return false;
  // We rely on the upstream listTools cache rather than pattern-matching the
  // name, because Composio's tool slugs change as toolkits evolve. mcp-client.ts
  // caches the connection so this is cheap.
  const endpoint = ctx.agentId ? endpointCache.get(ctx.agentId) ?? await getEndpoint(ctx) : null;
  if (!endpoint) return false;
  try {
    const tools = await mcpListTools(endpoint.url, endpoint.headers);
    return tools.some(t => t.name === name);
  } catch {
    return false;
  }
}

/** Dispatch a Composio tool call. Returns a JSON string for parity with dispatchOpenAiTool. */
export async function dispatchComposioTool(name: string, argsStr: string, ctx: ToolContext): Promise<string> {
  const endpoint = ctx.agentId ? endpointCache.get(ctx.agentId) ?? await getEndpoint(ctx) : null;
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
