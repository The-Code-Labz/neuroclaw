// ── Give-up pattern learning ─────────────────────────────────────────────────
// The async, right-layer version of "an agent that fixes errors". When a turn's
// give-up condition fires (consecutive tool-failure streak, both planes), we DON'T
// spin up a real-time repair agent — that would fire on healthy turns and mask the
// real bug (see the streak fix in claude-cli.ts / openai-agents-backbone.ts).
//
// Instead we do two cheap things:
//   1. recordGiveUp() — emit a structured `agent_give_up` analytics event with a
//      NORMALIZED signature, so benign error CLASSES can be clustered across turns.
//   2. detectGiveUpPatterns() — an async sweep (piggybacks the log-analyzer's
//      5-min loop) that clusters those events over 24h and, when a signature
//      RECURS past a threshold, files a task to LogAnalyst proposing a give-up
//      carve-out. No LLM in the hot path; no per-turn babysitting. The harness
//      keeps owning the live "is this turn stuck" call; this only helps it get
//      SMARTER at not-counting benign errors over time.

import { getDb, getAgentByName, logAnalytics } from '../db';
import { createTask } from './task-manager';
import { logger } from '../utils/logger';

// ── Signature normalization ──────────────────────────────────────────────────
// The whole value is in clustering: two turns that died on "malformed tool-input
// JSON" must land on the SAME signature even though the surrounding text differs.
// Known benign classes get a stable label + benign:true (strong carve-out
// candidates); everything else falls back to a path/uuid/number-stripped token.

export interface GiveUpClass {
  signature: string;
  benign:    boolean;
  label:     string;
}

export function classifyGiveUp(kind: string, cmd: string | null, output: string): GiveUpClass {
  const hay = `${cmd ?? ''}\n${output}`.toLowerCase();

  // Benign, self-correcting classes — model/formatting mistakes, not task blockers.
  if (hay.includes('could not be parsed as json') || hay.includes('inputvalidationerror'))
    return { signature: `${kind}:json_input`, benign: true, label: 'malformed tool-input JSON (tool never ran)' };
  if (hay.includes('has been modified since read'))
    return { signature: `${kind}:stale_read`, benign: true, label: 'stale file read after edit (self-corrects with re-Read)' };
  if (hay.includes('has not been read yet') || hay.includes('must be read'))
    return { signature: `${kind}:unread_file`, benign: true, label: 'edit before read (self-corrects with Read)' };
  if (/\bexit code\s*1\b/.test(hay))
    return { signature: `${kind}:exit_1`, benign: true, label: 'command exit 1 (often a grep/test no-match, not a real failure)' };

  // Fallback: first stable error token, path/uuid/number-stripped so it clusters.
  const firstLine = output.split('\n').map(s => s.trim()).find(Boolean) ?? kind;
  const norm = firstLine
    .toLowerCase()
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '<uuid>')
    .replace(/(?:\/[^\s/]+)+/g, '<path>')
    .replace(/\d+/g, 'N')
    .slice(0, 48)
    .trim();
  return { signature: `${kind}:${norm || 'unknown'}`, benign: false, label: firstLine.slice(0, 80) };
}

// ── Emit (called from both give-up planes) ───────────────────────────────────

export interface GiveUpEvent {
  plane:      'claude-cli' | 'backbone';
  kind:       string;                 // 'failures' | 'repeat' | 'idle' | ...
  agentId?:   string | null;
  agentName?: string | null;
  model?:     string | null;
  cmd?:       string | null;          // the failing step/command (or tool name)
  count?:     number | null;
  failStreak?: number | null;
  output?:    string;                 // scrubbed tail of the last failure
}

export function recordGiveUp(ev: GiveUpEvent): void {
  // Telemetry must NEVER break a turn — the give-up path is already a bail.
  try {
    const { signature, benign, label } = classifyGiveUp(ev.kind, ev.cmd ?? null, ev.output ?? '');
    logAnalytics('agent_give_up', {
      plane:      ev.plane,
      kind:       ev.kind,
      agentId:    ev.agentId ?? null,
      agentName:  ev.agentName ?? null,
      model:      ev.model ?? null,
      cmd:        ev.cmd ?? null,
      count:      ev.count ?? null,
      failStreak: ev.failStreak ?? null,
      signature,
      benign,
      label,
    });
  } catch { /* swallow — never let telemetry surface into the turn */ }
}

