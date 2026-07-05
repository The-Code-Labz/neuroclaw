/* App entry */
import React from 'react';
import ReactDOM from 'react-dom/client';

// Mobile bottom navigation for PWA experience
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
             href={`/dashboard#${item.id}`}
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

// ── Per-page code-splitting (Dashboard v3 §3.4) ─────────────────────────────
// Page modules have NO default export — they are side-effect modules that set a
// window global (e.g. window.Overview). So a bare React.lazy(() => import()) is
// wrong. lazyPage() evaluates the chunk (which assigns the global), then resolves
// to a component reading that global. A <React.Suspense> boundary wraps <Page/>.
// On a stale-deploy chunk 404 it auto-reloads once (sessionStorage guard), then
// shows the existing "module failed to load — refresh" panel.
const ChunkFail = ({ name }) => (
  <div className="mono muted" style={{ padding: 32 }}>{name} module failed to load — refresh the page.</div>
);
const lazyPage = (loader, globalName) =>
  React.lazy(async () => {
    const guard = 'nc_chunk_reload_' + globalName;
    try {
      await loader(); // evaluates the chunk → assigns window[globalName]
      if (typeof window[globalName] === 'undefined') throw new Error('global ' + globalName + ' not assigned');
      sessionStorage.removeItem(guard); // healthy load — re-arm the reload guard
      return { default: () => React.createElement(window[globalName]) };
    } catch (err) {
      if (!sessionStorage.getItem(guard)) {
        // Likely a stale deploy (chunk URL 404s). Reload once to fetch fresh assets.
        sessionStorage.setItem(guard, '1');
        location.reload();
        return { default: () => null };
      }
      console.error('[lazyPage]', globalName, err);
      return { default: () => React.createElement(ChunkFail, { name: globalName }) };
    }
  });

