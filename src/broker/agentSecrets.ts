/**
 * broker/agentSecrets.ts — agent-scoped secret resolution (injector core).
 *
 * One audited, scope-checked resolution path for every consumer (in-process
 * tools, subprocess adapters, discovery). Resolved values are returned to
 * caller CODE only — never to an agent's LLM context.
 *
 * See docs/superpowers/specs/2026-05-15-agent-broker-secret-injection-design.md
 */
import type { SecretType } from './nameParser';
import { getStorage } from './storage';
import { parseName, normalizeAgentPrefix } from './nameParser';
import { auditLog } from './audit';
import { getCanonicalPrefix } from './agentRegistry';
import { getAgentById } from '../db';
import { logger } from '../utils/logger';

export interface SecretSpec {
  service: string;
  type: SecretType;
}

export interface SecretMeta {
  name: string;
  scope: string;
  service: string;
  type: SecretType;
  notes: string;
  tags: string[];
}

export interface EnvBundleResult {
  env: Record<string, string>;
  denied: string[];
  missing: string[];
}

/**
 * Discriminated union. Consumers MUST `switch (r.outcome)`; TypeScript then
 * narrows each branch to exactly its own fields. Variants are intentionally
 * NOT field-padded — `denied`/`missing` have no `value` by design.
 */
export type ResolveOutcome =
  | { outcome: 'ok';       name: string;     value: string; source: 'broker' }
  | { outcome: 'fallback'; name: string;     value: string; source: 'env' }
  | { outcome: 'denied';   name: string }
  | { outcome: 'missing';  attempted: string[] };

export class CredentialDeniedError extends Error {
  constructor(
    public readonly secretName: string,
    public readonly agentId: string | null,
    public readonly purpose: string,
  ) {
    super(`credential_denied: ${secretName} (agent=${agentId ?? 'none'}, purpose=${purpose})`);
    this.name = 'CredentialDeniedError';
  }
}

export class CredentialMissingError extends Error {
  constructor(
    public readonly attempted: string[],
    public readonly agentId: string | null,
    public readonly purpose: string,
  ) {
    super(`credential_missing: ${attempted.join(', ')} (agent=${agentId ?? 'none'}, purpose=${purpose})`);
    this.name = 'CredentialMissingError';
  }
}

/**
 * Map an internal agent id to the canonical agent name the broker scopes by.
 * Returns null for a null/undefined/unknown id, and never throws. A null
 * result means resolution is limited to SHARED_* / NEUROCLAW_* — no
 * <PREFIX>_* access.
 */
export function agentNameForBroker(agentId: string | null): string | null {
  if (!agentId) return null;
  try {
    const row = getAgentById(agentId);
    if (!row) {
      logger.warn('broker: secret resolution for unknown agentId', { agentId });
      return null;
    }
    return row.name;
  } catch {
    return null;
  }
}

/** Inline scope check — DB-free. Mirrors scopeResolver minus the prefix lookup. */
function inScope(prefix: string | null, scope: string): boolean {
  return scope === 'SHARED' || scope === 'NEUROCLAW' || (prefix !== null && scope === prefix);
}

/** Write a broker audit row for a resolution attempt. */
function auditUse(
  agentName: string | null,
  agentId: string | null,
  secretName: string | undefined,
  purpose: string,
  outcome: 'ok' | 'denied' | 'error',
  detail: string,
): void {
  auditLog({
    event: 'use',
    agent: agentName ?? 'unknown',
    session_id: agentId ?? 'unknown',
    secret_name: secretName,
    purpose,
    outcome,
    detail,
  });
}

/**
 * Resolve a credential by service + type, scoped to the named agent.
 *
 * Tries <PREFIX>_SVC_TYPE, then SHARED_SVC_TYPE, then NEUROCLAW_SVC_TYPE.
 * Every candidate is in-scope for this agent by construction, so this
 * function never returns `denied` — only `ok`, `fallback`, or `missing`.
 *
 * DB-free: pass an already-resolved `agentName` + `prefix`. `getStorage()`
 * is the only external dependency (swap it in tests via `setStorage`).
 */
export async function resolveCredentialForName(
  agentName: string | null,
  prefix: string | null,
  spec: SecretSpec,
  purpose: string,
  fallback?: string,
): Promise<ResolveOutcome> {
  const service = normalizeAgentPrefix(spec.service);
  const candidates: string[] = [];
  if (prefix) candidates.push(`${prefix}_${service}_${spec.type}`);
  candidates.push(`SHARED_${service}_${spec.type}`, `NEUROCLAW_${service}_${spec.type}`);

  let sawStorageError = false;
  for (const name of candidates) {
    let value: string | null;
    try {
      value = await getStorage().getValue(name);
    } catch (err) {
      sawStorageError = true;
      logger.warn('broker: storage error during resolveCredential candidate probe', {
        secret: name, err: (err as Error).message,
      });
      continue;
    }
    if (value === null) continue;
    auditUse(agentName, null, name, purpose, 'ok', 'resolved from broker');
    return { outcome: 'ok', name, value, source: 'broker' };
  }

  if (sawStorageError) {
    logger.warn('broker: storage unavailable — degraded resolution', { purpose, attempted: candidates });
  }

  const lastCandidate = candidates[candidates.length - 1];
  if (fallback !== undefined) {
    logger.warn('broker: falling back to env value (secret not resolved from broker)', {
      service, type: spec.type, purpose, attempted: candidates,
    });
    auditUse(agentName, null, lastCandidate, purpose, 'error', 'env fallback (broker did not serve this secret)');
    return { outcome: 'fallback', name: lastCandidate, value: fallback, source: 'env' };
  }

  auditUse(agentName, null, undefined, purpose, 'error', `missing: ${candidates.join(',')}`);
  return { outcome: 'missing', attempted: candidates };
}

