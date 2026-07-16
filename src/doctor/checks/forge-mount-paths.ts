// forge.mount-paths — sanity-check the Forge skill's config surface.
//
// The Forge skill at .claude/skills/forge/ uses Oracle's account via
// FORGE_EMAIL / FORGE_PASSWORD env, talks to forge-backend.neurolearninglabs.com,
// and (in some deployments) caches the JWT at ~/.forge_jwt. There is no
// hard-coded mount-path registry in this repo today, so this check is best-
// effort: it verifies the forge.py script exists and that creds are set.
//
// Severity: info — Forge isn't load-bearing for core NeuroClaw runtime.

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { register } from '../registry';

const SKILL_SCRIPT_CANDIDATES = [
  '.claude/skills/forge/scripts/forge.py',
  '.claude/skills/forge/forge.py',
  '.agents/skills/forge/scripts/forge.py',
];

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch { return false; }
}

register({
  id: 'forge.mount-paths',
  scope: 'config',
  severity: 'info',
  description: 'Forge skill script + credentials are present (if Forge is in use)',
  async run(ctx) {
    const issues: string[] = [];
    const meta: Record<string, unknown> = {};

    // 1. Script presence
    let scriptFound: string | null = null;
    for (const rel of SKILL_SCRIPT_CANDIDATES) {
      const abs = join(ctx.repoRoot, rel);
      if (await fileExists(abs)) { scriptFound = rel; break; }
    }
    meta.scriptFound = scriptFound;

    // 2. Credentials — env-supplied; tolerant when unset because Forge isn't
    // required for NeuroClaw to run.
    const hasEmail = Boolean((ctx.env.FORGE_EMAIL ?? '').trim());
    const hasPwd = Boolean((ctx.env.FORGE_PASSWORD ?? '').trim());
    meta.hasEmail = hasEmail;
    meta.hasPwd = hasPwd;

    if (scriptFound && (hasEmail !== hasPwd)) {
      issues.push('Forge script present but only one of FORGE_EMAIL / FORGE_PASSWORD is set');
    }

    // 3. JWT cache (optional)
    const jwtPath = join(homedir(), '.forge_jwt');
    const hasJwt = await fileExists(jwtPath);
    meta.jwtCache = hasJwt ? jwtPath : null;

    // 4. Cross-check: projects table contains git_repo URLs but no mount roots
    // exist in this repo's schema today. Just report the count for visibility.
    try {
      const row = ctx.db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE archived = 0`).get() as { n: number } | undefined;
      meta.activeProjects = row?.n ?? 0;
    } catch { /* table optional */ }

    if (!scriptFound && (hasEmail || hasPwd)) {
      issues.push('FORGE_* env vars set but no forge skill script found in repo');
    }

    const ok = issues.length === 0;
    const credState = hasEmail && hasPwd ? 'set' : (hasEmail || hasPwd ? 'partial' : 'unset');
    const detail = ok
      ? (!hasEmail && !hasPwd
          ? `Forge unused on this host (script=${scriptFound ?? 'absent'}, creds=unset)`
          : `Forge configured (script=${scriptFound ?? 'absent'}, creds=${credState}, jwt=${hasJwt ? 'cached' : 'none'})`)
      : issues.join('; ');

    return {
      ok,
      detail,
      fix: ok ? undefined : {
        suggestion: 'Set both FORGE_EMAIL and FORGE_PASSWORD, or remove them entirely. See .claude/skills/forge/SKILL.md.',
        automated: false,
      },
      meta,
    };
  },
});
