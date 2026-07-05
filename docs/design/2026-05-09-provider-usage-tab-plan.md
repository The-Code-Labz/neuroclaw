# Provider Usage Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated Usage dashboard page showing per-provider token consumption, call counts, and estimated cost with time-range filtering and per-agent drill-down; fix the Analytics page provider donut to show real provider names.

**Architecture:** All LLM calls already log to the `model_spend` table in SQLite. We add two query functions to `model-spend.ts`, one API endpoint to `routes.ts`, a new `page-usage.jsx` component, and wire everything up through `live-data.jsx`, `data.jsx`, `app.jsx`, and `NeuroClaw.html`. One line in `alfred.ts` renames the Claude CLI provider key from `'anthropic'` to `'claude-cli'` so the two Anthropic paths are distinguishable in historical data going forward.

**Tech Stack:** TypeScript (better-sqlite3), Hono (routes), React 18 (JSX via Babel standalone), existing dashboard component patterns (StatCard, Section, PageHeader, Icon).

---

## File Map

| File | Action | What changes |
|---|---|---|
| `src/agent/alfred.ts` | Modify | One `logSpend` call: `provider: 'anthropic'` → `'claude-cli'` in `chatStreamClaudeCli` |
| `src/system/model-spend.ts` | Modify | Add `ProviderUsageRow`, `ProviderAgentRow` interfaces + `spendByProvider()` + `spendByProviderAndAgent()` |
| `src/dashboard/routes.ts` | Modify | Add `GET /api/analytics/usage` endpoint |
| `src/dashboard/v2/src/page-usage.jsx` | Create | New Usage page component |
| `src/dashboard/v2/src/live-data.jsx` | Modify | Add `providerUsage` to tick call list; fix `providerSplit` to use real provider names |
| `src/dashboard/v2/src/data.jsx` | Modify | Add Usage entry to `NAV` OBSERVE group |
| `src/dashboard/v2/src/app.jsx` | Modify | Add `usage` entry to `PAGES` map |
| `src/dashboard/v2/NeuroClaw.html` | Modify | Add `<script>` tag for `page-usage.jsx` |

---

## Task 1: Fix Claude CLI provider key

**Files:**
- Modify: `src/agent/alfred.ts` (around line 1153)

- [ ] **Step 1: Locate the logSpend call inside chatStreamClaudeCli**

  The function starts at line 1026. There is exactly one `logSpend` call inside it. It currently reads:
  ```typescript
  logSpend({
    provider:      'anthropic',
    model_id:      model,
    input_tokens:  realInputTokens  ?? estimateTokens(finalSystemPrompt + userMessage),
    output_tokens: realOutputTokens ?? estimateTokens(textAccum),
    agent_id:      agentId ?? null,
    session_id:    sessionId,
  });
  ```

- [ ] **Step 2: Change the provider key**

  Replace `provider: 'anthropic'` with `provider: 'claude-cli'` in that call only. The `chatStreamAnthropic` function (which calls the Anthropic REST API directly) keeps `provider: 'anthropic'` unchanged.

  Result:
  ```typescript
  logSpend({
    provider:      'claude-cli',
    model_id:      model,
    input_tokens:  realInputTokens  ?? estimateTokens(finalSystemPrompt + userMessage),
    output_tokens: realOutputTokens ?? estimateTokens(textAccum),
    agent_id:      agentId ?? null,
    session_id:    sessionId,
  });
  ```

- [ ] **Step 3: Type-check**

  ```bash
  cd /home/neuroclaw-v1 && npx tsc --noEmit
  ```
  Expected: no errors related to this change (provider is `string`, so the value change is type-safe).

- [ ] **Step 4: Commit**

  ```bash
  git add src/agent/alfred.ts
  git commit -m "fix(spend): log claude-cli provider separately from anthropic API"
  ```

---

## Task 2: Add provider query functions to model-spend.ts

**Files:**
- Modify: `src/system/model-spend.ts`