/**
 * Resolve an explicit broker secret name, scoped to the named agent.
 *
 * Used by the subprocess adapter (bash_run's secrets[]). Unlike
 * resolveCredentialForName, the name is arbitrary, so this CAN return
 * `denied`. The scope check happens before any storage read — a denied
 * name's value is never fetched.
 */
export async function resolveByNameForName(
  agentName: string | null,
  prefix: string | null,
  name: string,
  purpose: string,
): Promise<ResolveOutcome> {
  const parsed = parseName(name);
  if (!parsed) {
    auditUse(agentName, null, name, purpose, 'error', 'invalid name shape');
    return { outcome: 'missing', attempted: [name] };
  }
  if (!inScope(prefix, parsed.scope)) {
    auditUse(agentName, null, name, purpose, 'denied', 'scope denied');
    return { outcome: 'denied', name };
  }
  let value: string | null;
  try {
    value = await getStorage().getValue(name);
  } catch (err) {
    logger.warn('broker: storage unavailable during resolveByName', {
      secret: name, err: (err as Error).message,
    });
    auditUse(agentName, null, name, purpose, 'error', 'storage unavailable');
    return { outcome: 'missing', attempted: [name] };
  }
  if (value === null) {
    auditUse(agentName, null, name, purpose, 'error', 'not found');
    return { outcome: 'missing', attempted: [name] };
  }
  auditUse(agentName, null, name, purpose, 'ok', 'resolved from broker');
  return { outcome: 'ok', name, value, source: 'broker' };
}

/**
 * List the secrets a given prefix is scoped to — metadata only, never values.
 * Powers the secrets_list tool and the prompt awareness block (Phase 4).
 */
export async function listAccessibleForName(prefix: string | null): Promise<SecretMeta[]> {
  let all;
  try {
    all = await getStorage().list();
  } catch (err) {
    logger.warn('broker: storage unavailable during listAccessible', {
      err: (err as Error).message,
    });
    return [];
  }
  const out: SecretMeta[] = [];
  for (const sec of all) {
    const parsed = parseName(sec.name);
    if (!parsed) continue;
    if (!inScope(prefix, parsed.scope)) continue;
    out.push({
      name: sec.name,
      scope: parsed.scope,
      service: parsed.service,
      type: parsed.type as SecretType,
      notes: sec.notes,
      tags: sec.tags,
    });
  }
  return out;
}

/**
 * Batch-resolve explicit names into an env map for subprocess injection.
 * Denied and missing names are reported separately, never injected.
 */
export async function resolveEnvBundleForName(
  agentName: string | null,
  prefix: string | null,
  names: string[],
  purpose: string,
): Promise<EnvBundleResult> {
  const env: Record<string, string> = {};
  const denied: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const r = await resolveByNameForName(agentName, prefix, name, purpose);
    if (r.outcome === 'ok' || r.outcome === 'fallback') env[name] = r.value;
    else if (r.outcome === 'denied') denied.push(name);
    else missing.push(name);
  }
  return { env, denied, missing };
}

// ── Public agentId-based wrappers ─────────────────────────────────────────
// Thin: look up identity from the DB, then delegate to the *ForName cores.

function identityFor(agentId: string | null): { name: string | null; prefix: string | null } {
  const name = agentNameForBroker(agentId);
  const prefix = name ? getCanonicalPrefix(name) : null;
  return { name, prefix };
}

export function resolveCredential(
  agentId: string | null,
  spec: SecretSpec,
  purpose: string,
  fallback?: string,
): Promise<ResolveOutcome> {
  const { name, prefix } = identityFor(agentId);
  return resolveCredentialForName(name, prefix, spec, purpose, fallback);
}

export function resolveByName(
  agentId: string | null,
  name: string,
  purpose: string,
): Promise<ResolveOutcome> {
  const { name: agentName, prefix } = identityFor(agentId);
  return resolveByNameForName(agentName, prefix, name, purpose);
}

export function listAccessible(agentId: string | null): Promise<SecretMeta[]> {
  const { prefix } = identityFor(agentId);
  return listAccessibleForName(prefix);
}

export function resolveEnvBundle(
  agentId: string | null,
  names: string[],
  purpose: string,
): Promise<EnvBundleResult> {
  const { name, prefix } = identityFor(agentId);
  return resolveEnvBundleForName(name, prefix, names, purpose);
}
