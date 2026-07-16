/* Shell: Sidebar, TopBar, Footer terminal */

const coreTone = (state) => {
  if (state === 'awake' || state === 'ok' || state === 'online') return 'green';
  if (state === 'degraded' || state === 'warn') return 'amber';
  if (state === 'offline' || state === 'fail') return 'red';
  return 'muted';
};

const coreLabel = (state) => ({
  awake: 'AWAKE',
  degraded: 'DEGRADED',
  booting: 'BOOTING',
  offline: 'OFFLINE',
  online: 'ONLINE',
})[state] || String(state || 'LOADING').toUpperCase();

const formatUptime = (seconds) => {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

const compactModel = (model) => {
  const m = String(model || '—');
  if (m.length <= 18) return m;
  return m.replace(/^claude-/, '').replace(/^gpt-/, 'gpt-').slice(0, 18);
};

const refreshAge = () => {
  const at = window.NC_DATA?.LIVE_META?.refreshedAt || window.NC_LAST_REFRESH;
  if (!at) return 'loading';
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  return secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
};

const abbreviateId = (id) => {
  const s = String(id || '');
  if (!s) return 'new';
  return s.length <= 10 ? s : s.slice(0, 8);
};

const gitLabel = (git = {}) => {
  const branch = String(git.branch || 'unknown').replace(/^refs\/heads\//, '');
  const sync = `${git.ahead ? `↑${git.ahead}` : ''}${git.behind ? `↓${git.behind}` : ''}`;
  return `${branch}${git.dirty ? '*' : ''}${sync ? ` ${sync}` : ''}`;
};

const connectionState = () => {
  const data = window.NC_DATA || {};
  const meta = data.LIVE_META || {};
  const status = data.STATUS || {};
  const at = meta.refreshedAt || window.NC_LAST_REFRESH;
  const ageMs = at ? Date.now() - at : Infinity;
  const failed = Array.isArray(meta.failed) ? meta.failed : [];
  const lastError = (() => {
    try { return window.NC_LIVE?.lastError?.(); } catch { return null; }
  })();

  if (lastError || status.status === 'offline' || failed.includes('status') || failed.includes('core')) {
    return { tone: 'red', label: 'error' };
  }
  if ((window.NC_LIVE?._sseFailures || 0) >= 3 || ageMs > 45_000 || failed.length > 0) {
    return { tone: 'amber', label: 'stalled' };
  }
  return { tone: 'green', label: 'connected' };
};

const getDashboardToken = () => {
  try {
    return new URLSearchParams(location.search).get('token')
      || document.cookie.match(/dashboard-token=([^;]+)/)?.[1]
      || '';
  } catch { return ''; }
};

const VersionSwitch = () => {
  const token = getDashboardToken();
  const isV4 = location.pathname.startsWith('/dashboard-v4');
  const href = isV4
    ? (token ? `/dashboard?token=${encodeURIComponent(token)}` : '/dashboard')
    : (token ? `/dashboard-v4?token=${encodeURIComponent(token)}` : '/dashboard-v4');
  const label = isV4 ? 'v4 → v3' : 'v3 → v4';
  return (
    <a href={href} className="nc-btn version-switch" title={`Switch to ${isV4 ? 'v3' : 'v4'} dashboard`}>
      <Icon name={isV4 ? 'arrow-left' : 'arrow-right'} size={12} />
      <span className="mono" style={{ fontSize: 10, fontWeight: 700 }}>{label}</span>
    </a>
  );
};

const RestartButton = ({ iconOnly = false }) => {
  const [state, setState] = React.useState('idle'); // idle | confirm | restarting

  const handleClick = async () => {
    if (state === 'idle') { setState('confirm'); return; }
    if (state === 'confirm') {
      setState('restarting');
      try {
        await window.NC_API.post('/api/system/restart');
      } catch { /* server exits before responding */ }
      // Poll until the server comes back up
      const poll = setInterval(async () => {
        try {
          await window.NC_API.get('/api/status');
          clearInterval(poll);
          window.location.reload();
        } catch { /* still restarting */ }
      }, 1500);
    }
  };

  const handleBlur = () => { if (state === 'confirm') setState('idle'); };

  if (state === 'restarting') {
    return (
      <span className="mono muted" style={{ fontSize: 9, whiteSpace: 'nowrap' }}>restarting…</span>
    );
  }

  const label = state === 'confirm' ? (iconOnly ? '✓' : 'confirm?') : (iconOnly ? null : 'restart');
  const tone = state === 'confirm' ? 'var(--amber)' : 'var(--muted)';

  return (
    <button
      className="nc-btn ghost"
      style={{ padding: iconOnly ? 6 : '4px 8px', color: tone, fontSize: iconOnly ? undefined : 9, whiteSpace: 'nowrap' }}
      title={state === 'confirm' ? 'Click again to confirm restart' : 'Restart server'}
      onClick={handleClick}
      onBlur={handleBlur}
    >
      {/* Restart / power icon */}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
        <path d="M3 3v5h5"/>
      </svg>
      {!iconOnly && <span style={{ marginLeft: 4 }}>{label}</span>}
      {iconOnly && state === 'confirm' && <span style={{ marginLeft: 2, fontSize: 9 }}>✓</span>}
    </button>
  );
};

const Sidebar = ({ active, setActive, collapsed, setCollapsed }) => {
  const { NAV, CORE, STATUS } = window.NC_DATA;
  const state = CORE?.state || STATUS?.status || 'loading';
  const tone = coreTone(state);
  const version = STATUS?.version || '1.0.0';
  const uptime = formatUptime(CORE?.uptimeSec ?? STATUS?.uptime);
  
  // Force collapsed view on smaller screens (CSS forces narrow sidebar anyway)
  const [forceCollapsed, setForceCollapsed] = React.useState(window.innerWidth < 1024);
  React.useEffect(() => {
    const handleResize = () => setForceCollapsed(window.innerWidth < 1024);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  
  const isCollapsed = collapsed || forceCollapsed;
  
  return (
    <aside className="sidebar nc-sidebar" style={{
      background: 'var(--bg-0)',
      borderRight: '1px solid var(--line)',
      overflowY: 'auto',
      position: 'relative',
    }}>
      {/* Logo */}
      <div style={{ padding: isCollapsed ? '14px 8px' : '16px 16px 12px', display: 'flex', alignItems: 'center', justifyContent: isCollapsed ? 'center' : 'flex-start', gap: 10, borderBottom: '1px solid var(--line-soft)' }}>
        <div style={{ filter: 'drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 70%, transparent))' }}>
          <Icon name="logo" size={isCollapsed ? 28 : 26} />
        </div>
        {!isCollapsed && (
          <div style={{ lineHeight: 1.05 }}>
            <div style={{ fontFamily: 'var(--display)', fontWeight: 700, letterSpacing: '0.18em', fontSize: 13 }}>NEUROCLAW</div>
            <div className="label-tiny" style={{ color: 'var(--accent-2)', letterSpacing: '0.24em', fontSize: 9 }}>AI · COMMAND · OS</div>
          </div>
        )}
      </div>

      {/* Nav */}
      <div style={{ padding: '10px 0' }}>
        {NAV.map((g, gi) => (
          <div key={gi} style={{ marginBottom: 6 }}>
            {!isCollapsed && (
              <div className="label-tiny" style={{ padding: '8px 16px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{g.group}</span>
                <span className="dot muted" style={{ width: 5, height: 5 }} />
              </div>
            )}
            {g.items.map(it => (
              <a key={it.id}
                 href={'/dashboard#' + it.id}
                 className={(active === it.id ? 'active ' : '') + (it.soon ? 'disabled ' : '')}
                 onClick={(e) => {
                   if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
                   e.preventDefault();
                   if (!it.soon) { 
                     setActive(it.id); 
                     // Close mobile sidebar when navigating
                     if (window.innerWidth <= 640) { 
                       document.querySelector('.nc-sidebar')?.classList.remove('mob-open'); 
                       document.getElementById('sidebar-mob-overlay')?.classList.remove('open'); 
                     } 
                   }
                 }}
                 title={it.label}
                 style={{ justifyContent: isCollapsed ? 'center' : 'flex-start', padding: isCollapsed ? '10px 0' : '8px 14px' }}>
                <Icon name={it.icon} size={15} />
                {!isCollapsed && <span style={{ flex: 1 }}>{it.label}</span>}
                {!isCollapsed && it.soon && <span className="tag muted" style={{ fontSize: 8, padding: '1px 5px' }}>SOON</span>}
              </a>
            ))}
          </div>
        ))}
      </div>

      {/* Footer collapse + health */}
      <div style={{ position: 'sticky', bottom: 0, padding: isCollapsed ? 8 : 12, borderTop: '1px solid var(--line-soft)', background: 'var(--bg-0)' }}>
        {!isCollapsed ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className={`dot ${tone} ${tone !== 'muted' ? 'pulse' : ''}`} /> CORE · v{version}
                </div>
                <div style={{ marginTop: 3, color: 'var(--accent-2)' }}>uptime {uptime} · {coreLabel(state).toLowerCase()}</div>
              </div>
              <button className="nc-btn ghost" onClick={() => setCollapsed(true)} title="Collapse">
                <Icon name="menu" size={14} />
              </button>
            </div>
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
              <RestartButton />
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <span className={`dot ${tone} ${tone !== 'muted' ? 'pulse' : ''}`} />
            {/* Only show expand button if screen is large enough */}
            {!forceCollapsed && (
              <button className="nc-btn ghost" style={{ padding: 6 }} onClick={() => setCollapsed(false)} title="Expand">
                <Icon name="menu" size={14} />
              </button>
            )}
            <RestartButton iconOnly />
          </div>
        )}
      </div>
    </aside>
  );
};

const StatusChip = ({ tone = 'cyan', label, value }) => (
  <div className="chip" style={{ borderColor: 'var(--line)' }}>
    <span className={`dot ${tone === 'cyan' ? 'cyan' : tone} ${tone !== 'muted' ? 'pulse' : ''}`} />
    <span className="muted">{label}</span>
    <span style={{ color: 'var(--text)' }}>{value}</span>
  </div>
);

const NotificationBell = () => {
  const [alerts, setAlerts]         = React.useState([]);
  const [open, setOpen]             = React.useState(false);
  const [dismissing, setDismissing] = React.useState(null);

  const load = () => {
    window.NC_API.get('/api/analyst/alerts?unread=true&limit=20')
      .then(d => setAlerts(Array.isArray(d) ? d : []))
      .catch(() => {});
  };

  React.useEffect(() => {
    load();
    window.addEventListener('nc-data-tick', load);
    return () => window.removeEventListener('nc-data-tick', load);
  }, []);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    setTimeout(() => document.addEventListener('click', close), 0);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const dismiss = async (id, e) => {
    e.stopPropagation();
    setDismissing(id);
    try {
      await window.NC_API.post(`/api/analyst/alerts/${id}/dismiss`);
      setAlerts(a => a.filter(x => x.id !== id));
    } catch { /* silent */ }
    setDismissing(null);
  };

  const count = alerts.length;
  const badgeTone = alerts.some(a => a.severity === 'critical') ? 'var(--danger)'
    : alerts.some(a => a.severity === 'warn') ? 'var(--amber)' : 'var(--accent)';
  const sevColor = (s) => s === 'critical' ? 'red' : s === 'warn' ? 'amber' : 'cyan';

  return (
    <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
      <button
        className="nc-btn ghost"
        style={{ position: 'relative', padding: '4px 8px', lineHeight: 1 }}
        onClick={() => setOpen(o => !o)}
        title="Stephanie — team intel"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        {count > 0 && (
          <span style={{
            position: 'absolute', top: 0, right: 0,
            background: badgeTone, color: '#000',
            borderRadius: '50%', width: 14, height: 14,
            fontSize: 8, fontWeight: 700, lineHeight: '14px', textAlign: 'center',
            fontFamily: 'var(--mono)',
            transform: 'translate(4px, -4px)',
          }}>{count > 9 ? '9+' : count}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 4px)',
          width: 360, maxHeight: 420, overflow: 'auto',
          background: 'var(--panel)', border: '1px solid var(--line)',
          borderRadius: 6, zIndex: 9000,
          boxShadow: '0 8px 32px rgba(0,0,0,0.9)',
        }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="label-tiny neonc">STEPHANIE · TEAM INTEL</div>
            <button className="nc-btn ghost" style={{ fontSize: 9, padding: '2px 6px' }}
              onClick={() => { window.dispatchEvent(new CustomEvent('nc-goto', { detail: { page: 'sentinel' } })); setOpen(false); }}>View all →</button>
          </div>
          {count === 0 ? (
            <div className="mono muted" style={{ padding: '18px 14px', fontSize: 11, textAlign: 'center' }}>// all clear</div>
          ) : (
            alerts.slice(0, 5).map((a, i) => (
              <div key={a.id} style={{ padding: '10px 14px', borderBottom: i < Math.min(alerts.length, 5) - 1 ? '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)' : 'none' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                  <span className={`dot ${sevColor(a.severity)} pulse`} />
                  <span className={`tag ${sevColor(a.severity)}`} style={{ fontSize: 9 }}>{a.type}</span>
                  <span className="mono muted" style={{ fontSize: 10, marginLeft: 'auto' }}>
                    {a.created_at ? new Date(a.created_at).toLocaleTimeString() : '—'}
                  </span>
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.4, marginBottom: 6 }}>{a.message}</div>
                <button
                  className="nc-btn ghost"
                  style={{ fontSize: 9, padding: '2px 8px' }}
                  disabled={dismissing === a.id}
                  onClick={(e) => dismiss(a.id, e)}
                >{dismissing === a.id ? 'dismissing...' : 'dismiss'}</button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

const TopBar = ({ activeLabel, onCmd }) => {
  const data = window.NC_DATA || {};
  const core = data.CORE || {};
  const actions = core.actions || {};
  const status = data.STATUS || {};
  const analytics = data.ANALYTICS || {};
  const mcpReady = actions.mcpReady ?? (data.MCP_SERVERS || []).filter(s => s.enabled !== false && (s.status === 'ready' || s.status === 'online')).length;
  const mcpTotal = actions.mcpTotal ?? (data.MCP_SERVERS || []).filter(s => s.enabled !== false).length;
  const memValue = (actions.memories != null ? Number(actions.memories) : (data.MEM_STATS?.total || 0)).toLocaleString();
  const chips = [
    { tone: coreTone(core.state || status.status), label: 'SYS', value: coreLabel(core.state || status.status) },
    { tone: 'cyan', label: 'MODEL', value: compactModel(status.model || data.PROVIDERS?.[0]?.model) },
    { tone: actions.memories ? 'cyan' : 'muted', label: 'MEMORY', value: memValue },
    { tone: mcpTotal > 0 && mcpReady === mcpTotal ? 'green' : mcpReady > 0 ? 'amber' : 'muted', label: 'MCP', value: `${mcpReady}/${mcpTotal}` },
    { tone: (actions.recent429s || analytics.c429 || 0) > 0 ? 'amber' : 'green', label: '429s', value: actions.recent429s ?? analytics.c429 ?? 0 },
    { tone: (actions.tempAgents ?? status.tempAgents ?? 0) > 0 ? 'violet' : 'muted', label: 'TEMP', value: actions.tempAgents ?? status.tempAgents ?? 0 },
    { tone: (actions.queuePressure || 0) > 0 ? 'amber' : 'cyan', label: 'QUEUE', value: actions.queuePressure ?? data.CLAUDE?.queueLength ?? 0 },
  ];
  return (
    <header className="topbar" style={{
      borderBottom: '1px solid var(--line)',
      background: 'var(--bg-1)',
      display: 'flex', alignItems: 'center', gap: 14, padding: '0 16px',
    }}>
      {/* Crumbs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 11, minWidth: 0, flex: '0 1 auto' }}>
        <span className="muted hide-mobile">NEUROCLAW</span>
        <span className="muted hide-mobile">/</span>
        <span style={{ color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeLabel}</span>
        <span className="blink neonc hide-mobile" style={{ marginLeft: 2 }}>_</span>
      </div>

      <div style={{ flex: 1 }} />

      {/* Status chips - hidden on mobile */}
      <div className="topbar-chips hide-mobile" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'nowrap', overflow: 'hidden' }}>
        {chips.slice(0, 4).map(chip => <StatusChip key={chip.label} {...chip} />)}
      </div>

      <NotificationBell />

      <VersionSwitch />

      {/* Search / Cmd - compact on mobile */}
      <button onClick={onCmd} className="nc-btn topbar-search" style={{ minWidth: 'auto', justifyContent: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Icon name="search" size={13} />
          <span className="hide-mobile" style={{ color: 'var(--muted)' }}>Search · Command...</span>
        </span>
        <span className="hide-tablet mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
          <kbd style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)', border: '1px solid var(--line)', padding: '0 5px', borderRadius: 2, fontSize: 10 }}>⌘</kbd>
          <kbd style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)', border: '1px solid var(--line)', padding: '0 5px', borderRadius: 2, fontSize: 10 }}>K</kbd>
        </span>
      </button>
    </header>
  );
};

const FooterTerminal = () => {
  const [fps, setFps] = React.useState(null);
  const [statusCtx, setStatusCtx] = React.useState(() => window.NC_STATUS_CONTEXT || null);
  React.useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const loop = (now) => {
      frames += 1;
      if (now - last >= 1000) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  React.useEffect(() => {
    const sync = () => setStatusCtx(window.NC_STATUS_CONTEXT || null);
    window.addEventListener('nc-status-context', sync);
    window.addEventListener('nc-data-tick', sync);
    return () => {
      window.removeEventListener('nc-status-context', sync);
      window.removeEventListener('nc-data-tick', sync);
    };
  }, []);
  const data = window.NC_DATA || {};
  const status = data.STATUS || {};
  const agents = data.AGENTS || [];
  const sessions = data.SESSIONS || [];
  const proc = status.process || {};
  const mem = proc.memory || {};
  const spend = data.SPEND?.lastHour || {};
  const cpu = proc.cpuLoadPct;
  const ctx = statusCtx || {};
  const fallbackAgent = agents.find(a => a.name === 'Alfred') || agents.find(a => a.status === 'live' || a.status === 'active') || agents[0];
  const agent = (ctx.agentId && agents.find(a => (a._raw?.id || a.id) === ctx.agentId))
    || (ctx.agentName && agents.find(a => a.name === ctx.agentName))
    || fallbackAgent
    || {};
  const sessionId = ctx.sessionId || sessions.find(s => s.active)?.id || sessions[0]?.id || '';
  const mode = ctx.mode || (ctx.source === 'terminal' ? 'terminal' : 'dashboard');
  const model = compactModel(ctx.model || agent.model || status.model);
  const conn = connectionState();
  const agentText = `${agent.name || ctx.agentName || 'agent'} · ${agent.role || ctx.agentRole || 'agent'}`;
  const git = status.git || {};
  return (
    <footer className="footer mono" style={{
      borderTop: '1px solid var(--line)',
      background: 'var(--bg-0)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '0 10px',
      fontSize: 10, color: 'var(--muted)',
      letterSpacing: '0.03em',
      overflow: 'hidden',
    }}>
      <div title={agentText} style={{ flex: '1 1 0', minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
        <span style={{ color: 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>@{agentText}</span>
        <span className="hide-tablet" style={{ color: 'var(--accent-2)', whiteSpace: 'nowrap' }}>{mode} · {model}</span>
      </div>

      <div title={`refresh ${refreshAge()}`} style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6, color: conn.tone === 'green' ? 'var(--green)' : conn.tone === 'amber' ? 'var(--amber)' : 'var(--danger)' }}>
        <span className={`dot ${conn.tone} ${conn.tone !== 'red' ? 'pulse' : ''}`} style={{ width: 7, height: 7 }} />
        <span style={{ whiteSpace: 'nowrap' }}>{conn.label}</span>
        <span className="hide-mobile" style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{refreshAge()}</span>
      </div>

      <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, overflow: 'hidden' }}>
        <span style={{ color: 'var(--accent-2)', whiteSpace: 'nowrap' }}>s:{abbreviateId(sessionId)}</span>
        <span title={gitLabel(git)} style={{ color: git.dirty ? 'var(--amber)' : 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{gitLabel(git)}</span>
        <span className="hide-tablet">fps {fps ?? '—'}</span>
        <span className="hide-tablet">cpu {cpu == null ? '—' : `${cpu}%`}</span>
        <span className="hide-tablet">heap {mem.heapUsedMb || '—'}mb</span>
        <span className="hide-tablet">calls/h {spend.call_count ?? '—'}</span>
      </div>
    </footer>
  );
};

const PageHeader = ({ title, subtitle, right }) => (
  <div className="page-header">
    <div style={{ minWidth: 0 }}>
      <div className="label-tiny hide-mobile" style={{ color: 'var(--accent-2)' }}>// section</div>
      <h1 style={{ margin: '4px 0 6px', fontFamily: 'var(--display)', fontWeight: 600, fontSize: 'clamp(20px, 5vw, 28px)', letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {title}
        <span className="blink neonc hide-mobile" style={{ marginLeft: 8, fontSize: 22 }}>_</span>
      </h1>
      {subtitle && <div className="muted mono hide-mobile" style={{ fontSize: 12 }}>{subtitle}</div>}
    </div>
    <div className="page-header-actions">{right}</div>
  </div>
);

const Section = ({ title, right, children, padded = true }) => (
  <div className="nc-panel glow" style={{ padding: padded ? 16 : 0, marginBottom: 16 }}>
    {(title || right) && (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: padded ? 14 : 0, padding: padded ? 0 : '12px 14px', borderBottom: padded ? 'none' : '1px solid var(--line-soft)' }}>
        <div className="label-tiny" style={{ color: 'var(--accent)' }}>{title}</div>
        <div style={{ display: 'flex', gap: 8 }}>{right}</div>
      </div>
    )}
    {children}
  </div>
);

const StatCard = ({ label, value, sub, tone = 'cyan', icon }) => (
  <div className="nc-panel glow tilt stat-card" style={{ padding: 14, position: 'relative', overflow: 'hidden' }}>
    <div className="stripe-bg" style={{ position: 'absolute', inset: 0, opacity: 0.3, pointerEvents: 'none' }} />
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="label-tiny">{label}</div>
        {icon && <Icon name={icon} size={14} className={tone === 'cyan' ? 'neonc' : tone === 'violet' ? 'violetc' : 'amberc'} />}
      </div>
      <div className="stat-value" style={{ fontFamily: 'var(--mono)', fontSize: 28, fontWeight: 600, marginTop: 6, color: 'var(--accent)' }}>
        {value}
      </div>
      <div className="mono" style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>
    </div>
  </div>
);

// ── SubTabs (Dashboard v3 §1) ───────────────────────────────────────────────
// Flat segmented bar under a merged page. Owns the second hash segment
// (#page/subtab), defaulting to the first tab. Renders only the active tab's
// body so sub-views mount lazily (e.g. the Logs EventSource opens only when
// its tab is shown). tabs = [{ id, label, render: () => <Comp/> }].
const SubTabs = ({ pageId, tabs }) => {
  const readSub = () => {
    const parts = location.hash.replace(/^#/, '').split('/');
    const sub = parts[0] === pageId ? parts[1] : null;
    return tabs.some(t => t.id === sub) ? sub : tabs[0].id;
  };
  const [active, setActive] = React.useState(readSub);
  React.useEffect(() => {
    const onHash = () => setActive(readSub());
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('popstate', onHash); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);
  const go = (id) => {
    setActive(id);
    history.pushState(null, '', '/dashboard#' + pageId + '/' + id);
  };
  const current = tabs.find(t => t.id === active) || tabs[0];
  return (
    <>
      <div className="subtabs mono" style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--line)', marginBottom: 18, overflowX: 'auto' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => go(t.id)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: '8px 16px', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: active === t.id ? 'var(--accent)' : 'var(--muted)',
              borderBottom: active === t.id ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1, whiteSpace: 'nowrap', transition: 'color .15s ease',
            }}>
            {t.label}
          </button>
        ))}
      </div>
      {current.render()}
    </>
  );
};

Object.assign(window, { Sidebar, TopBar, FooterTerminal, PageHeader, Section, StatCard, StatusChip, SubTabs });