- [ ] **Step 1: Add the two new interfaces after the existing `SpendByModel` interface (around line 103)**

  ```typescript
  export interface ProviderUsageRow {
    provider:     string;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    call_count:   number;
    est_cost_usd: number;
  }

  export interface ProviderAgentRow {
    provider:   string;
    agent_id:   string | null;
    agent_name: string;
    total_tokens: number;
    call_count:   number;
  }
  ```

- [ ] **Step 2: Add `spendByProvider()` at the bottom of the file**

  ```typescript
  export function spendByProvider(hours: number): ProviderUsageRow[] {
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    return getDb().prepare(`
      SELECT
        s.provider,
        COALESCE(SUM(s.input_tokens + s.output_tokens), 0) AS total_tokens,
        COALESCE(SUM(s.input_tokens),  0) AS input_tokens,
        COALESCE(SUM(s.output_tokens), 0) AS output_tokens,
        COUNT(*) AS call_count,
        COALESCE(SUM(
          (s.input_tokens  / 1000.0) * COALESCE(c.cost_per_1k_input,  0) +
          (s.output_tokens / 1000.0) * COALESCE(c.cost_per_1k_output, 0)
        ), 0) AS est_cost_usd
      FROM model_spend s
      LEFT JOIN model_catalog c
        ON c.provider = s.provider AND c.model_id = s.model_id
      WHERE s.created_at > ?
      GROUP BY s.provider
      ORDER BY total_tokens DESC
    `).all(cutoff) as ProviderUsageRow[];
  }
  ```

- [ ] **Step 3: Add `spendByProviderAndAgent()` at the bottom of the file**

  ```typescript
  export function spendByProviderAndAgent(hours: number): ProviderAgentRow[] {
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    return getDb().prepare(`
      SELECT
        s.provider,
        s.agent_id,
        COALESCE(a.name, 'unknown') AS agent_name,
        COALESCE(SUM(s.input_tokens + s.output_tokens), 0) AS total_tokens,
        COUNT(*) AS call_count
      FROM model_spend s
      LEFT JOIN agents a ON a.id = s.agent_id
      WHERE s.created_at > ?
      GROUP BY s.provider, s.agent_id
      ORDER BY s.provider, total_tokens DESC
    `).all(cutoff) as ProviderAgentRow[];
  }
  ```

- [ ] **Step 4: Type-check**

  ```bash
  cd /home/neuroclaw-v1 && npx tsc --noEmit
  ```
  Expected: no new errors.

- [ ] **Step 5: Commit**

  ```bash
  git add src/system/model-spend.ts
  git commit -m "feat(spend): add spendByProvider and spendByProviderAndAgent queries"
  ```

---

## Task 3: Add /api/analytics/usage endpoint

**Files:**
- Modify: `src/dashboard/routes.ts`

- [ ] **Step 1: Import the new functions**

  Find the existing import line for model-spend (line ~49):
  ```typescript
  import { spendLastHourWithCost, spendByTierLastHour, spendByModelLastHour } from '../system/model-spend';
  ```
  Add the two new exports:
  ```typescript
  import { spendLastHourWithCost, spendByTierLastHour, spendByModelLastHour, spendByProvider, spendByProviderAndAgent } from '../system/model-spend';
  ```

- [ ] **Step 2: Add the endpoint after the existing `/api/analytics/heatmap` handler**

  Find the heatmap endpoint (around line 2918) and add immediately after its closing `});`:
  ```typescript
  app.get('/api/analytics/usage', (c) => {
    try {
      const hours = Math.min(720, Math.max(1, parseInt(c.req.query('hours') ?? '24', 10)));
      return c.json({
        byProvider:      spendByProvider(hours),
        byProviderAgent: spendByProviderAndAgent(hours),
      });
    } catch (e) {
      console.error('Analytics usage:', e);
      return c.json({ error: String(e) }, 500);
    }
  });
  ```

- [ ] **Step 3: Type-check**

  ```bash
  cd /home/neuroclaw-v1 && npx tsc --noEmit
  ```
  Expected: no new errors.

- [ ] **Step 4: Smoke-test the endpoint**

  Start the dashboard server in the background if it isn't running:
  ```bash
  TOKEN=$(grep DASHBOARD_TOKEN /home/neuroclaw-v1/.env | cut -d= -f2)
  curl -s "http://localhost:3141/api/analytics/usage?hours=24&token=${TOKEN}" | head -c 400
  ```
  Expected: JSON with `byProvider` and `byProviderAgent` arrays (may be empty if `model_spend` has no rows).

