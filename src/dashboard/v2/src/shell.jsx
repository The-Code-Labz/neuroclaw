/* Shell: Sidebar, TopBar, Footer terminal */

const Sidebar = ({ active, setActive, collapsed, setCollapsed }) => {
  const { NAV } = window.NC_DATA;
  return (
    <aside className="sidebar nc-sidebar" style={{
      background: 'linear-gradient(180deg, rgba(7,17,31,0.95), rgba(2,6,23,0.95))',
      borderRight: '1px solid var(--line)',
      overflowY: 'auto',
      position: 'relative',
    }}>
      {/* Logo */}
      <div style={{ padding: collapsed ? '14px 8px' : '16px 16px 12px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--line-soft)' }}>
        <div style={{ filter: 'drop-shadow(0 0 6px rgba(0,183,255,0.7))' }}>
          <Icon name="logo" size={collapsed ? 28 : 26} />
        </div>
        {!collapsed && (
          <div style={{ lineHeight: 1.05 }}>
            <div style={{ fontFamily: 'var(--display)', fontWeight: 700, letterSpacing: '0.18em', fontSize: 13 }}>NEUROCLAW</div>
            <div className="label-tiny" style={{ color: 'var(--neon-2)', letterSpacing: '0.24em', fontSize: 9 }}>AI · COMMAND · OS</div>
          </div>
        )}
      </div>

      {/* Nav */}
      <div style={{ padding: '10px 0' }}>
        {NAV.map((g, gi) => (
          <div key={gi} style={{ marginBottom: 6 }}>
            {!collapsed && (
              <div className="label-tiny" style={{ padding: '8px 16px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{g.group}</span>
                <span className="dot muted" style={{ width: 5, height: 5 }} />
              </div>
            )}
            {g.items.map(it => (
              <a key={it.id}
                 className={(active === it.id ? 'active ' : '') + (it.soon ? 'disabled ' : '')}
                 onClick={() => !it.soon && setActive(it.id)}
                 title={it.label}
                 style={{ justifyContent: collapsed ? 'center' : 'flex-start', padding: collapsed ? '10px 0' : '8px 14px' }}>
                <Icon name={it.icon} size={15} />
                {!collapsed && <span style={{ flex: 1 }}>{it.label}</span>}
                {!collapsed && it.soon && <span className="tag muted" style={{ fontSize: 8, padding: '1px 5px' }}>SOON</span>}
              </a>
            ))}
          </div>
        ))}
      </div>

      {/* Footer collapse + health */}
      <div style={{ position: 'sticky', bottom: 0, padding: 12, borderTop: '1px solid var(--line-soft)', background: 'rgba(2,6,23,0.9)' }}>
        {!collapsed ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="dot green pulse" /> CORE · v1.0.0
              </div>
              <div style={{ marginTop: 3, color: 'var(--neon-2)' }}>uptime 2d · 14:22</div>
            </div>
            <button className="nc-btn ghost" onClick={() => setCollapsed(true)} title="Collapse">
              <Icon name="menu" size={14} />
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <span className="dot green pulse" />
            <button className="nc-btn ghost" style={{ padding: 6 }} onClick={() => setCollapsed(false)} title="Expand">
              <Icon name="menu" size={14} />
            </button>
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

const TopBar = ({ activeLabel, onCmd }) => {
  return (
    <header className="topbar" style={{
      borderBottom: '1px solid var(--line)',
      background: 'linear-gradient(180deg, rgba(7,17,31,0.92), rgba(2,6,23,0.7))',
      display: 'flex', alignItems: 'center', gap: 14, padding: '0 16px',
    }}>
      {/* Crumbs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 11 }}>
        <span className="muted">NEUROCLAW</span>
        <span className="muted">/</span>
        <span style={{ color: 'var(--neon)' }}>{activeLabel}</span>
        <span className="blink neonc" style={{ marginLeft: 2 }}>_</span>
      </div>

      <div style={{ flex: 1 }} />

      {/* Status chips */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <StatusChip tone="green" label="SYS" value="ONLINE" />
        <StatusChip tone="cyan" label="MODEL" value="opus-4.1" />
        <StatusChip tone="cyan" label="VAULT" value="sync" />
        <StatusChip tone="cyan" label="MCP" value="3/3" />
        <StatusChip tone="amber" label="429s" value="12" />
        <StatusChip tone="violet" label="TEMP" value="2" />
        <StatusChip tone="cyan" label="QUEUE" value="5" />
      </div>

      {/* Search / Cmd */}
      <button onClick={onCmd} className="nc-btn" style={{ minWidth: 220, justifyContent: 'space-between' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Icon name="search" size={13} />
          <span style={{ color: 'var(--muted)' }}>Search · Command...</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} className="mono">
          <kbd style={{ background: 'rgba(0,183,255,0.1)', border: '1px solid var(--line)', padding: '0 5px', borderRadius: 2, fontSize: 10 }}>⌘</kbd>
          <kbd style={{ background: 'rgba(0,183,255,0.1)', border: '1px solid var(--line)', padding: '0 5px', borderRadius: 2, fontSize: 10 }}>K</kbd>
        </span>
      </button>
    </header>
  );
};

const FooterTerminal = () => {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => { const i = setInterval(() => setTick(t => t+1), 1500); return () => clearInterval(i); }, []);
  const lines = [
    'route(alfred → coder, conf=0.84)',
    'mcp.vault_search ok 84ms',
    'spawn debugger-42 ttl=900',
    'memory.write +3 (insight, procedural, preference)',
    'router.fallback voidai → claude-cli',
    'dream.cycle ready @03:00',
  ];
  const line = lines[tick % lines.length];
  return (
    <footer className="footer mono" style={{
      borderTop: '1px solid var(--line)',
      background: 'rgba(0,8,20,0.85)',
      display: 'flex', alignItems: 'center', gap: 14, padding: '0 14px',
      fontSize: 10, color: 'var(--muted)',
      letterSpacing: '0.06em',
    }}>
      <span style={{ color: 'var(--neon)' }}>● tx</span>
      <span style={{ color: 'var(--text-soft)' }}>{line}<span className="blink">_</span></span>
      <span style={{ flex: 1 }} />
      <span>fps 60</span>
      <span>cpu 11%</span>
      <span>mem 184mb</span>
      <span style={{ color: 'var(--neon-2)' }}>● secure tunnel</span>
      <span style={{ color: 'var(--green)' }}>● 03:14:09 UTC</span>
    </footer>
  );
};

const PageHeader = ({ title, subtitle, right }) => (
  <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
    <div>
      <div className="label-tiny" style={{ color: 'var(--neon-2)' }}>// section</div>
      <h1 style={{ margin: '4px 0 6px', fontFamily: 'var(--display)', fontWeight: 600, fontSize: 28, letterSpacing: '-0.01em' }}>
        {title}
        <span className="blink neonc" style={{ marginLeft: 8, fontSize: 22 }}>_</span>
      </h1>
      {subtitle && <div className="muted mono" style={{ fontSize: 12 }}>{subtitle}</div>}
    </div>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{right}</div>
  </div>
);

const Section = ({ title, right, children, padded = true }) => (
  <div className="nc-panel glow" style={{ padding: padded ? 16 : 0, marginBottom: 16 }}>
    {(title || right) && (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: padded ? 14 : 0, padding: padded ? 0 : '12px 14px', borderBottom: padded ? 'none' : '1px solid var(--line-soft)' }}>
        <div className="label-tiny" style={{ color: 'var(--neon)' }}>{title}</div>
        <div style={{ display: 'flex', gap: 8 }}>{right}</div>
      </div>
    )}
    {children}
  </div>
);

const StatCard = ({ label, value, sub, tone = 'cyan', icon }) => (
  <div className="nc-panel glow tilt" style={{ padding: 14, position: 'relative', overflow: 'hidden' }}>
    <div className="stripe-bg" style={{ position: 'absolute', inset: 0, opacity: 0.3, pointerEvents: 'none' }} />
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="label-tiny">{label}</div>
        {icon && <Icon name={icon} size={14} className={tone === 'cyan' ? 'neonc' : tone === 'violet' ? 'violetc' : 'amberc'} />}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 28, fontWeight: 600, marginTop: 6, color: 'var(--text)', textShadow: '0 0 12px rgba(0,183,255,0.35)' }}>
        {value}
      </div>
      <div className="mono" style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>
    </div>
  </div>
);

Object.assign(window, { Sidebar, TopBar, FooterTerminal, PageHeader, Section, StatCard, StatusChip });
