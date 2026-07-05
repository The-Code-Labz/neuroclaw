# Dream Cycle Journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Live + Journal sub-tabs to the Dream Cycle dashboard page, powered by hive_mind polling and a new /api/dream/history endpoint.

**Architecture:** A new `GET /api/dream/history` route reads `dream_cycle_complete` hive events and returns structured `DreamCycleEntry` objects. `live-data.jsx` adds `dreamHistory` to its fetch bundle and maps live dream state from hive events. `page-dream.jsx` is fully rewritten with the existing pipeline/stats layout intact at top and two sub-tabs below: **LIVE** (last cycle steps + extractions + tomorrow plan) and **JOURNAL** (master-detail history browser).

**Tech Stack:** TypeScript (Hono routes, Better-SQLite3), React (JSX, useState/useEffect), NeuroClaw design system (CSS vars, nc-panel, nc-btn, Icon, PageHeader, Section, StatCard)

---

## File Map

| File | Change |
|------|--------|
| `src/dashboard/routes.ts` | Add `GET /api/dream/history` after line 1227 |
| `src/dashboard/v2/src/data.jsx` | Extend DREAM mock at line 183 with `running`, `events`, `history` fields |
| `src/dashboard/v2/src/live-data.jsx` | Add `dreamHistory` to calls array (line ~350); add DREAM mapping block after hive section |
| `src/dashboard/v2/src/page-dream.jsx` | Full rewrite |

---

## Task 1: Add GET /api/dream/history route

**Files:**
- Modify: `src/dashboard/routes.ts` — insert after line 1227 (after the `/api/dream/status` handler closing brace)

- [ ] **Step 1: Insert the route**

Open `src/dashboard/routes.ts`. Find this exact closing brace (end of `/api/dream/status`):

```typescript
    });
  });

  // ── Sentinel ─────────────────────────────────────────────────────────────
```

Replace it with:

```typescript
    });
  });

  app.get('/api/dream/history', (c) => {
    const db = getDb();
    const completes = db.prepare(`
      SELECT id, metadata, created_at FROM hive_mind
      WHERE action = 'dream_cycle_complete'
      ORDER BY created_at DESC
      LIMIT 100
    `).all() as { id: string; metadata: string | null; created_at: string }[];

    const total = completes.length;
    const entries = completes.map((row, i) => {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(row.metadata ?? '{}'); } catch { /* ignore bad JSON */ }
      return {
        id:          row.id,
        number:      total - i,
        startedAt:   (meta.startedAt  as string)  ?? row.created_at,
        completedAt: (meta.completedAt as string)  ?? row.created_at,
        durationMs:  (meta.durationMs  as number)  ?? 0,
        status:      (meta.ok as boolean) === false ? 'failed' : 'complete',
        scope:       (meta.scope       as Record<string, number>) ?? {},
        output:      (meta.output      as Record<string, number>) ?? {},
        vaultPaths:  (meta.vaultPaths  as { procedures: string[]; insights: string[]; log: string | null; plan: string | null }) ?? { procedures: [], insights: [], log: null, plan: null },
        errors:      (meta.errors      as string[]) ?? [],
      };
    });

    return c.json({ history: entries });
  });

  // ── Sentinel ─────────────────────────────────────────────────────────────
```

- [ ] **Step 2: Type-check**

```bash
cd /home/neuroclaw-v1 && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors (or only pre-existing errors unrelated to this change).

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/routes.ts
git commit -m "feat: add GET /api/dream/history endpoint"
```

---

## Task 2: Update data.jsx DREAM mock

**Files:**
- Modify: `src/dashboard/v2/src/data.jsx` — lines 183–188

- [ ] **Step 1: Extend the DREAM mock**

Find and replace in `src/dashboard/v2/src/data.jsx`:

```javascript
const DREAM = {
  enabled: true,
  next: '03:00 — in 4h 46m',
  last: { processed: 38, extracted: 12, promoted: 4, insights: 2, plan: true },
  pipeline: ['Raw Chats','Wash','Extract','Categorize','Store','Insight','Tomorrow Plan'],
};
```