// ── Detect (async sweep — piggybacks the log-analyzer loop) ──────────────────

const PATTERN_WINDOW_MS      = 24 * 60 * 60 * 1000;   // rolling window for clustering
const PATTERN_THRESHOLD      = 3;                      // occurrences of one signature → propose
const REPROPOSE_COOLDOWN_MS  = 7 * 24 * 60 * 60 * 1000; // don't refile the same carve-out for a week

interface Cluster {
  count:     number;
  benign:    boolean;
  label:     string;
  sampleCmd: string | null;
  kind:      string;
}

export async function detectGiveUpPatterns(): Promise<void> {
  try {
    const db = getDb();
    const since = new Date(Date.now() - PATTERN_WINDOW_MS).toISOString();
    const rows = db.prepare(`
      SELECT data FROM analytics_events
      WHERE event_type = 'agent_give_up' AND created_at >= ?
    `).all(since) as Array<{ data: string | null }>;
    if (rows.length === 0) return;

    // Cluster by normalized signature.
    const clusters = new Map<string, Cluster>();
    for (const r of rows) {
      if (!r.data) continue;
      let d: Record<string, unknown>;
      try { d = JSON.parse(r.data) as Record<string, unknown>; } catch { continue; }
      const sig = typeof d.signature === 'string' ? d.signature : undefined;
      if (!sig) continue;
      const c = clusters.get(sig) ?? {
        count:     0,
        benign:    Boolean(d.benign),
        label:     typeof d.label === 'string' ? d.label : sig,
        sampleCmd: typeof d.cmd === 'string' ? d.cmd : null,
        kind:      typeof d.kind === 'string' ? d.kind : '',
      };
      c.count++;
      if (!c.sampleCmd && typeof d.cmd === 'string') c.sampleCmd = d.cmd;
      clusters.set(sig, c);
    }

    for (const [sig, c] of clusters) {
      if (c.count < PATTERN_THRESHOLD) continue;

      // Dedup: don't refile the same proposal within the cooldown.
      const markerKey = `giveup_proposal:${sig}`;
      const marker = db.prepare('SELECT value FROM config_items WHERE key = ?').get(markerKey) as { value: string } | undefined;
      if (marker && Date.now() - new Date(marker.value).getTime() < REPROPOSE_COOLDOWN_MS) continue;

      const analyst = getAgentByName('LogAnalyst');
      const classNote = c.benign
        ? 'This is a BENIGN, self-correcting error class — a strong carve-out candidate. Propose a regex/predicate to exempt it (count at half-weight, or reset the streak) in the give-up counter.'
        : 'This may be a GENUINE recurring blocker (not obviously benign). Investigate the root cause before proposing any carve-out — do not blindly exempt it.';

      await createTask(
        `Give-up pattern recurring: ${c.label} (${c.count}× / 24h)`,
        {
          agentId:        analyst?.id,
          priority_level: c.benign ? 'low' : 'medium',
          feature:        'giveup-carveout',
          task_source:    'background',
          assignee:       'LogAnalyst',
          description:
            `The give-up mechanism bailed **${c.count} turns in the last 24h** on the same normalized signature \`${sig}\`.\n\n` +
            `**Sample failing step:** ${c.sampleCmd ? '`' + c.sampleCmd.slice(0, 200) + '`' : '(none captured)'}\n\n` +
            `**Classification:** ${classNote}\n\n` +
            `**Where the carve-out lives — fix BOTH planes or the pattern persists on the other:**\n` +
            `- \`src/providers/claude-cli.ts\` — the \`isSelfCorrecting\` branch driving \`failStreak\`.\n` +
            `- \`src/agent/openai-agents-backbone.ts\` — \`onToolResult\` streak logic.\n\n` +
            `A benign class should count at half-weight (~2× budget) or reset the streak, mirroring the existing read-before-write carve-out.\n\n` +
            `_Filed automatically by the give-up pattern detector (log-analyzer sweep)._`,
        },
      );

      db.prepare(
        `INSERT INTO config_items (key, value, description) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(markerKey, new Date().toISOString(), 'Give-up carve-out proposal last-filed timestamp');

      logger.info('give-up-telemetry: filed carve-out proposal', { signature: sig, count: c.count, benign: c.benign });
    }
  } catch (err) {
    logger.warn('give-up-telemetry: pattern detection failed', { err: err instanceof Error ? err.message : err });
  }
}
