/* Memory page (live-wired) */
const Memory = () => {
  const { MEMORIES } = window.NC_DATA;
  const [filter, setFilter] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [activeRaw, setActive] = React.useState(null);
  const empty = !MEMORIES || MEMORIES.length === 0;
  React.useEffect(() => {
    if (!empty && !activeRaw) setActive(MEMORIES[0]);
  }, [empty, MEMORIES]);
  if (empty) {
    return (
      <div>
        <PageHeader title="Memory" subtitle="// neural archive · salience · promotion" right={<>
          <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>
        </>}/>
        <div className="nc-panel glow" style={{ padding: 30, textAlign: 'center' }}>
          <div className="mono muted">// no memories yet — they appear automatically after assistant turns</div>
        </div>
      </div>
    );
  }
  const active = activeRaw || MEMORIES[0];
  const types = ['all','working','episodic','semantic','procedural','preference','insight','session_summary','project'];
  const list = (MEMORIES || [])
    .filter(m => filter === 'all' || m.type === filter)
    .filter(m => !search || (m.title + ' ' + m.summary).toLowerCase().includes(search.toLowerCase()));

  const onDelete = async (m) => {
    if (!confirm(`Delete memory "${m.title}"? (Vault note is not removed.)`)) return;
    try {
      await fetch('/api/memory/index/' + (m._raw?.id || m.id), { method: 'DELETE', credentials: 'same-origin' });
      await window.NC_LIVE.refresh();
      if (activeRaw && (activeRaw._raw?.id || activeRaw.id) === (m._raw?.id || m.id)) setActive(null);
    } catch (e) { alert('Failed: ' + e.message); }
  };

  return (
    <div>
      <PageHeader title="Memory" subtitle="// neural archive · salience · promotion" right={<>
        <input className="nc-input" placeholder="search…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 200 }}/>
        <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>
      </>}/>

      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr 320px', gap: 12 }}>
        {/* Type filters */}
        <div className="nc-panel glow" style={{ padding: 12 }}>
          <div className="label-tiny neonc" style={{ marginBottom: 10 }}>TYPES</div>
          {types.map(t => (
            <div key={t} onClick={() => setFilter(t)} style={{ padding: '7px 10px', borderRadius: 2, cursor: 'pointer', background: filter === t ? 'rgba(0,183,255,0.12)' : 'transparent', border: filter === t ? '1px solid var(--line-hard)' : '1px solid transparent', marginBottom: 3, fontFamily: 'var(--mono)', fontSize: 11, color: filter === t ? '#fff' : 'var(--text-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{t}</span>
              <span className="mono muted" style={{ fontSize: 9 }}>{t === 'all' ? MEMORIES.length : MEMORIES.filter(m => m.type === t).length}</span>
            </div>
          ))}
          <hr className="nc-hr" style={{ margin: '12px 0' }}/>
          <div className="label-tiny" style={{ marginBottom: 8 }}>STATE</div>
          {['final','draft','pinned','promoted','decaying'].map(s => (
            <div key={s} className="mono" style={{ fontSize: 11, padding: '4px 6px', color: 'var(--text-soft)' }}>· {s}</div>
          ))}
        </div>

        {/* Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10, alignContent: 'start' }}>
          {list.map(m => {
            const dim = m.decay;
            return (
              <div key={m.id} className="nc-panel glow tilt" onClick={() => setActive(m)} style={{ padding: 12, cursor: 'pointer', opacity: dim ? 0.55 : 1, position: 'relative', boxShadow: m.salience > 0.7 ? '0 0 0 1px var(--neon), 0 0 20px rgba(0,183,255,0.25)' : undefined }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span className={`tag ${m.type === 'preference' ? 'violet' : m.type === 'insight' ? 'cyan' : m.type === 'procedural' ? 'blue' : 'muted'}`} style={{ fontSize: 9 }}>{m.type}</span>
                  <span className="mono muted" style={{ fontSize: 9 }}>{m.id}</span>
                </div>
                <div className="mono" style={{ fontSize: 12, color: '#fff', marginBottom: 4, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  {m.promoted && <Icon name="star" size={11} className="amberc" style={{ marginTop: 2, flex: 'none' }}/>}
                  <span>{m.title}</span>
                </div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)', lineHeight: 1.5, marginBottom: 8 }}>{m.summary}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 6 }}>
                  <div>
                    <div className="label-tiny" style={{ fontSize: 8 }}>IMPORTANCE</div>
                    <div className="bar-track" style={{ marginTop: 3 }}><div className="bar-fill" style={{ width: `${m.importance*100}%` }}/></div>
                  </div>
                  <div>
                    <div className="label-tiny" style={{ fontSize: 8 }}>SALIENCE</div>
                    <div className="bar-track" style={{ marginTop: 3 }}><div className="bar-fill" style={{ width: `${m.salience*100}%`, background: 'linear-gradient(90deg, var(--neon-2), var(--violet))' }}/></div>
                  </div>
                </div>
                <div className="mono muted" style={{ fontSize: 9, display: 'flex', justifyContent: 'space-between' }}>
                  <span>@{m.agent}</span><span>{m.lastSeen}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Inspector */}
        <div className="nc-panel glow" style={{ padding: 14, alignSelf: 'start', position: 'sticky', top: 0 }}>
          <div className="label-tiny neonc" style={{ marginBottom: 10 }}>MEMORY INSPECTOR</div>
          <div className="mono" style={{ fontSize: 12, color: '#fff', marginBottom: 4, display: 'flex', gap: 6 }}>
            {active.promoted && <Icon name="star" size={12} className="amberc"/>}
            {active.title}
          </div>
          <div className="mono muted" style={{ fontSize: 10, marginBottom: 10 }}>{active.id} · {active.type}</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.6, marginBottom: 12 }}>{active.summary}</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}>
            {active.tags.map(t => <span key={t} className="tag" style={{ fontSize: 9 }}>#{t}</span>)}
          </div>
          {[
            ['IMPORTANCE', active.importance, 'var(--neon)'],
            ['SALIENCE', active.salience, 'var(--neon-2)'],
          ].map(([l, v, c], i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <div className="mono" style={{ fontSize: 10, display: 'flex', justifyContent: 'space-between', color: 'var(--text-soft)' }}><span>{l}</span><span>{(v*100).toFixed(0)}%</span></div>
              <div className="bar-track" style={{ marginTop: 3 }}><div className="bar-fill" style={{ width: `${v*100}%`, background: `linear-gradient(90deg, ${c}, var(--neon-2))` }}/></div>
            </div>
          ))}
          <hr className="nc-hr" style={{ margin: '12px 0' }}/>
          <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)', lineHeight: 1.7 }}>
            <div><span className="muted">vault:</span> <span className="neonc">{active.vault}</span></div>
            <div><span className="muted">agent:</span> @{active.agent}</div>
            <div><span className="muted">state:</span> {active.state}</div>
            <div><span className="muted">last:</span> {active.lastSeen}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <button className="nc-btn ghost" style={{ flex: 1, fontSize: 10, color: 'var(--danger)' }} onClick={() => onDelete(active)}>Delete</button>
          </div>
        </div>
      </div>
    </div>
  );
};
window.Memory = Memory;
