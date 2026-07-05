// Composio Toolkit Tier Policy
//
// Every toolkit falls into one of three tiers:
//
//   T1 — Auto-share.   The toolkit operates on YOUR data with you as the only
//                      human. Read-heavy, low-risk. Any agent that needs the
//                      toolkit gets auto-granted access to the single shared
//                      connection. One OAuth, all agents.
//
//   T2 — Ask at connect. The toolkit performs identity-bound actions
//                        (sending email, posting socially) where per-agent
//                        attribution might matter. When an agent requests a
//                        connection, we check:
//                          - Same-agent connection exists? Use it.
//                          - Different-agent connection exists? Block and
//                            prompt the user via the dashboard.
//                          - Nothing exists? Run OAuth, ask user "share or
//                            per-agent?" before stamping.
//
//   T3 — Locked.        Money, identity, infrastructure. Never auto-connected.
//                       Every connection requires explicit dashboard approval
//                       with a Discord notification. Always per-agent.
//
// Anything not classified defaults to T2 (safe-by-default).

export type Tier = 'T1' | 'T2' | 'T3';

/**
 * Canonical tier classifications. Keys are Composio toolkit slugs (lowercase).
 *
 * Sources of truth for slug names:
 *   - composio.toolkits.getToolkits()  (catalog lookup)
 *   - Whatever the user has authorized in their Composio dashboard.
 *
 * If you're adding a new toolkit:
 *   - Read-mostly, you-the-owner data    → T1
 *   - Sends/posts/messages as you        → T2
 *   - Money, identity, infra, credentials → T3
 */
export const TIER_MAP: Record<string, Tier> = {
  // ── T1: auto-share ─────────────────────────────────────────────────────────
  googlesheets:    'T1',
  googledrive:     'T1',
  googlecalendar:  'T1',
  googledocs:      'T1',
  google_sheets:   'T1',
  google_drive:    'T1',
  google_calendar: 'T1',
  google_docs:     'T1',
  notion:          'T1',
  linear:          'T1',
  github:          'T1',
  gitlab:          'T1',

  // ── T2: ask at connect ─────────────────────────────────────────────────────
  gmail:           'T2',
  discord:         'T2',
  slack:           'T2',
  twitter:         'T2',
  x:               'T2',
  twitter_v2:      'T2',
  instagram:       'T2',
  meta_ads:        'T2',
  metaads:         'T2',
  facebook_ads:    'T2',
  tiktok:          'T2',
  outlook:         'T2',
  microsoft_teams: 'T2',
  whatsapp:        'T2',
  telegram:        'T2',
  sendgrid:        'T2',
  mailchimp:       'T2',

  // ── T3: locked + approval ──────────────────────────────────────────────────
  stripe:          'T3',
  plaid:           'T3',
  banking:         'T3',
  payment:         'T3',
  paypal:          'T3',
  square:          'T3',
  shopify:         'T3',           // can move money / orders
  namecheap:       'T3',
  godaddy:         'T3',
  cloudflare:      'T3',  // can change DNS / kill prod → treat as infra
  aws:             'T3',
  digitalocean:    'T3',
  vercel:          'T3',
  netlify:         'T3',
  twilio:          'T3',           // sends SMS, costs $$
};

/** Default tier for anything not in the map. Safe-by-default. */
export const DEFAULT_TIER: Tier = 'T2';

/** Look up the tier for a toolkit slug. Slugs are normalized to lowercase. */
export function tierFor(toolkitSlug: string): Tier {
  return TIER_MAP[toolkitSlug.toLowerCase().trim()] ?? DEFAULT_TIER;
}

/**
 * Decision result returned by `decideConnectionPolicy()`.
 * - "auto_grant_shared":     existing T1 shared connection found; wire it in.
 * - "use_existing_owned":    same-agent T2 connection found; reuse it.
 * - "request_user_decision": T2 conflict (other agent owns one); ask user how to scope.
 * - "block_require_approval": T3 toolkit; never auto-create; require dashboard approval.
 * - "allow_new_owned":       no existing connection; agent may run OAuth and stamp it.
 */
