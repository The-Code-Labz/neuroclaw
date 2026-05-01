/* Hive Mind */
const HiveMind = () => {
  const { HIVE_EVENTS } = window.NC_DATA;
  const all = [...HIVE_EVENTS, ...HIVE_EVENTS.map(e => ({ ...e, t: e.t.replace('22:', '21:') }))];
  return (
    <div>
      <PageHeader title="Hive Mind" subtitle="// agent collective event stream · tactical command log" right={<>
        <button className="nc-btn"><Icon name="search" size={12}/> Filter</button>
        <button className="nc-btn"><Icon name="terminal" size={12}/> Compact</button>
        <button className="nc-btn primary"><Icon name="pause" size={12}/> Pause Stream</button>
      </>}/>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {['ALL','auto_route','spawn_success','memory_saved','tool_call','vault_sync','task_created','route_fallback','dream_cycle_complete'].map((f, i) => (
          <span key={f} className={`tag ${i === 0 ? 'blue' : ''}`} style={{ cursor: 'pointer' }}>{f}</span>
        ))}
      </div>

      <div className="nc-panel glow" style={{ padding: 0, position: 'relative', overflow: 'hidden' }}>
        <div className="scan-line"/>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between' }}>
          <div className="label-tiny neonc"><span className="dot cyan pulse" style={{ marginRight: 6 }}/>STREAM · TX</div>
          <div className="mono muted" style={{ fontSize: 10 }}>{all.length} events · 1h window</div>
        </div>
        <div style={{ maxHeight: 540, overflow: 'auto' }}>
          {all.map((e, i) => {
            const toneCls = e.tone === 'blue' ? 'blue' : e.tone === 'cyan' ? 'cyan' : e.tone === 'violet' ? 'violet' : e.tone === 'amber' ? 'amber' : e.tone === 'red' ? 'red' : 'green';
            return (
              <div key={i} className="mono" style={{ display: 'grid', gridTemplateColumns: '90px 22px 110px 160px 1fr 80px', gap: 12, padding: '8px 16px', borderBottom: '1px dashed rgba(0,183,255,0.06)', alignItems: 'center', fontSize: 11 }}>
                <span className="muted">{e.t}</span>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: e.tone === 'blue' ? 'var(--neon)' : e.tone === 'cyan' ? 'var(--neon-2)' : e.tone === 'violet' ? 'var(--violet)' : e.tone === 'amber' ? 'var(--amber)' : e.tone === 'red' ? 'var(--danger)' : 'var(--green)', boxShadow: `0 0 6px currentColor` }}/>
                <span style={{ color: 'var(--text)' }}>@{e.agent}</span>
                <span className={`tag ${toneCls}`} style={{ fontSize: 9, justifySelf: 'start' }}>{e.action}</span>
                <span style={{ color: 'var(--text-soft)' }}>{e.summary}</span>
                <span className="muted" style={{ textAlign: 'right' }}>↳ inspect</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
window.HiveMind = HiveMind;
