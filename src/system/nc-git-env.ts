// Main-checkout coordination-lock env helpers (Phase 1 + Phase 2).
//
// Shared between bashRun and the interactive CLI providers so every git write
// in the main checkout routes through scripts/nc-git.sh with a lock token and
// real attribution. Worktree and non-repo paths stay unwrapped.

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { config } from '../config';

const execFileAsync = promisify(execFile);

export const NC_GIT_SHIM_DIR = path.join(config.ncGit.repoRoot, 'scripts', 'git-shim');

/** Return true only when cwd is inside the guarded main checkout. Fast-path the
 *  exact repo root; for subdirectories use git rev-parse --show-toplevel and
 *  compare EQUALITY (never substring) so worktrees at /home/nclaw-worktrees/*
 *  stay exempt. */
export async function isMainCheckout(cwd: string): Promise<boolean> {
  const repoRoot = config.ncGit.repoRoot;
  if (path.resolve(cwd) === repoRoot) return true;
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      timeout: 5000,
    });
    return stdout.trim() === repoRoot;
  } catch {
    return false;
  }
}

/** Prepend the git PATH shim and pin the real git binary. The caller's
 *  process.env.PATH is never mutated: only the per-call child-env copy is
 *  touched. The shim itself resolves git via NC_GIT_REAL_GIT to avoid recursion
 *  (Phase 1 M1). */
export function maybeInjectGitShim(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const currentPath = env.PATH ?? process.env.PATH ?? '';
  return {
    ...env,
    PATH: `${NC_GIT_SHIM_DIR}${path.delimiter}${currentPath}`,
    NC_GIT_REAL_GIT: '/usr/bin/git',
  };
}

/** Stamp NC_AGENT/NC_SESSION onto a child-env copy. Undefined ids are skipped
 *  so callers can safely pass optional values. */
export function stampGitAttribution(
  env: Record<string, string | undefined>,
  agentId: string | undefined,
  sessionId: string | undefined,
): Record<string, string | undefined> {
  const out = { ...env };
  if (agentId !== undefined) out.NC_AGENT = agentId;
  if (sessionId !== undefined) out.NC_SESSION = sessionId;
  return out;
}

/** Convenience for CLI providers: stamp attribution and, when cwd is the main
 *  checkout and the lock is enabled, inject the git shim. Default cwd is the
 *  Node process cwd (the main checkout for the providers that spawn here). */
export async function prepareProviderGitEnv(
  baseEnv: Record<string, string | undefined>,
  agentId: string | undefined,
  sessionId: string | undefined,
  cwd: string = process.cwd(),
): Promise<Record<string, string | undefined>> {
  let env = stampGitAttribution(baseEnv, agentId, sessionId);
  if (!config.ncGit.lockDisabled && await isMainCheckout(cwd)) {
    env = maybeInjectGitShim(env);
  }
  return env;
}