- [ ] **Step 5: Commit**

  ```bash
  git add src/dashboard/routes.ts
  git commit -m "feat(api): add GET /api/analytics/usage endpoint"
  ```

---

## Task 4: Create page-usage.jsx

**Files:**
- Create: `src/dashboard/v2/src/page-usage.jsx`

- [ ] **Step 1: Create the file with the full component**

  ```jsx
  /* Usage — per-provider token consumption with time-range filter and agent drill-down */

  const USAGE_RANGES = [
    { label: '1H',  hours: 1   },
    { label: '24H', hours: 24  },
    { label: '7D',  hours: 168 },
    { label: '30D', hours: 720 },
  ];

  const CLI_PROVIDERS = new Set(['codex', 'gemini']);

  function providerLabel(p) {
    const names = {
      voidai:      'VoidAI',
      anthropic:   'Anthropic API',
      'claude-cli':'Claude CLI',
      codex:       'Codex CLI',
      gemini:      'Gemini CLI',
      openrouter:  'OpenRouter',
      ollama:      'Ollama',
    };
    return names[p] || p.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
  }

  function providerColor(p) {
    const colors = {
      voidai:      'var(--neon)',
      anthropic:   'var(--neon-2)',
      'claude-cli':'#7dd3fc',
      codex:       'var(--violet)',
      gemini:      '#4ade80',
      openrouter:  '#fb923c',
      ollama:      '#a78bfa',
    };
    return colors[p] || 'var(--muted)';
  }

  function fmtTokens(n, provider) {
    const prefix = CLI_PROVIDERS.has(provider) ? '~' : '';
    if (n >= 1_000_000) return prefix + (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return prefix + (n / 1_000).toFixed(1) + 'K';
    return prefix + String(n);
  }

  function fmtCost(usd, provider) {
    if (CLI_PROVIDERS.has(provider)) return '—';
    return '$' + (usd || 0).toFixed(4);
  }

  const Usage = () => {
    const [range, setRange]     = React.useState(24);
    const [data,  setData]      = React.useState(null);
    const [loading, setLoading] = React.useState(false);
    const [expanded, setExpanded] = React.useState(new Set());

    React.useEffect(() => {
      setLoading(true);
      window.NC_API.get(`/api/analytics/usage?hours=${range}`)
        .then(d => { setData(d); setExpanded(new Set()); })
        .catch(() => setData(null))
        .finally(() => setLoading(false));
    }, [range]);

    const byProvider = data?.byProvider ?? [];
    const byProviderAgent = data?.byProviderAgent ?? [];

    const totalTokens = byProvider.reduce((s, r) => s + r.total_tokens, 0);
    const totalCalls  = byProvider.reduce((s, r) => s + r.call_count,   0);
    const totalCost   = byProvider
      .filter(r => !CLI_PROVIDERS.has(r.provider))
      .reduce((s, r) => s + r.est_cost_usd, 0);
    const topProvider = byProvider[0] ? providerLabel(byProvider[0].provider) : '—';

    function toggleExpand(provider) {
      setExpanded(prev => {
        const next = new Set(prev);
        next.has(provider) ? next.delete(provider) : next.add(provider);
        return next;
      });
    }

    function agentsFor(provider) {
      return byProviderAgent.filter(r => r.provider === provider);
    }

    return (
      <div>
        <PageHeader
          title="Usage"
          subtitle="// provider · tokens · cost"
          right={
            <div style={{ display: 'flex', gap: 4 }}>
              {USAGE_RANGES.map(r => (
                <button
                  key={r.hours}
                  className={`nc-btn${range === r.hours ? ' active' : ''}`}
                  style={{ minWidth: 40, opacity: range === r.hours ? 1 : 0.55 }}
                  onClick={() => setRange(r.hours)}
                >{r.label}</button>
              ))}
              {loading && <span className="mono muted" style={{ fontSize: 10, alignSelf: 'center', marginLeft: 6 }}>loading…</span>}
            </div>
          }
        />

        {/* Summary stat cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
          <StatCard label="TOTAL TOKENS" value={fmtTokens(totalTokens, '')} sub={`${totalCalls} calls`} tone="cyan"/>
          <StatCard label="EST COST" value={'$' + totalCost.toFixed(4)} sub="API providers only" tone="cyan"/>
          <StatCard label="TOP PROVIDER" value={topProvider} sub={byProvider[0] ? fmtTokens(byProvider[0].total_tokens, byProvider[0].provider) + ' tokens' : '—'} tone="cyan"/>
          <StatCard label="PROVIDERS ACTIVE" value={byProvider.length} sub={`in last ${range >= 168 ? Math.round(range/24) + 'd' : range + 'h'}`} tone="cyan"/>
        </div>

        {/* Provider breakdown table */}
        <Section title="PROVIDER BREAKDOWN">
          {byProvider.length === 0 ? (
            <div className="mono muted" style={{ padding: '24px 0', textAlign: 'center', fontSize: 12 }}>
              No usage recorded in this period.
            </div>
          ) : (
            <div>
              {/* Header row */}
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.2fr 0.8fr 0.8fr 1.4fr', gap: 8, padding: '6px 8px', borderBottom: '1px solid var(--line-soft)' }} className="mono muted">
                <span style={{ fontSize: 10 }}>PROVIDER</span>
                <span style={{ fontSize: 10 }}>TOKENS</span>
                <span style={{ fontSize: 10 }}>CALLS</span>
                <span style={{ fontSize: 10 }}>EST COST</span>
                <span style={{ fontSize: 10 }}>SHARE</span>
              </div>

              {byProvider.map((row) => {
                const share  = totalTokens > 0 ? row.total_tokens / totalTokens : 0;
                const isOpen = expanded.has(row.provider);
                const agents = agentsFor(row.provider);
                const color  = providerColor(row.provider);

                return (
                  <div key={row.provider}>
                    {/* Provider row */}
                    <div
                      onClick={() => toggleExpand(row.provider)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '2fr 1.2fr 0.8fr 0.8fr 1.4fr',
                        gap: 8,
                        padding: '10px 8px',
                        borderBottom: '1px solid var(--line-soft)',
                        cursor: 'pointer',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,183,255,0.04)'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}
                    >
                      <span className="mono" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ opacity: 0.6, fontSize: 10 }}>{isOpen ? '▼' : '▶'}</span>
                        <span style={{ width: 8, height: 8, background: color, boxShadow: `0 0 5px ${color}`, display: 'inline-block' }}/>
                        {providerLabel(row.provider)}
                      </span>
                      <span className="mono neonc" style={{ fontSize: 12 }}>{fmtTokens(row.total_tokens, row.provider)}</span>
                      <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{row.call_count.toLocaleString()}</span>
                      <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{fmtCost(row.est_cost_usd, row.provider)}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div className="bar-track" style={{ flex: 1 }}>
                          <div className="bar-fill" style={{ width: `${share * 100}%`, background: color }}/>
                        </div>
                        <span className="mono" style={{ fontSize: 10, color: 'var(--muted)', minWidth: 32 }}>{(share * 100).toFixed(0)}%</span>
                      </div>
                    </div>

                    {/* Agent sub-rows */}
                    {isOpen && agents.length > 0 && (
                      <div style={{ background: 'rgba(0,0,0,0.2)', borderBottom: '1px solid var(--line-soft)' }}>
                        {agents.map((a) => (
                          <div
                            key={a.agent_id ?? 'unknown'}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: '2fr 1.2fr 0.8fr 0.8fr 1.4fr',
                              gap: 8,
                              padding: '7px 8px 7px 32px',
                              borderBottom: '1px solid rgba(255,255,255,0.03)',
                            }}
                          >
                            <span className="mono muted" style={{ fontSize: 11 }}>{a.agent_name}</span>
                            <span className="mono" style={{ fontSize: 11 }}>{fmtTokens(a.total_tokens, row.provider)}</span>
                            <span className="mono muted" style={{ fontSize: 11 }}>{a.call_count.toLocaleString()}</span>
                            <span className="mono muted" style={{ fontSize: 11 }}>—</span>
                            <span/>
                          </div>
                        ))}
                      </div>
                    )}
                    {isOpen && agents.length === 0 && (
                      <div style={{ padding: '8px 8px 8px 32px', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <span className="mono muted" style={{ fontSize: 11 }}>No agent breakdown available.</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      </div>
    );
  };

  window.Usage = Usage;
  ```