// PAGES = the 11 consolidated nav pages (v3 §1). Merged parents bundle their
// sub-views into their own chunk and own the #page/subtab hash via SubTabs.
// Sessions folded into Chat as a left rail; #sessions redirects to #chat.
const PAGES = {
  // ── CORE ──
  overview:    { label: 'Overview',        cmp: lazyPage(() => import('./page-overview.jsx'),     'Overview')    },
  chat:        { label: 'Chat',            cmp: lazyPage(() => import('./page-chat.jsx'),         'Chat')        },
  agents:      { label: 'Agents',          cmp: lazyPage(() => import('./page-agents-hub.jsx'),   'AgentsHub')   }, // Agents · Comms · Hive Mind
  tasks:       { label: 'Mission Control', cmp: lazyPage(() => import('./page-tasks-hub.jsx'),    'TasksHub')    }, // Tasks · Automation
  studio:      { label: 'Studio',          cmp: lazyPage(() => import('./page-studio.jsx'),       'Studio')      }, // Canvas · NeuroLab · Terminal · Neuro Room
  // ── MIND ──
  memory:      { label: 'Memory',          cmp: lazyPage(() => import('./page-memory-hub.jsx'),   'MemoryHub')   }, // Memory · Vault · Dream
  // ── SYSTEM ──
  connect:     { label: 'Connect',         cmp: lazyPage(() => import('./page-connect-hub.jsx'),  'ConnectHub')  }, // Providers · MCP · Skills · Channels · Composio
  security:    { label: 'Security',        cmp: lazyPage(() => import('./page-security.jsx'),     'Security')    }, // Sentinel · Approvals · Secrets
  // ── OBSERVE ──
  observability: { label: 'Observability', cmp: lazyPage(() => import('./page-observability.jsx'), 'Observability') }, // Analytics · Usage · Health · Logs
  settings:    { label: 'Settings',        cmp: lazyPage(() => import('./page-settings.jsx'),     'Settings')    },
  docs:        { label: 'Docs',            cmp: lazyPage(() => import('./page-docs.jsx'),         'Docs')        },
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#00b7ff",
  "accent2": "#00f5d4",
  "violet": "#a78bfa",
  "scanlines": false,
  "gridOverlay": false,
  "density": "comfy",
  "page": "overview"
}/*EDITMODE-END*/;

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
      <div className="nc-panel glow" onClick={e => e.stopPropagation()} style={{ width: 560, maxHeight: '70vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="cmd" size={14} className="neonc"/>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="type a command or page..." style={{ flex: 1, background: 'transparent', border: 0, outline: 0, color: '#fff', fontFamily: 'var(--mono)', fontSize: 13 }}/>
          <span className="blink neonc">▌</span>
        </div>
        <div style={{ overflow: 'auto', maxHeight: '50vh' }}>
          {filtered.map((it, i) => (
            <div key={i} onClick={it.do} className="mono" style={{ padding: '10px 16px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer', borderBottom: '1px dashed rgba(0,183,255,0.06)', fontSize: 12 }}
                 onMouseOver={e => e.currentTarget.style.background = 'rgba(0,183,255,0.08)'}
                 onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
              <span><span className={`tag ${it.kind === 'goto' ? 'blue' : 'cyan'}`} style={{ fontSize: 9, marginRight: 8 }}>{it.kind}</span>{it.label}</span>
              <span className="muted" style={{ fontSize: 10 }}>{it.hint}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ── Hash routing: #page/subtab + back-compat redirects (Dashboard v3 §1) ────
// As pages merge, old single-segment hashes redirect to their new parent/subtab
// home so bookmarks, nc-goto events, and hardcoded hash jumps keep working.
const REDIRECTS = {
  // Chat (Sessions folded into the Chat left rail)
  sessions:  'chat',
  // Observability
  analytics: 'observability/analytics',
  usage:     'observability/usage',
  health:    'observability/health',
  logs:      'observability/logs',
  // Memory
  vault:     'memory/vault',
  dream:     'memory/dream',
  // Agents
  comms:     'agents/comms',
  hivemind:  'agents/hivemind',
  // Mission Control
  automation: 'tasks/automation',
  // Studio
  canvas:    'studio/canvas',
  neurolab:  'studio/neurolab',
  terminal:  'studio/terminal',
  neuroroom: 'studio/neuroroom',
  // Connect
  providers:   'connect/providers',
  mcp:         'connect/mcp',
  skills:      'connect/skills',
  channels:    'connect/channels',
  connections: 'connect/composio',
  // Security
  sentinel:  'security/sentinel',
  approvals: 'security/approvals',
  secrets:   'security/secrets',
};
// Resolve location.hash → a known top-level page id (first segment), applying
// redirects (and rewriting the hash in place). Returns null if unknown.
const resolvePage = () => {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return null;
  let page = raw.split('/')[0];
  if (REDIRECTS[page]) {
    history.replaceState(null, '', '/dashboard#' + REDIRECTS[page]);
    page = REDIRECTS[page].split('/')[0];
  }
  return PAGES[page] ? page : null;
};

// Catches render-time throws in a page so one bad page never blanks the whole
// app (React.lazy/Suspense only handle chunk *load* errors, not render errors).
// Keyed by the active page in App, so navigating away clears the error state.
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
    history.pushState(null, '', '/dashboard#' + page);
  }, []);
  
  // Auto-collapse sidebar based on screen width
  // < 640px: hidden (mobile menu takes over)
  // 640-1024px: collapsed (icons only)
  // > 1024px: expanded
  const getInitialCollapsed = () => window.innerWidth < 1024;
  const [collapsed, setCollapsed] = React.useState(getInitialCollapsed);
  
  // Listen for resize and auto-collapse/expand
  React.useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      if (width < 1024) {
        setCollapsed(true);
      }
      // Don't auto-expand - let user control that
    };
    window.addEventListener('resize', handleResize);
    // Run once on mount
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  
  const [cmd, setCmd] = React.useState(false);
  const [serverConfig, setServerConfig] = React.useState(() =>
    isStandalone() ? getStoredServer() : 'local'
  );
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  // Re-render whenever live-data refreshes window.NC_DATA.
  const [, setDataTick] = React.useState(0);

  React.useEffect(() => {
    const onTick = () => setDataTick(t => t + 1);
    window.addEventListener('nc-data-tick', onTick);
    return () => window.removeEventListener('nc-data-tick', onTick);
  }, []);

  // Back/forward button support.
  React.useEffect(() => {
    const onPop = () => {
      const p = resolvePage();
      if (p) setActiveState(p);
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop); // catch location.hash= jumps + apply redirects
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('hashchange', onPop); };
  }, []);

  // Cross-page nav (e.g. Sessions "open" button jumps to Chat).
  React.useEffect(() => {
    const onGoto = (e) => {
      if (e?.detail?.page) {
        const page = e.detail.page;
        if (REDIRECTS[page]) {
          history.pushState(null, '', '/dashboard#' + REDIRECTS[page]);
          setActiveState(REDIRECTS[page].split('/')[0]);
        } else {
          setActive(page);
        }
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
    const handler = (e) => {
      e.preventDefault();
      window.__pwaInstallPrompt = e;
      window.dispatchEvent(new Event('pwa-install-available'));
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  React.useEffect(() => {
    if (serverConfig && serverConfig !== 'local') {
      window.__ncServer = serverConfig;
    }
  }, [serverConfig]);

  React.useEffect(() => {
    const r = document.documentElement;
    // Write the new token names (canonical) plus legacy aliases for unmigrated styles.
    r.style.setProperty('--accent', tweaks.accent);
    r.style.setProperty('--accent-2', tweaks.accent2);
    r.style.setProperty('--violet', tweaks.violet);
  }, [tweaks.accent, tweaks.accent2, tweaks.violet]);

  const Page = PAGES[active]?.cmp || PAGES.overview.cmp;
  const label = PAGES[active]?.label || 'Overview';

  if (serverConfig === null) {
    return <ConnectScreen onConnected={(cfg) => {
      window.__ncServer = cfg;
      setServerConfig(cfg);
    }} />;
  }

  return (
    <>
      {!tweaks.scanlines && <style>{`body::after{display:none}`}</style>}
      {!tweaks.gridOverlay && <style>{`body::before{display:none}`}</style>}
      <div className={`app ${collapsed ? 'collapsed' : ''}`} data-screen-label={`${active}`}>
        <Sidebar active={active} setActive={setActive} collapsed={collapsed} setCollapsed={setCollapsed}/>
        <TopBar activeLabel={label} onCmd={() => setCmd(true)}/>
        <main className="main" style={{ padding: tweaks.density === 'compact' ? 14 : 22 }}>
          <PageErrorBoundary key={active}>
            <React.Suspense fallback={<div className="mono muted" style={{ padding: 32, opacity: 0.6 }}>loading…</div>}>
              <Page/>
            </React.Suspense>
          </PageErrorBoundary>
        </main>
        <FooterTerminal/>
      </div>

      <CommandPalette open={cmd} onClose={() => setCmd(false)} setActive={setActive}/>
      
      {/* Mobile bottom nav for PWA */}
      <MobileBottomNav active={active} setActive={setActive} />

      <window.TweaksPanel title="NEUROCLAW · TWEAKS">
        <window.TweakSection title="Theme">
          <window.TweakColor label="Primary neon" value={tweaks.accent} onChange={v => setTweak('accent', v)}/>
          <window.TweakColor label="Secondary neon" value={tweaks.accent2} onChange={v => setTweak('accent2', v)}/>
          <window.TweakColor label="Violet" value={tweaks.violet} onChange={v => setTweak('violet', v)}/>
        </window.TweakSection>
        <window.TweakSection title="FX">
          <window.TweakToggle label="Scanlines" value={tweaks.scanlines} onChange={v => setTweak('scanlines', v)}/>
          <window.TweakToggle label="Grid overlay" value={tweaks.gridOverlay} onChange={v => setTweak('gridOverlay', v)}/>
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
