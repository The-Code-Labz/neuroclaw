/* Analytics */
const Analytics = () => {
  const { ANALYTICS } = window.NC_DATA;
  const { msgs, topAgents, topTools, providerSplit, taskStats, c429, routingAccuracy, spawned, memoryWrites, vaultSyncs } = ANALYTICS;
  const max = Math.max(...msgs);

  // heatmap 7x24
  const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => Math.random()));

  return (
    <div>
      <PageHeader title="Analytics" subtitle="// telemetry · usage · routing accuracy" right={<>
        <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>
      </>}/>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 16 }}>
        <StatCard label="MEMORY WRITES (24H)" value={memoryWrites || 0} sub={`${vaultSyncs || 0} this hour`} tone="cyan"/>
        <StatCard label="TOKENS (1H)" value={ANALYTICS.tokens || '0'} sub={`${ANALYTICS.callCount || 0} LLM calls`} tone="cyan"/>
        <StatCard label="SPEND (1H)" value={ANALYTICS.estCostUsd != null ? '$' + ANALYTICS.estCostUsd.toFixed(4) : '$0'} sub="estimated USD" tone="cyan"/>
        <StatCard label="429 / HOUR" value={c429 ?? 0} sub={(c429 ?? 0) > 0 ? 'throttled' : 'clean'} tone={(c429 ?? 0) > 0 ? 'amber' : 'cyan'}/>
        <StatCard label="TASKS" value={`${taskStats?.ok || 0}/${(taskStats?.ok || 0) + (taskStats?.fail || 0)}`} sub={`${taskStats?.fail || 0} failed`} tone="cyan"/>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12, marginBottom: 16 }}>
        <Section title="MESSAGES · 24H">
          <div className="grid-bg" style={{ minHeight: 220, position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 3, padding: '12px 6px 4px', border: '1px solid var(--line-soft)', borderRadius: 2 }}>
            {msgs.map((v, i) => (
              <div key={i} className="chart-bar" style={{ height: `${(v/max)*92}%` }}/>
            ))}
            <div style={{ position: 'absolute', left: 8, top: 8 }} className="mono muted" style={{ fontSize: 10 }}>peak {max}</div>
          </div>
        </Section>

        <Section title="PROVIDER USAGE">
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '8px 0' }}>
            <svg viewBox="0 0 100 100" style={{ width: 130, height: 130, transform: 'rotate(-90deg)' }}>
              {(() => {
                let off = 0;
                const r = 40, c = 2 * Math.PI * r;
                return providerSplit.map((p, i) => {
                  const len = c * p.share;
                  const el = <circle key={i} cx="50" cy="50" r={r} fill="none" stroke={p.color} strokeWidth="14" strokeDasharray={`${len} ${c-len}`} strokeDashoffset={-off} style={{ filter: 'drop-shadow(0 0 4px currentColor)' }}/>;
                  off += len;
                  return el;
                });
              })()}
            </svg>
            <div style={{ flex: 1 }}>
              {providerSplit.map((p, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ width: 10, height: 10, background: p.color, boxShadow: `0 0 6px ${p.color}` }}/>
                  <span className="mono" style={{ fontSize: 11, flex: 1 }}>{p.name}</span>
                  <span className="mono neonc" style={{ fontSize: 11 }}>{(p.share*100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </div>
        </Section>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
        <Section title="TOP AGENTS">
          {topAgents.map((a, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div className="mono" style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}><span>{a.name}</span><span className="neonc">{(a.share*100).toFixed(0)}%</span></div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${a.share*100}%` }}/></div>
            </div>
          ))}
        </Section>
        <Section title="TOP TOOLS">
          {topTools.map((t, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <div className="mono" style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}><span>{t.name}</span><span className="neon2">{(t.share*100).toFixed(0)}%</span></div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${t.share*100}%`, background: 'linear-gradient(90deg, var(--neon-2), var(--violet))' }}/></div>
            </div>
          ))}
        </Section>
        <Section title="MEMORY WRITES · 7D">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 160 }}>
            {[34,52,28,71,46,84,62].map((v, i) => (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <div className="chart-bar" style={{ height: `${(v/84)*100}%`, width: '100%', background: 'linear-gradient(180deg, var(--neon-2), rgba(0,245,212,0.2))' }}/>
                <span className="mono muted" style={{ fontSize: 9 }}>{['M','T','W','T','F','S','S'][i]}</span>
              </div>
            ))}
          </div>
          <div className="mono muted" style={{ fontSize: 10, marginTop: 8 }}>{memoryWrites} today · {vaultSyncs} vault syncs</div>
        </Section>
      </div>

      <Section title="ACTIVITY HEATMAP · 7D × 24H">
        <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr', gap: 6 }}>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-around' }} className="mono muted">
            {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => <span key={d} style={{ fontSize: 10 }}>{d}</span>)}
          </div>
          <div style={{ display: 'grid', gridTemplateRows: 'repeat(7, 1fr)', gap: 3 }}>
            {heat.map((row, ri) => (
              <div key={ri} style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 3 }}>
                {row.map((v, ci) => (
                  <div key={ci} style={{ height: 16, background: `rgba(0,183,255,${0.06 + v*0.65})`, boxShadow: v > 0.7 ? '0 0 6px rgba(0,183,255,0.5)' : 'none', borderRadius: 1 }}/>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, paddingLeft: 46 }} className="mono muted">
          <span style={{ fontSize: 9 }}>00</span><span style={{ fontSize: 9 }}>06</span><span style={{ fontSize: 9 }}>12</span><span style={{ fontSize: 9 }}>18</span><span style={{ fontSize: 9 }}>24</span>
        </div>
      </Section>
    </div>
  );
};
window.Analytics = Analytics;
