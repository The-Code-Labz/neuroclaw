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
//
// Connection management is enforced by `src/composio/connection-policy.ts`.
// When an agent's session needs OAuth to a new toolkit, Composio fires our
// `callbackUrl` (configured below). The dashboard's
// /api/composio/connect/callback route receives the new account, stamps the
// owner, and applies the tier policy (auto-share / per-agent / blocked).

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
const inflight = new Map<string, Promise<ComposioMcpEndpoint>>();

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

/**
 * Execute a single Composio tool via the SDK's structured `arguments` channel —
 * the deterministic path that bypasses the hosted MCP meta-tool's nested arg
 * slot (which Composio's server collapses into a `{"$text":"..."}` NL-fallback,
 * dropping required params). See .planning/specs/2026-07-18-composio-text-wrap-fix.md.
 *
 * ⚠️ NEVER populate `text` here — only `arguments`. `ToolExecuteParams.text` is
 * Composio's natural-language mode; populating it is exactly what reintroduces
 * the `$text` corruption this path exists to eliminate.
 */
export async function executeComposioTool(
  slug: string,
  opts: { userId: string; arguments: Record<string, unknown>; connectedAccountId?: string },
): Promise<unknown> {
  const client = getClient();
  // Q4: pin the toolkit version explicitly (default 'latest') so behaviour is
  // deterministic and logged, rather than silently drifting. The SDK's
  // dangerouslySkipVersionCheck is a compat flag; the version above is the pin.
  const version = process.env.COMPOSIO_TOOLKIT_VERSION || 'latest';
  logger.debug('composio.execute', { slug, userId: opts.userId, version });
  return client.tools.execute(slug, {
    userId:                     opts.userId,
    version,
    arguments:                  opts.arguments, // structured ONLY — never `text`
    connectedAccountId:         opts.connectedAccountId,
    dangerouslySkipVersionCheck: true,
  } as never);
}

function cacheKey(userId: string, toolkits: string[] | null): string {
  return `${userId}::${toolkits ? toolkits.slice().sort().join(',') : '*'}`;
}

/**
 * Derive the public-facing dashboard URL used for the Composio OAuth callback.
 * Order of precedence:
 *   1. COMPOSIO_CALLBACK_URL  — explicit override (highest priority)
 *   2. DASHBOARD_PUBLIC_URL   — the dashboard's public origin
 *   3. http://localhost:<DASHBOARD_PORT>  — local fallback (dev only)
 *
 * Returns the absolute callback URL Composio will hit after a user finishes
 * authorizing a new connected account. Trailing slashes are stripped.
 */