Replace with:

```javascript
const DREAM = {
  enabled: true,
  next: '03:00 — in 4h 46m',
  last: { processed: 38, extracted: 12, promoted: 4, insights: 2, plan: true },
  pipeline: ['Raw Chats','Wash','Extract','Categorize','Store','Insight','Tomorrow Plan'],
  running: false,
  events: [],
  history: [],
};
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/v2/src/data.jsx
git commit -m "feat: extend DREAM mock with running/events/history fields"
```

---

## Task 3: Wire live-data.jsx

**Files:**
- Modify: `src/dashboard/v2/src/live-data.jsx`
  - Add `dreamHistory` fetch to calls array (~line 350)
  - Add DREAM mapping block after hive section (~line 411)

- [ ] **Step 1: Add dreamHistory to the calls array**

Find in `src/dashboard/v2/src/live-data.jsx`:

```javascript
    ['skills',     '/api/skills?full=1'],
    ['analystAlerts', '/api/analyst/alerts?limit=20'],
  ];
```

Replace with:

```javascript
    ['skills',       '/api/skills?full=1'],
    ['analystAlerts','/api/analyst/alerts?limit=20'],
    ['dreamHistory', '/api/dream/history'],
  ];
```

- [ ] **Step 2: Add DREAM mapping block**

Find in `src/dashboard/v2/src/live-data.jsx`:

```javascript
  // ── MEMORIES (memory_index, the v1.4+ long-term store) ──
  if (Array.isArray(r.memory)) {
    window.NC_DATA.MEMORIES = r.memory.map(mapMemory);
  }

  // ── HIVE EVENTS ──
  if (Array.isArray(r.hive)) {
    window.NC_DATA.HIVE_EVENTS = r.hive.map(mapHiveEvent);
  }
```

Replace with:

```javascript
  // ── MEMORIES (memory_index, the v1.4+ long-term store) ──
  if (Array.isArray(r.memory)) {
    window.NC_DATA.MEMORIES = r.memory.map(mapMemory);
  }

  // ── HIVE EVENTS ──
  if (Array.isArray(r.hive)) {
    window.NC_DATA.HIVE_EVENTS = r.hive.map(mapHiveEvent);
  }

  // ── DREAM (live run state from hive + history from dreamHistory) ──
  if (Array.isArray(r.hive)) {
    const dreamEvts  = r.hive.filter(e => e.action && e.action.startsWith('dream_'));
    const lastStart  = dreamEvts.find(e => e.action === 'dream_cycle_start');
    const lastDone   = dreamEvts.find(e => e.action === 'dream_cycle_complete' || e.action === 'dream_cycle_failed');
    const isRunning  = !!lastStart && (
      !lastDone ||
      new Date(lastStart.created_at).getTime() > new Date(lastDone.created_at).getTime()
    );
    window.NC_DATA.DREAM = { ...window.NC_DATA.DREAM, running: isRunning, events: dreamEvts };
  }
  if (r.dreamHistory && Array.isArray(r.dreamHistory.history)) {
    const h = r.dreamHistory.history;
    window.NC_DATA.DREAM = {
      ...window.NC_DATA.DREAM,
      history: h,
      last: h.length > 0 ? {
        processed: h[0].scope?.sessionsAnalyzed  ?? window.NC_DATA.DREAM?.last?.processed ?? 0,
        extracted: (h[0].output?.proceduresCreated ?? 0) + (h[0].output?.insightsCreated ?? 0),
        promoted:  h[0].output?.memoriesPromoted   ?? window.NC_DATA.DREAM?.last?.promoted ?? 0,
        insights:  h[0].output?.insightsCreated    ?? window.NC_DATA.DREAM?.last?.insights ?? 0,
        plan:      (h[0].output?.plansCreated ?? 0) > 0,
      } : window.NC_DATA.DREAM?.last,
    };
  }
```

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/v2/src/live-data.jsx
git commit -m "feat: wire DREAM live state and history into live-data refresh"
```

---

## Task 4: Rewrite page-dream.jsx

**Files:**
- Modify: `src/dashboard/v2/src/page-dream.jsx` — full rewrite

- [ ] **Step 1: Write the full component**

Replace the entire contents of `src/dashboard/v2/src/page-dream.jsx` with:

```jsx
/* Dream Cycle page — v2 with Live + Journal sub-tabs */

