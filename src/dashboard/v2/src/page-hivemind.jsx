/* Actions that are pure infrastructure noise — not agent reasoning/decisions */
const HIVE_NOISE_ACTIONS = new Set([
  'agent_heartbeat',
  'mcp_probe_ok',
  'job_claimed',
  'job_done',
  'job_quota_requeued',
  'sessions_cleaned_up',
  'cleanup_force_deleted_unarchived',
  'sentinel_check_in',
  'tasks_archived',
  'subtask_overflow_sequential',
]);

/* Hive Mind (live-wired) */
const HiveMind = () => {
  const [tab, setTab] = React.useState('timeline');
  const [filter, setFilter] = React.useState('ALL');
  const [search, setSearch] = React.useState('');
  const [paused, setPaused] = React.useState(false);
  const [showNoise, setShowNoise] = React.useState(false);

  // Live re-render on hive ticks. NC_DATA.HIVE_EVENTS is already kept fresh by
  // NC_LIVE (/api/state/stream → _applySSEEvent → emitTick({keys:['hive']})).
  // The timeline previously destructured the array once at mount and never
  // re-rendered — that was the "out of sync / slow to update" bug. We just need
  // to repaint when a hive tick lands, honoring the Pause toggle.
  const [, force] = React.useReducer(x => x + 1, 0);
  const frozenRef = React.useRef(null);
  React.useEffect(() => {
    const onTick = (e) => {
      if (paused) return;
      const keys = e.detail && e.detail.keys;
      if (!keys || keys.includes('hive')) force();
    };
    window.addEventListener('nc-data-tick', onTick);
    return () => window.removeEventListener('nc-data-tick', onTick);
  }, [paused]);

  const liveEvents = window.NC_DATA.HIVE_EVENTS || [];
  // When paused, hold the last snapshot so the stream visibly freezes.
  if (!paused) frozenRef.current = liveEvents;
  const allEvents = paused ? (frozenRef.current || liveEvents) : liveEvents;

  const events = showNoise ? allEvents : allEvents.filter(e => !HIVE_NOISE_ACTIONS.has(e.action));

  const actions = ['ALL', ...Array.from(new Set(events.map(e => e.action)))].slice(0, 16);

  const filtered = events
    .filter(e => filter === 'ALL' || e.action === filter)
    .filter(e => !search || (e.summary || '').toLowerCase().includes(search.toLowerCase()) || (e.agent || '').includes(search));

  return (
    <div>
      <PageHeader title="Hive Mind" subtitle="// agent collective event stream · tactical command log" right={<>
        <input className="nc-input" placeholder="search…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 200 }}/>
        <button className={`nc-btn${showNoise ? ' primary' : ''}`} onClick={() => setShowNoise(n => !n)} title="Toggle heartbeats, probes, and other system events">
          {showNoise ? 'All Events' : 'Agent Only'}
        </button>
        <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>
        {tab === 'timeline' && <button className="nc-btn primary" onClick={() => setPaused(p => !p)}><Icon name={paused ? 'bolt' : 'pause'} size={12}/> {paused ? 'Resume' : 'Pause'}</button>}
      </>}/>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {['timeline','traces'].map(t => (
          <button key={t} className={`nc-btn${tab === t ? ' primary' : ''}`} onClick={() => setTab(t)} style={{ textTransform: 'uppercase', fontSize: 11 }}>{t}</button>
        ))}
      </div>

      {tab === 'timeline' && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {actions.map(f => (
              <span key={f} onClick={() => setFilter(f)} className={`tag ${filter === f ? 'blue' : ''}`} style={{ cursor: 'pointer' }}>{f}</span>
            ))}
          </div>
          <div className="nc-panel glow" style={{ padding: 0, position: 'relative', overflow: 'hidden' }}>
            <div className="scan-line"/>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between' }}>
              <div className="label-tiny neonc"><span className={`dot ${paused ? 'muted' : 'cyan pulse'}`} style={{ marginRight: 6 }}/>STREAM · {paused ? 'PAUSED' : 'TX'}</div>
              <div className="mono muted" style={{ fontSize: 10 }}>{filtered.length} of {events.length} events</div>
            </div>
            <div style={{ maxHeight: 540, overflow: 'auto' }}>
              {filtered.map((e, i) => {
                const toneCls = e.tone === 'blue' ? 'blue' : e.tone === 'cyan' ? 'cyan' : e.tone === 'violet' ? 'violet' : e.tone === 'amber' ? 'amber' : e.tone === 'red' ? 'red' : 'green';
                return (
                  <div key={i} className="mono" style={{ display: 'grid', gridTemplateColumns: '90px 22px 110px 200px 1fr', gap: 12, padding: '8px 16px', borderBottom: '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)', alignItems: 'center', fontSize: 11 }}>
                    <span className="muted">{e.t}</span>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: e.tone === 'blue' ? 'var(--accent)' : e.tone === 'cyan' ? 'var(--accent-2)' : e.tone === 'violet' ? 'var(--violet)' : e.tone === 'amber' ? 'var(--amber)' : e.tone === 'red' ? 'var(--danger)' : 'var(--green)', boxShadow: `0 0 6px currentColor` }}/>
                    <span style={{ color: 'var(--text)' }}>@{e.agent}</span>
                    <span className={`tag ${toneCls}`} style={{ fontSize: 9, justifySelf: 'start' }}>{e.action}</span>
                    <span style={{ color: 'var(--text-soft)' }}>{e.summary}</span>
                  </div>
                );
              })}
              {filtered.length === 0 && <div className="mono muted" style={{ padding: 30, textAlign: 'center' }}>// no events match</div>}
            </div>
          </div>
        </>
      )}

      {tab === 'traces' && <TracesPanel search={search}/>}
    </div>
  );
};
window.HiveMind = HiveMind;

