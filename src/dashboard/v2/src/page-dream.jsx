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

// Maps hive events since last dream_cycle_start to per-step state.
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
  { key: 'vault',     num: '③', label: 'memory writes' },
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

  const stepColor = (state) =>
    state === 'done'   ? 'var(--green)'  :
    state === 'active' ? 'var(--accent)'   : 'var(--muted)';

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        {running ? (
          <>
            <span className="dot green pulse" style={{ width: 7, height: 7 }}/>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text)' }}>RUNNING</span>
            <span className="mono muted" style={{ fontSize: 10 }}>· started {toLocalTime(events.find(e => e.action === 'dream_cycle_start')?.created_at)}</span>
            <span className="tag" style={{ fontSize: 8, background: 'rgba(16,185,129,0.1)', borderColor: 'rgba(16,185,129,0.3)', color: 'var(--green)' }}>live</span>
          </>
        ) : lastEntry ? (
          <>
            <span className="dot" style={{ width: 7, height: 7, background: 'var(--muted)' }}/>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text)' }}>LAST RUN</span>
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
              <div style={{
                width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, fontWeight: 700,
                background: state === 'done'   ? 'rgba(16,185,129,0.12)'  :
                            state === 'active' ? 'color-mix(in srgb, var(--accent) 12%, transparent)'   : 'rgba(100,116,139,0.08)',
                border: `1px solid ${state === 'done' ? 'rgba(16,185,129,0.4)' : state === 'active' ? 'color-mix(in srgb, var(--accent) 50%, transparent)' : 'rgba(100,116,139,0.2)'}`,
                color: stepColor(state),
              }}>
                {state === 'done' ? '✓' : state === 'active' ? '…' : '·'}
              </div>
              <span className="mono" style={{ flex: 1, fontSize: 11, color: stepColor(state) }}>
                {step.num} {step.label}
              </span>
              <span className="mono" style={{ fontSize: 10, color: state === 'idle' ? 'var(--muted)' : 'var(--accent-2)', textAlign: 'right', minWidth: 160 }}>
                {state === 'idle' ? '—' : meta}
              </span>
            </div>
          );
        })}
      </div>

      {/* Extracted this cycle */}
      {lastEntry && ((vp.procedures ?? []).length > 0 || (vp.insights ?? []).length > 0) && (
        <div style={{ marginBottom: 14 }}>
          <div className="label-tiny" style={{ marginBottom: 8 }}>EXTRACTED THIS CYCLE</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
            {(vp.procedures ?? []).map((p, i) => (
              <div key={i} className="nc-panel" style={{ padding: '7px 10px' }}>
                <div className="mono" style={{ fontSize: 7, color: 'var(--accent)', letterSpacing: '.1em', marginBottom: 3 }}>PROCEDURAL</div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--text)' }}>{p.split('/').pop()?.replace(/_/g, ' ') ?? p}</div>
              </div>
            ))}
            {(vp.insights ?? []).map((ins, i) => (
              <div key={i} className="nc-panel" style={{ padding: '7px 10px' }}>
                <div className="mono" style={{ fontSize: 7, color: 'var(--accent-2)', letterSpacing: '.1em', marginBottom: 3 }}>INSIGHT</div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--text)' }}>{ins.split('/').pop()?.replace(/_/g, ' ') ?? ins}</div>
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

function buildDailyLog(s, o) {
  return [
    `Sessions analyzed: ${s.sessionsAnalyzed ?? 0}`,
    `Messages scanned: ${s.messagesScanned ?? 0}`,
    `Memories scanned: ${s.memoriesScanned ?? 0}`,
    `Tasks scanned: ${s.tasksScanned ?? 0}`,
    `Comms scanned: ${s.commsScanned ?? 0}`,
    '',
    `Decisions extracted: ${o.decisionsExtracted ?? 0}`,
    `Patterns detected: ${o.patternsDetected ?? 0}`,
    `Procedures created: ${o.proceduresCreated ?? 0}`,
    `Insights created: ${o.insightsCreated ?? 0}`,
    `Memories promoted (episodic→semantic/procedural): ${o.memoriesPromoted ?? 0}`,
    `Memories merged (semantic dedupe): ${o.memoriesMerged ?? 0}`,
    `Memories pruned: ${o.memoriesPruned ?? 0}`,
    `Plans created: ${o.plansCreated ?? 0}`,
  ].join('\n');
}

const JournalEntry = ({ entry }) => {
  const [logOpen,  setLogOpen]  = React.useState(false);
  const [planOpen, setPlanOpen] = React.useState(false);

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
        <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Dream #{entry.number}</div>
        <div className="mono muted" style={{ fontSize: 10, display: 'flex', gap: 12 }}>
          <span>{toLocalTime(entry.completedAt)}</span>
          <span>{fmtDuration(entry.durationMs)}</span>
          <span style={{ color: entry.status === 'failed' ? 'var(--danger)' : entry.status === 'partial' ? 'var(--amber)' : 'var(--green)' }}>{entry.status}</span>
        </div>
      </div>
      <div className="stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 12 }}>
        {stats.map(({ label, val }) => (
          <div key={label} className="nc-panel" style={{ padding: '6px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>{val}</div>
            <div className="label-tiny" style={{ fontSize: 7 }}>{label}</div>
          </div>
        ))}
      </div>
      <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '0 0 10px' }}/>
      <div style={{ marginBottom: 12 }}>
        {steps.map(({ name, val }) => (
          <div key={name} className="mono" style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--line)', fontSize: 10 }}>
            <span style={{ color: 'var(--text)' }}>{name}</span>
            <span style={{ color: 'var(--accent-2)' }}>{val}</span>
          </div>
        ))}
      </div>
      {/* Daily Log — inline readable content */}
      <div style={{ marginBottom: 12 }}>
        <button
          onClick={() => setLogOpen(v => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', width: '100%' }}
        >
          <div className="label-tiny" style={{ color: 'var(--muted)' }}>DAILY LOG</div>
          <span className="mono" style={{ fontSize: 8, color: 'var(--muted)', marginLeft: 'auto' }}>{logOpen ? '▲ hide' : '▼ read'}</span>
        </button>
        {logOpen && (
          <pre style={{ margin: '6px 0 0', padding: '10px 12px', background: 'rgba(0,0,0,0.3)', borderRadius: 2, border: '1px solid var(--line)', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.7 }}>
            {buildDailyLog(s, o)}
          </pre>
        )}
      </div>

      {((vp.procedures?.length ?? 0) + (vp.insights?.length ?? 0) > 0) && (
        <div style={{ marginBottom: 12 }}>
          <div className="label-tiny" style={{ marginBottom: 6 }}>MEMORY WRITES</div>
          {[...(vp.procedures ?? []), ...(vp.insights ?? [])].map((p, i) => (
            <div key={i} className="mono muted" style={{ fontSize: 9, padding: '2px 0' }}>· {p.split('/').pop()}</div>
          ))}
        </div>
      )}

      {vp.plan && (
        <div style={{ border: '1px solid rgba(139,92,246,0.25)', borderRadius: 2, padding: '8px 10px', background: 'rgba(139,92,246,0.04)' }}>
          <button
            onClick={() => setPlanOpen(v => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: 0, width: '100%' }}
          >
            <div className="label-tiny" style={{ color: 'var(--violet)' }}>NEXT-DAY PLAN</div>
            <span className="mono" style={{ fontSize: 8, color: 'var(--muted)', marginLeft: 'auto' }}>{planOpen ? '▲ hide' : '▼ read'}</span>
          </button>
          <div className="mono" style={{ fontSize: 9, color: 'var(--text)', marginTop: 4 }}>{vp.plan.split('/').pop()}</div>
          {planOpen && entry.planNote?.summary && (
            <pre style={{ margin: '8px 0 0', padding: '10px 12px', background: 'rgba(0,0,0,0.3)', borderRadius: 2, border: '1px solid rgba(139,92,246,0.2)', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.7 }}>
              {entry.planNote.summary}
            </pre>
          )}
          {planOpen && !entry.planNote?.summary && (
            <div className="mono muted" style={{ fontSize: 9, marginTop: 8 }}>// plan content stored in long-term memory</div>
          )}
        </div>
      )}
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
    <div className="split-grid" style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 14 }}>
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
                background: isActive ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
              }}
            >
              <div className="mono muted" style={{ fontSize: 8, marginBottom: 2 }}>{toLocalTime(entry.completedAt)}</div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--text)', marginBottom: 4 }}>Dream #{entry.number}</div>
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                <span className="tag" style={{ fontSize: 7 }}>{(entry.output?.proceduresCreated ?? 0) + (entry.output?.insightsCreated ?? 0)} mem</span>
                <span className="tag" style={{ fontSize: 7 }}>{fmtDuration(entry.durationMs)}</span>
                {entry.status === 'failed' && <span className="tag red" style={{ fontSize: 7 }}>failed</span>}
                {entry.status === 'partial' && <span className="tag amber" style={{ fontSize: 7 }}>partial</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mem-panel" style={{ alignSelf: 'start' }}>
        <JournalEntry entry={activeEntry} />
      </div>
    </div>
  );
};

