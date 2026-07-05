// Per-agent / per-session turn budgets for the dashboard chat reliability
// overhaul (v3.2). Replaces the single global CLAUDE_MAX_TURNS=20 ceiling
// with a profile-based system that lets heavy reasoning agents (Oracle,
// Jarvis, Lucius, A.S.A.G.I) run much longer tool loops while still
// providing a hard ceiling so a runaway agent can't burn all our quota.
//
// Two thresholds per resolution:
//   soft — checkpoint + emit `signal=paused`. The agent's loop breaks here
//          and the run is left in status='paused'. A follow-up user message
//          (or an automatic continuation in a future sprint) resumes.
//   hard — emit `signal=stopped` and end the run with status='stopped'. No
//          resumption.
//
// Resolution order (first non-null wins):
//   1. session.max_turns_override        — rare per-conversation knob
//   2. agent.max_turns_soft / _hard      — explicit per-agent values
//   3. WORKLOAD_PRESETS[agent.workload_profile]
//   4. WORKLOAD_PRESETS.normal           — final fallback
//
// The session override applies BOTH soft+hard at once (set to the same value
// — useful for clamping a runaway session without touching the agent record).

export const WORKLOAD_PRESETS = {
  light:    { soft: 10,  hard: 20  },
  normal:   { soft: 60,  hard: 120 },
  heavy:    { soft: 80,  hard: 160 },
  marathon: { soft: 200, hard: 400 },
} as const;

export type WorkloadProfile = keyof typeof WORKLOAD_PRESETS;

export interface TurnBudget {
  soft: number;
  hard: number;
}

interface AgentLike {
  max_turns_soft?:  number | null;
  max_turns_hard?:  number | null;
  workload_profile?: string | null;
}

interface SessionLike {
  max_turns_override?: number | null;
}

/**
 * Compute the effective soft/hard turn budget for an agent + optional
 * session override. Never returns negative or zero values; if explicit
 * values are bogus we fall back to the workload preset.
 */
export function resolveTurnBudget(
  agent: AgentLike | undefined | null,
  session?: SessionLike | undefined | null,
): TurnBudget {
  const profileKey = (agent?.workload_profile ?? 'normal') as WorkloadProfile;
  const preset = WORKLOAD_PRESETS[profileKey] ?? WORKLOAD_PRESETS.normal;

  // Session override clamps both — useful for "run this conversation longer
  // than the agent's default" OR "cap this runaway session".
  const sessionOverride = sanitize(session?.max_turns_override);
  if (sessionOverride !== null) {
    return { soft: sessionOverride, hard: sessionOverride };
  }

  const soft = sanitize(agent?.max_turns_soft) ?? preset.soft;
  let   hard = sanitize(agent?.max_turns_hard) ?? preset.hard;
  // Hard must be >= soft; if a user types soft=100 hard=50, raise hard.
  if (hard < soft) hard = soft;
  return { soft, hard };
}

/** Coerce arbitrary input to a positive integer or null. */
function sanitize(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function isValidProfile(p: string | null | undefined): p is WorkloadProfile {
  return typeof p === 'string' && p in WORKLOAD_PRESETS;
}
