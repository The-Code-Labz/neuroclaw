// Thin Composio wrapper.
//
// Composio's `composio.create(userId)` returns a tool-router Session whose
// hosted MCP server URL + headers we can plug into any MCP-compatible runtime
// (Codex CLI, Claude Agent SDK, our own mcp-client.ts). We cache sessions by
// (userId, toolkit-allowlist) for COMPOSIO_SESSION_TTL_SEC seconds so a
// single chat turn doesn't mint a fresh session per tool call.
//
// Per-agent identity: each NeuroClaw agent has its own `composio_user_id`
// column. That lets one agent post to YOUR Discord and another agent post to
// a team Discord, etc. Shared user_ids are also fine.

import { Composio } from '@composio/core';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface ComposioMcpEndpoint {
  url:      string;
  headers:  Record<string, string>;
  /** What toolkits this session has access to. null = unrestricted. */
  toolkits: string[] | null;
}

interface CachedSession extends ComposioMcpEndpoint {
  expiresAt: number;
}

const sessions = new Map<string, CachedSession>();

let cachedClient: Composio | null = null;

function getClient(): Composio {
  if (!config.composio.enabled || !config.composio.apiKey) {
    throw new Error('Composio is not configured (set COMPOSIO_API_KEY)');
  }
  if (cachedClient) return cachedClient;
  cachedClient = new Composio({
    apiKey:  config.composio.apiKey,
    baseURL: config.composio.baseUrl,
    // Disable Composio's auto-fetched OpenAI provider helpers — we only use
    // the tool router + MCP URL, not their per-provider tool reshaping.
    allowTracking: true,
  });
  logger.info('Composio client initialized', { baseURL: config.composio.baseUrl ?? '(default)' });
  return cachedClient;
}

function cacheKey(userId: string, toolkits: string[] | null): string {
  return `${userId}::${toolkits ? toolkits.slice().sort().join(',') : '*'}`;
}

/**
 * Get (or mint + cache) a Composio MCP endpoint for the given user identity.
 * Returns the URL + headers that can be passed to ANY MCP client.
 *
 * @param userId   Composio user id (we store this on agents.composio_user_id)
 * @param toolkits Optional allowlist of toolkit slugs (e.g. ['github','discord']).
 *                 Null/undefined = all toolkits.
 */
export async function getComposioMcp(
  userId: string,
  toolkits: string[] | null = null,
): Promise<ComposioMcpEndpoint> {
  const key = cacheKey(userId, toolkits);
  const cached = sessions.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const client = getClient();
  // The tool router session is what backs hosted MCP. Pass toolkit filter
  // when the agent's composio_toolkits column is non-null.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg: any = {};
  if (toolkits && toolkits.length > 0) cfg.toolkits = toolkits;

  const session = await client.create(userId, cfg);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mcp = (session as any).mcp;
  if (!mcp?.url || !mcp?.headers) {
    throw new Error('Composio session did not return an MCP URL/headers');
  }

  const endpoint: CachedSession = {
    url:       String(mcp.url),
    headers:   mcp.headers as Record<string, string>,
    toolkits,
    expiresAt: Date.now() + config.composio.sessionTtlSec * 1000,
  };
  sessions.set(key, endpoint);
  logger.info('Composio session created', { userId, toolkits, mcpUrl: endpoint.url });
  return endpoint;
}

/** Drop the entire session cache (e.g. on user-revoked accounts, key change). */
export function clearComposioSessionCache(): void {
  sessions.clear();
}

/**
 * List every toolkit available in the Composio catalog. Used by the dashboard
 * agent-edit modal to populate the toolkit chip picker.
 */
export async function listComposioToolkits(): Promise<Array<{ slug: string; name: string; logo?: string | null }>> {
  const client = getClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await (client.toolkits as any).getToolkits({});
  // The Composio SDK returns { items: Toolkit[] } or Toolkit[] depending on version.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = Array.isArray(result) ? result : (result.items ?? result.data ?? []);
  return items.map((t) => ({
    slug: String(t.slug ?? t.toolkit ?? t.name ?? '').toLowerCase(),
    name: String(t.name ?? t.slug ?? 'unknown'),
    logo: t.logo ?? t.icon ?? null,
  })).filter(t => t.slug);
}

/**
 * List the connected accounts this user has authorized in Composio. Useful
 * for showing the dashboard which apps the agent can already act on (vs
 * which need OAuth setup first).
 */
export async function listConnectedAccounts(userId: string): Promise<Array<{ toolkit: string; status: string; id: string }>> {
  const client = getClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await (client.connectedAccounts as any).list({ userIds: [userId] });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = Array.isArray(result) ? result : (result.items ?? result.data ?? []);
  return items.map((a) => ({
    toolkit: String(a.toolkit?.slug ?? a.toolkit ?? a.appName ?? 'unknown').toLowerCase(),
    status:  String(a.status ?? a.state ?? 'unknown'),
    id:      String(a.id ?? a.connected_account_id ?? ''),
  }));
}

/**
 * Parse the JSON-encoded toolkits array stored on the agents table.
 * Returns null when "all toolkits" should apply.
 */
export function parseAgentToolkits(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.map(String).map(s => s.trim().toLowerCase()).filter(Boolean);
  } catch {
    return null;
  }
}
