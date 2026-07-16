/* Overview page v4 — Calm Instrument */

const Overview = () => {
  const { AGENTS, HIVE_EVENTS, ANALYTICS, DREAM, CORE } = window.NC_DATA;
  const [waking, setWaking] = React.useState(false);
  const [wakeMsg, setWakeMsg] = React.useState('');
  const sparkline = ANALYTICS.msgs;
  const max = Math.max(1, ...sparkline);
  const core = CORE || {};
  const coreChecks = core.checks || {};
  const coreActions = core.actions || {};

  const stateTone = (state) => ({
    awake: 'accent',
    online: 'accent',
    degraded: 'amber',
    booting: 'amber',
    offline: 'red',
  }[state] || 'muted');

  const checkTone = (state) => ({
    ok: 'green',
    warn: 'amber',
    fail: 'red',
    off: 'muted',
  }[state] || 'muted');

  const checkLevel = (state) => ({ ok: 1, warn: 0.65, off: 0.35, fail: 0 }[state] ?? 0);

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

  const a = AGENTS || [];
  const ts = window.NC_DATA.TASKS || [];
  const ss = window.NC_DATA.SESSIONS || [];
  const ms = window.NC_DATA.MEMORIES || [];
  const memStats = window.NC_DATA.MEM_STATS || {};
  const an = window.NC_DATA.ANALYTICS || {};
  const mcp = window.NC_DATA.MCP_SERVERS || [];
  const live = a.filter(x => x.status === 'live').length;
  const busy = a.filter(x => x.status === 'busy').length;
  const idle = a.filter(x => x.status === 'idle').length;
  const temp = a.filter(x => x.temp).length;
  const todo = ts.filter(t => t.status === 'todo' || t.status === 'doing').length;
  const memWritesToday = memStats.lastDay ?? 0;
  const totalMemories = memStats.total ?? ms.length;
  const onlineMcp = mcp.filter(m => m.status === 'online' || m.status === 'ready').length;

  const healthBars = [
    ['Router', coreChecks.router, coreActions.activeAgents != null ? `${coreActions.activeAgents} agents` : 'pending'],
    ['Providers', coreChecks.providers, coreActions.recent429s != null ? `${coreActions.recent429s} 429s · q${coreActions.queuePressure || 0}` : 'pending'],
    ['Agents', coreChecks.agents, coreActions.heartbeatFailures != null ? `${coreActions.heartbeatFailures} fail · ${coreActions.heartbeatOk || 0} ok` : 'pending'],
    ['Memory', coreChecks.memory, coreActions.memories != null ? `${coreActions.memories} entries` : 'pending'],
    ['MCP Tools', coreChecks.mcp, coreActions.mcpTotal != null ? `${coreActions.mcpReady || 0}/${coreActions.mcpTotal} up` : 'pending'],
    ['Daemons', coreChecks.background, coreActions.backgroundTotal != null ? `${coreActions.backgroundReady || 0}/${coreActions.backgroundTotal} ready` : 'pending'],
  ];

  const providers = window.NC_DATA.PROVIDERS || [];
  const agents = (AGENTS || []).slice(0, 8);
  const analystAlerts = (window.NC_DATA.ANALYST_ALERTS || []).filter(a => !a.dismissed_at);
  const sevColor = (s) => s === 'critical' ? 'red' : s === 'warn' ? 'amber' : 'violet';
  const worstTone = analystAlerts.some(a => a.severity === 'critical') ? 'red'
    : analystAlerts.some(a => a.severity === 'warn') ? 'amber' : 'green';

  return (
    <div className="os-layout">
      <PageHeader
        title="Overview"
        subtitle="System status · core health · active agents"
        right={<button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>}
      />

      {/* System status bar — replaces the large core orb with compact, useful info */}
      <div className="system-status-bar">
        <div className="status-main">
          <span className={`dot ${stateTone(core.state)} ${['awake','online'].includes(core.state) ? 'pulse' : ''}`} style={{ width: 9, height: 9 }} />
          <div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Core state</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: `var(--${stateTone(core.state)})`, textTransform: 'capitalize', lineHeight: 1.2 }}>{String(core.state || 'booting')}</div>
          </div>
          <div className="status-divider" />
          <div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Health</div>
            <div className="mono" style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.2 }}>{Number(core.score || 0).toFixed(3)}</div>
          </div>
          <div className="status-divider" />
          <div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Checked</div>
            <div className="mono" style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.2 }}>{core.checkedAt ? new Date(core.checkedAt).toLocaleTimeString('en-US', { hour12: true }) : '—'}</div>
          </div>
        </div>

        <div className="status-checks">
          {[
            ['router', coreChecks.router],
            ['providers', coreChecks.providers],
            ['agents', coreChecks.agents],
            ['memory', coreChecks.memory],
            ['tools', coreChecks.mcp],
            ['daemons', coreChecks.background],
          ].map(([k, check], i) => (
            <div key={i} className="status-check-pill" title={check?.detail || ''}>
              <span className={`dot ${checkTone(check?.state)} ${check?.state === 'ok' ? 'pulse' : ''}`} />
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'capitalize' }}>{k}</span>
            </div>
          ))}
        </div>

        <button className="nc-btn primary" onClick={wakeCore} disabled={waking}><Icon name="bolt" size={12}/> {waking ? 'Waking...' : 'Wake all'}</button>

        {wakeMsg && (
          <div className="mono wake-msg" style={{ color: wakeMsg.includes('failed') || wakeMsg.includes('error') ? 'var(--error)' : 'var(--text-secondary)' }}>{wakeMsg}</div>
        )}
      </div>

      {/* Metrics */}
      <div className="metric-grid">
        <StatCard label="Active agents" value={a.length} sub={`${idle} idle · ${busy} busy`} tone="accent" icon="agents" />
        <StatCard label="Pending tasks" value={todo} sub={`${ts.length} total`} tone="amber" icon="tasks" />
        <StatCard label="Memories" value={totalMemories.toLocaleString()} sub={`+${memWritesToday} today`} tone="accent" icon="memory" />
        <StatCard label="MCP status" value={`${onlineMcp}/${mcp.length}`} sub={mcp.length ? '' : 'none configured'} tone="accent" icon="mcp" />
      </div>

      {/* Activity + Health */}
      <div className="two-col">
        <Section title="Agent activity · 24h">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 140, paddingTop: 8 }}>
            {sparkline.map((v, i) => (
              <div key={i} className="chart-bar" style={{ height: `${(v/max)*100}%`, opacity: 0.35 + (i/sparkline.length)*0.65 }} />
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }} className="mono muted">
            <span style={{ fontSize: 10 }}>00:00</span>
            <span style={{ fontSize: 10 }}>06:00</span>
            <span style={{ fontSize: 10 }}>12:00</span>
            <span style={{ fontSize: 10 }}>18:00</span>
            <span style={{ fontSize: 10 }}>now</span>
          </div>
        </Section>

        <Section title="System health">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {healthBars.map(([k, check, sub], i) => {
              const v = checkLevel(check?.state);
              const c = checkTone(check?.state);
              return (
                <div key={i}>
                  <div className="mono" style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)', marginBottom: 6 }}>
                    <span>{k}</span>
                    <span style={{ color: 'var(--text-tertiary)', fontSize: 10 }}>{sub}</span>
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" title={check?.detail || ''} style={{ width: `${v*100}%`, background: `var(--${c})` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ borderTop: '1px solid var(--border-default)', marginTop: 16, paddingTop: 14 }}>
            <div className="label-tiny" style={{ color: 'var(--text-tertiary)', marginBottom: 6 }}>Dream cycle</div>
            <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>next run · {DREAM.next}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{DREAM.lastRun ? `last: ${DREAM.lastRun}` : DREAM.lastExtracted ? `last: ${DREAM.lastExtracted}` : 'last: —'}</div>
          </div>
        </Section>
      </div>

      {/* Agent roster */}
      <Section title="Agent roster" right={<button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => window.dispatchEvent(new CustomEvent('nc-goto', { detail: { page: 'agents' } }))}>View all →</button>}>
        <div className="agent-list">
          {agents.map(a => (
            <div key={a.id} className="agent-row">
              <div className="agent-avatar">
                {a._raw?.avatar_url
                  ? <img src={a._raw.avatar_url} alt="" />
                  : a.name[0]}
              </div>
              <div className="agent-meta">
                <div className="agent-name">{a.name} {a.temp && <span className="tag violet" style={{ fontSize: 8, padding: '1px 5px' }}>TEMP</span>}</div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{a.role} · {compactModel(a.model)}</div>
              </div>
              <div className="agent-task mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{a.currentTask || a.lastTask || 'idle'}</div>
              <div className="agent-status">
                <span className={`dot ${a.status === 'live' ? 'green' : a.status === 'busy' ? 'amber' : 'muted'} ${a.status !== 'idle' ? 'pulse' : ''}`} />
                <span className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{a.status}</span>
              </div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)', width: 28, textAlign: 'right' }}>{a.tasks || 0}t</div>
            </div>
          ))}
        </div>
      </Section>

      {/* Providers + Hive */}
      <div className="two-col">
        <Section title="Provider backends" className="aux-section">
          <div className="provider-list">
            {providers.map((p, i, arr) => (
              <div key={p.id} className="provider-row">
                <span className={`dot ${p.status === 'online' ? 'green' : p.status === 'warn' ? 'amber' : 'red'} ${p.status === 'online' ? 'pulse' : ''}`} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-primary)' }}>{p.name}</div>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{p.backend} · {compactModel(p.model)}</div>
                </div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>q{p.queue || 0}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Hive mind · live" className="aux-section" right={<div className="mono" style={{ fontSize: 10, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="dot accent pulse" /> tx
        </div>}
        >
          <div className="hive-list">
            {(HIVE_EVENTS || []).slice(0, 8).map((e, i) => (
              <div key={i} className="hive-row">
                <span className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)', width: 44, flexShrink: 0 }}>{(e.t || '').slice(0, 5)}</span>
                <span className={`tag ${e.tone === 'blue' || e.tone === 'cyan' || e.tone === 'violet' ? 'accent' : e.tone === 'amber' ? 'amber' : e.tone === 'red' ? 'red' : 'green'}`} style={{ fontSize: 8, padding: '1px 5px', flexShrink: 0 }}>{e.action}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.agent} · {e.summary}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>

      {/* Team Intel */}
      <Section title="Team intel · Stephanie" className="aux-section"
        right={<button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => window.dispatchEvent(new CustomEvent('nc-goto', { detail: { page: 'sentinel' } }))}>Sentinel →</button>}
      >
        {analystAlerts.length === 0 ? (
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            <span className={`dot ${worstTone} pulse`} style={{ marginRight: 8 }} /> all clear
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {analystAlerts.slice(0, 3).map((a, i) => (
              <div key={a.id} className="alert-row">
                <span className={`dot ${sevColor(a.severity)} pulse`} style={{ marginTop: 4, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                    <span className={`tag ${sevColor(a.severity)}`} style={{ fontSize: 8 }}>{a.type}</span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{a.created_at ? new Date(a.created_at).toLocaleTimeString() : '—'}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>{a.message}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
};

window.Overview = Overview;