- [ ] **Step 2: Verify the file was created**

  ```bash
  ls -la /home/neuroclaw-v1/src/dashboard/v2/src/page-usage.jsx
  ```
  Expected: file exists, non-zero size.

- [ ] **Step 3: Commit**

  ```bash
  git add src/dashboard/v2/src/page-usage.jsx
  git commit -m "feat(dashboard): add Usage page with provider breakdown and agent drill-down"
  ```

---

## Task 5: Wire up live-data.jsx and fix Analytics donut

**Files:**
- Modify: `src/dashboard/v2/src/live-data.jsx`

- [ ] **Step 1: Add providerUsage to the fetch call list**

  Find the `calls` array in `liveTick()` (around line 360). Add one entry:
  ```js
  ['providerUsage', '/api/analytics/usage?hours=1'],
  ```
  Place it with the other analytics calls, e.g. after the `heatmap` line.

- [ ] **Step 2: Store the raw usage data on NC_DATA**

  In the data-mapping block after the `calls` array is resolved (after `window.NC_DATA.LIVE_META = ...`), add:
  ```js
  if (r.providerUsage) {
    window.NC_DATA.USAGE = r.providerUsage;
  }
  ```
  Place this alongside similar blocks like `if (r.spend) { ... }`.

- [ ] **Step 3: Fix the providerSplit calculation**

  Find the existing `providerSplit` calculation inside `if (r.spend) { ... }` (around line 593):
  ```js
  const providerSplit = (r.spend.byTier || []).map(t => ({
    name: (t.tier || '').toUpperCase(),
    share: t.total_tokens / totalTokens,
    color: t.tier === 'high' ? 'var(--violet)' : t.tier === 'mid' ? 'var(--neon-2)' : 'var(--neon)',
  }));
  ```

  Replace it with:
  ```js
  const providerColors = {
    voidai:      'var(--neon)',
    anthropic:   'var(--neon-2)',
    'claude-cli':'#7dd3fc',
    codex:       'var(--violet)',
    gemini:      '#4ade80',
    openrouter:  '#fb923c',
    ollama:      '#a78bfa',
  };
  const providerNames = {
    voidai:      'VoidAI',
    anthropic:   'Anthropic API',
    'claude-cli':'Claude CLI',
    codex:       'Codex CLI',
    gemini:      'Gemini CLI',
    openrouter:  'OpenRouter',
    ollama:      'Ollama',
  };
  const puRows = r.providerUsage?.byProvider ?? [];
  const puTotal = puRows.reduce((s, p) => s + p.total_tokens, 1);
  const providerSplit = puRows.length > 0
    ? puRows.map(p => ({
        name:  providerNames[p.provider] || p.provider,
        share: p.total_tokens / puTotal,
        color: providerColors[p.provider] || 'var(--muted)',
      }))
    : (r.spend.byTier || []).map(t => ({
        name:  (t.tier || '').toUpperCase(),
        share: t.total_tokens / totalTokens,
        color: t.tier === 'high' ? 'var(--violet)' : t.tier === 'mid' ? 'var(--neon-2)' : 'var(--neon)',
      }));
  ```
  The fallback to `byTier` keeps the Analytics donut working even if the new endpoint is temporarily unavailable.

