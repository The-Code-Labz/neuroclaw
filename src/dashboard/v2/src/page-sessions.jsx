/* Sessions page (live-wired) */
const Sessions = () => {
  const { SESSIONS, AGENTS } = window.NC_DATA;
  const [filter, setFilter] = React.useState('');

  const onRename = async (s) => {
    const next = prompt('Rename session', s.title);
    if (!next || next === s.title) return;
    try {
      await fetch('/api/sessions/' + s.id, { method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: next }) });
      await window.NC_LIVE.refresh();
    } catch (e) { alert('Failed: ' + e.message); }
  };
  const onDelete = async (s) => {
    if (!confirm(`Delete session "${s.title}" and all its messages?`)) return;
    try {
      await fetch('/api/sessions/' + s.id, { method: 'DELETE', credentials: 'same-origin' });
      await window.NC_LIVE.refresh();
    } catch (e) { alert('Failed: ' + e.message); }
  };

  const filtered = (SESSIONS || []).filter(s => !filter || (s.title || '').toLowerCase().includes(filter.toLowerCase()) || s.id.includes(filter));

  return (
    <div>
      <PageHeader
        title="Sessions"
        subtitle="// chat threads · checkpoints · session keys"
        right={<>
          <input className="nc-input" placeholder="filter…" value={filter} onChange={e => setFilter(e.target.value)} style={{ maxWidth: 200 }}/>
          <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>
        </>}
      />
      <Section title={`ACTIVE & RECENT · ${filtered.length}`} padded={false}>
        <div style={{ padding: '0 0 4px' }}>
          <div className="mono" style={{ display: 'grid', gridTemplateColumns: '60px 2fr 1.4fr 90px 200px 110px 160px', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line-soft)', fontSize: 10, color: 'var(--muted)', letterSpacing: '0.14em' }}>
            <span>STATUS</span><span>TITLE</span><span>AGENTS</span><span>MSGS</span><span>ID</span><span>LAST</span><span>ACTIONS</span>
          </div>
          {filtered.map(s => (
            <div key={s.id} className="mono" style={{ display: 'grid', gridTemplateColumns: '60px 2fr 1.4fr 90px 200px 110px 160px', gap: 10, padding: '12px 16px', borderBottom: '1px dashed rgba(0,183,255,0.06)', fontSize: 12, alignItems: 'center' }}>
              <span><span className={`dot ${s.active ? 'cyan pulse' : 'muted'}`}/></span>
              <span style={{ color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
              <span style={{ display: 'flex' }}>
                {(s.agents || []).map((id, i) => {
                  const a = AGENTS.find(ag => (ag._raw?.id || ag.id) === id);
                  return <span key={id+i} title={a?.name} style={{ width: 22, height: 22, borderRadius: '50%', background: 'rgba(0,183,255,0.18)', border: '1px solid var(--line-hard)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, marginLeft: i > 0 ? -6 : 0, color: '#fff' }}>{a?.name[0] || '?'}</span>;
                })}
                {(!s.agents || s.agents.length === 0) && <span className="muted">—</span>}
              </span>
              <span className="neonc">{s.msgs}</span>
              <span className="muted" style={{ fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.id}</span>
              <span style={{ color: 'var(--text-soft)' }}>{s.last}</span>
              <span style={{ display: 'flex', gap: 4 }}>
                <button className="nc-btn ghost" style={{ fontSize: 9, padding: '3px 6px' }} onClick={() => { window.dispatchEvent(new CustomEvent('nc-goto', { detail: { page: 'chat', sessionId: s.id } })); }}>open</button>
                <button className="nc-btn ghost" style={{ fontSize: 9, padding: '3px 6px' }} onClick={() => onRename(s)}>rename</button>
                <button className="nc-btn ghost" style={{ fontSize: 9, padding: '3px 6px', color: 'var(--danger)' }} onClick={() => onDelete(s)}>del</button>
              </span>
            </div>
          ))}
          {filtered.length === 0 && <div className="mono muted" style={{ padding: 30, textAlign: 'center' }}>// no sessions match</div>}
        </div>
      </Section>
    </div>
  );
};
window.Sessions = Sessions;
