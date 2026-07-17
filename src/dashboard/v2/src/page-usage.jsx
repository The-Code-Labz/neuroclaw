/* Usage — per-provider token consumption with time-range filter and agent drill-down */

const USAGE_RANGES = [
  { label: '1H',  hours: 1   },
  { label: '24H', hours: 24  },
  { label: '7D',  hours: 168 },
  { label: '30D', hours: 720 },
];

const CLI_PROVIDERS = new Set(['codex', 'gemini', 'claude-cli', 'antigravity', 'opencode']);

function providerLabel(p) {
  const names = {
    voidai:        'VoidAI',
    anthropic:     'Anthropic API',
    'claude-cli':  'Claude CLI',
    codex:         'Codex CLI',
    gemini:        'Gemini CLI',
    'gemini-api':  'Gemini API',
    'kimi-api':    'Kimi Code API',
    openrouter:    'OpenRouter',
    ollama:        'Ollama',
    antigravity:   'Antigravity',
    opencode:      'OpenCode CLI',
  };
  return names[p] || p.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
}

function providerColor(p) {
  const colors = {
    voidai:        'var(--accent)',
    anthropic:     'var(--accent-2)',
    'claude-cli':  '#7dd3fc',
    codex:         'var(--violet)',
    gemini:        '#4ade80',
    'gemini-api':  '#4ade80',
    'kimi-api':    '#f97316',
    openrouter:    '#fb923c',
    ollama:        '#a78bfa',
    antigravity:   '#34d399',
    opencode:      '#818cf8',
  };
  return colors[p] || 'var(--muted)';
}

function fmtTokens(n, provider) {
  const prefix = CLI_PROVIDERS.has(provider) ? '~' : '';
  if (n >= 1_000_000) return prefix + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return prefix + (n / 1_000).toFixed(1) + 'K';
  return prefix + String(n);
}

function fmtCost(usd, provider) {
  if (CLI_PROVIDERS.has(provider)) return '—';
  return '$' + (usd || 0).toFixed(4);
}

// ── Subscription quota panel ─────────────────────────────────────────────────

const QUOTA_PROVIDERS = [
  { key: 'antigravity', label: 'Antigravity', color: '#34d399',     endpoint: '/api/providers/antigravity/usage', style: 'windows' },
  { key: 'claude',      label: 'Claude',      color: '#7dd3fc',     endpoint: '/api/providers/claude/usage',      style: 'windows' },
  { key: 'codex',       label: 'Codex CLI',   color: 'var(--violet)', endpoint: '/api/providers/codex/usage',     style: 'windows' },
  { key: 'minimax',     label: 'MiniMax',     color: '#f59e0b',     endpoint: '/api/providers/minimax/usage',     style: 'windows' },
  { key: 'kimi',        label: 'Kimi',        color: '#a78bfa',     endpoint: '/api/providers/kimi/usage',        style: 'windows' },
  { key: 'grok',        label: 'Grok CLI',   color: '#f4f4f5',     endpoint: '/api/providers/grok/usage',        style: 'windows' },
  { key: 'openrouter',  label: 'OpenRouter', color: '#60a5fa',     endpoint: '/api/providers/openrouter/usage',  style: 'windows' },
  { key: 'voidai',      label: 'VoidAI',     color: '#c084fc',     endpoint: '/api/providers/voidai/usage',      style: 'windows' },
  { key: 'kie',         label: 'KIE AI',     color: '#2dd4bf',     endpoint: '/api/providers/kie/usage',          style: 'windows' },
  { key: 'fal',         label: 'fal.ai',     color: '#f472b6',     endpoint: '/api/providers/fal/usage',          style: 'windows' },
  { key: 'venice',      label: 'Venice',     color: '#fb7185',     endpoint: '/api/providers/venice/usage',       style: 'windows' },
  { key: 'abacus',      label: 'Abacus',     color: '#818cf8',     endpoint: '/api/providers/abacus/usage',       style: 'windows' },
  { key: 'openart',     label: 'OpenArt',    color: '#fbbf24',     endpoint: '/api/providers/openart/usage',      style: 'windows' },
];

