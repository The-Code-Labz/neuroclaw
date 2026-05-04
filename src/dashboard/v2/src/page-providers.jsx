/* Providers + live model catalog */
const Providers = () => {
  const { PROVIDERS, AGENTS } = window.NC_DATA;
  const [models, setModels] = React.useState([]);
  const [refreshing, setRefreshing] = React.useState(false);
  const [stats, setStats] = React.useState({ high: 0, mid: 0, low: 0 });

  React.useEffect(() => {
    let cancelled = false;
    window.NC_API.get('/api/models?provider=voidai').then(rows => {
      if (cancelled) return;
      const m = rows || [];
      setModels(m);
      const counts = { high: 0, mid: 0, low: 0 };
      m.forEach(x => counts[x.tier] = (counts[x.tier] || 0) + 1);
      setStats(counts);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const refreshCatalog = async () => {
    setRefreshing(true);
    try {
      await window.NC_API.post('/api/models/refresh?provider=voidai');
      const rows = await window.NC_API.get('/api/models?provider=voidai');
      setModels(rows || []);
      const counts = { high: 0, mid: 0, low: 0 };
      (rows || []).forEach(x => counts[x.tier] = (counts[x.tier] || 0) + 1);
      setStats(counts);
    } catch (e) { alert('Refresh failed: ' + e.message); }
    finally { setRefreshing(false); }
  };

  return (
    <div>
      <PageHeader title="Providers" subtitle="// model backends · routing · health" right={<>
        <button className="nc-btn" onClick={refreshCatalog} disabled={refreshing}><Icon name="refresh" size={12}/> {refreshing ? 'Probing…' : 'Probe VoidAI'}</button>
        <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh All</button>
      </>}/>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
        {PROVIDERS.map(p => (
          <div key={p.id} className="nc-panel glow tilt" style={{ padding: 14, opacity: p.soon ? 0.55 : 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={`dot ${p.status === 'online' ? 'green' : p.status === 'warn' ? 'amber' : 'muted'} ${p.status === 'online' ? 'pulse' : ''}`}/>
                <span style={{ fontFamily: 'var(--display)', fontSize: 16, fontWeight: 600 }}>{p.name}</span>
              </div>
              {p.soon ? <span className="tag muted" style={{ fontSize: 9 }}>SOON</span> : <span className={`tag ${p.status === 'online' ? 'green' : p.status === 'warn' ? 'amber' : 'muted'}`} style={{ fontSize: 9 }}>{p.status}</span>}
            </div>
            <div className="mono muted" style={{ fontSize: 10, marginBottom: 10 }}>backend · {p.backend}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', marginBottom: 8 }}>{p.model}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              <div><div className="label-tiny">QUEUE</div><div className="mono neonc" style={{ fontSize: 14 }}>{p.queue}</div></div>
              <div><div className="label-tiny">ERRORS</div><div className="mono" style={{ fontSize: 14, color: p.errors > 0 ? 'var(--amber)' : 'var(--text)' }}>{p.errors}</div></div>
              <div><div className="label-tiny">RATE</div><div className="mono" style={{ fontSize: 14 }}>{p.rate}</div></div>
            </div>
          </div>
        ))}
      </div>

      <Section title={`LIVE VOIDAI MODEL CATALOG · ${models.length} models · ${stats.high} HIGH · ${stats.mid} MID · ${stats.low} LOW`} padded={false}>
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          <div className="mono" style={{ display: 'grid', gridTemplateColumns: '60px 1fr 80px 110px 110px', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line-soft)', fontSize: 10, color: 'var(--muted)', letterSpacing: '0.14em' }}>
            <span>TIER</span><span>MODEL</span><span>STATE</span><span>$ IN/1K</span><span>$ OUT/1K</span>
          </div>
          {models.map(m => {
            const tone = m.tier === 'high' ? 'amberc' : m.tier === 'mid' ? 'neon2' : 'neonc';
            return (
              <div key={m.id} className="mono" style={{ display: 'grid', gridTemplateColumns: '60px 1fr 80px 110px 110px', gap: 10, padding: '8px 16px', borderBottom: '1px dashed rgba(0,183,255,0.05)', fontSize: 11, alignItems: 'center' }}>
                <span className={tone}>{m.tier.toUpperCase()}</span>
                <span style={{ color: 'var(--text)' }}>{m.model_id}</span>
                <span className={m.is_available ? 'greenc' : 'dangerc'} style={{ fontSize: 10 }}>{m.is_available ? 'available' : 'missing'}</span>
                <span className="muted" style={{ fontSize: 10 }}>{m.cost_per_1k_input != null ? '$' + m.cost_per_1k_input.toFixed(2) : '—'}</span>
                <span className="muted" style={{ fontSize: 10 }}>{m.cost_per_1k_output != null ? '$' + m.cost_per_1k_output.toFixed(2) : '—'}</span>
              </div>
            );
          })}
          {models.length === 0 && <div className="mono muted" style={{ padding: 24, textAlign: 'center' }}>// loading catalog…</div>}
        </div>
      </Section>

      <Section title="AGENT × PROVIDER MATRIX" padded={false}>
        <div className="mono" style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr 1fr 1fr 80px', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line-soft)', fontSize: 10, color: 'var(--muted)', letterSpacing: '0.14em' }}>
          <span>AGENT</span><span>PROVIDER</span><span>MODEL</span><span>TOOLS</span><span>FALLBACK</span><span>STATUS</span>
        </div>
        {AGENTS.filter(a => !a.temp).map(a => (
          <div key={a.id} className="mono" style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr 1fr 1fr 80px', gap: 10, padding: '12px 16px', borderBottom: '1px dashed rgba(0,183,255,0.06)', fontSize: 11, alignItems: 'center' }}>
            <span style={{ color: '#fff' }}>@{a.name}</span>
            <span className="neonc">{a.provider}</span>
            <span style={{ color: 'var(--text-soft)' }}>{a.model}</span>
            <span style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>{a.caps.slice(0,3).map(c => <span key={c} className="tag" style={{ fontSize: 8, padding: '0 4px' }}>{c}</span>)}</span>
            <span className="muted">claude-cli</span>
            <span><span className={`dot ${a.status === 'live' ? 'green' : a.status === 'busy' ? 'amber' : 'muted'} pulse`}/></span>
          </div>
        ))}
      </Section>
    </div>
  );
};
window.Providers = Providers;