/* Traces panel — fetches runs then lazy-loads events per run */
const TracesPanel = ({ search }) => {
  const [runs, setRuns] = React.useState(null);
  const [expanded, setExpanded] = React.useState({});
  const [events, setEvents] = React.useState({});

  const loadRuns = () => {
    window.NC_API.get('/api/runs?limit=30')
      .then(data => setRuns(Array.isArray(data) ? data : []))
      .catch(() => setRuns([]));
  };

  React.useEffect(() => { loadRuns(); }, []);

  React.useEffect(() => {
    let es;
    try {
      const tok = window.NC_API?.token;
      const sseUrl = tok ? `/api/hive/stream?token=${tok}` : '/api/hive/stream';
      es = new EventSource(sseUrl);
      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.type !== 'hive_event') return;
          const runId = ev.event?.run_id;
          if (!runId) return;
          loadRuns();
          setEvents(prev => {
            if (!prev[runId]) return prev;
            return { ...prev, [runId]: [...prev[runId], ev.event] };
          });
        } catch { /* ignore */ }
      };
      es.onerror = () => {};
    } catch { /* SSE not supported */ }
    return () => { if (es) es.close(); };
  }, []);

  const toggle = (runId) => {
    const opening = !expanded[runId];
    setExpanded(prev => ({ ...prev, [runId]: !prev[runId] }));
    if (opening && events[runId] === undefined) {
      window.NC_API.get(`/api/runs/${runId}`)
        .then(data => setEvents(p => ({ ...p, [runId]: data?.events ?? [] })))
        .catch(() => setEvents(p => ({ ...p, [runId]: [] })));
    }
  };

  if (runs === null) return <div className="mono muted" style={{ padding: 30 }}>// loading traces…</div>;
  if (runs.length === 0) return <div className="mono muted" style={{ padding: 30 }}>// no runs yet — trigger a chat that uses tools</div>;

  const filteredRuns = search
    ? runs.filter(r => (r.agent_name || '').toLowerCase().includes(search.toLowerCase()) || r.id.includes(search))
    : runs;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {filteredRuns.map(run => {
        const isOpen = !!expanded[run.id];
        const runEvents = events[run.id] || [];
        const parseTS = s => { if (!s) return NaN; const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z'; return new Date(iso).getTime(); };
        const durationMs = run.ended_at ? parseTS(run.ended_at) - parseTS(run.started_at) : null;

        return (
          <div key={run.id} className="nc-panel" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              onClick={() => toggle(run.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', background: isOpen ? 'color-mix(in srgb, var(--accent) 4%, transparent)' : 'transparent' }}
            >
              <span className="dot cyan pulse" style={{ flexShrink: 0 }}/>
              <span className="mono" style={{ fontWeight: 700, color: 'var(--accent-2)', fontSize: 12 }}>@{run.agent_name || 'unknown'}</span>
              <span className="mono muted" style={{ fontSize: 11 }}>{(() => { const iso = (run.started_at || '').includes('T') ? run.started_at : (run.started_at || '').replace(' ', 'T') + 'Z'; const d = new Date(iso); return isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit' }); })()}</span>
              {durationMs !== null && <span className="tag cyan" style={{ fontSize: 9 }}>{(durationMs / 1000).toFixed(1)}s</span>}
              <span className="tag" style={{ fontSize: 9 }}>{run.event_count ?? '?'} events</span>
              <span style={{ flex: 1 }}/>
              <span className="mono muted" style={{ fontSize: 10 }}>{isOpen ? '▲' : '▶'}</span>
            </div>

            {isOpen && (
              <div style={{ borderTop: '1px dashed color-mix(in srgb, var(--accent) 10%, transparent)', padding: '8px 0' }}>
                {events[run.id] === undefined && (
                  <div className="mono muted" style={{ padding: '10px 20px', fontSize: 11 }}>// loading events…</div>
                )}
                {events[run.id] !== undefined && runEvents.length === 0 && (
                  <div className="mono muted" style={{ padding: '10px 20px', fontSize: 11 }}>// no hive events for this run</div>
                )}
                {runEvents.map((ev, i) => <TraceEventRow key={i} ev={ev}/>)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/* Single event row inside a trace */
const TraceEventRow = ({ ev }) => {
  const [showFull, setShowFull] = React.useState(false);

  let meta = null;
  try { meta = ev.metadata ? JSON.parse(ev.metadata) : null; } catch { /* ignore */ }

  const cfg = ({
    agent_thought:     { glyph: '~',  color: 'var(--violet)',  label: 'THOUGHT' },
    tool_call:         { glyph: '⚙',  color: 'var(--amber)',   label: 'TOOL CALL' },
    tool_result:       { glyph: '✓',  color: 'var(--green)',   label: 'RESULT' },
    tool_error:        { glyph: '✗',  color: 'var(--danger)',  label: 'ERROR' },
    agent_response:    { glyph: '◀',  color: 'var(--accent)',    label: 'RESPONSE' },
    auto_route:        { glyph: '→',  color: 'var(--accent-2)',  label: 'ROUTE' },
    manual_delegation: { glyph: '→',  color: 'var(--accent-2)',  label: 'DELEGATE' },
    task_decomposed:   { glyph: '⊕',  color: 'var(--accent-2)',  label: 'DECOMPOSE' },
    task_decompose_collapsed: { glyph: '⊖', color: 'var(--accent-2)', label: 'COLLAPSE' },
    multi_agent_step:  { glyph: '⊕',  color: 'var(--accent-2)',  label: 'STEP' },
    result_merged:     { glyph: '⊕',  color: 'var(--accent-2)',  label: 'MERGE' },
  })[ev.action] || { glyph: '·', color: 'var(--muted)', label: ev.action };

  let primary = ev.summary || '';
  let expandable = null;

  if (ev.action === 'agent_thought' && meta?.text) {
    primary = meta.text.slice(0, 120);
    if (meta.text.length > 120) expandable = meta.text;
  } else if (ev.action === 'tool_call' && meta?.args) {
    primary = `${meta.tool}(${(meta.args || '').slice(0, 80)})`;
    if ((meta.args || '').length > 80) {
      try { expandable = JSON.stringify(JSON.parse(meta.args), null, 2); }
      catch { expandable = meta.args; }
    }
  } else if (ev.action === 'tool_result' && meta?.result) {
    primary = `${meta.tool} → ${meta.result.slice(0, 100)}`;
    if (meta.result.length > 100) expandable = meta.result;
  } else if (ev.action === 'agent_response' && meta?.text) {
    primary = meta.text.slice(0, 120);
    if (meta.text.length > 120) expandable = meta.text;
  }

  const _tsIso = (ev.created_at || '').includes('T') ? ev.created_at : (ev.created_at || '').replace(' ', 'T') + 'Z';
  const _tsDate = new Date(_tsIso);
  const ts = isNaN(_tsDate.getTime()) ? '—' : _tsDate.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit' });

  return (
    <div style={{ padding: '5px 20px', borderBottom: '1px dashed color-mix(in srgb, var(--accent) 4%, transparent)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span className="mono muted" style={{ fontSize: 10, flexShrink: 0, paddingTop: 1 }}>{ts}</span>
        <span style={{ color: cfg.color, fontWeight: 700, fontSize: 13, flexShrink: 0, width: 14, textAlign: 'center' }}>{cfg.glyph}</span>
        <span className="mono" style={{ fontSize: 9, color: cfg.color, flexShrink: 0, paddingTop: 2, minWidth: 70 }}>{cfg.label}</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', flex: 1, wordBreak: 'break-word' }}>{primary}</span>
        {expandable && (
          <span
            onClick={() => setShowFull(s => !s)}
            className="mono"
            style={{ fontSize: 9, color: 'var(--accent)', cursor: 'pointer', flexShrink: 0, paddingTop: 2 }}
          >{showFull ? 'collapse' : 'expand'}</span>
        )}
      </div>
      {showFull && expandable && (
        <pre style={{ margin: '6px 0 2px 54px', padding: '8px 10px', background: 'rgba(0,0,0,0.4)', borderRadius: 4, fontSize: 10, color: 'var(--text-soft)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 300, overflow: 'auto' }}>{expandable}</pre>
      )}
    </div>
  );
};
