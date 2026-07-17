/* Overview page — "Calm Instrument"
 * Fewer bordered cards, clearer hierarchy: Atrium (core status) → Metrics →
 * Activity/Health → Providers/Hive → Roster → Team Intel. Motion is restrained
 * (breathing dot, live pulses) — nothing competes for attention.
 */

const Overview = () => {
  const { AGENTS, HIVE_EVENTS, ANALYTICS, DREAM, CORE } = window.NC_DATA;
  const [waking, setWaking] = React.useState(false);
  const [wakeMsg, setWakeMsg] = React.useState('');
  const sparkline = ANALYTICS.msgs;
  const max = Math.max(...sparkline);
  const core = CORE || {};
  const coreChecks = core.checks || {};
  const coreState = core.state || 'booting';

  const stateTone = (state) => ({
    awake: 'var(--accent-2)',
    online: 'var(--accent-2)',
    degraded: 'var(--amber)',
    booting: 'var(--accent)',
    offline: 'var(--danger)',
  }[state] || 'var(--text-soft)');
  const breathClass = (state) => ({
    awake: 'ok', online: 'ok', degraded: 'warn', offline: 'off',
  }[state] || 'boot');
  const checkDotClass = (state) => ({ ok: 'green', warn: 'amber', fail: 'red', off: 'muted' }[state] || 'muted');
  const checkLevel = (state) => ({ ok: 0.92, warn: 0.6, off: 0.32, fail: 0.04 }[state] ?? 0.04);

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

  const a   = AGENTS || [];
  const ts  = window.NC_DATA.TASKS || [];
  const ss  = window.NC_DATA.SESSIONS || [];
  const ms  = window.NC_DATA.MEMORIES || [];
  const memStats = window.NC_DATA.MEM_STATS || {};
  const an  = window.NC_DATA.ANALYTICS || {};
  const mcp = window.NC_DATA.MCP_SERVERS || [];
  const idle = a.filter(x => x.status === 'idle').length;
  const busy = a.filter(x => x.status === 'busy').length;
  const temp = a.filter(x => x.temp).length;
  const todo = ts.filter(t => t.status === 'todo' || t.status === 'doing').length;
  const memWritesToday = memStats.lastDay ?? 0;
  const totalMemories = memStats.total ?? ms.length;
  const onlineMcp = mcp.filter(m => m.status === 'online' || m.status === 'ready').length;
  const c429 = an.c429 ?? 0;

  const analystAlerts = (window.NC_DATA.ANALYST_ALERTS || []).filter(x => !x.dismissed_at);
  const sevTone = (s) => s === 'critical' ? 'red' : s === 'warn' ? 'amber' : 'cyan';
  const worstTone = analystAlerts.some(x => x.severity === 'critical') ? 'red'
    : analystAlerts.some(x => x.severity === 'warn') ? 'amber' : 'green';

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle="// system status · entry points · health"
        right={<button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>}
      />

      {/* ── Atrium — the single hero. State, health, subsystems, wake-all. ── */}
      <div className="ov-atrium">
        <div className="ov-atrium-top">
          <div className={`ov-breath ov-breath--${breathClass(coreState)}`}>
            <span className="ov-breath__ring" />
            <span className="ov-breath__halo" />
            <span className="ov-breath__core" />
          </div>
          <div className="ov-atrium-meta">
            <div className="ov-eyebrow">NeuroClaw · Core</div>
            <div className="ov-state-word" style={{ color: stateTone(coreState) }}>{coreState}</div>
          </div>
          <div className="ov-atrium-readouts">
            <div className="ov-readout">
              <div className="ov-readout__label">Health</div>
              <div className="ov-readout__value mono">{Number(core.score || 0).toFixed(3)}</div>
            </div>
            <div className="ov-readout">
              <div className="ov-readout__label">Last check</div>
              <div className="ov-readout__value mono">{core.checkedAt ? new Date(core.checkedAt).toLocaleTimeString([], { hour12: true }) : '—'}</div>
            </div>
          </div>
          <button className="nc-btn primary" onClick={wakeCore} disabled={waking}>
            <Icon name="bolt" size={12}/> {waking ? 'Waking…' : 'Wake all'}
          </button>
        </div>
        <div className="ov-subsystems">
          {[
            ['router', coreChecks.router],
            ['providers', coreChecks.providers],
            ['agents', coreChecks.agents],
            ['memory', coreChecks.memory],
            ['tools', coreChecks.mcp],
            ['daemons', coreChecks.background],
          ].map(([k, check], i) => (
            <div key={i} className="ov-subsystem" title={check?.detail || ''}>
              <span className={`dot ${checkDotClass(check?.state)} ${check?.state === 'ok' ? 'pulse' : ''}`} />
              <span className="mono">{k}</span>
            </div>
          ))}
        </div>
        {(wakeMsg || coreChecks.providers?.detail) && (
          <div className={`ov-whisper ${wakeMsg && wakeMsg.includes('failed') ? 'is-error' : ''}`}>
            {wakeMsg || coreChecks.providers?.detail}
          </div>
        )}
      </div>

      {/* ── Metrics strip — borderless, hairline dividers, no per-card chrome ── */}
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <StatCard label="ACTIVE AGENTS"   value={a.length} sub={`${idle} idle · ${busy} busy${temp ? ` · ${temp} temp` : ''}`} tone="cyan" icon="agents"/>
        <StatCard label="SESSIONS"        value={ss.length} sub="all sessions" tone="cyan" icon="sessions"/>
        <StatCard label="PENDING TASKS"   value={todo} sub={`${ts.length} total`} tone="amber" icon="tasks"/>
        <StatCard label="MEMORIES"        value={totalMemories.toLocaleString()} sub={`+${memWritesToday} today · supabase`} tone="cyan" icon="memory"/>
        <StatCard label="MCP STATUS"      value={`${onlineMcp} / ${mcp.length}`} sub={mcp.length ? '' : 'none configured'} tone="cyan" icon="mcp"/>
        <StatCard label="SPEND (1H)"      value={an.estCostUsd != null ? '$' + an.estCostUsd.toFixed(4) : '—'} sub={`${an.tokens || '0'} tokens · ${c429} 429s`} tone={c429 > 0 ? 'amber' : 'cyan'} icon="vault"/>
      </div>

      {/* ── Activity + Health ── */}
      <div className="ov-row ov-row--pair">
        <div className="ov-block">
          <div className="ov-block__head">
            <div className="ov-block__title">Agent activity · 24h</div>
            <div className="mono muted" style={{ fontSize: 10 }}>peak {max} msg</div>
          </div>
          <div className="grid-bg" style={{ height: 160, position: 'relative', padding: '10px 4px 4px', display: 'flex', alignItems: 'flex-end', gap: 3, borderRadius: 'var(--radius-inline)', border: '1px solid var(--line-soft)' }}>
            {sparkline.map((v, i) => (
              <div key={i} className="chart-bar" style={{ height: `${(v / max) * 92}%`, opacity: 0.55 + (i / sparkline.length) * 0.45 }} />
            ))}
            <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', borderTop: '1px dashed color-mix(in srgb, var(--accent) 18%, transparent)', pointerEvents: 'none' }} />
          </div>
          <div className="mono muted" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10 }}>
            <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>now</span>
          </div>
        </div>

        <div className="ov-block">
          <div className="ov-block__title" style={{ marginBottom: 16 }}>System health</div>
          {(() => {
            const bars = [
              ['ROUTER',     coreChecks.router,     core.actions?.activeAgents != null ? `${core.actions.activeAgents} agents` : 'pending'],
              ['PROVIDERS',  coreChecks.providers,  core.actions?.recent429s != null ? `${core.actions.recent429s} 429s · q${core.actions?.queuePressure || 0}` : 'pending'],
              ['AGENTS',     coreChecks.agents,     core.actions?.heartbeatFailures != null ? `${core.actions.heartbeatFailures} fail · ${core.actions.heartbeatOk || 0} ok` : 'pending'],
              ['MEMORY',     coreChecks.memory,     core.actions?.memories != null ? `${core.actions.memories} entries` : 'pending'],
              ['MCP TOOLS',  coreChecks.mcp,        core.actions?.mcpTotal != null ? `${core.actions.mcpReady || 0}/${core.actions.mcpTotal} up` : 'pending'],
              ['DAEMONS',    coreChecks.background, core.actions?.backgroundTotal != null ? `${core.actions.backgroundReady || 0}/${core.actions.backgroundTotal} ready` : 'pending'],
            ];
            return bars.map(([k, check, sub], i) => {
              const v = checkLevel(check?.state);
              const c = ({ ok: 'var(--green)', warn: 'var(--amber)', fail: 'var(--danger)', off: 'var(--muted)' })[check?.state] || 'var(--muted)';
              return (
                <div key={i} style={{ marginBottom: 12 }}>
                  <div className="mono" style={{ fontSize: 10, display: 'flex', justifyContent: 'space-between', color: 'var(--text-soft)', marginBottom: 5 }}>
                    <span>{k}</span><span style={{ color: 'var(--muted)', fontSize: 9 }}>{sub}</span>
                  </div>
                  <div className="bar-track ov-vital">
                    <div className="bar-fill ov-vital__fill" title={check?.detail || ''} style={{ width: `${v * 100}%`, background: `linear-gradient(90deg, ${c}, var(--accent-2))` }} />
                  </div>
                </div>
              );
            });
          })()}
          <div style={{ borderTop: '1px solid var(--line-soft)', marginTop: 6, paddingTop: 12 }}>
            <div className="ov-eyebrow" style={{ marginBottom: 6 }}>Dream cycle</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)' }}>next run · {DREAM.next}</div>
            <div className="mono muted" style={{ fontSize: 10, marginTop: 2 }}>
              {DREAM.lastRun ? `last: ${DREAM.lastRun}` : DREAM.lastExtracted ? `last: ${DREAM.lastExtracted}` : 'last: —'}
            </div>
          </div>
        </div>
      </div>

      {/* ── Providers + Hive — quieter, aux tone ── */}
      <div className="ov-row ov-row--pair">
        <div className="ov-block ov-block--aux">
          <div className="ov-block__title" style={{ marginBottom: 12 }}>Provider backends</div>
          {(window.NC_DATA.PROVIDERS || []).map((p, i, arr) => (
            <div key={p.id} className="ov-list-row" style={{ borderBottom: i < arr.length - 1 ? '1px solid var(--line-soft)' : 'none' }}>
              <span className={`dot ${p.status === 'online' ? 'green' : p.status === 'warn' ? 'amber' : 'red'} pulse`} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mono" style={{ fontSize: 12, color: 'var(--text)' }}>{p.name}</div>
                <div className="mono muted" style={{ fontSize: 10 }}>{p.backend} · {p.model}</div>
              </div>
              <div className="mono muted" style={{ fontSize: 10 }}>q{p.queue}</div>
            </div>
          ))}
        </div>

        <div className="ov-block ov-block--aux ov-block--flush">
          <div className="ov-block__head" style={{ padding: '14px 18px', borderBottom: '1px solid var(--line-soft)', marginBottom: 0 }}>
            <div className="ov-block__title">Hive mind · live</div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--accent-2)' }}><span className="dot cyan pulse" style={{ marginRight: 4 }} />tx</div>
          </div>
          <div style={{ maxHeight: 236, overflow: 'auto' }}>
            {(HIVE_EVENTS || []).slice(0, 8).map((e, i) => (
              <div key={i} style={{ padding: '10px 18px', borderBottom: '1px solid var(--line-soft)', display: 'grid', gridTemplateColumns: '54px 1fr', gap: 8, alignItems: 'flex-start' }}>
                <span className="mono muted" style={{ fontSize: 10 }}>{(e.t || '').slice(0, 5)}</span>
                <div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
                    <span className={`tag ${['blue', 'cyan', 'violet', 'amber', 'red'].includes(e.tone) ? e.tone : 'green'}`} style={{ fontSize: 9, padding: '1px 6px' }}>{e.action}</span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--text-soft)' }}>{e.agent}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)' }}>{e.summary}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Agent roster — full width, roll-call ── */}
      <div className="ov-block" style={{ marginBottom: 24 }}>
        <div className="ov-block__head">
          <div className="ov-block__title">Agent roster</div>
          <button className="nc-btn ghost" style={{ fontSize: 9, padding: '2px 8px' }} onClick={() => { window.location.hash = 'agents'; }}>View all →</button>
        </div>
        <div className="ov-roster">
          {a.slice(0, 8).map(ag => (
            <div key={ag.id} className="ov-roster-row">
              <div className="ov-roster-avatar" style={{ background: ag.temp ? 'radial-gradient(circle, rgba(139,92,246,0.5), rgba(139,92,246,0.1))' : 'radial-gradient(circle, color-mix(in srgb, var(--accent) 50%, transparent), color-mix(in srgb, var(--accent) 10%, transparent))', border: `1px solid ${ag.temp ? 'rgba(139,92,246,0.5)' : 'var(--line-hard)'}` }}>
                {ag._raw?.avatar_url
                  ? <img src={ag._raw.avatar_url} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }} />
                  : ag.name[0]}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="ov-roster-name">{ag.name} {ag.temp && <span className="violetc" style={{ fontSize: 9, marginLeft: 6 }}>TEMP</span>}</div>
                <div className="ov-roster-sub">{ag.role} · {ag.model}</div>
              </div>
              <span className={`dot ${ag.status === 'live' ? 'green' : ag.status === 'busy' ? 'amber' : 'muted'} ${ag.status !== 'idle' ? 'pulse' : ''}`} />
              <span className="mono muted" style={{ fontSize: 10, textAlign: 'right' }}>{ag.tasks}t</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Team Intel · Sentinel — footer strip ── */}
      <div className="ov-block ov-block--aux ov-block--flush">
        <div className="ov-block__head" style={{ padding: '12px 18px', borderBottom: '1px solid var(--line-soft)', marginBottom: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`dot ${analystAlerts.length > 0 ? worstTone : 'green'} pulse`} />
            <div className="ov-block__title">Team intel · Stephanie</div>
          </div>
          <button className="nc-btn ghost" style={{ fontSize: 9, padding: '2px 8px' }} onClick={() => { window.location.hash = 'sentinel'; }}>Sentinel →</button>
        </div>
        {analystAlerts.length === 0 ? (
          <div className="mono muted" style={{ padding: '14px 18px', fontSize: 11 }}>// all clear</div>
        ) : (
          analystAlerts.slice(0, 3).map((al, i, arr) => (
            <div key={al.id} style={{ padding: '12px 18px', borderBottom: i < arr.length - 1 ? '1px solid var(--line-soft)' : 'none', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span className={`dot ${sevTone(al.severity)} pulse`} style={{ marginTop: 4, flexShrink: 0 }} />
              <div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                  <span className={`tag ${sevTone(al.severity)}`} style={{ fontSize: 9 }}>{al.type}</span>
                  <span className="mono muted" style={{ fontSize: 10 }}>{al.created_at ? new Date(al.created_at).toLocaleTimeString() : '—'}</span>
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.4 }}>{al.message}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

window.Overview = Overview;
