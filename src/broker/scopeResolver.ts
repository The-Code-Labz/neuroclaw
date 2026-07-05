/**
 * broker/scopeResolver.ts — naming-convention access policy (spec v3 §5).
 *
 *   1. SHARED_*           → any verified agent
 *   2. NEUROCLAW_*        → any verified agent (project-wide)
 *   3. <X>_*              → only agent whose canonical prefix === X
 *   4. nc-supervisor      → may not call use/exec/search/describe directly
 *   5. anything else      → DENY
 */
import { parseName } from './nameParser';
import { getCanonicalPrefix } from './agentRegistry';

const SUPERVISOR_IDENTITY = 'nc-supervisor';

export function resolveScope(agentName: string, secretName: string): boolean {
  const parsed = parseName(secretName);
  if (!parsed) return false;

  if (agentName === SUPERVISOR_IDENTITY) return false;

  if (parsed.scope === 'SHARED' || parsed.scope === 'NEUROCLAW') return true;

  const canonical = getCanonicalPrefix(agentName);
  if (canonical && parsed.scope === canonical) return true;

  return false;
}

export function filterAccessible<T extends { name: string }>(
  agentName: string,
  rows: readonly T[],
): T[] {
  return rows.filter((r) => resolveScope(agentName, r.name));
}