- [ ] **Step 4: Commit**

  ```bash
  git add src/dashboard/v2/src/live-data.jsx
  git commit -m "feat(live-data): add providerUsage to tick; fix Analytics provider donut"
  ```

---

## Task 6: Register Usage in nav, PAGES, and HTML

**Files:**
- Modify: `src/dashboard/v2/src/data.jsx`
- Modify: `src/dashboard/v2/src/app.jsx`
- Modify: `src/dashboard/v2/NeuroClaw.html`

- [ ] **Step 1: Add Usage to the NAV in data.jsx**

  Find the `OBSERVE` group (around line 28):
  ```js
  { group: 'OBSERVE', items: [
    { id: 'analytics',label: 'Analytics',  icon: 'analytics' },
    { id: 'health',   label: 'Health',     icon: 'shield' },
    { id: 'logs',     label: 'Logs',       icon: 'logs' },
    { id: 'approvals',label: 'Approvals',  icon: 'shield' },
    { id: 'settings', label: 'Settings',   icon: 'settings' },
    { id: 'docs',     label: 'Docs',       icon: 'docs' },
  ]},
  ```
  Add the Usage entry after Analytics:
  ```js
  { group: 'OBSERVE', items: [
    { id: 'analytics',label: 'Analytics',  icon: 'analytics' },
    { id: 'usage',    label: 'Usage',      icon: 'analytics' },
    { id: 'health',   label: 'Health',     icon: 'shield' },
    { id: 'logs',     label: 'Logs',       icon: 'logs' },
    { id: 'approvals',label: 'Approvals',  icon: 'shield' },
    { id: 'settings', label: 'Settings',   icon: 'settings' },
    { id: 'docs',     label: 'Docs',       icon: 'docs' },
  ]},
  ```

