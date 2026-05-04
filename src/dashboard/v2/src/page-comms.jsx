/* Comms (live-wired) */
const Comms = () => {
  const { COMMS } = window.NC_DATA;
  const list = COMMS || [];
  const [search, setSearch] = React.useState('');
  const filtered = list.filter(c => !search || ((c.from + ' ' + c.to + ' ' + c.msg) || '').toLowerCase().includes(search.toLowerCase()));
  return (
    <div>
      <PageHeader title="Comms" subtitle="// agent-to-agent relay · directives · acknowledgments" right={<>
        <input className="nc-input" placeholder="filter…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 200 }}/>
        <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>
      </>}/>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12 }}>
        <Section title="RELAY LOG" padded={false}>
          <div className="mono" style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr 90px 80px', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line-soft)', fontSize: 10, color: 'var(--muted)', letterSpacing: '0.14em' }}>
            <span>TIME</span><span>FROM → TO</span><span>MESSAGE / RESPONSE</span><span>TASK</span><span>STATUS</span>
          </div>
          {filtered.length === 0 && <div className="mono muted" style={{ padding: 30, textAlign: 'center' }}>// no agent-to-agent messages yet</div>}
          {filtered.map((c, i) => (
            <div key={i} className="mono" style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr 90px 80px', gap: 10, padding: '12px 16px', borderBottom: '1px dashed rgba(0,183,255,0.06)', fontSize: 11, alignItems: 'center' }}>
              <span className="muted">{c.t}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="neonc">@{c.from}</span>
                <Icon name="arrow-right" size={10} className="muted"/>
                <span className="neon2">@{c.to}</span>
              </span>
              <div>
                <div style={{ color: 'var(--text)' }}>"{c.msg}"</div>
                <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>↳ "{c.resp}"</div>
              </div>
              <span style={{ color: 'var(--text-soft)' }}>{c.task}</span>
              <span className={`tag ${c.status === 'streaming' ? 'cyan' : c.status === 'closed' ? 'muted' : 'blue'}`} style={{ fontSize: 9 }}>{c.status}</span>
            </div>
          ))}
        </Section>

        <Section title="RELAY GRAPH">
          <div style={{ position: 'relative', height: 400, border: '1px solid var(--line-soft)', borderRadius: 2 }} className="grid-bg">
            <svg viewBox="0 0 400 400" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
              <defs>
                <marker id="arr2" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill="#00f5d4"/>
                </marker>
              </defs>
              <line x1="200" y1="200" x2="100" y2="100" stroke="#00b7ff" strokeWidth="1.4" markerEnd="url(#arr2)"/>
              <line x1="200" y1="200" x2="320" y2="120" stroke="#00b7ff" strokeWidth="1.4" markerEnd="url(#arr2)"/>
              <line x1="200" y1="200" x2="320" y2="300" stroke="#00b7ff" strokeWidth="1.4" markerEnd="url(#arr2)"/>
              <line x1="200" y1="200" x2="80" y2="320" stroke="#00b7ff" strokeWidth="1.4" markerEnd="url(#arr2)"/>
              <line x1="100" y1="100" x2="320" y2="120" stroke="rgba(0,245,212,0.3)" strokeDasharray="3 3" strokeWidth="1"/>
            </svg>
            {[
              { x: 200, y: 200, n: 'Alfred' },
              { x: 100, y: 100, n: 'Researcher' },
              { x: 320, y: 120, n: 'Coder' },
              { x: 320, y: 300, n: 'Archivist' },
              { x: 80, y: 320, n: 'Planner' },
            ].map((n, i) => (
              <div key={i} style={{ position: 'absolute', left: `${(n.x/400)*100}%`, top: `${(n.y/400)*100}%`, transform: 'translate(-50%, -50%)', textAlign: 'center' }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'radial-gradient(circle, var(--neon), rgba(0,0,0,0))', border: '1px solid var(--neon)', boxShadow: '0 0 10px rgba(0,183,255,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontWeight: 700, color: '#fff' }}>{n.n[0]}</div>
                <div className="mono" style={{ fontSize: 9, marginTop: 4, color: 'var(--text-soft)' }}>{n.n}</div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
};
window.Comms = Comms;
