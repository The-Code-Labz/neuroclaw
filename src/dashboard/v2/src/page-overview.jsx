/* Overview page */

const Overview = () => {
  const { AGENTS, HIVE_EVENTS, ANALYTICS, DREAM, CORE } = window.NC_DATA;
  const [waking, setWaking] = React.useState(false);
  const [wakeMsg, setWakeMsg] = React.useState('');
  const sparkline = ANALYTICS.msgs;
  const max = Math.max(...sparkline);
  const core = CORE || {};
  const coreChecks = core.checks || {};
  const coreActions = core.actions || {};
  const stateTone = (state) => ({
    awake: 'var(--accent-2)',
    degraded: 'var(--amber)',
    booting: 'var(--accent)',
    offline: 'var(--danger)',
  }[state] || 'var(--text-soft)');
  const checkTone = (state) => ({
    ok: 'var(--accent-2)',
    warn: 'var(--amber)',
    fail: 'var(--danger)',
    off: 'var(--muted)',
  }[state] || 'var(--text-soft)');
  const checkLevel = (state) => ({ ok: 1, warn: 0.62, off: 0.35, fail: 0 }[state] ?? 0);
  const wakeCore = async () => {
    setWaking(true);
    setWakeMsg('waking core services...');
    try {
      const result = await window.NC_API.post('/api/core/wake', undefined, 60000);
      if (result?.core) window.NC_DATA.CORE = result.core;
      setWakeMsg(result?.ok ? 'wake complete' : 'wake completed with warnings');
      await window.NC_LIVE.refresh();
    } catch (err) {
      setWakeMsg(err.message || String(err));
    } finally {
      setWaking(false);
    }
  };
  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle="// system status · entry points · health"
        right={<>
          <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>
          <button className="nc-btn primary" onClick={wakeCore} disabled={waking}><Icon name="bolt" size={12}/> {waking ? 'Waking...' : 'Wake all'}</button>
        </>}
      />

      {/* Top stat grid — live values from NC_DATA */}
      {(() => {
        const a   = AGENTS || [];
        const ts  = window.NC_DATA.TASKS || [];
        const ss  = window.NC_DATA.SESSIONS || [];
        const ms  = window.NC_DATA.MEMORIES || [];
        const memStats = window.NC_DATA.MEM_STATS || {};
        const an  = window.NC_DATA.ANALYTICS || {};
        const mcp = window.NC_DATA.MCP_SERVERS || [];
        const live = a.filter(x => x.status === 'live').length;
        const busy = a.filter(x => x.status === 'busy').length;
        const idle = a.filter(x => x.status === 'idle').length;
        const temp = a.filter(x => x.temp).length;
        const todo = ts.filter(t => t.status === 'todo' || t.status === 'doing').length;
        const memWritesToday = memStats.lastDay ?? 0;
        const totalMemories = memStats.total ?? ms.length; // Use stats total, fallback to array length
        const onlineMcp = mcp.filter(m => m.status === 'online' || m.status === 'ready').length;
        return (
          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <StatCard label="ACTIVE AGENTS"   value={a.length} sub={`${idle} idle · ${busy} busy`} tone="cyan" icon="agents"/>
            <StatCard label="TEMP AGENTS"     value={temp} sub={temp ? 'spawned, running' : 'none'} tone="violet" icon="bolt"/>
            <StatCard label="ACTIVE SESSIONS" value={ss.length} sub="all sessions" tone="cyan" icon="sessions"/>
            <StatCard label="PENDING TASKS"   value={todo} sub={`${ts.length} total`} tone="amber" icon="tasks"/>
            <StatCard label="MEMORIES"        value={totalMemories.toLocaleString()} sub={`+${memWritesToday} today · supabase`} tone="cyan" icon="memory"/>
            <StatCard label="MCP STATUS"      value={`${onlineMcp} / ${mcp.length}`} sub={mcp.length ? '' : 'none configured'} tone="cyan" icon="mcp"/>
            <StatCard label="CLAUDE 429s"     value={an.c429 ?? 0} sub="last hour" tone={(an.c429 ?? 0) > 0 ? 'amber' : 'cyan'} icon="shield"/>
            <StatCard label="SPEND (1H)"      value={an.estCostUsd != null ? '$' + an.estCostUsd.toFixed(4) : '—'} sub={(an.tokens || '0') + ' tokens'} tone="cyan" icon="vault"/>
          </div>
        );
      })()}

      {/* Core orb + activity + health */}
      <div className="overview-3col" style={{ marginBottom: 16 }}>
        {/* CORE orb */}
        <div className="nc-panel glow" style={{ padding: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', overflow: 'hidden', position: 'relative' }}>
          <div className="scan-line" />
          <div className="label-tiny" style={{ alignSelf: 'flex-start', color: 'var(--accent)' }}>NEUROCLAW · CORE</div>
          <div className="orb-container" style={{ flex: 1, position: 'relative' }}>
            <div className="orb" />
            <div style={{ position: 'absolute', textAlign: 'center', fontFamily: 'var(--mono)' }}>
              <div className="label-tiny" style={{ color: 'var(--accent-2)' }}>CORE STATE</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: stateTone(core.state), textShadow: `0 0 10px ${stateTone(core.state)}` }}>{String(core.state || 'booting').toUpperCase()}</div>
              <div style={{ fontSize: 10, color: 'var(--text-soft)', marginTop: 2 }}>// {Number(core.score || 0).toFixed(3)} health</div>
              <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 3 }}>{core.checkedAt ? new Date(core.checkedAt).toLocaleTimeString('en-US', { hour12: true }) : 'waiting for probe'}</div>
            </div>
          </div>
          <div className="stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, width: '100%', marginTop: 6 }}>
            {[
              ['router', coreChecks.router],
              ['memory', coreChecks.memory],
              ['tools',  coreChecks.mcp],
            ].map(([k, check], i) => (
              <div key={i} className="mono" style={{ textAlign: 'center', fontSize: 10, padding: '6px 4px', border: '1px solid var(--line-soft)', borderRadius: 2 }}>
                <div className="muted" style={{ letterSpacing: '0.14em' }}>{k.toUpperCase()}</div>
                <div style={{ color: checkTone(check?.state) }}>{String(check?.state || 'wait').toUpperCase()}</div>
              </div>
            ))}
          </div>
          <div className="mono" style={{ width: '100%', fontSize: 10, color: wakeMsg && wakeMsg.includes('failed') ? 'var(--danger)' : 'var(--text-soft)', marginTop: 8, minHeight: 14, textAlign: 'center' }}>
            {wakeMsg || coreChecks.providers?.detail || 'core probe pending'}
          </div>
        </div>

        {/* Activity sparkline */}
        <div className="nc-panel glow" style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="label-tiny neonc">AGENT ACTIVITY · 24H</div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)' }}>peak {max} msg · last 24h</div>
          </div>
          <div className="grid-bg" style={{ flex: 1, marginTop: 12, position: 'relative', minHeight: 180, padding: '10px 4px 4px', display: 'flex', alignItems: 'flex-end', gap: 3, borderRadius: 2, border: '1px solid var(--line-soft)' }}>
            {sparkline.map((v, i) => (
              <div key={i} className="chart-bar" style={{ height: `${(v/max)*92}%`, opacity: 0.7 + (i/sparkline.length)*0.3 }} />
            ))}
            <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', borderTop: '1px dashed color-mix(in srgb, var(--accent) 18%, transparent)', pointerEvents: 'none' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }} className="mono muted">
            <span style={{ fontSize: 10 }}>00:00</span><span style={{ fontSize: 10 }}>06:00</span><span style={{ fontSize: 10 }}>12:00</span><span style={{ fontSize: 10 }}>18:00</span><span style={{ fontSize: 10 }}>now</span>
          </div>
        </div>

        {/* System health */}
        <div className="nc-panel glow" style={{ padding: 16 }}>
          <div className="label-tiny neonc" style={{ marginBottom: 12 }}>SYSTEM HEALTH</div>
          {(() => {
            const bars = [
              ['ROUTER',     coreChecks.router,     coreActions.activeAgents != null ? `${coreActions.activeAgents} agents` : 'pending'],
              ['PROVIDERS',  coreChecks.providers,  coreActions.recent429s != null ? `${coreActions.recent429s} 429s · q${coreActions.queuePressure || 0}` : 'pending'],
              ['AGENTS',     coreChecks.agents,     coreActions.heartbeatFailures != null ? `${coreActions.heartbeatFailures} fail · ${coreActions.heartbeatOk || 0} ok` : 'pending'],
              ['MEMORY',     coreChecks.memory,     coreActions.memories != null ? `${coreActions.memories} entries` : 'pending'],
              ['MCP TOOLS',  coreChecks.mcp,        coreActions.mcpTotal != null ? `${coreActions.mcpReady || 0}/${coreActions.mcpTotal} up` : 'pending'],
              ['DAEMONS',    coreChecks.background, coreActions.backgroundTotal != null ? `${coreActions.backgroundReady || 0}/${coreActions.backgroundTotal} ready` : 'pending'],
            ];
            return bars.map(([k, check, sub], i) => {
              const v = checkLevel(check?.state);
              const c = checkTone(check?.state);
              return (
              <div key={i} style={{ marginBottom: 12 }}>
                <div className="mono" style={{ fontSize: 10, display: 'flex', justifyContent: 'space-between', color: 'var(--text-soft)', marginBottom: 4 }}>
                  <span>{k}</span><span style={{ color: 'var(--muted)', fontSize: 9 }}>{sub}</span>
                </div>
                <div className="bar-track">
                  <div className="bar-fill" title={check?.detail || ''} style={{ width: `${v*100}%`, background: `linear-gradient(90deg, ${c}, var(--accent-2))` }} />
                </div>
              </div>
              );
            });
          })()}
          <div style={{ borderTop: '1px solid var(--line-soft)', marginTop: 8, paddingTop: 10 }}>
            <div className="label-tiny" style={{ marginBottom: 6 }}>DREAM CYCLE</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)' }}>next run · {DREAM.next}</div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
              {DREAM.lastRun ? `last: ${DREAM.lastRun}` : DREAM.lastExtracted ? `last: ${DREAM.lastExtracted}` : 'last: —'}
            </div>
          </div>
        </div>
      </div>

      {/* Backends + Hive feed + Agents */}
      <div className="overview-3col">
        {/* Backend status */}
        <div className="nc-panel glow" style={{ padding: 16 }}>
          <div className="label-tiny neonc" style={{ marginBottom: 10 }}>PROVIDER BACKENDS</div>
          {(window.NC_DATA.PROVIDERS || []).map((p, i, arr) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderBottom: i < arr.length - 1 ? '1px dashed color-mix(in srgb, var(--accent) 8%, transparent)' : 'none' }}>
              <span className={`dot ${p.status === 'online' ? 'green' : p.status === 'warn' ? 'amber' : 'red'} pulse`} />
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)' }}>{p.name}</div>
                <div className="mono muted" style={{ fontSize: 10 }}>{p.backend} · {p.model}</div>
              </div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)' }}>q{p.queue}</div>
            </div>
          ))}
        </div>

        {/* Hive feed live */}
        <div className="nc-panel glow" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between' }}>
            <div className="label-tiny neonc">HIVE MIND · LIVE</div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--accent-2)' }}><span className="dot cyan pulse" style={{ marginRight: 4 }} />tx</div>
          </div>
          <div style={{ maxHeight: 240, overflow: 'auto' }}>
            {(HIVE_EVENTS || []).slice(0, 8).map((e, i) => (
              <div key={i} style={{ padding: '8px 14px', borderBottom: '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)', display: 'grid', gridTemplateColumns: '60px 1fr', gap: 8, alignItems: 'flex-start' }}>
                <span className="mono muted" style={{ fontSize: 10 }}>{(e.t || '').slice(0, 5)}</span>
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
          {(AGENTS || []).slice(0, 6).map(a => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)' }}>
              <div style={{ width: 28, height: 28, borderRadius: 6, background: a.temp ? 'radial-gradient(circle, rgba(139,92,246,0.5), rgba(139,92,246,0.1))' : 'radial-gradient(circle, color-mix(in srgb, var(--accent) 50%, transparent), color-mix(in srgb, var(--accent) 10%, transparent))', border: `1px solid ${a.temp ? 'rgba(139,92,246,0.5)' : 'var(--line-hard)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, overflow: 'hidden' }}>
                {a._raw?.avatar_url
                  ? <img src={a._raw.avatar_url} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 6 }} />
                  : a.name[0]}
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

      {/* Stephanie — Team Intel */}
      {(() => {
        const analystAlerts = (window.NC_DATA.ANALYST_ALERTS || []).filter(a => !a.dismissed_at);
        const sevColor = (s) => s === 'critical' ? 'red' : s === 'warn' ? 'amber' : 'cyan';
        const worstTone = analystAlerts.some(a => a.severity === 'critical') ? 'red'
          : analystAlerts.some(a => a.severity === 'warn') ? 'amber' : 'green';
        return (
          <div className="nc-panel glow" style={{ padding: 0, overflow: 'hidden', marginTop: 16 }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={`dot ${analystAlerts.length > 0 ? worstTone : 'green'} pulse`} />
                <div className="label-tiny neonc">TEAM INTEL · STEPHANIE</div>
              </div>
              <button className="nc-btn ghost" style={{ fontSize: 9, padding: '2px 8px' }}
                onClick={() => { window.location.hash = 'sentinel'; }}>Sentinel →</button>
            </div>
            {analystAlerts.length === 0 ? (
              <div className="mono muted" style={{ padding: '12px 16px', fontSize: 11 }}>// all clear</div>
            ) : (
              analystAlerts.slice(0, 3).map((a, i, arr) => (
                <div key={a.id} style={{ padding: '10px 14px', borderBottom: i < arr.length - 1 ? '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)' : 'none', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <span className={`dot ${sevColor(a.severity)} pulse`} style={{ marginTop: 4, flexShrink: 0 }} />
                  <div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                      <span className={`tag ${sevColor(a.severity)}`} style={{ fontSize: 9 }}>{a.type}</span>
                      <span className="mono muted" style={{ fontSize: 10 }}>
                        {a.created_at ? new Date(a.created_at).toLocaleTimeString() : '—'}
                      </span>
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.4 }}>{a.message}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        );
      })()}
    </div>
  );
};

window.Overview = Overview;