// ── Helpers ───────────────────────────────────────────────────────────────────

function toLocalTime(isoOrSqlite) {
  if (!isoOrSqlite) return '—';
  const s = isoOrSqlite.includes('T') ? isoOrSqlite : isoOrSqlite.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: true, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Maps hive events (since last dream_cycle_start) to per-step state.
// Returns object keyed by stepKey → 'done' | 'active' | 'idle'
function computeStepStates(running, events) {
  if (!running) return { gather: 'done', analyze: 'done', vault: 'done', transform: 'done', prune: 'done', plan: 'done' };
  const has = (action) => events.some(e => e.action === action);
  const order = ['gather', 'analyze', 'vault', 'transform', 'prune', 'plan'];
  const done = {
    gather:    has('memories_created') || has('memories_promoted') || has('memories_pruned') || has('plan_created') || has('dream_cycle_complete'),
    analyze:   has('memories_created') || has('memories_promoted') || has('memories_pruned') || has('plan_created') || has('dream_cycle_complete'),
    vault:     has('memories_promoted') || has('memories_pruned') || has('plan_created') || has('dream_cycle_complete'),
    transform: has('memories_pruned') || has('plan_created') || has('dream_cycle_complete'),
    prune:     has('plan_created') || has('dream_cycle_complete'),
    plan:      has('dream_cycle_complete'),
  };
  const firstUndone = order.find(k => !done[k]);
  return Object.fromEntries(order.map(k => [k, done[k] ? 'done' : k === firstUndone ? 'active' : 'idle']));
}

const STEP_DEFS = [
  { key: 'gather',    num: '①', label: 'gather sessions' },
  { key: 'analyze',   num: '②', label: 'per-session analysis' },
  { key: 'vault',     num: '③', label: 'vault writes' },
  { key: 'transform', num: '④', label: 'transform memories' },
  { key: 'prune',     num: '⑤', label: 'prune stale' },
  { key: 'plan',      num: '⑥', label: 'next-day plan' },
];

function getStepMeta(stepKey, lastEntry) {
  if (!lastEntry) return '—';
  const o = lastEntry.output ?? {};
  const s = lastEntry.scope  ?? {};
  switch (stepKey) {
    case 'gather':    return `${s.sessionsAnalyzed ?? 0} sessions · ${s.messagesScanned ?? 0} msgs`;
    case 'analyze':   return `${o.decisionsExtracted ?? 0} decisions · ${o.patternsDetected ?? 0} patterns`;
    case 'vault':     return `${o.proceduresCreated ?? 0} procedures · ${o.insightsCreated ?? 0} insights`;
    case 'transform': return `${o.memoriesPromoted ?? 0} promoted · ${o.memoriesMerged ?? 0} merged`;
    case 'prune':     return `${o.memoriesPruned ?? 0} removed`;
    case 'plan':      return (o.plansCreated ?? 0) > 0 ? `${o.plansCreated} created · ready ✓` : '—';
    default:          return '—';
  }
}

// ── LiveTab ───────────────────────────────────────────────────────────────────

const LiveTab = ({ running, events, lastEntry }) => {
  const stepStates = computeStepStates(running, events);
  const vp = lastEntry?.vaultPaths ?? {};
  const procedureCount = (vp.procedures ?? []).length;
  const insightCount   = (vp.insights ?? []).length;

  const stepColor = (state) =>
    state === 'done'   ? 'var(--green)'  :
    state === 'active' ? 'var(--neon)'   : 'var(--muted)';

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        {running ? (
          <>
            <span className="dot green pulse" style={{ width: 7, height: 7 }}/>
            <span className="mono" style={{ fontSize: 11, color: '#fff' }}>RUNNING</span>
            <span className="mono muted" style={{ fontSize: 10 }}>· started {toLocalTime(events.find(e => e.action === 'dream_cycle_start')?.created_at)}</span>
            <span className="tag" style={{ fontSize: 8, background: 'rgba(16,185,129,0.1)', borderColor: 'rgba(16,185,129,0.3)', color: 'var(--green)' }}>live</span>
          </>
        ) : lastEntry ? (
          <>
            <span className="dot" style={{ width: 7, height: 7, background: 'var(--muted)' }}/>
            <span className="mono" style={{ fontSize: 11, color: '#fff' }}>LAST RUN</span>
            <span className="mono muted" style={{ fontSize: 10 }}>· {toLocalTime(lastEntry.completedAt)} · {fmtDuration(lastEntry.durationMs)}</span>
            <span className="tag" style={{ fontSize: 8 }}>complete ✓</span>
          </>
        ) : (
          <span className="mono muted" style={{ fontSize: 11 }}>// no cycles recorded yet</span>
        )}
      </div>

      {/* Step list */}
      <div className="nc-panel" style={{ padding: 0, marginBottom: 14, overflow: 'hidden' }}>
        {STEP_DEFS.map((step, i) => {
          const state = stepStates[step.key] ?? (lastEntry ? 'done' : 'idle');
          const meta  = getStepMeta(step.key, lastEntry);
          return (
            <div key={step.key} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 14px',
              borderBottom: i < STEP_DEFS.length - 1 ? '1px solid var(--line)' : 'none',
            }}>
              {/* Status icon */}
              <div style={{
                width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, fontWeight: 700,
                background: state === 'done'   ? 'rgba(16,185,129,0.12)'  :
                            state === 'active' ? 'rgba(0,183,255,0.12)'   : 'rgba(100,116,139,0.08)',
                border: `1px solid ${state === 'done' ? 'rgba(16,185,129,0.4)' : state === 'active' ? 'rgba(0,183,255,0.5)' : 'rgba(100,116,139,0.2)'}`,
                color: stepColor(state),
                animation: state === 'active' ? 'pulse-opacity 1.5s infinite' : 'none',
              }}>
                {state === 'done' ? '✓' : state === 'active' ? '…' : '·'}
              </div>

              {/* Step label */}
              <span className="mono" style={{ flex: 1, fontSize: 11, color: stepColor(state) }}>
                {step.num} {step.label}
              </span>

              {/* Result meta */}
              <span className="mono" style={{ fontSize: 10, color: state === 'idle' ? 'var(--muted)' : 'var(--neon-2)', textAlign: 'right', minWidth: 160 }}>
                {state === 'idle' ? '—' : meta}
              </span>
            </div>
          );
        })}
      </div>

      {/* Extracted this cycle */}
      {lastEntry && (procedureCount > 0 || insightCount > 0) && (
        <div style={{ marginBottom: 14 }}>
          <div className="label-tiny" style={{ marginBottom: 8 }}>EXTRACTED THIS CYCLE</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
            {(vp.procedures ?? []).map((p, i) => (
              <div key={i} className="nc-panel" style={{ padding: '7px 10px' }}>
                <div className="mono" style={{ fontSize: 7, color: 'var(--neon)', letterSpacing: '.1em', marginBottom: 3 }}>PROCEDURAL</div>
                <div className="mono" style={{ fontSize: 10, color: '#fff' }}>{p.split('/').pop()?.replace(/_/g, ' ') ?? p}</div>
              </div>
            ))}
            {(vp.insights ?? []).map((ins, i) => (
              <div key={i} className="nc-panel" style={{ padding: '7px 10px' }}>
                <div className="mono" style={{ fontSize: 7, color: 'var(--neon-2)', letterSpacing: '.1em', marginBottom: 3 }}>INSIGHT</div>
                <div className="mono" style={{ fontSize: 10, color: '#fff' }}>{ins.split('/').pop()?.replace(/_/g, ' ') ?? ins}</div>
              </div>
            ))}
            {vp.log && (
              <div className="nc-panel" style={{ padding: '7px 10px' }}>
                <div className="mono" style={{ fontSize: 7, color: 'var(--muted)', letterSpacing: '.1em', marginBottom: 3 }}>DAILY LOG</div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>{vp.log.split('/').pop()}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tomorrow plan */}
      {lastEntry?.vaultPaths?.plan && (
        <div style={{ border: '1px solid rgba(139,92,246,0.3)', borderRadius: 3, padding: '10px 14px', background: 'rgba(139,92,246,0.04)' }}>
          <div className="label-tiny" style={{ color: 'var(--violet)', marginBottom: 6 }}>TOMORROW · NEXT-DAY PLAN</div>
          <div className="mono muted" style={{ fontSize: 10 }}>{lastEntry.vaultPaths.plan.split('/').pop()?.replace(/_/g, ' ') ?? lastEntry.vaultPaths.plan}</div>
        </div>
      )}

      {!lastEntry && !running && (
        <div className="mono muted" style={{ fontSize: 11, padding: '24px 0', textAlign: 'center' }}>
          // no dream cycles recorded yet — run one to populate this view
        </div>
      )}
    </div>
  );
};

// ── JournalTab ────────────────────────────────────────────────────────────────

const JournalEntry = ({ entry }) => {
  if (!entry) return (
    <div className="mono muted" style={{ fontSize: 11, padding: '32px 0', textAlign: 'center' }}>
      // select a run from the list
    </div>
  );
  const o = entry.output ?? {};
  const s = entry.scope  ?? {};
  const vp = entry.vaultPaths ?? {};
  const stats = [
    { label: 'SESSIONS',  val: s.sessionsAnalyzed ?? 0 },
    { label: 'EXTRACTED', val: (o.proceduresCreated ?? 0) + (o.insightsCreated ?? 0) },
    { label: 'PROMOTED',  val: o.memoriesPromoted ?? 0 },
    { label: 'WRITTEN',   val: (o.proceduresCreated ?? 0) + (o.insightsCreated ?? 0) + (o.plansCreated ?? 0) },
  ];
  const steps = [
    { name: 'gather',    val: `${s.sessionsAnalyzed ?? 0} sessions · ${s.messagesScanned ?? 0} msgs` },
    { name: 'analyze',   val: `${o.decisionsExtracted ?? 0} decisions · ${o.patternsDetected ?? 0} patterns` },
    { name: 'vault',     val: `${o.proceduresCreated ?? 0} procedures · ${o.insightsCreated ?? 0} insights` },
    { name: 'transform', val: `${o.memoriesPromoted ?? 0} promoted · ${o.memoriesMerged ?? 0} merged` },
    { name: 'prune',     val: `${o.memoriesPruned ?? 0} removed` },
    { name: 'plan',      val: (o.plansCreated ?? 0) > 0 ? `${o.plansCreated} created` : '—' },
  ];
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Dream #{entry.number}</div>
        <div className="mono muted" style={{ fontSize: 10, display: 'flex', gap: 12 }}>
          <span>{toLocalTime(entry.completedAt)}</span>
          <span>{fmtDuration(entry.durationMs)}</span>
          <span style={{ color: entry.status === 'failed' ? 'var(--danger)' : 'var(--green)' }}>{entry.status}</span>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 12 }}>
        {stats.map(({ label, val }) => (
          <div key={label} className="nc-panel" style={{ padding: '6px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--neon)' }}>{val}</div>
            <div className="label-tiny" style={{ fontSize: 7 }}>{label}</div>
          </div>
        ))}
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '0 0 10px' }}/>

      {/* Step breakdown */}
      <div style={{ marginBottom: 12 }}>
        {steps.map(({ name, val }) => (
          <div key={name} className="mono" style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--line)', fontSize: 10 }}>
            <span style={{ color: 'var(--text)' }}>{name}</span>
            <span style={{ color: 'var(--neon-2)' }}>{val}</span>
          </div>
        ))}
      </div>

      {/* Vault paths */}
      {((vp.procedures?.length ?? 0) + (vp.insights?.length ?? 0) > 0) && (
        <div style={{ marginBottom: 12 }}>
          <div className="label-tiny" style={{ marginBottom: 6 }}>VAULT WRITES</div>
          {[...(vp.procedures ?? []), ...(vp.insights ?? [])].map((p, i) => (
            <div key={i} className="mono muted" style={{ fontSize: 9, padding: '2px 0' }}>· {p.split('/').pop()}</div>
          ))}
        </div>
      )}

      {/* Plan */}
      {vp.plan && (
        <div style={{ border: '1px solid rgba(139,92,246,0.25)', borderRadius: 2, padding: '8px 10px', background: 'rgba(139,92,246,0.04)' }}>
          <div className="label-tiny" style={{ color: 'var(--violet)', marginBottom: 4 }}>NEXT-DAY PLAN</div>
          <div className="mono" style={{ fontSize: 9, color: 'var(--text)' }}>{vp.plan.split('/').pop()}</div>
        </div>
      )}

      {/* Errors */}
      {entry.errors?.length > 0 && (
        <div style={{ marginTop: 10, padding: '8px 10px', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 2, background: 'rgba(239,68,68,0.04)' }}>
          <div className="label-tiny" style={{ color: 'var(--danger)', marginBottom: 4 }}>ERRORS</div>
          {entry.errors.map((e, i) => <div key={i} className="mono" style={{ fontSize: 9, color: 'var(--danger)' }}>· {e}</div>)}
        </div>
      )}
    </div>
  );
};

