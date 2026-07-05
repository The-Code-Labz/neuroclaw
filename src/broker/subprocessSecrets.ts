/**
 * broker/subprocessSecrets.ts — subprocess delivery adapter (spec §Component 2).
 *
 * Turns an agent's declared broker secret names into a child-process `env`
 * map, ready for `spawn({ env })`. Resolution, scope-checking, and auditing
 * happen in the Phase 1 injector core (`resolveEnvBundle`); this module only
 * adapts the result to the subprocess delivery hop and exposes the resolved
 * values so the caller can scrub them out of the child's stdout/stderr.
 *
 * Reused by bash_run (Phase 2) and MCP / skill-script spawns (Phase 5).
 *
 * See docs/superpowers/specs/2026-05-15-agent-broker-secret-injection-design.md
 */
import { resolveEnvBundle, listAccessible } from './agentSecrets';

export interface SubprocessSecrets {
  /** Base env merged with resolved secret values — pass straight to spawn({ env }). */
  env: Record<string, string | undefined>;
  /** Resolved name→value map. Feed to scrubOutput() to redact the child's output. */
  resolved: Record<string, string>;
  /** Requested names the calling agent is not scoped to. Never injected. */
  denied: string[];
  /** Requested names absent from the broker. Never injected. */
  missing: string[];
}

/**
 * Resolve `names` (explicit broker secret names, scoped to `agentId`) and merge
 * the resolved values onto `baseEnv`. An empty or undefined `names` is a no-op
 * fast path: `baseEnv` is returned by reference, untouched, with empty
 * resolved / denied / missing. Never throws — `resolveEnvBundle` absorbs
 * storage errors and reports them as `missing`.
 */
export async function buildSubprocessEnv(
  agentId: string | null,
  names: string[] | undefined,
  purpose: string,
  baseEnv: Record<string, string | undefined>,
): Promise<SubprocessSecrets> {
  if (!names || names.length === 0) {
    return { env: baseEnv, resolved: {}, denied: [], missing: [] };
  }
  const bundle = await resolveEnvBundle(agentId, names, purpose);
  return {
    env: { ...baseEnv, ...bundle.env },
    resolved: bundle.env,
    denied: bundle.denied,
    missing: bundle.missing,
  };
}

/**
 * Resolve EVERY broker secret the agent is scoped to and merge the values onto
 * `baseEnv`. For a subprocess consumer whose whole turn is the child process
 * (a CLI-backed agent) — it receives its full broker identity as environment,
 * rather than naming individual secrets per call. `resolved` is the name→value
 * map for output scrubbing. An agent scoped to nothing is the no-op fast path.
 */
export async function buildAgentScopedEnv(
  agentId: string | null,
  purpose: string,
  baseEnv: Record<string, string | undefined>,
): Promise<SubprocessSecrets> {
  const metas = await listAccessible(agentId);
  return buildSubprocessEnv(agentId, metas.map((m) => m.name), purpose, baseEnv);
}
