// kimi.context-budget — flag agents whose system prompt is too big for their model.
//
// Small-context models (Kimi-K2/K2.6, anything called *-mini) get pushed over
// their context window when the system prompt + injected memory blocks +
// tool-manifest grow over time. This check estimates token usage on the
// system_prompt alone (rough heuristic: 1 token ≈ 4 chars) and flags any
// agent above 60% of its known window.
//
// The suggested fix nudges toward narrower tool scope. The agents table
// doesn't have a tool_scope column today; the suggestion is still actionable
// (reduce skills/tools attached to the agent, shorten the system prompt).

import { register } from '../registry';

// Known model → context window (tokens). Conservative defaults; we use the
// first key that matches as a substring of the agent.model.
const CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/kimi-?k2(\.|-)?6/i,    128_000],
  [/kimi-?k2/i,            128_000],
  [/kimi/i,                128_000],
  [/gpt-?4o-?mini/i,       128_000],
  [/gpt-?4\.?1-?mini/i,  1_000_000],
  [/gpt-?4\.?1/i,        1_000_000],
  [/gpt-?4o/i,             128_000],
  [/claude-?(haiku|3-5-haiku|haiku-3)/i, 200_000],
  // xAI Grok
  [/grok-?4/i, 256_000],
  // small-context pattern fallback: anything explicitly tagged "-mini" or
  // "-small" or "8k"/"32k" suggests a tight budget.
  [/-mini\b/i,              32_000],
  [/-small\b/i,             32_000],
  [/\b8k\b/i,                8_000],
  [/\b32k\b/i,              32_000],
];

const BUDGET_RATIO = 0.6;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function windowFor(model: string): number | null {
  for (const [pattern, n] of CONTEXT_WINDOWS) {
    if (pattern.test(model)) return n;
  }
  return null;
}

register({
  id: 'kimi.context-budget',
  scope: 'config',
  severity: 'warn',
  description: 'Small-context agents are within 60% of their context window',
  async run(ctx) {
    interface AgentRow { id: string; name: string; model: string | null; system_prompt: string | null }
    let rows: AgentRow[] = [];
    try {
      rows = ctx.db
        .prepare(`SELECT id, name, model, system_prompt FROM agents WHERE status = 'active'`)
        .all() as AgentRow[];
    } catch {
      return { ok: true, detail: 'agents table unavailable — skipped', meta: { skipped: true } };
    }

    interface Hit { agent: string; model: string; tokens: number; window: number; pct: number }
    const hits: Hit[] = [];

    for (const r of rows) {
      const model = (r.model ?? '').trim();
      if (!model) continue;
      const win = windowFor(model);
      if (win === null) continue; // unknown model — skip rather than flag wrongly
      const tokens = estimateTokens(r.system_prompt ?? '');
      const ratio = tokens / win;
      if (ratio > BUDGET_RATIO) {
        hits.push({
          agent: r.name,
          model,
          tokens,
          window: win,
          pct: Math.round(ratio * 100),
        });
      }
    }

    return {
      ok: hits.length === 0,
      detail: hits.length === 0
        ? 'All small-context agents are within budget'
        : `${hits.length} agent(s) over ${Math.round(BUDGET_RATIO * 100)}% of context: `
          + hits.map(h => `${h.agent} (${h.model}) ${h.tokens}/${h.window} = ${h.pct}%`).join(', '),
      fix: hits.length > 0 ? {
        suggestion:
          'Reduce the agent\'s attached skills/tools (smaller tool manifest) and shorten the system prompt. '
          + 'When per-agent tool_scope lands, set tool_scope=\'core\' on these agents.',
        automated: false,
      } : undefined,
      meta: { hits, budgetRatio: BUDGET_RATIO },
    };
  },
});
