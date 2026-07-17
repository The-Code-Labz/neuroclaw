/* App entry v4 — Calm Instrument */
import React from 'react';
import ReactDOM from 'react-dom/client';

const MobileBottomNav = ({ active, setActive }) => {
  const quickNavItems = [
    { id: 'overview', label: 'Home', icon: 'overview' },
    { id: 'chat', label: 'Chat', icon: 'chat' },
    { id: 'agents', label: 'Agents', icon: 'agents' },
    { id: 'tasks', label: 'Tasks', icon: 'tasks' },
    { id: 'memory', label: 'Memory', icon: 'memory' },
  ];
  return (
    <nav className="mobile-bottom-nav">
      <div className="mobile-bottom-nav-inner">
        {quickNavItems.map(item => (
          <a key={item.id}
             href={`/dashboard-v4#${item.id}`}
             className={active === item.id ? 'active' : ''}
             onClick={e => { e.preventDefault(); setActive(item.id); }}>
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
          </a>
        ))}
      </div>
    </nav>
  );
};

const ChunkFail = ({ name }) => (
  <div className="mono muted" style={{ padding: 32 }}>{name} module failed to load — refresh the page.</div>
);

// ── Update-available banner ─────────────────────────────────────────────────
// Polls /api/version?remote=1 once on mount. When the origin has a newer stable
// tag than this checkout, shows a dismissible banner telling the operator to run
// ./update.sh (see README › Updating). Dismissal is remembered per-version so it
// stops nagging until the *next* release. Fails silent/offline — never blocks UI.
const UpdateBanner = () => {
  const [info, setInfo] = React.useState(null);
  const [dismissed, setDismissed] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await window.NC_API.get('/api/version?remote=1');
        if (!alive || !d || !d.updateAvailable || !d.latest) return;
        if (localStorage.getItem('nc_update_dismissed') === d.latest) setDismissed(true);
        setInfo(d);
      } catch { /* offline / no remote — stay quiet */ }
    })();
    return () => { alive = false; };
  }, []);
  if (!info || dismissed) return null;
  const dismiss = () => {
    try { localStorage.setItem('nc_update_dismissed', info.latest); } catch { /* ignore */ }
    setDismissed(true);
  };
  return (
    <div className="update-banner" role="status" style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px', marginBottom: 16, borderRadius: 8,
      background: 'rgba(0, 200, 120, 0.10)',
      border: '1px solid rgba(0, 200, 120, 0.35)', fontSize: 13,
    }}>
      <Icon name="refresh" size={18} />
      <div style={{ flex: 1 }}>
        <strong>Update available — {info.latest}</strong>
        <span className="muted" style={{ marginLeft: 8 }}>
          you're on {info.currentTag || info.version}. Run <code>./update.sh</code> to upgrade.
        </span>
      </div>
      <button onClick={dismiss} title="Dismiss until next release"
        style={{ background: 'none', border: 'none', cursor: 'pointer', opacity: 0.7, color: 'inherit', fontSize: 18, lineHeight: 1 }}>
        ×
      </button>
    </div>
  );
};

const lazyPage = (loader, globalName) =>
  React.lazy(async () => {
    const guard = 'nc_chunk_reload_' + globalName;
    try {
      await loader();
      if (typeof window[globalName] === 'undefined') throw new Error('global ' + globalName + ' not assigned');
      sessionStorage.removeItem(guard);
      return { default: () => React.createElement(window[globalName]) };
    } catch (err) {
      if (!sessionStorage.getItem(guard)) {
        sessionStorage.setItem(guard, '1');
        location.reload();
        return { default: () => null };
      }
      console.error('[lazyPage]', globalName, err);
      return { default: () => React.createElement(ChunkFail, { name: globalName }) };
    }
  });

const PAGES = {
  // v4 redesigned overview
  overview:    { label: 'Overview',        cmp: lazyPage(() => import('./page-overview.jsx'),     'Overview')    },
  // v4 redesigned pages
  notes:       { label: 'Notes',           cmp: lazyPage(() => import('./page-notes.jsx'),                  'Notes')       },
  studio:      { label: 'Studio',          cmp: lazyPage(() => import('./page-studio.jsx'),                 'Studio')      },
  // remaining pages reused from v2
  chat:        { label: 'Chat',            cmp: lazyPage(() => import('../../v2/src/page-chat.jsx'),         'Chat')        },
  agents:      { label: 'Agents',          cmp: lazyPage(() => import('../../v2/src/page-agents-hub.jsx'),   'AgentsHub')   },
  tasks:       { label: 'Mission Control', cmp: lazyPage(() => import('../../v2/src/page-tasks-hub.jsx'),    'TasksHub')    },
  memory:      { label: 'Memory',          cmp: lazyPage(() => import('./page-memory-hub.jsx'),             'MemoryHub')   },
  connect:     { label: 'Connect',         cmp: lazyPage(() => import('../../v2/src/page-connect-hub.jsx'),  'ConnectHub')  },
  security:    { label: 'Security',        cmp: lazyPage(() => import('./page-security-hub.jsx'),           'Security')    },
  observability: { label: 'Observability', cmp: lazyPage(() => import('../../v2/src/page-observability.jsx'), 'Observability') },
  settings:    { label: 'Settings',        cmp: lazyPage(() => import('./page-settings.jsx'),               'Settings')    },
  docs:        { label: 'Docs',            cmp: lazyPage(() => import('../../v2/src/page-docs.jsx'),         'Docs')        },
};