- [ ] **Step 2: Add Usage to PAGES in app.jsx**

  Find the `analytics` entry in the `PAGES` object (line 49):
  ```js
  analytics: { label: 'Analytics', cmp: () => typeof Analytics !== 'undefined' ? <Analytics/> : <div className="mono muted" style={{padding:32}}>Analytics module failed to load — refresh the page.</div> },
  ```
  Add the Usage entry on the next line:
  ```js
  usage: { label: 'Usage', cmp: () => typeof Usage !== 'undefined' ? <Usage/> : <div className="mono muted" style={{padding:32}}>Usage module failed to load.</div> },
  ```

- [ ] **Step 3: Add the script tag in NeuroClaw.html**

  Find the `page-analytics.jsx` script tag (line 1351):
  ```html
  <script type="text/babel" src="src/page-analytics.jsx"></script>
  ```
  Add immediately after it:
  ```html
  <script type="text/babel" src="src/page-usage.jsx"></script>
  ```

- [ ] **Step 4: Verify type-check still passes**

  ```bash
  cd /home/neuroclaw-v1 && npx tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 5: Commit**

  ```bash
  git add src/dashboard/v2/src/data.jsx src/dashboard/v2/src/app.jsx src/dashboard/v2/NeuroClaw.html
  git commit -m "feat(nav): register Usage page in nav, PAGES map, and HTML"
  ```

---

## Task 7: Manual end-to-end verification

- [ ] **Step 1: Start the dashboard**

  ```bash
  cd /home/neuroclaw-v1 && npm run dashboard
  ```

- [ ] **Step 2: Open the dashboard in a browser**

  Navigate to `http://localhost:3141/dashboard?token=<DASHBOARD_TOKEN>` (token from `.env`).

- [ ] **Step 3: Verify Usage appears in the OBSERVE nav group**

  Click "Usage" in the sidebar. The page should load with four stat cards and the provider breakdown table (or the empty-state message if `model_spend` has no rows).

- [ ] **Step 4: Verify time-range tabs work**

  Click 1H → 7D → 30D. Each click should trigger a loading indicator briefly, then re-render the table.

- [ ] **Step 5: Verify provider rows expand**

  If there are rows with data, click the `▶` on a provider row. It should expand to show agent sub-rows. Click again to collapse.

- [ ] **Step 6: Verify Analytics page provider donut uses real names**

  Navigate to Analytics. The "PROVIDER USAGE" donut should now show names like "VoidAI", "Claude CLI" etc. instead of "HIGH", "MID", "LOW".

- [ ] **Step 7: Verify the `~` prefix appears for CLI providers**

  If Codex CLI or Gemini CLI have any spend rows, their token counts in the Usage table should start with `~`. VoidAI and Anthropic API rows should show exact numbers without prefix.
