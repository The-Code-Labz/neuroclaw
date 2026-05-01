/* App entry */

const PAGES = {
  overview: { label: 'Overview', cmp: () => <Overview/> },
  chat: { label: 'Chat', cmp: () => <Chat/> },
  agents: { label: 'Agents', cmp: () => <Agents/> },
  para: { label: 'PARA Map', cmp: () => <Para/> },
  tasks: { label: 'Mission Control', cmp: () => <Tasks/> },
  sessions: { label: 'Sessions', cmp: () => <Sessions/> },
  memory: { label: 'Memory', cmp: () => <Memory/> },
  vault: { label: 'NeuroVault', cmp: () => <Vault/> },
  dream: { label: 'Dream Cycle', cmp: () => <Dream/> },
  hivemind: { label: 'Hive Mind', cmp: () => <HiveMind/> },
  comms: { label: 'Comms', cmp: () => <Comms/> },
  mcp: { label: 'MCP Tools', cmp: () => <MCP/> },
  providers: { label: 'Providers', cmp: () => <Providers/> },
  analytics: { label: 'Analytics', cmp: () => <Analytics/> },
  logs: { label: 'Logs', cmp: () => <Logs/> },
  settings: { label: 'Settings', cmp: () => <Settings/> },
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#00b7ff",
  "accent2": "#00f5d4",
  "violet": "#8b5cf6",
  "scanlines": true,
  "gridOverlay": true,
  "density": "comfy",
  "page": "overview"
}/*EDITMODE-END*/;

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

const App = () => {
  const [active, setActive] = React.useState(TWEAK_DEFAULTS.page || 'overview');
  const [collapsed, setCollapsed] = React.useState(false);
  const [cmd, setCmd] = React.useState(false);
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);

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
    const r = document.documentElement;
    r.style.setProperty('--neon', tweaks.accent);
    r.style.setProperty('--neon-2', tweaks.accent2);
    r.style.setProperty('--violet', tweaks.violet);
  }, [tweaks.accent, tweaks.accent2, tweaks.violet]);

  const Page = PAGES[active]?.cmp || PAGES.overview.cmp;
  const label = PAGES[active]?.label || 'Overview';

  return (
    <>
      {!tweaks.scanlines && <style>{`body::after{display:none}`}</style>}
      {!tweaks.gridOverlay && <style>{`body::before{display:none}`}</style>}
      <div className={`app ${collapsed ? 'collapsed' : ''}`} data-screen-label={`${active}`}>
        <Sidebar active={active} setActive={setActive} collapsed={collapsed} setCollapsed={setCollapsed}/>
        <TopBar activeLabel={label} onCmd={() => setCmd(true)}/>
        <main className="main" style={{ padding: tweaks.density === 'compact' ? 14 : 22 }}>
          <Page/>
        </main>
        <FooterTerminal/>
      </div>

      <CommandPalette open={cmd} onClose={() => setCmd(false)} setActive={setActive}/>

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
