/* Sessions page */
const Sessions = () => {
  const { SESSIONS, AGENTS } = window.NC_DATA;
  return (
    <div>
      <PageHeader
        title="Sessions"
        subtitle="// chat threads · checkpoints · session keys"
        right={<>
          <button className="nc-btn"><Icon name="search" size={12}/> Search</button>
          <button className="nc-btn primary"><Icon name="plus" size={12}/> New Session</button>
        </>}
      />
      <Section title="ACTIVE & RECENT" padded={false}>
        <div style={{ padding: '0 0 4px' }}>
          <div className="mono" style={{ display: 'grid', gridTemplateColumns: '60px 2fr 1.4fr 90px 110px 110px 140px', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line-soft)', fontSize: 10, color: 'var(--muted)', letterSpacing: '0.14em' }}>
            <span>STATUS</span><span>TITLE</span><span>AGENTS</span><span>MSGS</span><span>CREATED</span><span>LAST</span><span>ACTIONS</span>
          </div>
          {SESSIONS.map(s => (
            <div key={s.id} className="mono" style={{ display: 'grid', gridTemplateColumns: '60px 2fr 1.4fr 90px 110px 110px 140px', gap: 10, padding: '12px 16px', borderBottom: '1px dashed rgba(0,183,255,0.06)', fontSize: 12, alignItems: 'center' }}>
              <span><span className={`dot ${s.active ? 'cyan pulse' : 'muted'}`}/></span>
              <span style={{ color: '#fff' }}>{s.title}</span>
              <span style={{ display: 'flex', gap: -4 }}>
                {s.agents.map((id, i) => {
                  const a = AGENTS.find(ag => ag.id === id);
                  return <span key={id} title={a?.name} style={{ width: 22, height: 22, borderRadius: '50%', background: 'rgba(0,183,255,0.18)', border: '1px solid var(--line-hard)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, marginLeft: i > 0 ? -6 : 0, color: '#fff' }}>{a?.name[0] || '?'}</span>;
                })}
              </span>
              <span className="neonc">{s.msgs}</span>
              <span className="muted">{s.id}</span>
              <span style={{ color: 'var(--text-soft)' }}>{s.last}</span>
              <span style={{ display: 'flex', gap: 4 }}>
                <button className="nc-btn ghost" style={{ fontSize: 9, padding: '3px 6px' }}>open</button>
                <button className="nc-btn ghost" style={{ fontSize: 9, padding: '3px 6px' }}>rename</button>
                <button className="nc-btn ghost danger" style={{ fontSize: 9, padding: '3px 6px' }}>del</button>
              </span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
};
window.Sessions = Sessions;
