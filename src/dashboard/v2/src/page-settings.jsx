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

/* ── Spawn Settings (live-wired) ───────────────────────────────────────── */
const SpawnTab = () => {
  const DEFAULT_CFG = { enabled: false, maxDepth: 3, ttlHours: 6, softLimit: 10, hardLimit: 25, autoApprove: true, evalThreshold: 0.7 };
  const [cfg,       setCfg]       = React.useState(DEFAULT_CFG);
  const [draft,     setDraft]     = React.useState(DEFAULT_CFG);
  const [agents,    setAgents]    = React.useState([]);
  const [saving,    setSaving]    = React.useState(false);
  const [saved,     setSaved]     = React.useState(false);
  const [err,       setErr]       = React.useState(null);
  const [addAgent,  setAddAgent]  = React.useState('');

  const isDirty = JSON.stringify(cfg) !== JSON.stringify(draft);

  React.useEffect(() => {
    Promise.all([
      window.NC_API.get('/api/spawn/config'),
      window.NC_API.get('/api/agents'),
    ]).then(([sc, ag]) => {
      setCfg(sc); setDraft(sc);
      setAgents(Array.isArray(ag) ? ag.filter(a => a.status === 'active' && !a.temporary) : []);
    }).catch(e => setErr(e.message));
  }, []);

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const updated = await window.NC_API.patch('/api/spawn/config', draft);
      if (updated && !updated.error) { setCfg(updated); setDraft(updated); setSaved(true); setTimeout(() => setSaved(false), 2000); }
      else setErr(updated?.error || 'Save failed');
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const patch = (key, val) => setDraft(d => ({ ...d, [key]: val }));

  const exemptAgents = agents.filter(a => a.spawn_exempt);
  const nonExempt    = agents.filter(a => !a.spawn_exempt);

  const toggleExempt = async (agent, makeExempt) => {
    try {
      await window.NC_API.patch(`/api/agents/${agent.id}`, { spawn_exempt: makeExempt });
      setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, spawn_exempt: makeExempt } : a));
    } catch (e) { setErr(e.message); }
  };

  const InteractiveToggle = ({ value, onChange }) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} onClick={() => onChange(!value)}>
      <span style={{ width: 32, height: 16, borderRadius: 999, background: value ? 'rgba(0,183,255,0.4)' : 'rgba(100,116,139,0.3)', border: '1px solid var(--line)', position: 'relative', boxShadow: value ? '0 0 8px rgba(0,183,255,0.5)' : 'none' }}>
        <span style={{ position: 'absolute', top: 1, left: value ? 17 : 2, width: 12, height: 12, borderRadius: '50%', background: value ? 'var(--neon)' : '#334155', boxShadow: value ? '0 0 6px var(--neon)' : 'none', transition: 'left 0.15s' }}/>
      </span>
      <span className="mono" style={{ fontSize: 10, color: value ? 'var(--neon-2)' : 'var(--muted)' }}>{value ? 'ENABLED' : 'DISABLED'}</span>
    </span>
  );

  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>// {err}</div>}

      <SettingRow label="Allow temp agents" hint="Master switch — SPAWN_AGENTS_ENABLED">
        <InteractiveToggle value={draft.enabled} onChange={v => patch('enabled', v)}/>
      </SettingRow>
      <SettingRow label="Auto-approve spawns" hint="Skip manual approval for every spawn request">
        <InteractiveToggle value={draft.autoApprove} onChange={v => patch('autoApprove', v)}/>
      </SettingRow>
      <SettingRow label="Max spawn depth" hint="Max recursion depth (1–10). Hard-blocked above this.">
        <input className="nc-input" value={draft.maxDepth} min={1} max={10} type="number"
          onChange={e => patch('maxDepth', parseInt(e.target.value,10) || 1)} style={{ maxWidth: 80 }}/>
      </SettingRow>
      <SettingRow label="TTL (hours)" hint="Temp agents expire after this many hours">
        <input className="nc-input" value={draft.ttlHours} min={0.25} max={72} step={0.25} type="number"
          onChange={e => patch('ttlHours', parseFloat(e.target.value) || 1)} style={{ maxWidth: 100 }}/>
      </SettingRow>
      <SettingRow label="Soft limit" hint="Log warning above this many active temp agents">
        <input className="nc-input" value={draft.softLimit} min={1} max={100} type="number"
          onChange={e => patch('softLimit', parseInt(e.target.value,10) || 1)} style={{ maxWidth: 80 }}/>
      </SettingRow>
      <SettingRow label="Hard limit" hint="Block all new spawns above this count">
        <input className="nc-input" value={draft.hardLimit} min={1} max={200} type="number"
          onChange={e => patch('hardLimit', parseInt(e.target.value,10) || 1)} style={{ maxWidth: 80 }}/>
      </SettingRow>
      <SettingRow label="Eval threshold" hint="Minimum expected benefit (0–1) to approve spawn via LLM gate">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input className="nc-input" value={draft.evalThreshold} min={0} max={1} step={0.05} type="number"
            onChange={e => patch('evalThreshold', parseFloat(e.target.value) || 0)} style={{ maxWidth: 90 }}/>
          <span className="mono muted" style={{ fontSize: 10 }}>({Math.round(draft.evalThreshold*100)}% quality bar)</span>
        </div>
      </SettingRow>

      <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="nc-btn primary" disabled={!isDirty || saving} onClick={save}>
          {saving ? '…' : saved ? '✓ Saved' : 'Save Spawn Config'}
        </button>
        {isDirty && <span className="mono" style={{ fontSize: 10, color: 'var(--amber)' }}>// unsaved changes</span>}
      </div>

      {/* Spawn exceptions */}
      <div style={{ marginTop: 28, borderTop: '1px solid var(--line-soft)', paddingTop: 20 }}>
        <div className="label-tiny neonc" style={{ marginBottom: 12 }}>SPAWN EXCEPTIONS</div>
        <div className="mono muted" style={{ fontSize: 10, marginBottom: 14 }}>
          // agents listed here bypass the evaluateSpawn() LLM gate entirely — their spawn requests are auto-approved
        </div>

        {exemptAgents.length === 0 ? (
          <div className="mono muted" style={{ fontSize: 11, padding: '10px 0' }}>// no exceptions configured</div>
        ) : (
          <div style={{ marginBottom: 12 }}>
            {exemptAgents.map(a => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px dashed rgba(0,183,255,0.06)' }}>
                <span className="dot green" style={{ flexShrink: 0 }}/>
                <span className="mono" style={{ fontSize: 12, color: 'var(--neon-2)', flex: 1 }}>{a.name}</span>
                <span className="tag" style={{ fontSize: 9 }}>{a.role}</span>
                <button className="nc-btn" style={{ fontSize: 10, padding: '3px 8px', color: 'var(--danger)', borderColor: 'rgba(251,59,95,0.4)' }}
                  onClick={() => toggleExempt(a, false)}>Remove</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <select className="nc-input" value={addAgent} onChange={e => setAddAgent(e.target.value)}
            style={{ flex: 1, maxWidth: 280 }}>
            <option value="">— select agent to exempt —</option>
            {nonExempt.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button className="nc-btn primary" disabled={!addAgent}
            onClick={() => { const a = agents.find(x => x.id === addAgent); if (a) { toggleExempt(a, true); setAddAgent(''); } }}>
            + Add Exception
          </button>
        </div>
      </div>
    </>
  );
};

const Settings = () => {
  const tabs = ['Routing','Spawn','Memory','Dream Cycle','Providers','MCP','Exec & Safety','Dashboard','Live .env'];
  const [tab, setTab] = React.useState('Routing');
  const liveConfig = (window.NC_DATA && window.NC_DATA.CONFIG) || [];
  return (
    <div>
      <PageHeader title="Settings" subtitle="// configuration · safety · secrets" right={<>
        <button className="nc-btn"><Icon name="refresh" size={12}/> Reload .env</button>
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
        {tab === 'Spawn' && <SpawnTab/>}
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
        {tab === 'Live .env' && <>
          <div className="mono muted" style={{ fontSize: 11, marginBottom: 10 }}>// pulled from /api/config — secrets redacted server-side</div>
          {liveConfig.length === 0 && <div className="mono muted" style={{ fontSize: 11 }}>// loading…</div>}
          {liveConfig.map((c, i) => (
            <SettingRow key={i} label={c.key} hint={c.description || undefined}>
              {c.is_secret
                ? <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <code className="mono" style={{ background: 'rgba(2,6,23,0.7)', border: '1px solid var(--line)', padding: '6px 10px', fontSize: 11, color: 'var(--text-soft)', borderRadius: 2, flex: 1 }}>{c.value}</code>
                    <span className="tag amber" style={{ fontSize: 9 }}>REDACTED</span>
                  </div>
                : <code className="mono" style={{ background: 'rgba(2,6,23,0.7)', border: '1px solid var(--line)', padding: '6px 10px', fontSize: 11, color: 'var(--text-soft)', borderRadius: 2, display: 'block' }}>{String(c.value)}</code>}
            </SettingRow>
          ))}
        </>}
      </div>
    </div>
  );
};
window.Settings = Settings;
