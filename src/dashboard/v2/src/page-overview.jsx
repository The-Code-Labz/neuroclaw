/* Overview page */

const Overview = () => {
  const { AGENTS, HIVE_EVENTS, ANALYTICS, DREAM } = window.NC_DATA;
  const sparkline = ANALYTICS.msgs;
  const max = Math.max(...sparkline);
  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle="// system status · entry points · health"
        right={<>
          <button className="nc-btn"><Icon name="refresh" size={12}/> Refresh</button>
          <button className="nc-btn primary"><Icon name="bolt" size={12}/> Wake all</button>
        </>}
      />

      {/* Top stat grid — live values from NC_DATA */}
      {(() => {
        const a   = AGENTS || [];
        const ts  = window.NC_DATA.TASKS || [];
        const ss  = window.NC_DATA.SESSIONS || [];
        const ms  = window.NC_DATA.MEMORIES || [];
        const an  = window.NC_DATA.ANALYTICS || {};
        const mcp = window.NC_DATA.MCP_SERVERS || [];
        const live = a.filter(x => x.status === 'live').length;
        const busy = a.filter(x => x.status === 'busy').length;
        const idle = a.filter(x => x.status === 'idle').length;
        const temp = a.filter(x => x.temp).length;
        const todo = ts.filter(t => t.status === 'todo' || t.status === 'doing').length;
        const promoted = ms.filter(m => m.promoted).length;
        const onlineMcp = mcp.filter(m => m.status === 'online').length;
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
            <StatCard label="ACTIVE AGENTS"   value={a.length} sub={`${idle} idle · ${busy} busy`} tone="cyan" icon="agents"/>
            <StatCard label="TEMP AGENTS"     value={temp} sub={temp ? 'spawned, running' : 'none'} tone="violet" icon="bolt"/>
            <StatCard label="ACTIVE SESSIONS" value={ss.length} sub="all sessions" tone="cyan" icon="sessions"/>
            <StatCard label="PENDING TASKS"   value={todo} sub={`${ts.length} total`} tone="amber" icon="tasks"/>
            <StatCard label="MEMORIES"        value={ms.length.toLocaleString()} sub={`${promoted} in vault`} tone="cyan" icon="memory"/>
            <StatCard label="MCP STATUS"      value={`${onlineMcp} / ${mcp.length}`} sub={mcp.length ? '' : 'none configured'} tone="cyan" icon="mcp"/>
            <StatCard label="CLAUDE 429s"     value={an.c429 ?? 0} sub="last hour" tone={(an.c429 ?? 0) > 0 ? 'amber' : 'cyan'} icon="shield"/>
            <StatCard label="SPEND (1H)"      value={an.estCostUsd != null ? '$' + an.estCostUsd.toFixed(4) : '—'} sub={(an.tokens || '0') + ' tokens'} tone="cyan" icon="vault"/>
          </div>
        );
      })()}

      {/* Core orb + activity + health */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.5fr 1.1fr', gap: 12, marginBottom: 16 }}>
        {/* CORE orb */}
        <div className="nc-panel glow" style={{ padding: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', overflow: 'hidden', position: 'relative' }}>
          <div className="scan-line" />
          <div className="label-tiny" style={{ alignSelf: 'flex-start', color: 'var(--neon)' }}>NEUROCLAW · CORE</div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px 0', position: 'relative' }}>
            <div className="orb" />
            <div style={{ position: 'absolute', textAlign: 'center', fontFamily: 'var(--mono)' }}>
              <div className="label-tiny" style={{ color: 'var(--neon-2)' }}>CORE STATE</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#fff', textShadow: '0 0 10px var(--neon)' }}>AWAKE</div>
              <div style={{ fontSize: 10, color: 'var(--text-soft)', marginTop: 2 }}>// 0.842 sync</div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, width: '100%', marginTop: 6 }}>
            {[
              ['routing','OK'], ['memory','SYNC'], ['vault','LIVE'],
            ].map(([k, v], i) => (
              <div key={i} className="mono" style={{ textAlign: 'center', fontSize: 10, padding: '6px 4px', border: '1px solid var(--line-soft)', borderRadius: 2 }}>
                <div className="muted" style={{ letterSpacing: '0.14em' }}>{k.toUpperCase()}</div>
                <div className="neonc">{v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Activity sparkline */}
        <div className="nc-panel glow" style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="label-tiny neonc">AGENT ACTIVITY · 24H</div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)' }}>peak 182 msg · last 24h</div>
          </div>
          <div className="grid-bg" style={{ flex: 1, marginTop: 12, position: 'relative', minHeight: 180, padding: '10px 4px 4px', display: 'flex', alignItems: 'flex-end', gap: 3, borderRadius: 2, border: '1px solid var(--line-soft)' }}>
            {sparkline.map((v, i) => (
              <div key={i} className="chart-bar" style={{ height: `${(v/max)*92}%`, opacity: 0.7 + (i/sparkline.length)*0.3 }} />
            ))}
            <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', borderTop: '1px dashed rgba(0,183,255,0.18)', pointerEvents: 'none' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }} className="mono muted">
            <span style={{ fontSize: 10 }}>00:00</span><span style={{ fontSize: 10 }}>06:00</span><span style={{ fontSize: 10 }}>12:00</span><span style={{ fontSize: 10 }}>18:00</span><span style={{ fontSize: 10 }}>now</span>
          </div>
        </div>

        {/* System health */}
        <div className="nc-panel glow" style={{ padding: 16 }}>
          <div className="label-tiny neonc" style={{ marginBottom: 12 }}>SYSTEM HEALTH</div>
          {[
            ['CPU', 0.32, 'var(--neon)'],
            ['MEM', 0.58, 'var(--neon-2)'],
            ['ROUTER LATENCY', 0.18, 'var(--neon)'],
            ['MCP LATENCY', 0.71, 'var(--amber)'],
            ['QUEUE PRESSURE', 0.24, 'var(--neon-2)'],
          ].map(([k, v, c], i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <div className="mono" style={{ fontSize: 10, display: 'flex', justifyContent: 'space-between', color: 'var(--text-soft)', marginBottom: 4 }}>
                <span>{k}</span><span>{Math.round(v*100)}%</span>
              </div>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${v*100}%`, background: `linear-gradient(90deg, ${c}, var(--neon-2))` }} />
              </div>
            </div>
          ))}
          <div style={{ borderTop: '1px solid var(--line-soft)', marginTop: 8, paddingTop: 10 }}>
            <div className="label-tiny" style={{ marginBottom: 6 }}>DREAM CYCLE</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)' }}>next run · {DREAM.next}</div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>last: 38 → 12 → 4</div>
          </div>
        </div>
      </div>

      {/* Backends + Hive feed + Agents */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        {/* Backend status */}
        <div className="nc-panel glow" style={{ padding: 16 }}>
          <div className="label-tiny neonc" style={{ marginBottom: 10 }}>PROVIDER BACKENDS</div>
          {[
            ['Claude CLI', 'claude-cli', 'online', 'opus-4.1', 5],
            ['VoidAI', 'router', 'online', 'sonnet-4', 2],
            ['Anthropic API', 'cloud', 'warn', 'sonnet-4', 0],
            ['MCP Bus', 'mux', 'online', '—', 1],
          ].map(([n, b, s, m, q], i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderBottom: i < 3 ? '1px dashed rgba(0,183,255,0.08)' : 'none' }}>
              <span className={`dot ${s === 'online' ? 'green' : s === 'warn' ? 'amber' : 'red'} pulse`} />
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)' }}>{n}</div>
                <div className="mono muted" style={{ fontSize: 10 }}>{b} · {m}</div>
              </div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)' }}>q{q}</div>
            </div>
          ))}
        </div>

        {/* Hive feed live */}
        <div className="nc-panel glow" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between' }}>
            <div className="label-tiny neonc">HIVE MIND · LIVE</div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--neon-2)' }}><span className="dot cyan pulse" style={{ marginRight: 4 }} />tx</div>
          </div>
          <div style={{ maxHeight: 240, overflow: 'auto' }}>
            {HIVE_EVENTS.slice(0, 8).map((e, i) => (
              <div key={i} style={{ padding: '8px 14px', borderBottom: '1px dashed rgba(0,183,255,0.06)', display: 'grid', gridTemplateColumns: '60px 1fr', gap: 8, alignItems: 'flex-start' }}>
                <span className="mono muted" style={{ fontSize: 10 }}>{e.t.slice(0, 5)}</span>
                <div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
                    <span className={`tag ${e.tone === 'blue' ? 'blue' : e.tone === 'cyan' ? 'cyan' : e.tone === 'violet' ? 'violet' : e.tone === 'amber' ? 'amber' : e.tone === 'red' ? 'red' : 'green'}`} style={{ fontSize: 9, padding: '1px 6px' }}>{e.action}</span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--text-soft)' }}>{e.agent}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)' }}>{e.summary}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Agents quick */}
        <div className="nc-panel glow" style={{ padding: 16 }}>
          <div className="label-tiny neonc" style={{ marginBottom: 10 }}>AGENT ROSTER</div>
          {AGENTS.slice(0, 6).map(a => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '1px dashed rgba(0,183,255,0.06)' }}>
              <div style={{ width: 28, height: 28, borderRadius: 6, background: a.temp ? 'radial-gradient(circle, rgba(139,92,246,0.5), rgba(139,92,246,0.1))' : 'radial-gradient(circle, rgba(0,183,255,0.5), rgba(0,183,255,0.1))', border: `1px solid ${a.temp ? 'rgba(139,92,246,0.5)' : 'var(--line-hard)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700 }}>
                {a.name[0]}
              </div>
              <div style={{ flex: 1 }}>
                <div className="mono" style={{ fontSize: 12 }}>{a.name} {a.temp && <span className="violetc" style={{ fontSize: 9 }}>· TEMP</span>}</div>
                <div className="mono muted" style={{ fontSize: 10 }}>{a.role} · {a.model}</div>
              </div>
              <span className={`dot ${a.status === 'live' ? 'green' : a.status === 'busy' ? 'amber' : 'muted'} ${a.status !== 'idle' ? 'pulse' : ''}`} />
              <span className="mono muted" style={{ fontSize: 10, width: 22, textAlign: 'right' }}>{a.tasks}t</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

window.Overview = Overview;