function QuotaPanel({ providerCfg }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!providerCfg.endpoint) { setLoading(false); return; }  // note-only panel (e.g. Kimi)
    let cancelled = false;
    let retry = null;
    // Some providers (Grok CLI) drive a slow tmux PTY on a cold cache and blow
    // past NC_API's 10s fetch timeout. The backend still finishes and caches the
    // result, so on failure we retry once ~16s later to pick up the warm cache.
    const attempt = (isRetry) => window.NC_API.get(providerCfg.endpoint)
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => {
        if (cancelled) return;
        if (!isRetry) { retry = setTimeout(() => attempt(true), 16000); return; }
        setData({ ok: false, error: 'fetch failed' });
        setLoading(false);
      });
    attempt(false);
    return () => { cancelled = true; if (retry) clearTimeout(retry); };
  }, [providerCfg.endpoint]);

  const color = providerCfg.color;

  return (
    <div style={{
      border: `1px solid ${color}33`,
      borderRadius: 6,
      padding: '12px 14px',
      background: `${color}08`,
      minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ width: 8, height: 8, background: color, boxShadow: `0 0 6px ${color}`, display: 'inline-block', flexShrink: 0 }}/>
        <span className="mono" style={{ fontSize: 11, color, fontWeight: 600, letterSpacing: 1 }}>{providerCfg.label.toUpperCase()}</span>
        {loading && <span className="mono muted" style={{ fontSize: 9, marginLeft: 'auto' }}>loading…</span>}
      </div>

      {!loading && !data && <span className="mono muted" style={{ fontSize: 11 }}>unavailable</span>}

      {/* Windows-style providers (codex / claude / minimax) */}
      {!loading && data && providerCfg.style === 'windows' && (
        <div>
          {data.ok && data.windows?.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.windows.map(w => (
                <div key={w.label}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span className="mono muted" style={{ fontSize: 10 }}>{w.label}</span>
                    <span className="mono" style={{ fontSize: 10, color }}>{w.usedPercent}%</span>
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${w.usedPercent}%`, background: color }}/>
                  </div>
                  {w.resetAt && (
                    <span className="mono muted" style={{ fontSize: 9 }}>
                      resets {w.label === 'Week'
                        ? new Date(w.resetAt).toLocaleDateString([], { weekday: 'short' }) + ' ' + new Date(w.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                        : new Date(w.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
              ))}
              {data.note && <span className="mono muted" style={{ fontSize: 10, marginTop: 4 }}>{data.note}</span>}
              {data.plan && <span className="mono muted" style={{ fontSize: 10, marginTop: 4 }}>{data.plan}</span>}
            </div>
          ) : (
            <span className="mono muted" style={{ fontSize: 11 }}>{data.error || 'run `codex login`'}</span>
          )}
        </div>
      )}

      {/* Note-only providers (e.g. Kimi) */}
      {providerCfg.style === 'note' && (
        <span className="mono muted" style={{ fontSize: 10, lineHeight: 1.5 }}>{providerCfg.note}</span>
      )}
    </div>
  );
}

// ── Provider health chips (WS2 cooldown layer) ──────────────────────────────

function fmtCountdown(untilMs) {
  const left = Math.max(0, untilMs - Date.now());
  const m = Math.round(left / 60000);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  if (m >= 1)  return `${m}m`;
  return `${Math.round(left / 1000)}s`;
}

function HealthChips() {
  const [rows, setRows] = React.useState([]);

  const load = React.useCallback(() => {
    window.NC_API.get('/api/providers/health')
      .then(d => setRows(d.providers || []))
      .catch(() => setRows([]));
  }, []);

  React.useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  function resetProvider(p) {
    window.NC_API.post(`/api/providers/health/${encodeURIComponent(p)}/reset`, {})
      .then(load)
      .catch(() => {});
  }

  if (rows.length === 0) {
    return <span className="mono muted" style={{ fontSize: 11 }}>No provider traffic recorded yet.</span>;
  }

  const stateColor = s => s === 'ok' ? 'var(--success, #4ade80)' : s === 'cooldown' ? 'var(--amber, #f59e0b)' : 'var(--danger, #ef4444)';

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {rows.map(r => (
        <div
          key={r.provider}
          title={r.lastErrorClass ? `last error: ${r.lastErrorClass}${r.lastErrorAt ? ' @ ' + new Date(r.lastErrorAt).toLocaleTimeString() : ''} · ${r.requestCount} reqs` : `${r.requestCount} reqs`}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            border: `1px solid color-mix(in srgb, ${stateColor(r.state)} 27%, transparent)`,
            background: `color-mix(in srgb, ${stateColor(r.state)} 5%, transparent)`,
            borderRadius: 4, padding: '4px 8px',
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: stateColor(r.state), boxShadow: `0 0 5px ${stateColor(r.state)}`, display: 'inline-block' }}/>
          <span className="mono" style={{ fontSize: 11 }}>{providerLabel(r.provider)}</span>
          {r.state === 'cooldown' && r.cooldownUntil && (
            <span className="mono" style={{ fontSize: 10, color: 'var(--amber, #f59e0b)' }}>cooldown {fmtCountdown(r.cooldownUntil)}</span>
          )}
          {r.state === 'dead' && <span className="mono" style={{ fontSize: 10, color: 'var(--danger, #ef4444)' }}>dead</span>}
          {r.state !== 'ok' && (
            <button
              className="nc-btn"
              style={{ fontSize: 9, padding: '1px 5px', minWidth: 0 }}
              onClick={() => resetProvider(r.provider)}
            >reset</button>
          )}
        </div>
      ))}
    </div>
  );
}

const Usage = () => {
  const [range, setRange]     = React.useState(24);
  const [data,  setData]      = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [expanded, setExpanded] = React.useState(new Set());

  React.useEffect(() => {
    setLoading(true);
    window.NC_API.get(`/api/analytics/usage?hours=${range}`)
      .then(d => { setData(d); setExpanded(new Set()); })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [range]);

  const byProvider = data?.byProvider ?? [];
  const byProviderAgent = data?.byProviderAgent ?? [];

  const totalTokens = byProvider.reduce((s, r) => s + r.total_tokens, 0);
  const totalCalls  = byProvider.reduce((s, r) => s + r.call_count,   0);
  const totalCost   = byProvider
    .filter(r => !CLI_PROVIDERS.has(r.provider))
    .reduce((s, r) => s + r.est_cost_usd, 0);
  const topProvider = byProvider[0] ? providerLabel(byProvider[0].provider) : '—';

  function toggleExpand(provider) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(provider) ? next.delete(provider) : next.add(provider);
      return next;
    });
  }

  function agentsFor(provider) {
    return byProviderAgent.filter(r => r.provider === provider);
  }

  return (
    <div>
      <PageHeader
        title="Usage"
        subtitle="// provider · tokens · cost"
        right={
          <div style={{ display: 'flex', gap: 4 }}>
            {USAGE_RANGES.map(r => (
              <button
                key={r.hours}
                className={`nc-btn${range === r.hours ? ' active' : ''}`}
                style={{ minWidth: 40, opacity: range === r.hours ? 1 : 0.55 }}
                onClick={() => setRange(r.hours)}
              >{r.label}</button>
            ))}
            {loading && <span className="mono muted" style={{ fontSize: 10, alignSelf: 'center', marginLeft: 6 }}>loading…</span>}
          </div>
        }
      />

      {/* Summary stat cards */}
      <div className="stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <StatCard label="TOTAL TOKENS" value={fmtTokens(totalTokens, '')} sub={`${totalCalls} calls`} tone="cyan"/>
        <StatCard label="EST COST" value={'$' + totalCost.toFixed(4)} sub="API providers only" tone="cyan"/>
        <StatCard label="TOP PROVIDER" value={topProvider} sub={byProvider[0] ? fmtTokens(byProvider[0].total_tokens, byProvider[0].provider) + ' tokens' : '—'} tone="cyan"/>
        <StatCard label="PROVIDERS ACTIVE" value={byProvider.length} sub={`in last ${range >= 168 ? Math.round(range/24) + 'd' : range + 'h'}`} tone="cyan"/>
      </div>

      {/* Provider health chips (cooldown layer) */}
      <Section title="PROVIDER HEALTH" style={{ marginBottom: 16 }}>
        <HealthChips/>
      </Section>

      {/* Subscription quota cards */}
      <Section title="SUBSCRIPTION QUOTA" style={{ marginBottom: 16 }}>
        <div className="stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {QUOTA_PROVIDERS.map(p => <QuotaPanel key={p.key} providerCfg={p} />)}
        </div>
      </Section>

      {/* Provider breakdown table */}
      <Section title="PROVIDER BREAKDOWN">
        {byProvider.length === 0 ? (
          <div className="mono muted" style={{ padding: '24px 0', textAlign: 'center', fontSize: 12 }}>
            No usage recorded in this period.
          </div>
        ) : (
          <div className="table-scroll">
            {/* Header row */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.2fr 0.8fr 0.8fr 1.4fr', gap: 8, padding: '6px 8px', borderBottom: '1px solid var(--line-soft)' }} className="mono muted">
              <span style={{ fontSize: 10 }}>PROVIDER</span>
              <span style={{ fontSize: 10 }}>TOKENS</span>
              <span style={{ fontSize: 10 }}>CALLS</span>
              <span style={{ fontSize: 10 }}>EST COST</span>
              <span style={{ fontSize: 10 }}>SHARE</span>
            </div>

            {byProvider.map((row) => {
              const share  = totalTokens > 0 ? row.total_tokens / totalTokens : 0;
              const isOpen = expanded.has(row.provider);
              const agents = agentsFor(row.provider);
              const color  = providerColor(row.provider);

              return (
                <div key={row.provider}>
                  {/* Provider row */}
                  <div
                    onClick={() => toggleExpand(row.provider)}
                    className="ob-row"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '2fr 1.2fr 0.8fr 0.8fr 1.4fr',
                      gap: 8,
                      padding: '10px 8px',
                      borderBottom: '1px solid var(--line-soft)',
                    }}
                  >
                    <span className="mono" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ opacity: 0.6, fontSize: 10 }}>{isOpen ? '▼' : '▶'}</span>
                      <span style={{ width: 8, height: 8, background: color, boxShadow: `0 0 5px ${color}`, display: 'inline-block' }}/>
                      {providerLabel(row.provider)}
                    </span>
                    <span className="mono neonc" style={{ fontSize: 12 }}>{fmtTokens(row.total_tokens, row.provider)}</span>
                    <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{row.call_count.toLocaleString()}</span>
                    <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{fmtCost(row.est_cost_usd, row.provider)}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div className="bar-track" style={{ flex: 1 }}>
                        <div className="bar-fill" style={{ width: `${share * 100}%`, background: color }}/>
                      </div>
                      <span className="mono" style={{ fontSize: 10, color: 'var(--muted)', minWidth: 32 }}>{(share * 100).toFixed(0)}%</span>
                    </div>
                  </div>

                  {/* Agent sub-rows */}
                  {isOpen && agents.length > 0 && (
                    <div className="ob-sub-row" style={{ borderBottom: '1px solid var(--line-soft)' }}>
                      {agents.map((a) => (
                        <div
                          key={`${row.provider}:${a.agent_id ?? 'null'}`}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '2fr 1.2fr 0.8fr 0.8fr 1.4fr',
                            gap: 8,
                            padding: '7px 8px 7px 32px',
                            borderBottom: '1px solid var(--line-soft)',
                          }}
                        >
                          <span className="mono muted" style={{ fontSize: 11 }}>{a.agent_name}</span>
                          <span className="mono" style={{ fontSize: 11 }}>{fmtTokens(a.total_tokens, row.provider)}</span>
                          <span className="mono muted" style={{ fontSize: 11 }}>{a.call_count.toLocaleString()}</span>
                          <span className="mono muted" style={{ fontSize: 11 }}>—</span>
                          <span/>
                        </div>
                      ))}
                    </div>
                  )}
                  {isOpen && agents.length === 0 && (
                    <div style={{ padding: '8px 8px 8px 32px', borderBottom: '1px solid var(--line-soft)' }}>
                      <span className="mono muted" style={{ fontSize: 11 }}>No agent breakdown available.</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
};

window.Usage = Usage;
