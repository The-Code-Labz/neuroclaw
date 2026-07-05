/* Providers + live model catalog */
const Providers = () => {
  const { PROVIDERS, AGENTS } = window.NC_DATA;
  const [models, setModels] = React.useState([]);
  const [providers, setProviders] = React.useState(PROVIDERS || []);
  const [selectedProvider, setSelectedProvider] = React.useState('all');
  const [refreshing, setRefreshing] = React.useState(false);
  const [stats, setStats] = React.useState({ high: 0, mid: 0, low: 0 });

  // OpenRouter state
  const [openrouterModels, setOpenrouterModels] = React.useState([]);
  const [openrouterLoading, setOpenrouterLoading] = React.useState(false);
  const [openrouterSearch, setOpenrouterSearch] = React.useState('');
  const [openrouterTier, setOpenrouterTier] = React.useState('all');
  const [openrouterError, setOpenrouterError] = React.useState(null);

  const normalizeProvider = (provider) => {
    const p = String(provider || '').toLowerCase();
    return !p || p === 'openai' ? 'voidai' : p;
  };

  const countStats = (rows) => {
    const counts = { high: 0, mid: 0, low: 0 };
    (rows || []).forEach(x => counts[x.tier] = (counts[x.tier] || 0) + 1);
    return counts;
  };

  const loadProviderData = React.useCallback(async () => {
    const [providerRows, modelRows] = await Promise.all([
      window.NC_API.get('/api/providers').catch(() => null),
      window.NC_API.get('/api/models').catch(() => []),
    ]);
    if (Array.isArray(providerRows)) setProviders(providerRows);
    const rows = modelRows || [];
    setModels(rows);
    setStats(countStats(rows));
  }, []);

  const loadOpenRouterModels = React.useCallback(async () => {
    setOpenrouterLoading(true);
    setOpenrouterError(null);
    try {
      const result = await window.NC_API.get('/api/openrouter/models');
      if (result?.ok && Array.isArray(result.models)) {
        setOpenrouterModels(result.models);
      } else {
        setOpenrouterError(result?.error || 'Failed to load models');
        setOpenrouterModels([]);
      }
    } catch (e) {
      setOpenrouterError(e.message);
      setOpenrouterModels([]);
    } finally {
      setOpenrouterLoading(false);
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    loadProviderData().then(() => {
      if (cancelled) return;
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [loadProviderData]);

  React.useEffect(() => {
    const onTick = () => {
      if (Array.isArray(window.NC_DATA.PROVIDERS)) setProviders(window.NC_DATA.PROVIDERS);
    };
    window.addEventListener('nc-data-tick', onTick);
    return () => window.removeEventListener('nc-data-tick', onTick);
  }, []);

  const refreshCatalog = async () => {
    setRefreshing(true);
    try {
      const qs = selectedProvider === 'all' ? '' : `?provider=${encodeURIComponent(selectedProvider)}`;
      const result = await window.NC_API.post('/api/providers/refresh' + qs);
      if (Array.isArray(result?.providers)) setProviders(result.providers);
      await loadProviderData();
    } catch (e) { alert('Refresh failed: ' + e.message); }
    finally { setRefreshing(false); }
  };

  const displayProviders = providers.length ? providers : PROVIDERS;
  const refreshableProviders = displayProviders.filter(p => p.refreshable);
  const selectedIsRefreshable = selectedProvider === 'all' || refreshableProviders.some(p => p.id === selectedProvider);
  const filteredModels = selectedProvider === 'all'
    ? models
    : models.filter(m => normalizeProvider(m.provider) === selectedProvider);
  const filteredStats = selectedProvider === 'all' ? stats : countStats(filteredModels);
  const providerOptions = Array.from(new Set([
    ...refreshableProviders.map(p => p.id),
    ...models.map(m => normalizeProvider(m.provider)),
  ])).map(id => displayProviders.find(p => p.id === id) || { id, name: id });

  // Filter OpenRouter models
  const filteredOpenrouterModels = openrouterModels.filter(m => {
    const matchesSearch = !openrouterSearch ||
      m.id.toLowerCase().includes(openrouterSearch.toLowerCase()) ||
      (m.name || '').toLowerCase().includes(openrouterSearch.toLowerCase());
    const matchesTier = openrouterTier === 'all' || m.tier === openrouterTier;
    return matchesSearch && matchesTier;
  });

  const openrouterStats = {
    total: openrouterModels.length,
    free: openrouterModels.filter(m => m.tier === 'free').length,
    low: openrouterModels.filter(m => m.tier === 'low').length,
    mid: openrouterModels.filter(m => m.tier === 'mid').length,
    high: openrouterModels.filter(m => m.tier === 'high').length,
  };

  const openrouterProvider = displayProviders.find(p => p.id === 'openrouter');

  return (
    <div>
      <PageHeader title="Providers" subtitle="// model backends · routing · health" right={<>
        <select className="nc-select" value={selectedProvider} onChange={e => setSelectedProvider(e.target.value)} style={{ width: 170 }}>
          <option value="all">All providers</option>
          {providerOptions.map(p => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
        </select>
        <button className="nc-btn" onClick={refreshCatalog} disabled={refreshing || !selectedIsRefreshable}><Icon name="refresh" size={12}/> {refreshing ? 'Probing...' : selectedProvider === 'all' ? 'Probe All' : 'Probe Provider'}</button>
        <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh All</button>
      </>}/>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginBottom: 16 }}>
        {displayProviders.map(p => (
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              <div><div className="label-tiny">MODELS</div><div className="mono neonc" style={{ fontSize: 14 }}>{p.models ?? '—'}</div></div>
              <div><div className="label-tiny">AGENTS</div><div className="mono" style={{ fontSize: 14 }}>{p.agents ?? '—'}</div></div>
              <div><div className="label-tiny">QUEUE</div><div className="mono neonc" style={{ fontSize: 14 }}>{p.queue}</div></div>
              <div><div className="label-tiny">ERRORS</div><div className="mono" style={{ fontSize: 14, color: p.errors > 0 ? 'var(--amber)' : 'var(--text)' }}>{p.errors}</div></div>
            </div>
            {p.detail && <div className="mono muted" style={{ fontSize: 9, marginTop: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.detail}</div>}
          </div>
        ))}
      </div>

      {/* OpenRouter Models Section */}
      <Section title={`OPENROUTER MODELS${openrouterModels.length ? ` · ${openrouterStats.total} total · ${openrouterStats.free} FREE · ${openrouterStats.low} LOW · ${openrouterStats.mid} MID · ${openrouterStats.high} HIGH` : ''}`} padded={false}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="nc-input"
            placeholder="Search models... (e.g. gpt, claude, llama, free)"
            value={openrouterSearch}
            onChange={e => setOpenrouterSearch(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <select className="nc-select" value={openrouterTier} onChange={e => setOpenrouterTier(e.target.value)} style={{ width: 120 }}>
            <option value="all">All tiers</option>
            <option value="free">Free</option>
            <option value="low">Low</option>
            <option value="mid">Mid</option>
            <option value="high">High</option>
          </select>
          <button className="nc-btn" onClick={loadOpenRouterModels} disabled={openrouterLoading}>
            <Icon name="refresh" size={12}/> {openrouterLoading ? 'Loading...' : openrouterModels.length ? 'Refresh' : 'Fetch Models'}
          </button>
          {!openrouterProvider?.configured && (
            <span className="mono muted" style={{ fontSize: 10 }}>// set OPENROUTER_API_KEY to enable</span>
          )}
        </div>
        {openrouterError && (
          <div className="mono" style={{ padding: '12px 16px', color: 'var(--danger)', fontSize: 11 }}>// Error: {openrouterError}</div>
        )}
        {openrouterModels.length > 0 && (
          <div style={{ maxHeight: 400, overflow: 'auto' }}>
            <div className="mono" style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px 100px 100px', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line-soft)', fontSize: 10, color: 'var(--muted)', letterSpacing: '0.14em', position: 'sticky', top: 0, background: 'var(--surface)' }}>
              <span>TIER</span><span>MODEL ID</span><span>CONTEXT</span><span>$ IN/1K</span><span>$ OUT/1K</span>
            </div>
            {filteredOpenrouterModels.slice(0, 200).map(m => {
              const tone = m.tier === 'free' ? 'greenc' : m.tier === 'high' ? 'amberc' : m.tier === 'mid' ? 'neon2' : 'neonc';
              const promptPrice = m.pricing?.prompt ? (parseFloat(m.pricing.prompt) * 1000).toFixed(4) : '—';
              const completionPrice = m.pricing?.completion ? (parseFloat(m.pricing.completion) * 1000).toFixed(4) : '—';
              return (
                <div key={m.id} className="mono" style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px 100px 100px', gap: 10, padding: '8px 16px', borderBottom: '1px dashed rgba(0,183,255,0.05)', fontSize: 11, alignItems: 'center' }}>
                  <span className={tone} style={{ fontWeight: 600 }}>{m.tier.toUpperCase()}</span>
                  <span style={{ color: 'var(--text)', cursor: 'pointer' }} onClick={() => { navigator.clipboard.writeText(m.id); }} title="Click to copy">{m.id}</span>
                  <span className="muted" style={{ fontSize: 10 }}>{m.context_length ? (m.context_length / 1000).toFixed(0) + 'K' : '—'}</span>
                  <span className="muted" style={{ fontSize: 10 }}>{promptPrice === '0.0000' ? 'FREE' : '$' + promptPrice}</span>
                  <span className="muted" style={{ fontSize: 10 }}>{completionPrice === '0.0000' ? 'FREE' : '$' + completionPrice}</span>
                </div>
              );
            })}
            {filteredOpenrouterModels.length > 200 && (
              <div className="mono muted" style={{ padding: '12px 16px', textAlign: 'center', fontSize: 10 }}>// showing 200 of {filteredOpenrouterModels.length} models</div>
            )}
            {filteredOpenrouterModels.length === 0 && openrouterModels.length > 0 && (
              <div className="mono muted" style={{ padding: 24, textAlign: 'center' }}>// no models match your search</div>
            )}
          </div>
        )}
        {openrouterModels.length === 0 && !openrouterLoading && !openrouterError && (
          <div className="mono muted" style={{ padding: 24, textAlign: 'center' }}>// click "Fetch Models" to load OpenRouter catalog</div>
        )}
      </Section>

      <Section title={`LIVE MODEL CATALOG · ${filteredModels.length} models · ${filteredStats.high} HIGH · ${filteredStats.mid} MID · ${filteredStats.low} LOW`} padded={false}>
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          <div className="mono" style={{ display: 'grid', gridTemplateColumns: '110px 60px 1fr 80px 110px 110px', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line-soft)', fontSize: 10, color: 'var(--muted)', letterSpacing: '0.14em' }}>
            <span>PROVIDER</span><span>TIER</span><span>MODEL</span><span>STATE</span><span>$ IN/1K</span><span>$ OUT/1K</span>
          </div>
          {filteredModels.map(m => {
            const tone = m.tier === 'high' ? 'amberc' : m.tier === 'mid' ? 'neon2' : 'neonc';
            const provider = displayProviders.find(p => p.id === normalizeProvider(m.provider));
            return (
              <div key={m.id} className="mono" style={{ display: 'grid', gridTemplateColumns: '110px 60px 1fr 80px 110px 110px', gap: 10, padding: '8px 16px', borderBottom: '1px dashed rgba(0,183,255,0.05)', fontSize: 11, alignItems: 'center' }}>
                <span className="muted" style={{ fontSize: 10 }}>{provider?.name || m.provider || 'VoidAI'}</span>
                <span className={tone}>{m.tier.toUpperCase()}</span>
                <span style={{ color: 'var(--text)' }}>{m.model_id}</span>
                <span className={m.is_available ? 'greenc' : 'dangerc'} style={{ fontSize: 10 }}>{m.is_available ? 'available' : 'missing'}</span>
                <span className="muted" style={{ fontSize: 10 }}>{m.cost_per_1k_input != null ? '$' + m.cost_per_1k_input.toFixed(2) : '—'}</span>
                <span className="muted" style={{ fontSize: 10 }}>{m.cost_per_1k_output != null ? '$' + m.cost_per_1k_output.toFixed(2) : '—'}</span>
              </div>
            );
          })}
          {filteredModels.length === 0 && <div className="mono muted" style={{ padding: 24, textAlign: 'center' }}>// no catalog rows for this provider</div>}
        </div>
      </Section>

      <Section title="AGENT × PROVIDER MATRIX" padded={false}>
        <div className="mono" style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr 1fr 1fr 80px', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line-soft)', fontSize: 10, color: 'var(--muted)', letterSpacing: '0.14em' }}>
          <span>AGENT</span><span>PROVIDER</span><span>MODEL</span><span>TOOLS</span><span>RAW</span><span>STATUS</span>
        </div>
        {AGENTS.filter(a => !a.temp).map(a => (
          <div key={a.id} className="mono" style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr 1fr 1fr 80px', gap: 10, padding: '12px 16px', borderBottom: '1px dashed rgba(0,183,255,0.06)', fontSize: 11, alignItems: 'center' }}>
            <span style={{ color: '#fff' }}>@{a.name}</span>
            <span className="neonc">{a.provider}</span>
            <span style={{ color: 'var(--text-soft)' }}>{a.model}</span>
            <span style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>{a.caps.slice(0,3).map(c => <span key={c} className="tag" style={{ fontSize: 8, padding: '0 4px' }}>{c}</span>)}</span>
            <span className="muted">{a._raw?.provider || 'voidai'}</span>
            <span><span className={`dot ${a.status === 'live' ? 'green' : a.status === 'busy' ? 'amber' : 'muted'} pulse`}/></span>
          </div>
        ))}
      </Section>
    </div>
  );
};
window.Providers = Providers;