const JournalTab = ({ history, activeEntry, setActiveEntry }) => {
  if (!history.length) return (
    <div className="mono muted" style={{ fontSize: 11, padding: '32px 0', textAlign: 'center' }}>
      // no dream cycles recorded yet
    </div>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 14 }}>
      {/* List */}
      <div>
        {history.map(entry => {
          const isActive = activeEntry?.id === entry.id;
          return (
            <div
              key={entry.id}
              onClick={() => setActiveEntry(entry)}
              style={{
                padding: '9px 10px', borderRadius: 2, cursor: 'pointer', marginBottom: 3,
                border: `1px solid ${isActive ? 'var(--line-hard)' : 'transparent'}`,
                background: isActive ? 'rgba(0,183,255,0.08)' : 'transparent',
              }}
            >
              <div className="mono muted" style={{ fontSize: 8, marginBottom: 2 }}>{toLocalTime(entry.completedAt)}</div>
              <div className="mono" style={{ fontSize: 10, color: '#fff', marginBottom: 4 }}>Dream #{entry.number}</div>
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                <span className="tag" style={{ fontSize: 7 }}>{(entry.output?.proceduresCreated ?? 0) + (entry.output?.insightsCreated ?? 0)} mem</span>
                <span className="tag" style={{ fontSize: 7 }}>{fmtDuration(entry.durationMs)}</span>
                {entry.status === 'failed' && <span className="tag red" style={{ fontSize: 7 }}>failed</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail pane */}
      <div className="nc-panel glow" style={{ padding: 14, alignSelf: 'start' }}>
        <JournalEntry entry={activeEntry} />
      </div>
    </div>
  );
};

// ── Main Dream component ───────────────────────────────────────────────────────

const Dream = () => {
  const [activeTab, setActiveTab]       = React.useState('live');
  const [activeEntry, setActiveEntry]   = React.useState(null);

  const { DREAM } = window.NC_DATA;
  const history   = Array.isArray(DREAM?.history) ? DREAM.history : [];
  const running   = DREAM?.running ?? false;
  const events    = Array.isArray(DREAM?.events)  ? DREAM.events  : [];
  const pipeline  = DREAM?.pipeline ?? ['Raw Chats','Wash','Extract','Categorize','Store','Insight','Tomorrow Plan'];
  const lastEntry = history[0] ?? null;

  React.useEffect(() => {
    if (!activeEntry && history.length > 0) setActiveEntry(history[0]);
  }, [history.length]);

  const handleRunNow = async () => {
    try {
      await window.NC_API.post('/api/dream/run', undefined, 300000);
      await window.NC_LIVE.refresh();
    } catch (e) {
      alert('Dream cycle error: ' + e.message);
    }
  };

  // Pipeline node state: 'done' when cycle idle (last run complete), else from step states
  const stepStates = computeStepStates(running, events);
  const pipelineNodeState = (idx) => {
    if (!running && lastEntry) return 'done';
    if (!running) return 'idle';
    const keys = ['gather','analyze','vault','transform','prune','plan'];
    return stepStates[keys[idx % keys.length]] ?? 'idle';
  };

  const tabStyle = (id) => ({
    padding: '9px 16px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.1em',
    color: activeTab === id ? 'var(--neon)' : 'var(--muted)',
    borderBottom: activeTab === id ? '2px solid var(--neon)' : '2px solid transparent',
    background: 'transparent', border: 'none', cursor: 'pointer',
    display: 'flex', alignItems: 'center', gap: 6,
  });

  return (
    <div>
      <PageHeader
        title="Dream Cycle"
        subtitle="// nightly memory wash · insight extraction · plan generation"
        right={<>
          {running
            ? <span className="tag green"><span className="dot green pulse"/>running</span>
            : <span className="tag green"><span className="dot green pulse"/>enabled</span>
          }
          <span className="tag blue">next · {DREAM?.next ?? '—'}</span>
          <button className="nc-btn primary" onClick={handleRunNow} disabled={running}>
            <Icon name="play" size={12}/> Run Now
          </button>
        </>}
      />

      {/* Stat cards — unchanged */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 16 }}>
        {[
          ['SESSIONS PROCESSED', DREAM?.last?.processed ?? 0,   'last cycle'],
          ['MEMORIES EXTRACTED', DREAM?.last?.extracted ?? 0,   ''],
          ['PROMOTED',           DREAM?.last?.promoted  ?? 0,   ''],
          ['INSIGHTS GENERATED', DREAM?.last?.insights  ?? 0,   ''],
          ['NEXT-DAY PLAN',      DREAM?.last?.plan ? 'READY' : '—', ''],
        ].map(([l, v, sub], i) => <StatCard key={i} label={l} value={v} sub={sub} tone="cyan"/>)}
      </div>

      {/* Pipeline visualization — unchanged */}
      <Section title="WASH PIPELINE">
        <div style={{ position: 'relative', padding: '20px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ position: 'absolute', left: '6%', right: '6%', top: '50%', height: 2, background: 'linear-gradient(90deg, rgba(0,183,255,0.2), var(--neon), var(--neon-2), var(--violet), rgba(139,92,246,0.4))', boxShadow: '0 0 10px rgba(0,183,255,0.4)' }}/>
          {pipeline.map((s, i) => {
            const nodeState = pipelineNodeState(i);
            return (
              <div key={i} style={{ position: 'relative', textAlign: 'center', flex: 1 }}>
                <div style={{
                  width: 50, height: 50, borderRadius: '50%', margin: '0 auto',
                  border: `1.5px solid ${nodeState === 'done' ? 'var(--green)' : nodeState === 'active' ? 'var(--neon)' : 'var(--line-hard)'}`,
                  boxShadow: nodeState === 'done' ? '0 0 14px rgba(16,185,129,0.35)' : nodeState === 'active' ? '0 0 18px var(--neon)' : '0 0 8px rgba(0,183,255,0.3)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--mono)', fontWeight: 700,
                  color: nodeState === 'done' ? 'var(--green)' : nodeState === 'active' ? 'var(--neon)' : '#fff',
                  fontSize: 12, background: '#020617', position: 'relative', zIndex: 1,
                  animation: nodeState === 'active' ? 'pulse-opacity 1.5s infinite' : 'none',
                }}>{i + 1}</div>
                <div className="mono" style={{ fontSize: 10, marginTop: 8, color: nodeState === 'done' ? 'var(--green)' : nodeState === 'active' ? 'var(--neon)' : 'var(--text-soft)', letterSpacing: '0.06em' }}>
                  {s.toUpperCase()}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--line-hard)', marginBottom: 0 }}>
        <button style={tabStyle('live')} onClick={() => setActiveTab('live')}>
          LIVE
          {running && <span className="dot green pulse" style={{ width: 5, height: 5 }}/>}
        </button>
        <button style={tabStyle('journal')} onClick={() => setActiveTab('journal')}>
          JOURNAL
          {history.length > 0 && <span className="tag" style={{ fontSize: 8 }}>{history.length}</span>}
        </button>
      </div>

      <div style={{ padding: '16px 0' }}>
        {activeTab === 'live'
          ? <LiveTab running={running} events={events} lastEntry={lastEntry} />
          : <JournalTab history={history} activeEntry={activeEntry} setActiveEntry={setActiveEntry} />
        }
      </div>
    </div>
  );
};

window.Dream = Dream;
```

- [ ] **Step 2: Type-check the TypeScript side (routes only)**

```bash
cd /home/neuroclaw-v1 && npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/v2/src/page-dream.jsx
git commit -m "feat: rewrite Dream Cycle page with Live + Journal sub-tabs"
```

---

## Task 5: Build and verify

**Files:** none (read-only verification)

- [ ] **Step 1: Build the TypeScript**

```bash
cd /home/neuroclaw-v1 && npm run build 2>&1 | tail -20
```

Expected: exits 0, no TypeScript errors in src/dashboard/routes.ts.

- [ ] **Step 2: Start the dashboard**

```bash
cd /home/neuroclaw-v1 && npm run dashboard
```

Expected: `Dashboard server started on port 3141`.

- [ ] **Step 3: Open the Dream Cycle page**

Navigate to `http://localhost:3141/dashboard-v2` (use the DASHBOARD_TOKEN from .env as `?token=…`). Click **Dream Cycle** in the sidebar.

Verify:
- PageHeader, 5 stat cards, and pipeline visualization render without errors
- Two sub-tabs "LIVE" and "JOURNAL" appear below the pipeline
- LIVE tab shows last-run steps or "no cycles recorded yet" if the DB is empty
- JOURNAL tab shows the run list (or empty message if no runs)

- [ ] **Step 4: Test the history endpoint directly**

```bash
TOKEN=$(grep DASHBOARD_TOKEN /home/neuroclaw-v1/.env | cut -d= -f2)
curl -s "http://localhost:3141/api/dream/history?token=$TOKEN" | python3 -m json.tool | head -40
```

Expected: `{ "history": [ ... ] }` — either an array of past runs or an empty array.

- [ ] **Step 5: Trigger a test run**

In the dashboard, click **Run Now**. Verify:
- The pipeline nodes animate (active step pulses)
- The LIVE tab shows steps filling in progressively
- After completion, JOURNAL tab gains a new entry at the top

- [ ] **Step 6: Final commit**

```bash
git add -A
git status  # confirm only expected files are staged
git commit -m "feat: dream cycle journal — live streaming + history browser

Adds Live + Journal sub-tabs to Dream Cycle page. Live tab streams
hive_mind events during a cycle run and shows last cycle output at idle.
Journal tab provides a master-detail browser of all past cycle runs.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage check:**
- ✅ `GET /api/dream/history` endpoint → Task 1
- ✅ live-data.jsx DREAM live state (running detection, events) → Task 3 step 2
- ✅ live-data.jsx DREAM history fetch → Task 3 step 1 + step 2
- ✅ data.jsx mock extended → Task 2
- ✅ LIVE tab: coarse step updates, idle shows last run → Task 4 (LiveTab)
- ✅ JOURNAL tab: list + master-detail → Task 4 (JournalTab + JournalEntry)
- ✅ Pipeline nodes reflect run state → Task 4 (Dream main component, pipelineNodeState)
- ✅ Run Now still works → Task 4 (handleRunNow)
- ✅ No changes to dream-cycle.ts → confirmed (not in file map)
- ✅ Vault + memory persistence unchanged → confirmed

**Placeholder scan:** No TBDs, no "implement later", all steps have code.

**Type consistency:** `DreamCycleEntry.output` keys (`proceduresCreated`, `insightsCreated`, `memoriesPromoted`, `memoriesMerged`, `memoriesPruned`, `plansCreated`, `decisionsExtracted`, `patternsDetected`) match `DreamCycleResult.output` in `src/memory/dream-cycle.ts`. `scope` keys (`sessionsAnalyzed`, `messagesScanned`) match. Verified against source.
