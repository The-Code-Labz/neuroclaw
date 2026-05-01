/* Settings */
const SettingRow = ({ label, hint, children }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, padding: '12px 0', borderBottom: '1px dashed rgba(0,183,255,0.06)', alignItems: 'center' }}>
    <div>
      <div className="mono" style={{ fontSize: 12, color: '#fff' }}>{label}</div>
      {hint && <div className="mono muted" style={{ fontSize: 10, marginTop: 2 }}>{hint}</div>}
    </div>
    <div>{children}</div>
  </div>
);

const Toggle = ({ on }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
    <span style={{ width: 32, height: 16, borderRadius: 999, background: on ? 'rgba(0,183,255,0.4)' : 'rgba(100,116,139,0.3)', border: '1px solid var(--line)', position: 'relative', boxShadow: on ? '0 0 8px rgba(0,183,255,0.5)' : 'none' }}>
      <span style={{ position: 'absolute', top: 1, left: on ? 17 : 2, width: 12, height: 12, borderRadius: '50%', background: on ? 'var(--neon)' : '#334155', boxShadow: on ? '0 0 6px var(--neon)' : 'none', transition: 'left 0.15s' }}/>
    </span>
    <span className="mono" style={{ fontSize: 10, color: on ? 'var(--neon-2)' : 'var(--muted)' }}>{on ? 'ENABLED' : 'DISABLED'}</span>
  </span>
);

const Redacted = ({ label }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <code className="mono" style={{ background: 'rgba(2,6,23,0.7)', border: '1px solid var(--line)', padding: '6px 10px', fontSize: 11, color: 'var(--text-soft)', borderRadius: 2, flex: 1, fontFamily: 'var(--mono)' }}>{label}······</code>
    <span className="tag amber" style={{ fontSize: 9 }}><Icon name="shield" size={10}/> REDACTED</span>
    <button className="nc-btn ghost" style={{ padding: 6 }}><Icon name="eye" size={12}/></button>
  </div>
);

const Settings = () => {
  const tabs = ['Routing','Spawn','Memory','Dream Cycle','Providers','MCP','Exec & Safety','Dashboard'];
  const [tab, setTab] = React.useState('Routing');
  return (
    <div>
      <PageHeader title="Settings" subtitle="// configuration · safety · secrets" right={<>
        <button className="nc-btn"><Icon name="refresh" size={12}/> Reload .env</button>
        <button className="nc-btn primary">Save</button>
      </>}/>

      <div className="tab-bar" style={{ marginBottom: 12 }}>
        {tabs.map(t => (
          <div key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</div>
        ))}
      </div>

      <div className="nc-panel glow" style={{ padding: 18 }}>
        {tab === 'Routing' && <>
          <SettingRow label="Auto-delegation" hint="Alfred routes ambiguous user msgs">
            <Toggle on/>
          </SettingRow>
          <SettingRow label="Confidence threshold" hint="Below this, ask user">
            <input className="nc-input" defaultValue="0.65" style={{ maxWidth: 120 }}/>
          </SettingRow>
          <SettingRow label="Fallback chain">
            <div style={{ display: 'flex', gap: 6 }}>
              <span className="tag blue">claude-cli</span><Icon name="arrow-right" size={12} className="muted"/>
              <span className="tag blue">voidai</span><Icon name="arrow-right" size={12} className="muted"/>
              <span className="tag blue">anthropic-api</span>
            </div>
          </SettingRow>
        </>}
        {tab === 'Spawn' && <>
          <SettingRow label="Allow temp agents"><Toggle on/></SettingRow>
          <SettingRow label="Max spawn depth" hint="Hard cap on recursion"><input className="nc-input" defaultValue="3" style={{ maxWidth: 80 }}/></SettingRow>
          <SettingRow label="Default TTL"><input className="nc-input" defaultValue="900s" style={{ maxWidth: 120 }}/></SettingRow>
          <SettingRow label="Concurrent temp cap"><input className="nc-input" defaultValue="6" style={{ maxWidth: 80 }}/></SettingRow>
        </>}
        {tab === 'Memory' && <>
          <SettingRow label="Decay rate" hint="Per-day importance reduction"><input className="nc-input" defaultValue="0.04" style={{ maxWidth: 100 }}/></SettingRow>
          <SettingRow label="Auto-promote threshold"><input className="nc-input" defaultValue="0.85" style={{ maxWidth: 100 }}/></SettingRow>
          <SettingRow label="Working window" hint="Last N messages kept hot"><input className="nc-input" defaultValue="32" style={{ maxWidth: 80 }}/></SettingRow>
          <SettingRow label="Persist to vault"><Toggle on/></SettingRow>
        </>}
        {tab === 'Dream Cycle' && <>
          <SettingRow label="Enabled"><Toggle on/></SettingRow>
          <SettingRow label="Schedule (cron)"><input className="nc-input" defaultValue="0 3 * * *" style={{ maxWidth: 200 }}/></SettingRow>
          <SettingRow label="Lookback window"><input className="nc-input" defaultValue="24h" style={{ maxWidth: 100 }}/></SettingRow>
          <SettingRow label="Generate tomorrow plan"><Toggle on/></SettingRow>
        </>}
        {tab === 'Providers' && <>
          <SettingRow label="ANTHROPIC_API_KEY"><Redacted label="sk-ant-"/></SettingRow>
          <SettingRow label="VOIDAI_KEY"><Redacted label="vai-"/></SettingRow>
          <SettingRow label="Claude CLI binary"><input className="nc-input" defaultValue="/usr/local/bin/claude" style={{ maxWidth: 320 }}/></SettingRow>
          <SettingRow label="Default model"><input className="nc-input" defaultValue="claude-opus-4.1" style={{ maxWidth: 240 }}/></SettingRow>
        </>}
        {tab === 'MCP' && <>
          <SettingRow label="NeuroVault URL"><Redacted label="wss://vault."/></SettingRow>
          <SettingRow label="ResearchLM URL"><Redacted label="https://research."/></SettingRow>
          <SettingRow label="InsightsLM URL"><Redacted label="https://insights."/></SettingRow>
          <SettingRow label="MCP timeout"><input className="nc-input" defaultValue="8000ms" style={{ maxWidth: 120 }}/></SettingRow>
        </>}
        {tab === 'Exec & Safety' && <>
          <SettingRow label="Allow exec tools" hint="bash_run, edit, git"><Toggle on/></SettingRow>
          <SettingRow label="Sandbox path"><input className="nc-input" defaultValue="/tmp/nc-sandbox" style={{ maxWidth: 320 }}/></SettingRow>
          <SettingRow label="Block destructive"><Toggle on/></SettingRow>
          <SettingRow label="Approve > P1 actions"><Toggle on/></SettingRow>
          <SettingRow label="Audit all exec"><Toggle on/></SettingRow>
        </>}
        {tab === 'Dashboard' && <>
          <SettingRow label="Dashboard token"><Redacted label="nc-dash-"/></SettingRow>
          <SettingRow label="WebSocket URL"><input className="nc-input" defaultValue="wss://nc.local/ws" style={{ maxWidth: 320 }}/></SettingRow>
          <SettingRow label="Theme accent">
            <div style={{ display: 'flex', gap: 6 }}>
              {['#00b7ff','#00f5d4','#8b5cf6','#facc15'].map(c => <span key={c} style={{ width: 22, height: 22, borderRadius: 4, background: c, boxShadow: `0 0 8px ${c}`, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.2)' }}/>)}
            </div>
          </SettingRow>
        </>}
      </div>
    </div>
  );
};
window.Settings = Settings;
