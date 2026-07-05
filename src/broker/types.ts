/**
 * broker/types.ts — shared types for the NC Broker (spec v3 §4).
 *
 * Stable across the auth, manifest, bridge, and storage layers so route
 * handlers can pass values around without ad-hoc anonymous objects.
 */

export interface AgentContext {
  /** Canonical agent name from a verified HMAC token (or AsyncLocalStorage). */
  agentName: string;
  /** Random session id minted by the caller; threads agent activity together. */
  sessionId: string;
}

/** Parsed `SCOPE_SERVICE_TYPE` naming-convention tuple. */
export interface ParsedSecretName {
  /** SHARED, NEUROCLAW, or an agent canonical prefix (e.g. ORACLE). */
  scope: string;
  /** Third-party service identifier (GITHUB, STRIPE, OPENAI, …). */
  service: string;
  /** Credential kind (PAT, KEY, TOKEN, SECRET, PASSWORD, URL, CUSTOM). */
  type: string;
  /** Raw upper-snake-case name as stored. */
  raw: string;
}

/** Metadata-only view returned by /search and /describe (never includes value). */
export interface SecretRecord {
  name: string;
  scope: string;
  service: string;
  type: string;
  tags: string[];
  notes: string;
  created: string;
  rotated: string;
}

/** Audit row written for every broker access (use/exec/inject/search/etc). */
export interface BrokerAuditRow {
  ts: string;
  event:
    | 'use'
    | 'exec'
    | 'search'
    | 'describe'
    | 'inject'
    | 'inject_call'
    | 'create'
    | 'update'
    | 'delete'
    | 'rotate'
    | 'admin_list'
    | 'admin_reveal'
    | 'scrub_triggered';
  agent: string;
  session_id: string;
  secret_name?: string;
  secrets_requested?: string[];
  purpose?: string;
  outcome: 'ok' | 'denied' | 'error' | 'pending';
  target_mcp?: string;
  supervisor_pid?: number;
  detail?: string;
}
