/**
 * broker/agentRegistry.ts — canonical agent prefix registry (spec v3 §5).
 *
 * Each agent has at most ONE canonical prefix used by the broker scope
 * resolver (e.g. Oracle → "ORACLE", F.R.I.D.A.Y → "FRIDAY"). Stored on the
 * existing `agents` table (`canonical_prefix` column added by db migrations).
 *
 * Two collision rules apply:
 *   1. A prefix may not be reused — unique index enforces this at the db level.
 *   2. Aliased agents cannot both register their own prefix. The user picks
 *      ONE canonical agent and assigns the prefix there.
 */
import { getDb } from '../db';
import { normalizeAgentPrefix } from './nameParser';

const SUPERVISOR_IDENTITY = 'nc-supervisor';

/**
 * Derive a canonical prefix from an agent's display name. Pure — no DB.
 * Returns null when the derivation is empty, reserved, or not a valid
 * upper-snake identifier (such an agent simply gets SHARED_/NEUROCLAW_ scope).
 */
export function deriveCanonicalPrefix(agentName: string): string | null {
  const derived = normalizeAgentPrefix(agentName);
  if (!derived) return null;
  if (derived === 'SHARED' || derived === 'NEUROCLAW') return null;
  if (!/^[A-Z][A-Z0-9_]*$/.test(derived)) return null;
  return derived;
}

export function getCanonicalPrefix(agentName: string): string | null {
  if (agentName === SUPERVISOR_IDENTITY) return null;
  const db = getDb();
  const row = db
    .prepare('SELECT canonical_prefix FROM agents WHERE name = ? COLLATE NOCASE LIMIT 1')
    .get(agentName) as { canonical_prefix: string | null } | undefined;
  if (!row) return null;                                 // unknown agent
  if (row.canonical_prefix) return row.canonical_prefix;  // explicit override wins
  return deriveCanonicalPrefix(agentName);                // auto-derive when unset
}

export interface AgentPrefixRow {
  id: string;
  name: string;
  canonical_prefix: string | null;
}

export function listAgentPrefixes(): AgentPrefixRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, name, canonical_prefix
         FROM agents
        WHERE status = 'active'
        ORDER BY name ASC`,
    )
    .all() as AgentPrefixRow[];
}

export function setCanonicalPrefix(agentId: string, prefix: string | null): void {
  const db = getDb();
  let normalised: string | null = null;
  if (prefix !== null) {
    normalised = normalizeAgentPrefix(prefix);
    if (!/^[A-Z][A-Z0-9_]*$/.test(normalised)) throw new Error(`invalid_prefix: ${prefix}`);
    if (normalised === 'SHARED' || normalised === 'NEUROCLAW') {
      throw new Error(`reserved_prefix: ${normalised}`);
    }
  }
  const info = db
    .prepare('UPDATE agents SET canonical_prefix = ? WHERE id = ?')
    .run(normalised, agentId);
  if (info.changes === 0) throw new Error(`agent_not_found: ${agentId}`);
}

export function getAgentRowByName(name: string): AgentPrefixRow | null {
  const db = getDb();
  return (
    (db
      .prepare('SELECT id, name, canonical_prefix FROM agents WHERE name = ? COLLATE NOCASE LIMIT 1')
      .get(name) as AgentPrefixRow | undefined) ?? null
  );
}
