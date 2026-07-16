/**
 * broker/restrictedSecrets.ts — restricted secret class enforcement (SSH spec §2.1).
 *
 * SSH credentials are a RESTRICTED secret class. A restricted secret may only be
 * resolved by an unforgeable in-process capability held by `system/ssh-connect.ts`.
 * Every other path — the bash_run/skill secrets[] injector, broker.use/exec, and
 * the network-reachable /api/broker/agent/* routes — is DENIED, so an agent with a
 * valid shell (or a stolen 30s HMAC token) cannot exfiltrate a raw SSH key.
 *
 * DETECTION (name-first, storage-free — the deny fires before any value lookup):
 *   • `parseName(name).service === 'SSH'` — scope-independent, so it catches BOTH
 *     `SHARED_SSH_*` and agent-scoped `ORACLE_SSH_*` (a raw `^(SHARED_)?SSH_` regex
 *     would miss the latter — Lucius's real-bypass finding).
 *   • OR the secret carries the `restricted` tag (belt + suspenders; only checked
 *     where StoredSecret metadata is already in hand, since tags need a read).
 *
 * CAPABILITY (Lucius — a Symbol, not a string):
 *   RESTRICTED_SECRET_CAPABILITY is a module-scoped `unique symbol`. It cannot be
 *   JSON-serialized, cannot cross the HTTP boundary, and cannot be typed into a
 *   chat message. Only compiled in-process code that imports THIS exact symbol can
 *   present it — today that is solely `system/ssh-connect.ts`. HTTP route handlers
 *   never import it, so they can never satisfy the guard → unconditional network
 *   deny by construction, not by discipline.
 *
 * The guard is INTENTIONALLY always-on (not flag-gated): it is a security control,
 * and it only affects secrets whose service is `SSH` — which do not exist until the
 * SSH Machines feature stores its first credential. Zero collateral on today's
 * secrets (verified: no `*_SSH_*` name present at build time).
 */
import { parseName } from './nameParser';

/**
 * The one true in-process capability that authorizes restricted-secret resolution.
 * A `unique symbol` — unforgeable, non-serializable, import-only. Passed by
 * reference into `assertSecretAllowed` by `system/ssh-connect.ts`.
 */
export const RESTRICTED_SECRET_CAPABILITY: unique symbol = Symbol('nc.broker.restricted-secret-capability');
export type RestrictedSecretCapability = typeof RESTRICTED_SECRET_CAPABILITY;

/** Thrown when a restricted secret is requested without the capability. */
export class SecretRestrictedError extends Error {
  constructor(public readonly secretName: string) {
    super(`secret_restricted: ${secretName}`);
    this.name = 'SecretRestrictedError';
  }
}

/**
 * Name-based restricted detection — storage-free. True iff the parsed service is
 * `SSH` (scope-independent). This is the guaranteed enforcement signal; it needs
 * no value read, so the deny fires on the requested name before any lookup.
 */
export function isRestrictedName(name: string): boolean {
  const parsed = parseName(name);
  return parsed !== null && parsed.service === 'SSH';
}

/**
 * Full restricted detection: name-based OR the `restricted` tag. Use where the
 * StoredSecret's tags are already available (they require a metadata read, so
 * the name check remains the primary, storage-free gate).
 */
export function isRestrictedSecret(name: string, tags?: string[]): boolean {
  if (isRestrictedName(name)) return true;
  return Array.isArray(tags) && tags.includes('restricted');
}

/**
 * Throw `SecretRestrictedError` unless the secret is non-restricted OR the caller
 * presents the exact in-process capability. Used by the ONE legitimate in-process
 * path (`broker.withSecrets` from ssh-connect). Every other path checks
 * `isRestrictedSecret` inline and returns its own native denied shape.
 */
export function assertSecretAllowed(name: string, capability?: unknown, tags?: string[]): void {
  if (!isRestrictedSecret(name, tags)) return;                 // not restricted — no gate
  if (capability === RESTRICTED_SECRET_CAPABILITY) return;     // authorized in-process holder
  throw new SecretRestrictedError(name);                       // restricted + no/invalid cap → deny
}
