#!/usr/bin/env node
// scripts/composio-claim-orphans.mjs
//
// One-off migration: walk every Composio connected account in the current
// project, classify it against the tier policy, and either:
//
//   T1 → mark as shared in composio_account_meta (auto-share posture)
//   T2 → stamp owner if Composio reports one; otherwise queue a pending
//        decision so the dashboard surfaces it
//   T3 → never auto-mark; just record the meta row so the dashboard sees it
//
// Run it once after deploying the connections panel to seed the meta table
// from the live Composio state. Idempotent — re-running just refreshes the
// same rows.
//
// Usage:
//   node scripts/composio-claim-orphans.mjs                  # apply (default)
//   node scripts/composio-claim-orphans.mjs --dry-run        # report only
//   node scripts/composio-claim-orphans.mjs --json           # machine output
//
// Requires the same env the dashboard uses:
//   COMPOSIO_API_KEY  (mandatory)
//   COMPOSIO_BASE_URL (optional)
//
// Note: this script intentionally runs WITHOUT importing the dashboard's full
// runtime — it imports the tier policy + connection-policy modules directly
// against the compiled `dist/` so it's safe to run while the dashboard is up.

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Prefer the compiled dist (production); fall back to tsx for source if missing.
function hasDist() {
  return existsSync(resolve(ROOT, 'dist/composio/connection-policy.js'));
}

async function loadModules() {
  if (hasDist()) {
    const policy = await import(resolve(ROOT, 'dist/composio/connection-policy.js'));
    const tier   = await import(resolve(ROOT, 'dist/composio/tier-policy.js'));
    return { policy, tier };
  }
  // tsx fallback for dev environments where dist isn't built.
  try {
    // eslint-disable-next-line import/no-unresolved
    await import('tsx/esm');
    const policy = await import(resolve(ROOT, 'src/composio/connection-policy.ts'));
    const tier   = await import(resolve(ROOT, 'src/composio/tier-policy.ts'));
    return { policy, tier };
  } catch (err) {
    console.error('[orphan-claim] no dist/ and tsx not available. Run `npm run build` first.');
    console.error('[orphan-claim] error:', err?.message ?? err);
    process.exit(2);
  }
}

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run') || args.has('-n');
const JSON_OUT = args.has('--json');

(async () => {
  const { policy, tier } = await loadModules();
  const accounts = await policy.listAccountsWithMeta();

  if (accounts.length === 0) {
    console.error('[orphan-claim] no Composio accounts visible to the current API key. Nothing to do.');
    if (JSON_OUT) console.log(JSON.stringify({ processed: 0, results: [] }));
    process.exit(0);
  }

  const results = [];
  for (const a of accounts) {
    const tk = (a.toolkit || '').toLowerCase();
    const t  = tier.tierFor(tk);
    const action = (() => {
      if (t === 'T1') return a.shared ? 'noop-already-shared' : 'mark-shared';
      if (t === 'T2') return a.owner ? 'noop-has-owner' : 'flag-orphan-needs-owner';
      // T3
      return a.owner ? 'noop-locked-owned' : 'flag-orphan-needs-approval';
    })();

    if (!DRY) {
      if (action === 'mark-shared') {
        policy.setAccountMeta({ account_id: a.id, toolkit: tk, shared: true, owner: a.owner ?? null });
      } else if (action === 'flag-orphan-needs-owner' || action === 'flag-orphan-needs-approval') {
        // Just ensure the meta row exists so the dashboard knows about it.
        policy.setAccountMeta({ account_id: a.id, toolkit: tk, shared: false, owner: a.owner ?? null });
      } else {
        // Touch the row so updated_at refreshes and the dashboard's "last seen"
        // stays current.
        policy.setAccountMeta({ account_id: a.id, toolkit: tk, shared: a.shared, owner: a.owner ?? null });
      }
    }

    results.push({
      id: a.id,
      toolkit: tk,
      tier: t,
      status: a.status,
      owner: a.owner,
      shared: a.shared,
      action,
    });
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ processed: results.length, dry_run: DRY, results }, null, 2));
  } else {
    const pad = (s, n) => String(s ?? '').padEnd(n, ' ');
    console.log(`[orphan-claim] processed ${results.length} accounts${DRY ? ' (DRY RUN)' : ''}`);
    console.log(`  ${pad('TIER', 4)} ${pad('TOOLKIT', 16)} ${pad('OWNER', 14)} ${pad('SHARED', 7)} ${pad('ACTION', 28)} ID`);
    for (const r of results) {
      console.log(`  ${pad(r.tier, 4)} ${pad(r.toolkit, 16)} ${pad(r.owner ?? '—', 14)} ${pad(r.shared ? 'shared' : 'private', 7)} ${pad(r.action, 28)} ${r.id}`);
    }
    const summary = results.reduce((acc, r) => { acc[r.action] = (acc[r.action] ?? 0) + 1; return acc; }, {});
    console.log('[orphan-claim] summary:', summary);
    if (!DRY) console.log('[orphan-claim] done. composio_account_meta updated.');
  }
})().catch((err) => {
  console.error('[orphan-claim] FAILED:', err);
  process.exit(1);
});
