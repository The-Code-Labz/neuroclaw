// Composio Connection Policy Enforcement
//
// This is the brain that sits between an agent saying "I want to connect to
// toolkit X" and Composio's OAuth flow actually creating a new connection.
//
// Flow:
//   1. Agent's session is created with manageConnections enabled. When the
//      agent hits a toolkit it doesn't have access to, it would normally call
//      COMPOSIO_INITIATE_CONNECTION. Composio fires our callbackUrl.
//   2. Our callback handler calls evaluateConnectionRequest() (below) which
//      consults the tier policy + existing accounts list and decides:
//        - auto-grant from an existing shared/owned account (no new OAuth)
//        - allow the new OAuth to proceed (T1 or T2-uncontested)
//        - block and queue a user-decision pending in the dashboard
//        - block and queue an approval pending (T3)
//   3. After OAuth completes (or even when it's pre-existing), Composio fires
//      a second callback with `status: 'ACTIVE'` and the connected_account_id.
//      We use `recordCompletedConnection()` to stamp that account with the
//      owning agent's user_id AND, for T1 toolkits, flip the `shared` flag on
//      so future agents get auto-granted.
//   4. The dashboard exposes a Connections panel where pending decisions
//      can be resolved.

import { Composio } from '@composio/core';
import { getDb } from '../db';
import { logger } from '../utils/logger';
import { config } from '../config';
import {
  decideConnectionPolicy,
  tierFor,
  tierLabel,
  ConnectionDecision,
} from './tier-policy';

let cachedClient: Composio | null = null;
function getClient(): Composio {
  if (cachedClient) return cachedClient;
  cachedClient = new Composio({
    apiKey:  config.composio.apiKey,
    baseURL: config.composio.baseUrl,
    allowTracking: true,
  });
  return cachedClient;
}

// ── Persistence (pending decisions / approvals queue) ────────────────────────
//
// We store everything in SQLite under a single table so the dashboard can list
// what's outstanding, and `composio_account_meta` for the dashboard-managed
// "is this account shared / who owns it" data that Composio doesn't track natively.

export interface PendingConnectionRow {
  id:               string;
  toolkit:          string;
  tier:             string;
  requesting_agent: string;
  reason:           string;          // 'user_decision_required' | 'admin_approval_required'
  conflict_owner:   string | null;   // existing account's owner if T2 conflict
  conflict_account: string | null;
  created_at:       string;          // ISO
  resolved_at:      string | null;
  resolution:       string | null;   // 'use_existing_shared' | 'create_new_owned' | 'rejected'
  resolved_by:      string | null;
}

export interface AccountMetaRow {
  account_id: string;
  toolkit:    string;
  owner:      string | null;       // composio_user_id of the owning agent, or null
  shared:     0 | 1;               // dashboard-managed sharing toggle
  created_at: string;
  updated_at: string;
}

function ensureSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS composio_pending_connections (
      id               TEXT PRIMARY KEY,
      toolkit          TEXT NOT NULL,
      tier             TEXT NOT NULL,
      requesting_agent TEXT NOT NULL,
      reason           TEXT NOT NULL,
      conflict_owner   TEXT,
      conflict_account TEXT,
      created_at       TEXT NOT NULL,
      resolved_at      TEXT,
      resolution       TEXT,
      resolved_by      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_composio_pending_unresolved
      ON composio_pending_connections(resolved_at) WHERE resolved_at IS NULL;

    CREATE TABLE IF NOT EXISTS composio_account_meta (
      account_id TEXT PRIMARY KEY,
      toolkit    TEXT NOT NULL,
      owner      TEXT,
      shared     INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}
ensureSchema();

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowISO(): string { return new Date().toISOString(); }

function rid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export interface AccountWithMeta {
  id: string;
  toolkit: string;
  owner: string | null;
  shared: boolean;
  status: string;
  created_at?: string;
  rawComposio: Record<string, unknown>;
}

/**
 * Live-fetch every connected account in the Composio project and merge in our
 * dashboard-managed metadata (owner / shared). Returns the shape the
 * tier-policy evaluator + Connections page both consume.
 */
export async function listAccountsWithMeta(): Promise<AccountWithMeta[]> {
  const client = getClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await (client.connectedAccounts as any).list({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = Array.isArray(result) ? result : (result.items ?? result.data ?? []);

  // Pre-load every meta row in one query.
  const metas = getDb().prepare(`SELECT account_id, owner, shared FROM composio_account_meta`).all() as Array<{
    account_id: string; owner: string | null; shared: number;
  }>;
  const metaById = new Map(metas.map(m => [m.account_id, m]));

  return items.map((a) => {
    const id = String(a.id ?? a.connected_account_id ?? '');
    const toolkit = String(a.toolkit?.slug ?? a.toolkit ?? a.appName ?? 'unknown').toLowerCase();
    const status = String(a.status ?? a.state ?? 'unknown').toUpperCase();
    const meta = metaById.get(id);
    // Composio may also expose `userId` / `entity_id` on the account itself.
    const composioOwner = String(a.userId ?? a.user_id ?? a.entityId ?? a.entity_id ?? '').trim() || null;
    return {
      id,
      toolkit,
      owner: meta?.owner ?? composioOwner ?? null,
      shared: meta ? meta.shared === 1 : (a.experimental?.accountType === 'SHARED'),
      status,
      created_at: a.createdAt ?? a.created_at ?? undefined,
      rawComposio: a,
    };
  });
}

/**
 * Upsert the dashboard-managed metadata for an account. Used by the
 * Connections page when you assign an owner or flip the shared toggle.
 */
export function setAccountMeta(input: {
  account_id: string;
  toolkit: string;
  owner?: string | null;
  shared?: boolean;
}): void {
  const now = nowISO();
  const existing = getDb().prepare(`SELECT account_id FROM composio_account_meta WHERE account_id = ?`).get(input.account_id);
  if (existing) {
    const sets: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { updated_at: now, account_id: input.account_id };
    if (input.owner !== undefined) { sets.push('owner = @owner'); params.owner = input.owner; }
    if (input.shared !== undefined) { sets.push('shared = @shared'); params.shared = input.shared ? 1 : 0; }
    getDb().prepare(`UPDATE composio_account_meta SET ${sets.join(', ')} WHERE account_id = @account_id`).run(params);
  } else {
    getDb().prepare(`
      INSERT INTO composio_account_meta (account_id, toolkit, owner, shared, created_at, updated_at)
      VALUES (@account_id, @toolkit, @owner, @shared, @created_at, @updated_at)
    `).run({
      account_id: input.account_id,
      toolkit:    input.toolkit,
      owner:      input.owner ?? null,
      shared:     input.shared ? 1 : 0,
      created_at: now,
      updated_at: now,
    });
  }
}

/** Read one account meta row (or null) by account id. */
export function getAccountMeta(accountId: string): AccountMetaRow | null {
  const row = getDb().prepare(`SELECT * FROM composio_account_meta WHERE account_id = ?`).get(accountId) as AccountMetaRow | undefined;
  return row ?? null;
}

// ── The evaluator ─────────────────────────────────────────────────────────────

export interface EvaluateInput {
  toolkit: string;
  requestingAgent: string;
}

export interface EvaluateResult {
  decision:  ConnectionDecision;
  /** Set when we created a pending row that the dashboard needs to resolve. */
  pendingId?: string;
  /** Set when we resolved automatically (shared/owned existing). */
  grantedAccountId?: string;
}

/**
 * Evaluate a connection request against the tier policy + existing accounts.
 * Side effects: may insert a row into composio_pending_connections.
 */
export async function evaluateConnectionRequest(input: EvaluateInput): Promise<EvaluateResult> {
  const accounts = await listAccountsWithMeta();
  const filtered = accounts.filter(a => a.toolkit === input.toolkit.toLowerCase());

  const decision = decideConnectionPolicy({
    toolkitSlug:     input.toolkit,
    requestingAgent: input.requestingAgent,
    existingAccounts: filtered.map(a => ({
      id: a.id,
      toolkit: a.toolkit,
      owner: a.owner,
      shared: a.shared,
      status: a.status,
    })),
  });

  logger.info('Composio connection request evaluated', {
    toolkit: input.toolkit,
    agent:   input.requestingAgent,
    tier:    tierLabel(tierFor(input.toolkit)),
    action:  decision.action,
  });

  switch (decision.action) {
    case 'auto_grant_shared':
    case 'use_existing_owned':
      return { decision, grantedAccountId: decision.existingAccountId };

    case 'allow_new_owned':
      return { decision };

    case 'request_user_decision': {
      const id = rid('pcn');
      getDb().prepare(`
        INSERT INTO composio_pending_connections
          (id, toolkit, tier, requesting_agent, reason, conflict_owner, conflict_account, created_at)
        VALUES
          (@id, @toolkit, @tier, @requesting_agent, @reason, @conflict_owner, @conflict_account, @created_at)
      `).run({
        id,
        toolkit:          input.toolkit,
        tier:             decision.tier,
        requesting_agent: input.requestingAgent,
        reason:           'user_decision_required',
        conflict_owner:   decision.conflictingOwner,
        conflict_account: decision.conflictingAccountId,
        created_at:       nowISO(),
      });
      void notifyPending(id, input, decision.tier, 'user_decision_required');
      return { decision, pendingId: id };
    }

    case 'block_require_approval': {
      const id = rid('pcn');
      getDb().prepare(`
        INSERT INTO composio_pending_connections
          (id, toolkit, tier, requesting_agent, reason, conflict_owner, conflict_account, created_at)
        VALUES
          (@id, @toolkit, @tier, @requesting_agent, @reason, NULL, NULL, @created_at)
      `).run({
        id,
        toolkit:          input.toolkit,
        tier:             decision.tier,
        requesting_agent: input.requestingAgent,
        reason:           'admin_approval_required',
        created_at:       nowISO(),
      });
      void notifyPending(id, input, decision.tier, 'admin_approval_required');
      return { decision, pendingId: id };
    }
  }
}

/**
 * Fire-and-forget Discord + dashboard notification when a pending connection
 * is created. We never block the OAuth path on notification failures.
 */
async function notifyPending(
  pendingId: string,
  input: EvaluateInput,
  tier: string,
  reason: 'user_decision_required' | 'admin_approval_required',
): Promise<void> {
  try {
    const { sendAlert } = await import('../system/alert-dispatcher');
    const isApproval = reason === 'admin_approval_required';
    const url = `${config.dashboard.publicUrl}/dashboard#connections`;
    await sendAlert({
      severity: isApproval ? 'warn' : 'info',
      source:   'composio-connection-policy',
      title:    isApproval
        ? `Approval required: ${input.toolkit} (${tier})`
        : `Decision required: ${input.toolkit} (${tier} conflict)`,
      body: [
        `Agent ${input.requestingAgent} requested a connection to ${input.toolkit}.`,
        isApproval
          ? `This is a tier-3 (locked) toolkit and must be approved manually.`
          : `Another agent already owns the existing connection. Pick how to scope the new one.`,
        ``,
        `Resolve at: ${url} (pending id: ${pendingId})`,
      ].join('\n'),
      dedupKey: `composio-pending-${pendingId}`,
    });
  } catch (err) {
    logger.warn('Composio: failed to dispatch pending-connection alert', {
      pendingId, err: (err as Error).message,
    });
  }
}

// ── Pending-connections queue helpers (used by dashboard routes) ─────────────

export function listPendingConnections(opts: { resolved?: boolean } = {}): PendingConnectionRow[] {
  if (opts.resolved === false || opts.resolved === undefined) {
    return getDb().prepare(`
      SELECT * FROM composio_pending_connections
      WHERE resolved_at IS NULL
      ORDER BY created_at DESC
    `).all() as PendingConnectionRow[];
  }
  return getDb().prepare(`
    SELECT * FROM composio_pending_connections
    ORDER BY created_at DESC
    LIMIT 500
  `).all() as PendingConnectionRow[];
}

export function resolvePending(input: {
  id: string;
  resolution: 'use_existing_shared' | 'create_new_owned' | 'rejected';
  resolved_by: string;
}): boolean {
  const r = getDb().prepare(`
    UPDATE composio_pending_connections
       SET resolved_at = @resolved_at,
           resolution  = @resolution,
           resolved_by = @resolved_by
     WHERE id = @id AND resolved_at IS NULL
  `).run({
    id:          input.id,
    resolved_at: nowISO(),
    resolution:  input.resolution,
    resolved_by: input.resolved_by,
  });
  return r.changes > 0;
}

// ── Callback handler: stamp completed OAuth connections ──────────────────────

export interface ConnectCallbackPayload {
  // We accept Composio's webhook shape AND the lightweight shape an internal
  // caller might post. All fields normalised at the top of the function.
  event?:               string;   // 'connected_account.created' | 'connected_account.updated' | ...
  connected_account_id?: string;
  connectedAccountId?:   string;
  account_id?:           string;
  id?:                   string;
  toolkit?:              string;
  toolkit_slug?:         string;
  user_id?:              string;
  userId?:               string;
  entity_id?:            string;
  status?:               string;
  // Composio's payload nests the account: `data: { id, toolkitSlug, ... }`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?:                 any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connectedAccount?:     any;
}

export interface RecordedConnection {
  accountId: string;
  toolkit:   string;
  owner:     string | null;
  shared:    boolean;
  tier:      string;
  status:    string;
  action:    'stamped' | 'updated' | 'ignored';
  reason?:   string;
}

/**
 * Normalise an inbound Composio webhook (or internal post) and stamp ownership
 * on the resulting connected account. This is the second half of the
 * manageConnections flow — fires after the user finishes OAuth.
 *
 * Idempotent: calling twice with the same payload just refreshes the row.
 */
export async function recordCompletedConnection(payload: ConnectCallbackPayload): Promise<RecordedConnection> {
  // Reach into nested shapes so the same handler works for both Composio's
  // event webhook and our own simpler form posts.
  const data = payload.connectedAccount ?? payload.data ?? payload;
  const accountId =
    payload.connected_account_id ??
    payload.connectedAccountId   ??
    payload.account_id           ??
    payload.id                   ??
    data?.id                     ??
    data?.connected_account_id   ??
    data?.connectedAccountId;
  const toolkit = String(
    payload.toolkit_slug ?? payload.toolkit ??
    data?.toolkitSlug ?? data?.toolkit_slug ?? data?.toolkit?.slug ?? data?.toolkit ?? 'unknown',
  ).toLowerCase();
  const owner = String(
    payload.user_id ?? payload.userId ?? payload.entity_id ??
    data?.userId ?? data?.user_id ?? data?.entityId ?? data?.entity_id ?? '',
  ).trim() || null;
  const status = String(payload.status ?? data?.status ?? data?.state ?? 'unknown').toUpperCase();

  if (!accountId) {
    logger.warn('Composio callback: missing accountId — ignored', { payload: redact(payload) });
    return { accountId: '', toolkit, owner, shared: false, tier: tierFor(toolkit), status, action: 'ignored', reason: 'missing accountId' };
  }

  const tier = tierFor(toolkit);
  const existing = getAccountMeta(String(accountId));

  // Decide initial sharing posture:
  //   - T1: always shared
  //   - T2/T3: per-agent (shared=false) unless dashboard later flips it
  const sharedDefault = tier === 'T1';
  const sharedFinal = existing ? existing.shared === 1 : sharedDefault;

  // Preserve a manually-set owner if the callback arrives without one.
  const ownerFinal = owner ?? existing?.owner ?? null;

  setAccountMeta({
    account_id: String(accountId),
    toolkit,
    owner:  ownerFinal,
    shared: sharedFinal,
  });

  logger.info('Composio callback: recorded connection', {
    accountId, toolkit, tier, status, owner: ownerFinal, shared: sharedFinal,
    action: existing ? 'updated' : 'stamped',
  });

  // For T1, also auto-resolve any pending "request_user_decision" rows for the
  // same toolkit + agent — there's no decision to make now that a shared
  // account exists.
  if (tier === 'T1' && ownerFinal) {
    try {
      const open = getDb().prepare(`
        SELECT id FROM composio_pending_connections
        WHERE toolkit = ? AND requesting_agent = ? AND resolved_at IS NULL
      `).all(toolkit, ownerFinal) as Array<{ id: string }>;
      for (const row of open) {
        resolvePending({ id: row.id, resolution: 'use_existing_shared', resolved_by: 'auto:t1-callback' });
      }
    } catch (err) {
      logger.warn('Composio callback: T1 pending auto-resolve failed', { err: (err as Error).message });
    }
  }

  return {
    accountId: String(accountId),
    toolkit,
    owner: ownerFinal,
    shared: sharedFinal,
    tier,
    status,
    action: existing ? 'updated' : 'stamped',
  };
}

/** Strip secrets/large blobs from a payload before logging. */
function redact(p: ConnectCallbackPayload): unknown {
  try {
    const json = JSON.stringify(p);
    return json.length > 800 ? json.slice(0, 800) + '…(truncated)' : json;
  } catch {
    return '(unserialisable)';
  }
}

/**
 * Diagnostic helper exposed to the dashboard so the Connections page can show
 * a quick "what would tier policy do?" preview for the current agent + toolkit.
 */
export async function previewDecisionForToolkit(toolkit: string, agent: string): Promise<{
  decision: ConnectionDecision;
  matchingAccounts: AccountWithMeta[];
}> {
  const accounts = await listAccountsWithMeta();
  const matching = accounts.filter(a => a.toolkit === toolkit.toLowerCase());
  const decision = decideConnectionPolicy({
    toolkitSlug:      toolkit,
    requestingAgent:  agent,
    existingAccounts: matching.map(a => ({
      id: a.id, toolkit: a.toolkit, owner: a.owner, shared: a.shared, status: a.status,
    })),
  });
  return { decision, matchingAccounts: matching };
}
