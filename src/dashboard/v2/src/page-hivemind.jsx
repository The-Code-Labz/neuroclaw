/* Hive Mind (live-wired) */
const HiveMind = () => {
  const { HIVE_EVENTS } = window.NC_DATA;
  const events = HIVE_EVENTS || [];
  const [filter, setFilter] = React.useState('ALL');
  const [search, setSearch] = React.useState('');
  const [paused, setPaused] = React.useState(false);

  // Build dynamic action list from real events.
  const actions = ['ALL', ...Array.from(new Set(events.map(e => e.action)))].slice(0, 16);

  const filtered = events
    .filter(e => filter === 'ALL' || e.action === filter)
    .filter(e => !search || (e.summary || '').toLowerCase().includes(search.toLowerCase()) || (e.agent || '').includes(search));

  return (
    <div>
      <PageHeader title="Hive Mind" subtitle="// agent collective event stream · tactical command log" right={<>
        <input className="nc-input" placeholder="search…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 200 }}/>
        <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>
        <button className="nc-btn primary" onClick={() => setPaused(p => !p)}><Icon name={paused ? 'bolt' : 'pause'} size={12}/> {paused ? 'Resume' : 'Pause'}</button>
      </>}/>

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
              <div key={i} className="mono" style={{ display: 'grid', gridTemplateColumns: '90px 22px 110px 200px 1fr', gap: 12, padding: '8px 16px', borderBottom: '1px dashed rgba(0,183,255,0.06)', alignItems: 'center', fontSize: 11 }}>
                <span className="muted">{e.t}</span>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: e.tone === 'blue' ? 'var(--neon)' : e.tone === 'cyan' ? 'var(--neon-2)' : e.tone === 'violet' ? 'var(--violet)' : e.tone === 'amber' ? 'var(--amber)' : e.tone === 'red' ? 'var(--danger)' : 'var(--green)', boxShadow: `0 0 6px currentColor` }}/>
                <span style={{ color: 'var(--text)' }}>@{e.agent}</span>
                <span className={`tag ${toneCls}`} style={{ fontSize: 9, justifySelf: 'start' }}>{e.action}</span>
                <span style={{ color: 'var(--text-soft)' }}>{e.summary}</span>
              </div>
            );
          })}
          {filtered.length === 0 && <div className="mono muted" style={{ padding: 30, textAlign: 'center' }}>// no events match</div>}
        </div>
      </div>
    </div>
  );
};
window.HiveMind = HiveMind;
