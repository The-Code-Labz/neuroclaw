// git-identity.ts — per-agent git author/committer identity.
//
// WHY: this box has ONE shared global git identity (historically "Mio Naruse"),
// so every agent's commit was authored as that one persona regardless of who
// actually did the work — `git log` author became useless for attribution.
//
// FIX: git honors GIT_AUTHOR_*/GIT_COMMITTER_* env vars OVER config, in ANY
// working directory (shared serving tree AND per-agent worktrees). We inject
// these into the subprocess env at the one universal choke point
// (`buildSubprocessEnv`), derived from the calling agent — so registry
// `bash_run`, the native SDK `Bash` tool (via every CLI provider's
// `buildAgentScopedEnv`), and skills all get correct attribution uniformly.
//
// A null/unknown agent → {} → falls through to the (neutral) global config;
// system/user/manual commits are never broken.

import { getAgentById } from '../db';

/** Reserved, non-resolving domain (RFC 2606 `.invalid`) — zero impersonation risk. */
const AGENT_EMAIL_DOMAIN = (process.env.AGENT_EMAIL_DOMAIN ?? 'agents.neuroclaw.invalid').trim();

/** name → email-local-part slug: lowercase, non-alnum → '-', collapse/trim dashes. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'agent';
}

/**
 * Git author/committer env for a given agent. Returns {} when the agent can't
 * be resolved (null id, unknown row) so the caller falls through to global config.
 */
export function gitIdentityEnv(agentId: string | null | undefined): Record<string, string> {
  if (!agentId) return {};
  const agent = getAgentById(agentId);
  const name = agent?.name?.trim();
  if (!name) return {};
  const email = `${slugify(name)}@${AGENT_EMAIL_DOMAIN}`;
  return {
    GIT_AUTHOR_NAME:     name,
    GIT_AUTHOR_EMAIL:    email,
    GIT_COMMITTER_NAME:  name,
    GIT_COMMITTER_EMAIL: email,
  };
}