// ── Main Dream component ───────────────────────────────────────────────────────

const Dream = () => {
  const [activeTab, setActiveTab]     = React.useState('live');
  const [activeEntry, setActiveEntry] = React.useState(null);

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

  const stepStates = computeStepStates(running, events);
  const pipelineNodeState = (idx) => {
    if (!running && lastEntry) return 'done';
    if (!running) return 'idle';
    const keys = ['gather','analyze','vault','transform','prune','plan'];
    return stepStates[keys[Math.min(idx, keys.length - 1)]] ?? 'idle';
  };

  const tabStyle = (id) => ({
    padding: '9px 16px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.1em',
    color: activeTab === id ? 'var(--accent)' : 'var(--muted)',
    borderBottom: activeTab === id ? '2px solid var(--accent)' : '2px solid transparent',
    background: 'transparent', border: 'none',
    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
  });

  return (
    <div>
      <PageHeader
        title="Dream Cycle"
        subtitle="// nightly memory wash · insight extraction · plan generation"
        right={<>
          {running
            ? <span className="tag green"><span className="dot green pulse"/>running</span>
            : <span className="tag green"><span className="dot" style={{ width: 6, height: 6, background: 'var(--green)' }}/>enabled</span>
          }
          <span className="tag blue">next · {DREAM?.next ?? '—'}</span>
          <button className="nc-btn primary" onClick={handleRunNow} disabled={running}>
            <Icon name="play" size={12}/> Run Now
          </button>
        </>}
      />

      <div className="stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 16 }}>
        {[
          ['SESSIONS PROCESSED', DREAM?.last?.processed ?? 0,   'last cycle'],
          ['MEMORIES EXTRACTED', DREAM?.last?.extracted ?? 0,   ''],
          ['PROMOTED',           DREAM?.last?.promoted  ?? 0,   ''],
          ['INSIGHTS GENERATED', DREAM?.last?.insights  ?? 0,   ''],
          ['NEXT-DAY PLAN',      DREAM?.last?.plan ? 'READY' : '—', ''],
        ].map(([l, v, sub], i) => <StatCard key={i} label={l} value={v} sub={sub} tone="cyan"/>)}
      </div>

      <Section title="WASH PIPELINE">
        <div style={{ position: 'relative', padding: '20px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ position: 'absolute', left: '6%', right: '6%', top: '50%', height: 2, background: 'linear-gradient(90deg, color-mix(in srgb, var(--accent) 20%, transparent), var(--accent), var(--accent-2), var(--violet), rgba(139,92,246,0.4))', boxShadow: '0 0 10px color-mix(in srgb, var(--accent) 40%, transparent)' }}/>
          {pipeline.map((s, i) => {
            const nodeState = pipelineNodeState(i);
            return (
              <div key={i} style={{ position: 'relative', textAlign: 'center', flex: 1 }}>
                <div style={{
                  width: 50, height: 50, borderRadius: '50%', margin: '0 auto',
                  border: `1.5px solid ${nodeState === 'done' ? 'var(--green)' : nodeState === 'active' ? 'var(--accent)' : 'var(--line-hard)'}`,
                  boxShadow: nodeState === 'done' ? '0 0 14px rgba(16,185,129,0.35)' : nodeState === 'active' ? '0 0 18px var(--accent)' : '0 0 8px color-mix(in srgb, var(--accent) 30%, transparent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--mono)', fontWeight: 700,
                  color: nodeState === 'done' ? 'var(--green)' : nodeState === 'active' ? 'var(--accent)' : 'var(--text)',
                  fontSize: 12, background: 'var(--panel)', position: 'relative', zIndex: 1,
                }}>{i + 1}</div>
                <div className="mono" style={{ fontSize: 10, marginTop: 8, color: nodeState === 'done' ? 'var(--green)' : nodeState === 'active' ? 'var(--accent)' : 'var(--text-soft)', letterSpacing: '0.06em' }}>
                  {s.toUpperCase()}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

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