const TWEAK_DEFAULTS = {
  "accent": "#5BCEFF",
  "accent2": "#5BCEFF",
  "density": "comfy",
  "page": "overview"
};

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  navigator.standalone === true;

const getStoredServer = () => {
  try { return JSON.parse(localStorage.getItem('nclaw_server') || 'null'); } catch { return null; }
};

const CommandPalette = ({ open, onClose, setActive }) => {
  const [q, setQ] = React.useState('');
  if (!open) return null;
  const items = [
    ...Object.entries(PAGES).map(([id, p]) => ({ kind: 'goto', label: `Go to ${p.label}`, hint: id, do: () => { setActive(id); onClose(); } })),
    { kind: 'cmd', label: 'Spawn temp agent', hint: 'spawn', do: onClose },
    { kind: 'cmd', label: 'Run dream cycle now', hint: 'dream', do: onClose },
    { kind: 'cmd', label: 'Failover provider', hint: 'failover', do: onClose },
    { kind: 'cmd', label: 'Promote memory by id', hint: 'memory', do: onClose },
  ];
  const filtered = items.filter(it => !q || it.label.toLowerCase().includes(q.toLowerCase()) || it.hint.includes(q.toLowerCase()));
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="nc-panel modal-fixed-width" onClick={e => e.stopPropagation()} style={{ width: 560, maxHeight: '70vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-default)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="cmd" size={14} style={{ color: 'var(--accent)' }}/>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="type a command or page..." style={{ flex: 1, background: 'transparent', border: 0, outline: 0, color: '#fff', fontFamily: 'var(--mono)', fontSize: 13 }}/>
        </div>
        <div style={{ overflow: 'auto', maxHeight: '50vh' }}>
          {filtered.map((it, i) => (
            <div key={i} onClick={it.do} className="mono" style={{ padding: '10px 16px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer', borderBottom: '1px solid var(--border-default)', fontSize: 12 }}
                 onMouseOver={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                 onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
              <span><span className={`tag ${it.kind === 'goto' ? 'violet' : 'muted'}`} style={{ fontSize: 9, marginRight: 8 }}>{it.kind}</span>{it.label}</span>
              <span className="muted" style={{ fontSize: 10 }}>{it.hint}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const REDIRECTS = {
  sessions:  'chat',
  analytics: 'observability/analytics',
  usage:     'observability/usage',
  health:    'observability/health',
  logs:      'observability/logs',
  vault:     'memory/vault',
  dream:     'memory/dream',
  notebooks: 'memory/notebooks',
  comms:     'agents/comms',
  hivemind:  'agents/hivemind',
  automation: 'tasks/automation',
  canvas:    'studio/canvas',
  neurolab:  'studio/neurolab',
  terminal:  'studio/terminal',
  neuroroom: 'studio/neuroroom',
  gallery:   'studio/gallery',
  providers:   'connect/providers',
  mcp:         'connect/mcp',
  skills:      'connect/skills',
  channels:    'connect/channels',
  connections: 'connect/composio',
  sentinel:  'security/sentinel',
  approvals: 'security/approvals',
  secrets:   'security/secrets',
};

const resolvePage = () => {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return null;
  let page = raw.split('/')[0];
  if (REDIRECTS[page]) {
    history.replaceState(null, '', '/dashboard-v4#' + REDIRECTS[page]);
    page = REDIRECTS[page].split('/')[0];
  }
  return PAGES[page] ? page : null;
};

class PageErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) { console.error('[page render error]', err); }
  render() {
    if (this.state.err) {
      return (
        <div className="mono muted" style={{ padding: 32 }}>
          This page hit an error — switch tabs or refresh.
          <div style={{ marginTop: 8, fontSize: 11, opacity: 0.7 }}>{String(this.state.err?.message || this.state.err)}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

const App = () => {
  const initialPage = resolvePage() || (TWEAK_DEFAULTS.page || 'overview');
  const [active, setActiveState] = React.useState(initialPage);
  const setActive = React.useCallback((page) => {
    setActiveState(page);
    history.pushState(null, '', '/dashboard-v4#' + page);
  }, []);

  const getInitialCollapsed = () => window.innerWidth < 1024;
  const [collapsed, setCollapsed] = React.useState(getInitialCollapsed);

  React.useEffect(() => {
    const handleResize = () => { if (window.innerWidth < 1024) setCollapsed(true); };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [cmd, setCmd] = React.useState(false);
  const [serverConfig, setServerConfig] = React.useState(() => isStandalone() ? getStoredServer() : 'local');
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  const [, setDataTick] = React.useState(0);

  React.useEffect(() => {
    const onTick = () => setDataTick(t => t + 1);
    window.addEventListener('nc-data-tick', onTick);
    return () => window.removeEventListener('nc-data-tick', onTick);
  }, []);

  React.useEffect(() => {
    const onPop = () => { const p = resolvePage(); if (p) setActiveState(p); };
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('hashchange', onPop); };
  }, []);

  React.useEffect(() => {
    const onGoto = (e) => {
      if (e?.detail?.page) {
        const page = e.detail.page;
        if (REDIRECTS[page]) {
          history.pushState(null, '', '/dashboard-v4#' + REDIRECTS[page]);
          setActiveState(REDIRECTS[page].split('/')[0]);
        } else { setActive(page); }
      }
      if (e?.detail?.sessionId) window.NC_PENDING_SESSION = e.detail.sessionId;
    };
    window.addEventListener('nc-goto', onGoto);
    return () => window.removeEventListener('nc-goto', onGoto);
  }, [setActive]);

  React.useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmd(c => !c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  React.useEffect(() => {
    const handler = (e) => { e.preventDefault(); window.__pwaInstallPrompt = e; window.dispatchEvent(new Event('pwa-install-available')); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  React.useEffect(() => {
    if (serverConfig && serverConfig !== 'local') window.__ncServer = serverConfig;
  }, [serverConfig]);

  React.useEffect(() => {
    const r = document.documentElement;
    r.style.setProperty('--accent', tweaks.accent);
    r.style.setProperty('--accent-2', tweaks.accent2);
  }, [tweaks.accent, tweaks.accent2]);

  const Page = PAGES[active]?.cmp || PAGES.overview.cmp;
  const label = PAGES[active]?.label || 'Overview';

  if (serverConfig === null) {
    return <ConnectScreen onConnected={(cfg) => { window.__ncServer = cfg; setServerConfig(cfg); }} />;
  }

  return (
    <>
      <div className={`app ${collapsed ? 'collapsed' : ''}`} data-screen-label={`${active}`}>
        <Sidebar active={active} setActive={setActive} collapsed={collapsed} setCollapsed={setCollapsed}/>
        <TopBar activeLabel={label} onCmd={() => setCmd(true)}/>
        <main className="main" style={{ padding: tweaks.density === 'compact' ? 16 : 24 }}>
          <UpdateBanner/>
          <PageErrorBoundary key={active}>
            <React.Suspense fallback={<div className="mono muted" style={{ padding: 32, opacity: 0.6 }}>loading…</div>}>
              <Page/>
            </React.Suspense>
          </PageErrorBoundary>
        </main>
        <FooterTerminal/>
      </div>

      <CommandPalette open={cmd} onClose={() => setCmd(false)} setActive={setActive}/>

      <MobileBottomNav active={active} setActive={setActive} />

      <window.TweaksPanel title="NEUROCLAW · TWEAKS">
        <window.TweakSection title="Theme">
          <window.TweakColor label="Primary accent" value={tweaks.accent} onChange={v => setTweak('accent', v)}/>
          <window.TweakColor label="Secondary accent" value={tweaks.accent2} onChange={v => setTweak('accent2', v)}/>
        </window.TweakSection>
        <window.TweakSection title="Layout">
          <window.TweakRadio label="Density" value={tweaks.density} options={[{value: 'compact', label: 'Compact'}, {value: 'comfy', label: 'Comfy'}]} onChange={v => setTweak('density', v)}/>
        </window.TweakSection>
        <window.TweakSection title="Quick Nav">
          <window.TweakSelect label="Page" value={active} options={Object.entries(PAGES).map(([id, p]) => ({ value: id, label: p.label }))} onChange={v => setActive(v)}/>
        </window.TweakSection>
      </window.TweaksPanel>
    </>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