function buildCallbackUrl(): string | null {
  const explicit = process.env.COMPOSIO_CALLBACK_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  // config.dashboard.publicUrl already prefers DASHBOARD_PUBLIC_URL and
  // falls back to http://localhost:<DASHBOARD_PORT>. Production deployments
  // MUST set DASHBOARD_PUBLIC_URL or Composio's OAuth provider redirect
  // won't be able to reach this callback from the public internet (the
  // session/tools still work; only the post-OAuth account-stamping hook is
  // skipped).
  const base = config.dashboard.publicUrl;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/api/composio/connect/callback`;
}

interface DiscoveredAccount {
  toolkit: string;
  id:      string;
  /** The Composio user_id this account actually belongs to. */
  ownerUserId: string | null;
}

/**
 * Discover the connected accounts this user has authorized. Used when an
 * agent has no explicit toolkit allowlist — we still want to scope the
 * session to the apps the user is actually authorized on, AND wire each
 * toolkit to a specific connected-account id so executions don't get the
 * "No active connection found for toolkit" error.
 *
 * Returns an empty array if the user has no connections (in which case the
 * caller should fall back to "all toolkits" and rely on COMPOSIO_SEARCH_TOOLS).
 */
async function discoverUserAccounts(userId: string): Promise<DiscoveredAccount[]> {
  try {
    const client = getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await (client.connectedAccounts as any).list({ userIds: [userId] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = Array.isArray(result) ? result : (result.items ?? result.data ?? []);
    const accounts: DiscoveredAccount[] = [];
    const seen = new Set<string>();
    for (const a of items) {
      const slug = String(a.toolkit?.slug ?? a.toolkit ?? a.appName ?? '').toLowerCase().trim();
      const status = String(a.status ?? a.state ?? '').toUpperCase();
      const id = String(a.id ?? a.connected_account_id ?? '').trim();
      const owner = String(a.userId ?? a.user_id ?? a.entityId ?? a.entity_id ?? '').trim() || null;
      if (!slug || !id) continue;
      if (status && status !== 'ACTIVE' && status !== 'INITIATED') continue;
      // First-seen wins per toolkit (most-recent first if API returns sorted).
      if (seen.has(slug)) continue;
      seen.add(slug);
      accounts.push({ toolkit: slug, id, ownerUserId: owner });
    }
    return accounts;
  } catch (err) {
    logger.warn('Composio: failed to discover user accounts', { userId, err: (err as Error).message });
    return [];
  }
}

/**
 * For an agent's explicit toolkit allowlist, find any SHARED-tier-1
 * connected accounts so the agent can use them without authoring its own
 * OAuth flow.
 *
 * IMPORTANT: Composio's tool router validates that every `ca_xxx` passed in
 * `connectedAccounts` belongs to the session's `userId`. If we wire in a
 * shared account that belongs to a *different* composio user, the entire
 * session mint fails with `ToolRouterV2_InvalidConnectedAccountIds`.
 *
 * So this function now returns the *owner* alongside each shared account.
 * The mint path will only wire in shared accounts where the owner matches
 * the session userId — for the cross-user "auto-share" case, the agent has
 * to either (a) be given its own connection, or (b) rely on the dashboard
 * to provision one under its userId.
 */
async function discoverSharedAccountsForToolkits(toolkits: string[]): Promise<DiscoveredAccount[]> {
  if (toolkits.length === 0) return [];
  try {
    // Late-load to avoid a circular import at module top-level.
    const { listAccountsWithMeta } = await import('./connection-policy');
    const all = await listAccountsWithMeta();
    const wanted = new Set(toolkits.map(t => t.toLowerCase().trim()));
    const result: DiscoveredAccount[] = [];
    const seen = new Set<string>();
    for (const a of all) {
      if (!a.shared) continue;
      if (a.status !== 'ACTIVE') continue;
      if (!wanted.has(a.toolkit)) continue;
      if (seen.has(a.toolkit)) continue;
      seen.add(a.toolkit);
      result.push({ toolkit: a.toolkit, id: a.id, ownerUserId: a.owner ?? null });
    }
    return result;
  } catch (err) {
    logger.warn('Composio: failed to discover shared accounts', { err: (err as Error).message });
    return [];
  }
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

  // Deduplicate concurrent callers — if a mint is already in-flight for this
  // key, wait on that promise instead of calling client.create() again.
  const pending = inflight.get(key);
  if (pending) return pending;

  const mint = (async (): Promise<ComposioMcpEndpoint> => {
    try {
      const client = getClient();

      // Resolve which toolkits the session should be scoped to, AND which
      // connected-account id to use per toolkit.
      //
      // Why both:
      // 1) `toolkits` controls which tools get loaded into the MCP surface.
      //    Without a positive filter, the Tool Router defaults to a minimal
      //    meta-tool-only session and the actual app tools never appear.
      // 2) `connectedAccounts` controls which authorized account executes
      //    each tool call. Without it, executions fail with
      //    "No active connection found for toolkit(s) '<slug>' in this session"
      //    even though the user clearly HAS a connection — the session just
      //    isn't wired to it.
      //
      // CRITICAL CONSTRAINT (learned from Raphtalia/Notion outage):
      // Every `ca_xxx` in `connectedAccounts` MUST belong to the session's
      // `userId`. Passing a shared account that belongs to a different
      // composio user causes `ToolRouterV2_InvalidConnectedAccountIds` and
      // the entire session mint fails — taking down ALL toolkits, not just
      // the bad one. So we now filter by ownership before wiring anything
      // in, and we always preserve the toolkit allowlist regardless of
      // whether we found a usable account binding.
      const ownAccounts = await discoverUserAccounts(userId);
      const ownByToolkit = new Map<string, string>(ownAccounts.map(a => [a.toolkit, a.id]));

      // Requested toolkits = what the caller asked for, OR (if unspecified)
      // everything this user has a connection to.
      const requestedToolkits: string[] = (toolkits && toolkits.length > 0)
        ? toolkits.slice()
        : ownAccounts.map(a => a.toolkit);

      // Build the connected-accounts binding, but ONLY include accounts
      // whose owner matches the session userId. The shared-account fallback
      // is allowed only when the shared account is already owned by this
      // userId (e.g. a shared pool where the same composio user is wearing
      // multiple agent hats).
      const missing = requestedToolkits.filter(tk => !ownByToolkit.has(tk));
      const sharedCandidates = missing.length > 0
        ? await discoverSharedAccountsForToolkits(missing)
        : [];
      const sharedByToolkit = new Map<string, string>();
      const sharedSkipped: Array<{ toolkit: string; owner: string | null }> = [];
      for (const s of sharedCandidates) {
        if (s.ownerUserId && s.ownerUserId !== userId) {
          // Composio will reject this binding with
          // ToolRouterV2_InvalidConnectedAccountIds — skip it. The toolkit
          // stays in the allowlist; the agent will get a clean
          // "no active connection" at execute time and can use
          // COMPOSIO_MANAGE_CONNECTIONS to authorize its own account.
          sharedSkipped.push({ toolkit: s.toolkit, owner: s.ownerUserId });
          continue;
        }
        sharedByToolkit.set(s.toolkit, s.id);
      }

      const connectedAccountsCfg: Record<string, string[]> = {};
      for (const tk of requestedToolkits) {
        const accountId = ownByToolkit.get(tk) ?? sharedByToolkit.get(tk);
        if (accountId) connectedAccountsCfg[tk] = [accountId];
      }

      // The toolkit allowlist is preserved AS REQUESTED, even when we have
      // no connected-account binding for some entries. This is the fix for
      // the "Session Restriction] Toolkit 'X' is not allowed for this
      // session" failure: previously, when no account was found we'd let
      // the toolkit silently drop out, and Composio's session would refuse
      // any subsequent operation against it. Now the toolkit is allowed,
      // just unconnected — and `COMPOSIO_MANAGE_CONNECTIONS` works
      // normally to authorize a new account.
      const scopedToolkits = requestedToolkits.slice();

      // The tool router session is what backs hosted MCP.
      //
      // manageConnections — re-enabled (was previously hard-off). This puts
      // OAuth-initiation meta tools back in the agent's MCP surface so an
      // agent that genuinely needs a connection it doesn't have can request
      // one. The callbackUrl points at our /api/composio/connect/callback
      // endpoint so we can stamp the owner / apply tier policy / dedupe
      // against existing connections. Without manage-connections, the only
      // way to ever add a new account is through the dashboard, which we
      // also still support.
      //
      // workbench.enable=false: we already have our own sandbox/exec story.
      // Disabling cuts ~3 noise tools from every session.
      //
      // Lazy-loading mode: we do NOT preload.app-tools. The MCP surface only
      // exposes the meta-tools (COMPOSIO_SEARCH_TOOLS, COMPOSIO_MULTI_EXECUTE_TOOL).
      // When an agent needs a specific app action it calls SEARCH first, then
      // MULTI_EXECUTE with the tool name Composio returned. This keeps the
      // LLM tool list tiny (~2 tools instead of 40+) and avoids a heavy
      // mcpListTools round-trip on every session use.
      const callbackUrl = buildCallbackUrl();
      const buildCfg = (cAccounts: Record<string, string[]>) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cfg: any = {
          manageConnections: callbackUrl
            ? { enable: true, callbackUrl, waitForConnections: false }
            : { enable: true, waitForConnections: false },
          workbench:         { enable: false },
        };
        if (scopedToolkits.length > 0) {
          cfg.toolkits = scopedToolkits;
        }
        if (Object.keys(cAccounts).length > 0) {
          cfg.connectedAccounts = cAccounts;
        }
        return cfg;
      };

      // First attempt: with whatever bindings we believe are valid.
      let session: unknown;
      let appliedAccounts = connectedAccountsCfg;
      try {
        session = await client.create(userId, buildCfg(connectedAccountsCfg));
      } catch (err) {
        const msg = (err as Error).message || '';
        // Self-heal: if Composio rejected one or more `ca_xxx` IDs as not
        // belonging to this user, parse them out, drop those bindings, and
        // retry once. This prevents one bad binding (e.g. a stale shared
        // account whose owner got renamed) from taking down the whole
        // session for unrelated toolkits.
        if (msg.includes('ToolRouterV2_InvalidConnectedAccountIds') || msg.includes('Could not find connected account')) {
          const badIds = Array.from(new Set(
            (msg.match(/ca_[A-Za-z0-9_-]+/g) ?? []),
          ));
          if (badIds.length === 0) throw err;
          const trimmed: Record<string, string[]> = {};
          const dropped: string[] = [];
          for (const [tk, ids] of Object.entries(connectedAccountsCfg)) {
            const keep = ids.filter(id => !badIds.includes(id));
            if (keep.length > 0) trimmed[tk] = keep;
            else dropped.push(tk);
          }
          logger.warn('Composio: invalid connected-account binding(s), retrying without them', {
            userId,
            badIds,
            droppedToolkits: dropped,
          });
          session = await client.create(userId, buildCfg(trimmed));
          appliedAccounts = trimmed;
        } else {
          throw err;
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mcp = (session as any).mcp;
      if (!mcp?.url || !mcp?.headers) {
        throw new Error('Composio session did not return an MCP URL/headers');
      }

      const endpoint: CachedSession = {
        url:       String(mcp.url),
        headers:   mcp.headers as Record<string, string>,
        toolkits:  scopedToolkits.length > 0 ? scopedToolkits : null,
        expiresAt: Date.now() + config.composio.sessionTtlSec * 1000,
      };
      sessions.set(key, endpoint);
      logger.info('Composio session created', {
        userId,
        toolkitsRequested: toolkits,
        toolkitsApplied:   scopedToolkits.length > 0 ? scopedToolkits : '(all)',
        ownAccounts:       Array.from(ownByToolkit.keys()),
        sharedAccounts:    Array.from(sharedByToolkit.keys()),
        sharedSkipped:     sharedSkipped.length > 0 ? sharedSkipped : undefined,
        connectedAccounts: Object.keys(appliedAccounts),
        toolkitsWithoutBinding: scopedToolkits.filter(tk => !appliedAccounts[tk]),
        preload:           scopedToolkits.length > 0 ? 'all' : 'none',
        manageConnections: !!callbackUrl ? 'enabled (with callback)' : 'enabled (no callback URL set)',
        mcpUrl:            endpoint.url,
      });
      return endpoint;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, mint);
  return mint;
}

/** Drop the entire session cache (e.g. on user-revoked accounts, key change). */
export function clearComposioSessionCache(): void {
  sessions.clear();
  inflight.clear();
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

// ---------------------------------------------------------------------------
// Connection management (dashboard Composio connections page)
// ---------------------------------------------------------------------------
//
// The dashboard's Composio connections page (page-connections.jsx) uses these
// to list auth configs, start an OAuth flow, and delete an account. Same
// version-tolerant `any`-cast style as listConnectedAccounts above (the SDK
// returns Array | {items} | {data} depending on version).
// ---------------------------------------------------------------------------

export async function deleteConnectedAccount(id: string): Promise<void> {
  const client = getClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (client.connectedAccounts as any).delete(id);
}

export async function listAuthConfigs(): Promise<Array<{ id: string; name: string; toolkit: string }>> {
  const client = getClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await (client.authConfigs as any).list();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = Array.isArray(result) ? result : (result.items ?? result.data ?? []);
  return items.map((a) => ({
    id:      String(a.id ?? a.uuid ?? ''),
    name:    String(a.name ?? a.toolkit?.slug ?? a.toolkit ?? 'unknown'),
    toolkit: String(a.toolkit?.slug ?? a.toolkit ?? a.appName ?? 'unknown').toLowerCase(),
  })).filter(a => a.id);
}

export async function initiateConnection(
  opts: { userId: string; authConfigId: string }
): Promise<{ redirectUrl: string; accountId: string }> {
  const client = getClient();
  // initiate() is positional (userId, authConfigId) → ConnectionRequest{id, redirectUrl}.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r: any = await (client.connectedAccounts as any).initiate(opts.userId, opts.authConfigId);
  return {
    redirectUrl: String(r.redirectUrl ?? r.redirect_url ?? ''),
    accountId:   String(r.id ?? r.connectedAccountId ?? r.connected_account_id ?? ''),
  };
}