export type ConnectionDecision =
  | { action: 'auto_grant_shared';      tier: Tier; existingAccountId: string }
  | { action: 'use_existing_owned';     tier: Tier; existingAccountId: string }
  | { action: 'request_user_decision';  tier: Tier; conflictingOwner: string; conflictingAccountId: string }
  | { action: 'block_require_approval'; tier: Tier; reason: string }
  | { action: 'allow_new_owned';        tier: Tier };

export interface ConnectionContext {
  toolkitSlug: string;
  requestingAgent: string;          // composio_user_id of the agent asking
  existingAccounts: Array<{
    id: string;
    toolkit: string;
    owner: string | null;           // composio_user_id stamped on the account, or null = shared/orphan
    shared: boolean;                // true if marked as shared (allowAllUsers / accountType=SHARED)
    status: string;
  }>;
}

/**
 * The brain. Given a context, decide what to do for a connection request.
 * Pure function — no side effects.
 */
export function decideConnectionPolicy(ctx: ConnectionContext): ConnectionDecision {
  const tier = tierFor(ctx.toolkitSlug);
  const active = ctx.existingAccounts.filter(a => {
    const s = a.status.toUpperCase();
    return s === 'ACTIVE' || s === 'INITIATED';
  });

  // ── T3: never auto-grant, always approval ────────────────────────────────
  if (tier === 'T3') {
    return {
      action: 'block_require_approval',
      tier,
      reason: `Toolkit '${ctx.toolkitSlug}' is tier-3 (locked). Requires dashboard approval.`,
    };
  }

  // ── T1: auto-share ───────────────────────────────────────────────────────
  if (tier === 'T1') {
    // Any active T1 connection (shared OR owned by anyone) gets auto-shared
    // — that's the whole point of T1. Prefer one already marked shared.
    const candidate =
      active.find(a => a.shared) ??
      active.find(a => a.owner === ctx.requestingAgent) ??
      active[0];
    if (candidate) {
      return { action: 'auto_grant_shared', tier, existingAccountId: candidate.id };
    }
    // None exist yet → agent may create it, and we'll mark it shared after callback.
    return { action: 'allow_new_owned', tier };
  }

  // ── T2: ask at connect ───────────────────────────────────────────────────
  // Preference order:
  //   1. Shared account (user explicitly made it shared)
  //   2. Same-agent account
  //   3. Different-agent account → block, prompt user
  //   4. Nothing → allow new
  const sharedAccount = active.find(a => a.shared);
  if (sharedAccount) {
    return { action: 'auto_grant_shared', tier, existingAccountId: sharedAccount.id };
  }
  const ownedByRequester = active.find(a => a.owner === ctx.requestingAgent);
  if (ownedByRequester) {
    return { action: 'use_existing_owned', tier, existingAccountId: ownedByRequester.id };
  }
  const ownedByOther = active.find(a => a.owner && a.owner !== ctx.requestingAgent);
  if (ownedByOther) {
    return {
      action: 'request_user_decision',
      tier,
      conflictingOwner: ownedByOther.owner!,
      conflictingAccountId: ownedByOther.id,
    };
  }
  return { action: 'allow_new_owned', tier };
}

/** Friendly human-readable tier label for UI/logs. */
export function tierLabel(t: Tier): string {
  switch (t) {
    case 'T1': return 'Auto-share';
    case 'T2': return 'Ask at connect';
    case 'T3': return 'Locked (approval required)';
  }
}

/** Short tier badge for compact UI surfaces. */
export function tierBadge(t: Tier): string {
  switch (t) {
    case 'T1': return 'T1 · shared';
    case 'T2': return 'T2 · owned';
    case 'T3': return 'T3 · locked';
  }
}
