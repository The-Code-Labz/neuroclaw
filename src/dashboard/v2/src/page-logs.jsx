/* Logs */
const Logs = () => {
  const { LOGS } = window.NC_DATA;
  const [lvl, setLvl] = React.useState('ALL');
  const list = lvl === 'ALL' ? LOGS : LOGS.filter(l => l.lvl === lvl);
  const colorOf = lv => lv === 'ERROR' ? 'var(--danger)' : lv === 'WARN' ? 'var(--amber)' : lv === 'AUDIT' ? 'var(--violet)' : 'var(--neon-2)';
  return (
    <div>
      <PageHeader title="Logs" subtitle="// audit · exec · mcp · provider · memory" right={<>
        <input className="nc-input" placeholder="grep..." style={{ width: 200 }}/>
        <button className="nc-btn"><Icon name="refresh" size={12}/> Tail</button>
        <button className="nc-btn primary"><Icon name="terminal" size={12}/> Open Console</button>
      </>}/>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {['ALL','INFO','WARN','ERROR','AUDIT'].map(l => (
          <span key={l} onClick={() => setLvl(l)} className={`tag ${lvl === l ? 'blue' : ''}`} style={{ cursor: 'pointer' }}>{l}</span>
        ))}
        <span style={{ flex: 1 }}/>
        <span className="tag muted">stream · 32k lines/min</span>
      </div>

      <div className="nc-panel glow" style={{ padding: 0, position: 'relative', overflow: 'hidden' }}>
        <div className="scan-line"/>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between' }}>
          <div className="mono neonc" style={{ fontSize: 11 }}>$ tail -f /var/log/neuroclaw/*.log</div>
          <div className="mono muted" style={{ fontSize: 10 }}>{list.length} lines · live</div>
        </div>
        <div style={{ background: 'rgba(0,4,12,0.7)', padding: '10px 14px', maxHeight: 540, overflow: 'auto' }}>
          {list.map((l, i) => (
            <div key={i} className="mono" style={{ display: 'grid', gridTemplateColumns: '120px 60px 80px 1fr', gap: 12, padding: '4px 0', fontSize: 11, lineHeight: 1.5, borderBottom: '1px dashed rgba(0,183,255,0.04)' }}>
              <span className="muted">{l.t}</span>
              <span style={{ color: colorOf(l.lvl), fontWeight: 700 }}>{l.lvl}</span>
              <span className="neonc">[{l.src}]</span>
              <span style={{ color: 'var(--text-soft)' }}>{l.msg}</span>
            </div>
          ))}
          <div className="mono neonc" style={{ paddingTop: 6, fontSize: 11 }}>$ <span className="blink">▌</span></div>
        </div>
      </div>
    </div>
  );
};
window.Logs = Logs;
