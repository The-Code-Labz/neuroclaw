/* Settings v4 — configuration, safety, secrets
 *
 * Redesigned for the v4 dark theme. Keeps v2 logic and API calls.
 */
import { THEMES, DEFAULT_THEME_ID, LAYOUTS, DEFAULT_LAYOUT_ID, DESIGNS, DEFAULT_DESIGN_ID } from '../../v2/src/themes/registry.ts';

const SettingRow = ({ label, hint, children }) => (
  <div className="setting-row" style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 18, padding: '14px 0', borderBottom: '1px dashed var(--border-subtle)', alignItems: 'center' }}>
    <div>
      <div className="mono" style={{ fontSize: 13, color: 'var(--text-primary)' }}>{label}</div>
      {hint && <div className="mono muted" style={{ fontSize: 10, marginTop: 3, lineHeight: 1.5 }}>{hint}</div>}
    </div>
    <div>{children}</div>
  </div>
);

const InteractiveToggle = ({ value, onChange }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => onChange(!value)}>
    <span style={{
      width: 36, height: 18, borderRadius: 999,
      background: value ? 'var(--accent-soft-strong)' : 'var(--surface-2)',
      border: `1px solid ${value ? 'var(--accent)' : 'var(--border-default)'}`,
      position: 'relative', transition: 'background 150ms, border-color 150ms'
    }}>
      <span style={{
        position: 'absolute', top: 2, left: value ? 18 : 2,
        width: 12, height: 12, borderRadius: '50%',
        background: value ? 'var(--accent)' : 'var(--text-tertiary)',
        transition: 'left 150ms ease, background 150ms'
      }}/>
    </span>
    <span className="mono" style={{ fontSize: 11, color: value ? 'var(--accent)' : 'var(--text-tertiary)' }}>{value ? 'ENABLED' : 'DISABLED'}</span>
  </span>
);

const useEnvConfig = (keys) => {
  const [values, setValues] = React.useState({});
  const [original, setOriginal] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [err, setErr] = React.useState(null);

  React.useEffect(() => {
    window.NC_API.get('/api/env').then(res => {
      const vars = Array.isArray(res) ? res : (res.variables || []);
      const relevant = {};
      vars.forEach(v => { if (keys.includes(v.key)) relevant[v.key] = v.value; });
      setValues(relevant); setOriginal(relevant);
    }).catch(e => setErr(e.message)).finally(() => setLoading(false));
  }, []);

  const set = (key, val) => setValues(prev => ({ ...prev, [key]: val }));
  const dirty = Object.keys(values).some(k => values[k] !== original[k]);

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const updates = {};
      Object.keys(values).forEach(k => { if (values[k] !== original[k]) updates[k] = String(values[k]); });
      const res = await window.NC_API.patch('/api/env', { updates });
      if (!res?.success) throw new Error(res?.error || 'Save failed');
      setOriginal({ ...values }); setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return { values, set, dirty, save, saving, saved, err, loading };
};

const SaveBar = ({ dirty, saving, saved, onSave, label = 'Save' }) => (
  <div style={{ marginTop: 18, display: 'flex', gap: 10, alignItems: 'center' }}>
    <button className="nc-btn primary" disabled={!dirty || saving} onClick={onSave}>
      {saving ? '…' : saved ? '✓ Saved' : label}
    </button>
    {dirty && <span className="mono" style={{ fontSize: 11, color: 'var(--warning)' }}>// unsaved changes</span>}
  </div>
);

const SpawnTab = () => {
  const DEFAULT_CFG = { enabled: false, maxDepth: 3, ttlHours: 6, softLimit: 10, hardLimit: 25, autoApprove: true, evalThreshold: 0.7 };
  const [cfg, setCfg] = React.useState(DEFAULT_CFG);
  const [draft, setDraft] = React.useState(DEFAULT_CFG);
  const [agents, setAgents] = React.useState([]);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const [addAgent, setAddAgent] = React.useState('');
  const isDirty = JSON.stringify(cfg) !== JSON.stringify(draft);

  React.useEffect(() => {
    Promise.all([window.NC_API.get('/api/spawn/config'), window.NC_API.get('/api/agents')])
      .then(([sc, ag]) => { setCfg(sc); setDraft(sc); setAgents(Array.isArray(ag) ? ag.filter(a => a.status === 'active' && !a.temporary) : []); })
      .catch(e => setErr(e.message));
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
  const nonExempt = agents.filter(a => !a.spawn_exempt);

  const toggleExempt = async (agent, makeExempt) => {
    try {
      await window.NC_API.patch(`/api/agents/${agent.id}`, { spawn_exempt: makeExempt });
      setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, spawn_exempt: makeExempt } : a));
    } catch (e) { setErr(e.message); }
  };

  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>// {err}</div>}
      <SettingRow label="Allow temp agents" hint="Master switch — SPAWN_AGENTS_ENABLED">
        <InteractiveToggle value={draft.enabled} onChange={v => patch('enabled', v)}/>
      </SettingRow>
      <SettingRow label="Auto-approve spawns" hint="Skip manual approval for every spawn request">
        <InteractiveToggle value={draft.autoApprove} onChange={v => patch('autoApprove', v)}/>
      </SettingRow>
      <SettingRow label="Max spawn depth" hint="Max recursion depth (1–10). Hard-blocked above this.">
        <input className="nc-input" value={draft.maxDepth} min={1} max={10} type="number"
          onChange={e => patch('maxDepth', parseInt(e.target.value,10) || 1)} style={{ maxWidth: 90, fontSize: 13 }}/>
      </SettingRow>
      <SettingRow label="TTL (hours)" hint="Temp agents expire after this many hours">
        <input className="nc-input" value={draft.ttlHours} min={0.25} max={72} step={0.25} type="number"
          onChange={e => patch('ttlHours', parseFloat(e.target.value) || 1)} style={{ maxWidth: 110, fontSize: 13 }}/>
      </SettingRow>
      <SettingRow label="Soft limit" hint="Log warning above this many active temp agents">
        <input className="nc-input" value={draft.softLimit} min={1} max={100} type="number"
          onChange={e => patch('softLimit', parseInt(e.target.value,10) || 1)} style={{ maxWidth: 90, fontSize: 13 }}/>
      </SettingRow>
      <SettingRow label="Hard limit" hint="Block all new spawns above this count">
        <input className="nc-input" value={draft.hardLimit} min={1} max={200} type="number"
          onChange={e => patch('hardLimit', parseInt(e.target.value,10) || 1)} style={{ maxWidth: 90, fontSize: 13 }}/>
      </SettingRow>
      <SettingRow label="Eval threshold" hint="Minimum expected benefit (0–1) to approve spawn via LLM gate">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input className="nc-input" value={draft.evalThreshold} min={0} max={1} step={0.05} type="number"
            onChange={e => patch('evalThreshold', parseFloat(e.target.value) || 0)} style={{ maxWidth: 100, fontSize: 13 }}/>
          <span className="mono muted" style={{ fontSize: 11 }}>({Math.round(draft.evalThreshold*100)}% quality bar)</span>
        </div>
      </SettingRow>
      <SaveBar dirty={isDirty} saving={saving} saved={saved} onSave={save} label="Save Spawn Config"/>

      <div style={{ marginTop: 32, borderTop: '1px solid var(--border-subtle)', paddingTop: 24 }}>
        <div className="label-tiny" style={{ marginBottom: 14, color: 'var(--accent)' }}>SPAWN EXCEPTIONS</div>
        <div className="mono muted" style={{ fontSize: 11, marginBottom: 16 }}>
          // agents listed here bypass the evaluateSpawn() LLM gate entirely — their spawn requests are auto-approved
        </div>
        {exemptAgents.length === 0 ? (
          <div className="mono muted" style={{ fontSize: 12, padding: '12px 0' }}>// no exceptions configured</div>
        ) : (
          <div style={{ marginBottom: 14 }}>
            {exemptAgents.map(a => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px dashed var(--border-subtle)' }}>
                <span className="dot green" style={{ flexShrink: 0 }}/>
                <span className="mono" style={{ fontSize: 13, color: 'var(--accent)', flex: 1 }}>{a.name}</span>
                <span className="tag muted" style={{ fontSize: 10 }}>{a.role}</span>
                <button className="nc-btn" style={{ fontSize: 11, padding: '5px 10px', color: 'var(--error)', borderColor: 'rgba(252,165,165,0.35)' }}
                  onClick={() => toggleExempt(a, false)}>Remove</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
          <select className="nc-input" value={addAgent} onChange={e => setAddAgent(e.target.value)} style={{ flex: 1, maxWidth: 320, fontSize: 13 }}>
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

const EnvEditorTab = () => {
  const [envVars, setEnvVars] = React.useState([]);
  const [schema, setSchema] = React.useState({});
  const [draft, setDraft] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const [filter, setFilter] = React.useState('');
  const [showSecrets, setShowSecrets] = React.useState({});
  const [editingKey, setEditingKey] = React.useState(null);

  React.useEffect(() => {
    const load = async () => {
      setLoading(true); setErr(null);
      try {
        const [envRes, schemaRes] = await Promise.all([window.NC_API.get('/api/env'), window.NC_API.get('/api/env/schema')]);
        if (envRes && envRes.error) throw new Error(envRes.error);
        const variables = Array.isArray(envRes) ? envRes : (envRes.variables || []);
        const schemaArr = Array.isArray(schemaRes) ? schemaRes : (schemaRes.schema || []);
        const schemaMap = {};
        if (Array.isArray(schemaArr)) schemaArr.forEach(s => { schemaMap[s.key] = s; });
        else Object.assign(schemaMap, schemaArr);
        setEnvVars(variables); setSchema(schemaMap);
        const draftObj = {}; variables.forEach(v => { draftObj[v.key] = v.value; }); setDraft(draftObj);
      } catch (e) { setErr(e.message); }
      finally { setLoading(false); }
    };
    load();
  }, []);

  const dirtyKeys = React.useMemo(() => {
    const dirty = [];
    envVars.forEach(v => { if (draft[v.key] !== undefined && draft[v.key] !== v.value) dirty.push(v.key); });
    return dirty;
  }, [envVars, draft]);
  const isDirty = dirtyKeys.length > 0;

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const updates = {}; dirtyKeys.forEach(key => { updates[key] = draft[key]; });
      const res = await window.NC_API.patch('/api/env', { updates });
      if (res && res.error) throw new Error(res.error + (res.details ? ': ' + JSON.stringify(res.details) : ''));
      if (!res || !res.success) throw new Error('Save failed — no success response');
      setEnvVars(prev => prev.map(v => dirtyKeys.includes(v.key) ? { ...v, value: draft[v.key] } : v));
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const reload = async () => {
    setLoading(true); setErr(null);
    try {
      const envRes = await window.NC_API.get('/api/env');
      if (envRes && envRes.error) throw new Error(envRes.error);
      const variables = Array.isArray(envRes) ? envRes : (envRes.variables || []);
      setEnvVars(variables);
      const draftObj = {}; variables.forEach(v => { draftObj[v.key] = v.value; }); setDraft(draftObj);
      setEditingKey(null);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  const filtered = React.useMemo(() => {
    if (!filter) return envVars;
    const lc = filter.toLowerCase();
    return envVars.filter(v => v.key.toLowerCase().includes(lc) || (schema[v.key]?.description || '').toLowerCase().includes(lc));
  }, [envVars, filter, schema]);

  const grouped = React.useMemo(() => {
    const groups = {};
    filtered.forEach(v => {
      const cat = v.category || schema[v.key]?.category || (v.key.includes('_') ? v.key.split('_')[0] : 'OTHER');
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(v);
    });
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered, schema]);

  const toggleSecret = (key) => setShowSecrets(prev => ({ ...prev, [key]: !prev[key] }));
  const updateDraft = (key, value) => setDraft(prev => ({ ...prev, [key]: value }));
  const resetKey = (key) => { const original = envVars.find(v => v.key === key); if (original) setDraft(prev => ({ ...prev, [key]: original.value })); setEditingKey(null); };

  if (loading) return <div className="mono muted" style={{ fontSize: 12, padding: 24 }}>// loading environment variables…</div>;

  return (
    <>
      {err && (
        <div className="se-banner-danger" style={{ padding: '10px 14px', marginBottom: 14 }}>
          <div className="mono" style={{ color: 'var(--error)', fontSize: 12 }}>// error: {err}</div>
        </div>
      )}
      <div className="flex-wrap-mobile" style={{ marginBottom: 16 }}>
        <div className="page-header-search" style={{ flex: 1, maxWidth: 360 }}>
          <Icon name="search" size={18}/>
          <input placeholder="Filter variables…" value={filter} onChange={e => setFilter(e.target.value)}/>
        </div>
        <button className="nc-btn" onClick={reload} disabled={loading}><Icon name="refresh" size={14}/> Reload</button>
        <button className="nc-btn primary" onClick={save} disabled={!isDirty || saving}>
          {saving ? '…' : saved ? '✓ Saved' : `Save${isDirty ? ` (${dirtyKeys.length})` : ''}`}
        </button>
      </div>
      {isDirty && (
        <div className="mono" style={{ fontSize: 11, color: 'var(--warning)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="alert" size={14}/> {dirtyKeys.length} unsaved change{dirtyKeys.length > 1 ? 's' : ''}: {dirtyKeys.join(', ')}
        </div>
      )}
      {grouped.map(([prefix, vars]) => (
        <div key={prefix} style={{ marginBottom: 24 }}>
          <div className="label-tiny" style={{ marginBottom: 10, color: 'var(--accent)', borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>{prefix}</div>
          {vars.map(v => {
            const desc = schema[v.key]?.description;
            const isSecret = v.isSecret;
            const isEditing = editingKey === v.key;
            const isModified = dirtyKeys.includes(v.key);
            const currentValue = draft[v.key] ?? v.value;
            const showValue = !isSecret || showSecrets[v.key];
            return (
              <div key={v.key} className="setting-row" style={{
                display: 'grid', gridTemplateColumns: '220px 1fr auto', gap: 14, padding: '12px 0',
                borderBottom: '1px dashed var(--border-subtle)', alignItems: 'center',
                background: isModified ? 'rgba(252,211,77,0.04)' : 'transparent'
              }}>
                <div>
                  <div className="mono" style={{ fontSize: 12, color: isModified ? 'var(--warning)' : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {v.key}
                    {isModified && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warning)' }}/>}
                  </div>
                  {desc && <div className="mono muted" style={{ fontSize: 10, marginTop: 3 }}>{desc}</div>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {isEditing ? (
                    <input className="nc-input" value={currentValue}
                      onChange={e => updateDraft(v.key, e.target.value)}
                      onBlur={() => setEditingKey(null)}
                      onKeyDown={e => { if (e.key === 'Escape') resetKey(v.key); if (e.key === 'Enter') setEditingKey(null); }}
                      autoFocus style={{ flex: 1, fontSize: 12 }}
                      type={isSecret && !showValue ? 'password' : 'text'}/>
                  ) : (
                    <code onClick={() => setEditingKey(v.key)} style={{
                      background: 'var(--bg-base)', border: `1px solid ${isModified ? 'var(--warning)' : 'var(--border-default)'}`,
                      padding: '8px 12px', fontSize: 12, color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)',
                      flex: 1, cursor: 'pointer', wordBreak: 'break-all', fontFamily: 'var(--mono)'
                    }}>
                      {isSecret && !showValue ? '••••••••' : (currentValue || <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>empty</span>)}
                    </code>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {isSecret && (
                    <button className="nc-btn ghost" style={{ padding: 8 }} onClick={() => toggleSecret(v.key)} title={showValue ? 'Hide' : 'Show'}>
                      <Icon name={showValue ? 'eyeoff' : 'eye'} size={14}/>
                    </button>
                  )}
                  {isModified && (
                    <button className="nc-btn ghost" style={{ padding: 8, color: 'var(--text-tertiary)' }} onClick={() => resetKey(v.key)} title="Reset">
                      <Icon name="close" size={14}/>
                    </button>
                  )}
                  {isSecret && <span className="tag amber" style={{ fontSize: 9 }}>SECRET</span>}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {filtered.length === 0 && (
        <div className="mono muted" style={{ fontSize: 12, padding: 24, textAlign: 'center' }}>// no variables match "{filter}"</div>
      )}
      <div className="mono muted" style={{ fontSize: 10, marginTop: 24, padding: '14px 0', borderTop: '1px solid var(--border-subtle)' }}>
        // {envVars.length} variables loaded from .env · click value to edit · changes require save to persist
      </div>
    </>
  );
};

const RoutingTab = () => {
  const { values, set, dirty, save, saving, saved, err, loading } = useEnvConfig(['AUTO_DELEGATION_ENABLED', 'AUTO_DELEGATION_MIN_CONFIDENCE', 'ROUTER_MODEL']);
  if (loading) return <div className="mono muted" style={{ fontSize: 12 }}>// loading…</div>;
  const enabled = values['AUTO_DELEGATION_ENABLED'] === 'true';
  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>// {err}</div>}
      <SettingRow label="Auto-delegation" hint="AUTO_DELEGATION_ENABLED — routes ambiguous msgs to specialists">
        <InteractiveToggle value={enabled} onChange={v => set('AUTO_DELEGATION_ENABLED', String(v))}/>
      </SettingRow>
      <SettingRow label="Confidence threshold" hint="AUTO_DELEGATION_MIN_CONFIDENCE — below this, falls back to Alfred">
        <input className="nc-input" value={values['AUTO_DELEGATION_MIN_CONFIDENCE'] ?? '0.65'} type="number"
          min={0} max={1} step={0.05} style={{ maxWidth: 120, fontSize: 13 }}
          onChange={e => set('AUTO_DELEGATION_MIN_CONFIDENCE', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Router model" hint="ROUTER_MODEL — leave blank to use VOIDAI_MODEL">
        <input className="nc-input" value={values['ROUTER_MODEL'] ?? ''} placeholder="(uses VOIDAI_MODEL)"
          style={{ maxWidth: 300, fontSize: 13 }} onChange={e => set('ROUTER_MODEL', e.target.value)}/>
      </SettingRow>
      <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} label="Save Routing Config"/>
    </>
  );
};

const MemoryTab = () => {
  const { values, set, dirty, save, saving, saved, err, loading } = useEnvConfig([
    'MEMORY_IMPORTANCE_THRESHOLD', 'MEMORY_PREINJECT_ENABLED', 'MEMORY_PREINJECT_MAX',
    'MEMORY_EXTRACT_MIN_CHARS', 'MEMORY_PER_SESSION_MAX', 'MEMORY_PER_HOUR_MAX',
  ]);
  if (loading) return <div className="mono muted" style={{ fontSize: 12 }}>// loading…</div>;
  const preinject = (values['MEMORY_PREINJECT_ENABLED'] ?? 'true') !== 'false';
  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>// {err}</div>}
      <SettingRow label="Pre-inject enabled" hint="MEMORY_PREINJECT_ENABLED — inject top memories into every turn">
        <InteractiveToggle value={preinject} onChange={v => set('MEMORY_PREINJECT_ENABLED', String(v))}/>
      </SettingRow>
      <SettingRow label="Pre-inject top-N" hint="MEMORY_PREINJECT_MAX — max memories injected per turn">
        <input className="nc-input" value={values['MEMORY_PREINJECT_MAX'] ?? '5'} type="number" min={1} max={50}
          style={{ maxWidth: 90, fontSize: 13 }} onChange={e => set('MEMORY_PREINJECT_MAX', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Importance threshold" hint="MEMORY_IMPORTANCE_THRESHOLD — min score to persist a memory (0–1)">
        <input className="nc-input" value={values['MEMORY_IMPORTANCE_THRESHOLD'] ?? '0.6'} type="number"
          min={0} max={1} step={0.05} style={{ maxWidth: 100, fontSize: 13 }}
          onChange={e => set('MEMORY_IMPORTANCE_THRESHOLD', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Extract min chars" hint="MEMORY_EXTRACT_MIN_CHARS — skip extraction on short turns">
        <input className="nc-input" value={values['MEMORY_EXTRACT_MIN_CHARS'] ?? '200'} type="number" min={0}
          style={{ maxWidth: 100, fontSize: 13 }} onChange={e => set('MEMORY_EXTRACT_MIN_CHARS', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Per-session cap" hint="MEMORY_PER_SESSION_MAX — max memories stored per session">
        <input className="nc-input" value={values['MEMORY_PER_SESSION_MAX'] ?? '50'} type="number" min={1}
          style={{ maxWidth: 90, fontSize: 13 }} onChange={e => set('MEMORY_PER_SESSION_MAX', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Per-hour cap" hint="MEMORY_PER_HOUR_MAX — max memories stored per hour">
        <input className="nc-input" value={values['MEMORY_PER_HOUR_MAX'] ?? '200'} type="number" min={1}
          style={{ maxWidth: 90, fontSize: 13 }} onChange={e => set('MEMORY_PER_HOUR_MAX', e.target.value)}/>
      </SettingRow>
      <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} label="Save Memory Config"/>
    </>
  );
};

const DreamTab = () => {
  const { values, set, dirty, save, saving, saved, err, loading } = useEnvConfig(['DREAM_ENABLED', 'DREAM_RUN_TIME', 'DREAM_LOOKBACK_HOURS', 'DREAM_MODEL']);
  if (loading) return <div className="mono muted" style={{ fontSize: 12 }}>// loading…</div>;
  const enabled = values['DREAM_ENABLED'] === 'true';
  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>// {err}</div>}
      <SettingRow label="Enabled" hint="DREAM_ENABLED — nightly cognitive consolidation loop">
        <InteractiveToggle value={enabled} onChange={v => set('DREAM_ENABLED', String(v))}/>
      </SettingRow>
      <SettingRow label="Run time" hint="DREAM_RUN_TIME — 24h HH:MM format (e.g. 03:00)">
        <input className="nc-input" value={values['DREAM_RUN_TIME'] ?? '03:00'} placeholder="03:00"
          style={{ maxWidth: 120, fontSize: 13 }} onChange={e => set('DREAM_RUN_TIME', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Lookback hours" hint="DREAM_LOOKBACK_HOURS — how far back to scan sessions">
        <input className="nc-input" value={values['DREAM_LOOKBACK_HOURS'] ?? '24'} type="number" min={1} max={168}
          style={{ maxWidth: 100, fontSize: 13 }} onChange={e => set('DREAM_LOOKBACK_HOURS', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Model override" hint="DREAM_MODEL — blank to use VOIDAI_MODEL">
        <input className="nc-input" value={values['DREAM_MODEL'] ?? ''} placeholder="(uses VOIDAI_MODEL)"
          style={{ maxWidth: 300, fontSize: 13 }} onChange={e => set('DREAM_MODEL', e.target.value)}/>
      </SettingRow>
      <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} label="Save Dream Config"/>
    </>
  );
};

const FamilyEditor = ({ p, onSaved, onError }) => {
  const [model, setModel] = React.useState(p.modelOverride ?? '');
  const [baseURL, setBaseURL] = React.useState(p.baseURLOverride ?? '');
  const [busy, setBusy] = React.useState(null);
  const [showAdv, setShowAdv] = React.useState(!!p.baseURLOverride);
  React.useEffect(() => { setModel(p.modelOverride ?? ''); setBaseURL(p.baseURLOverride ?? ''); }, [p.modelOverride, p.baseURLOverride]);

  const patch = async (kind, body) => {
    setBusy(kind); onError(null);
    try {
      const res = await window.NC_API.patch(`/api/subagent-providers/${p.family}`, body);
      if (!res?.ok) throw new Error(res?.error || 'save failed');
      onSaved(res.providers);
    } catch (e) { onError(e.message); }
    finally { setBusy(null); }
  };

  const noKey = !p.keyPresent;
  const modelDirty = (model.trim() || null) !== (p.modelOverride ?? null);
  const baseURLDirty = (baseURL.trim() || null) !== (p.baseURLOverride ?? null);

  return (
    <div style={{ padding: '16px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{p.label}</div>
          <div className="mono muted" style={{ fontSize: 11 }}>{p.role}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {noKey ? (
            <span className="mono" style={{ fontSize: 11, color: 'var(--warning)' }}>⚠ no key ({p.keyEnv}) — set it in Live .env</span>
          ) : busy === 'toggle' ? (
            <span className="mono muted" style={{ fontSize: 11 }}>// saving…</span>
          ) : (
            <InteractiveToggle value={p.enabled} onChange={v => patch('toggle', { enabled: v })}/>
          )}
          <span className="tag muted" style={{ fontSize: 9 }}>{p.keyPresent ? 'KEY ✓' : 'NO KEY'}</span>
          {p.enabledOverride !== null && <span className="tag amber" style={{ fontSize: 9 }} title="enable state overrides the .env default">ENABLED OVERRIDE</span>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <span className="mono muted" style={{ fontSize: 11, width: 60 }}>model</span>
        <input className="nc-input" value={model} style={{ flex: 1, maxWidth: 340, fontSize: 12 }}
          placeholder={`default: ${p.modelDefault || 'n/a'}`} onChange={e => setModel(e.target.value)}/>
        <button className="nc-btn" disabled={!modelDirty || busy === 'model'} style={{ fontSize: 11, padding: '6px 12px' }}
          onClick={() => patch('model', { model: model.trim() || null })}>{busy === 'model' ? 'saving…' : 'Save'}</button>
        {p.modelOverride && <button className="nc-btn ghost" style={{ fontSize: 11, padding: '5px 10px' }} title="clear override → use env default"
          onClick={() => { setModel(''); patch('model', { model: null }); }}>Reset</button>}
        {p.modelOverride && <span className="tag amber" style={{ fontSize: 9 }}>OVERRIDE</span>}
      </div>
      <div style={{ marginTop: 10 }}>
        {!showAdv ? (
          <button className="nc-btn ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => setShowAdv(true)}>▸ advanced: change provider endpoint</button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="mono muted" style={{ fontSize: 11, width: 60 }}>endpoint</span>
            <input className="nc-input" value={baseURL} style={{ flex: 1, maxWidth: 340, fontSize: 12 }}
              placeholder={`default: ${p.baseURLDefault || 'n/a'}`} onChange={e => setBaseURL(e.target.value)}/>
            <button className="nc-btn" disabled={!baseURLDirty || busy === 'baseURL'} style={{ fontSize: 11, padding: '6px 12px' }}
              onClick={() => patch('baseURL', { baseURL: baseURL.trim() || null })}>{busy === 'baseURL' ? 'saving…' : 'Save'}</button>
            {p.baseURLOverride && <button className="nc-btn ghost" style={{ fontSize: 11, padding: '5px 10px' }} title="clear override → use env default"
              onClick={() => { setBaseURL(''); patch('baseURL', { baseURL: null }); }}>Reset</button>}
            {p.baseURLOverride && <span className="tag amber" style={{ fontSize: 9 }}>OVERRIDE</span>}
          </div>
        )}
        {showAdv && (
          <div className="mono muted" style={{ fontSize: 10, marginTop: 6, marginLeft: 70, lineHeight: 1.5 }}>
            // repoints this family's <b>{p.keyEnv}</b> key at any OpenAI-compatible endpoint (VoidAI / OpenRouter / DeepSeek / Ollama…). The key is unchanged — make sure it's valid for the endpoint you pick.
          </div>
        )}
      </div>
    </div>
  );
};

const SubAgentsTab = () => {
  const [providers, setProviders] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const load = () => {
    window.NC_API.get('/api/subagent-providers')
      .then(res => { if (res?.error) throw new Error(res.error); setProviders(res.providers || []); })
      .catch(e => setErr(e.message));
  };
  React.useEffect(load, []);
  if (err && !providers) return <div className="mono" style={{ color: 'var(--error)', fontSize: 12 }}>// {err}</div>;
  if (!providers) return <div className="mono muted" style={{ fontSize: 12 }}>// loading sub-agent providers…</div>;
  const anyEnabled = providers.some(p => p.enabled);
  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>// {err}</div>}
      <div className="mono muted" style={{ fontSize: 11, marginBottom: 12, lineHeight: 1.5 }}>
        // choose the provider + model for your sub-agents. Every change is live — no restart. Code tasks prefer Kimi, prose tasks prefer MiniMax; whatever's enabled forms the fallback chain. A family with no API key can't be enabled. Blank field = the .env default.
      </div>
      {providers.map(p => <FamilyEditor key={p.family} p={p} onSaved={setProviders} onError={setErr}/>)}
      {!anyEnabled && (
        <div className="se-banner-danger" style={{ padding: '10px 14px', marginTop: 16 }}>
          <div className="mono" style={{ fontSize: 11, color: 'var(--error)' }}>⚠ no sub-agent provider is enabled — every run_subtask call will fail. Enable at least one family above.</div>
        </div>
      )}
      <div className="mono muted" style={{ fontSize: 10, marginTop: 24, padding: '14px 0', borderTop: '1px solid var(--border-subtle)' }}>
        // OVERRIDE = set here, taking precedence over the SUBAGENT_* env default · API keys are managed in the Live .env tab · this panel never shows a key itself
      </div>
    </>
  );
};

const ProvidersTab = () => {
  const KEYS = ['ANTHROPIC_API_KEY','VOIDAI_API_KEY','VOIDAI_BASE_URL','VOIDAI_MODEL','CLAUDE_CLI_COMMAND','GEMINI_API_KEY'];
  const { values, set, dirty, save, saving, saved, err, loading } = useEnvConfig(KEYS);
  const [show, setShow] = React.useState({});
  if (loading) return <div className="mono muted" style={{ fontSize: 12 }}>// loading…</div>;

  const SecretRow = ({ envKey, label, hint, prefix }) => {
    const val = values[envKey] ?? '';
    const revealed = show[envKey];
    return (
      <SettingRow label={label} hint={hint}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input className="nc-input" value={val} type={revealed ? 'text' : 'password'}
            style={{ flex: 1, maxWidth: 400, fontSize: 12 }} onChange={e => set(envKey, e.target.value)} placeholder={val ? '' : `${prefix}…`}/>
          <button className="nc-btn ghost" style={{ padding: 8 }} onClick={() => setShow(s => ({ ...s, [envKey]: !s[envKey] }))}>
            <Icon name={revealed ? 'eyeoff' : 'eye'} size={14}/>
          </button>
          <span className="tag amber" style={{ fontSize: 9 }}>SECRET</span>
        </div>
      </SettingRow>
    );
  };

  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>// {err}</div>}
      <SecretRow envKey="ANTHROPIC_API_KEY" label="Anthropic API key" hint="ANTHROPIC_API_KEY" prefix="sk-ant-"/>
      <SecretRow envKey="GEMINI_API_KEY" label="Gemini API key" hint="GEMINI_API_KEY — required for voice_provider=gemini_live" prefix="AIza"/>
      <SecretRow envKey="VOIDAI_API_KEY" label="VoidAI API key" hint="VOIDAI_API_KEY" prefix="sk-voidai-"/>
      <SettingRow label="VoidAI base URL" hint="VOIDAI_BASE_URL">
        <input className="nc-input" value={values['VOIDAI_BASE_URL'] ?? ''} style={{ maxWidth: 400, fontSize: 13 }}
          onChange={e => set('VOIDAI_BASE_URL', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Default model" hint="VOIDAI_MODEL — used by all agents unless overridden">
        <input className="nc-input" value={values['VOIDAI_MODEL'] ?? ''} style={{ maxWidth: 320, fontSize: 13 }}
          onChange={e => set('VOIDAI_MODEL', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Claude CLI command" hint="CLAUDE_CLI_COMMAND — binary name or full path">
        <input className="nc-input" value={values['CLAUDE_CLI_COMMAND'] ?? 'claude'} style={{ maxWidth: 320, fontSize: 13 }}
          onChange={e => set('CLAUDE_CLI_COMMAND', e.target.value)}/>
      </SettingRow>
      <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} label="Save Provider Config"/>
    </>
  );
};

const McpTab = () => {
  const KEYS = ['NEUROVAULT_MCP_URL','NEUROVAULT_DEFAULT_VAULT','RESEARCHLM_MCP_URL','RESEARCHLM_SEARCH_TOOL','INSIGHTSLM_MCP_URL','INSIGHTSLM_SEARCH_TOOL'];
  const { values, set, dirty, save, saving, saved, err, loading } = useEnvConfig(KEYS);
  const [show, setShow] = React.useState({});
  if (loading) return <div className="mono muted" style={{ fontSize: 12 }}>// loading…</div>;

  const SecretRow = ({ envKey, label, hint }) => {
    const val = values[envKey] ?? '';
    const revealed = show[envKey];
    return (
      <SettingRow label={label} hint={hint}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input className="nc-input" value={val} type={revealed ? 'text' : 'password'}
            style={{ flex: 1, maxWidth: 440, fontSize: 12 }} onChange={e => set(envKey, e.target.value)} placeholder="not set"/>
          <button className="nc-btn ghost" style={{ padding: 8 }} onClick={() => setShow(s => ({ ...s, [envKey]: !s[envKey] }))}>
            <Icon name={revealed ? 'eyeoff' : 'eye'} size={14}/>
          </button>
        </div>
      </SettingRow>
    );
  };

  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>// {err}</div>}
      <SecretRow envKey="NEUROVAULT_MCP_URL" label="NeuroVault URL" hint="NEUROVAULT_MCP_URL — WebSocket URL of the vault server"/>
      <SettingRow label="Default vault" hint="NEUROVAULT_DEFAULT_VAULT — vault name for uncategorized writes">
        <input className="nc-input" value={values['NEUROVAULT_DEFAULT_VAULT'] ?? ''} style={{ maxWidth: 300, fontSize: 13 }}
          placeholder="not set" onChange={e => set('NEUROVAULT_DEFAULT_VAULT', e.target.value)}/>
      </SettingRow>
      <SecretRow envKey="RESEARCHLM_MCP_URL" label="ResearchLM URL" hint="RESEARCHLM_MCP_URL"/>
      <SettingRow label="ResearchLM tool name" hint="RESEARCHLM_SEARCH_TOOL — must match the tool the server exposes">
        <input className="nc-input" value={values['RESEARCHLM_SEARCH_TOOL'] ?? ''} style={{ maxWidth: 300, fontSize: 13 }}
          placeholder="not set" onChange={e => set('RESEARCHLM_SEARCH_TOOL', e.target.value)}/>
      </SettingRow>
      <SecretRow envKey="INSIGHTSLM_MCP_URL" label="InsightsLM URL" hint="INSIGHTSLM_MCP_URL"/>
      <SettingRow label="InsightsLM tool name" hint="INSIGHTSLM_SEARCH_TOOL — must match the tool the server exposes">
        <input className="nc-input" value={values['INSIGHTSLM_SEARCH_TOOL'] ?? ''} style={{ maxWidth: 300, fontSize: 13 }}
          placeholder="not set" onChange={e => set('INSIGHTSLM_SEARCH_TOOL', e.target.value)}/>
      </SettingRow>
      <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} label="Save MCP Config"/>
    </>
  );
};

const ExecTab = () => {
  const { values, set, dirty, save, saving, saved, err, loading } = useEnvConfig([
    'EXEC_TIMEOUT_MS', 'EXEC_OUTPUT_MAX_BYTES', 'EXEC_ROOT', 'EXEC_DEFAULT_CWD', 'EXEC_BASH_DENY',
  ]);
  if (loading) return <div className="mono muted" style={{ fontSize: 12 }}>// loading…</div>;
  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>// {err}</div>}
      <SettingRow label="Timeout (ms)" hint="EXEC_TIMEOUT_MS — max ms a bash_run command can run">
        <input className="nc-input" value={values['EXEC_TIMEOUT_MS'] ?? '60000'} type="number" min={1000}
          style={{ maxWidth: 130, fontSize: 13 }} onChange={e => set('EXEC_TIMEOUT_MS', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Output cap (bytes)" hint="EXEC_OUTPUT_MAX_BYTES — truncate stdout above this">
        <input className="nc-input" value={values['EXEC_OUTPUT_MAX_BYTES'] ?? '200000'} type="number" min={1024}
          style={{ maxWidth: 130, fontSize: 13 }} onChange={e => set('EXEC_OUTPUT_MAX_BYTES', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Sandbox root" hint="EXEC_ROOT — fs boundary; blank = no restriction">
        <input className="nc-input" value={values['EXEC_ROOT'] ?? ''} placeholder="(no restriction)"
          style={{ maxWidth: 360, fontSize: 13 }} onChange={e => set('EXEC_ROOT', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Default CWD" hint="EXEC_DEFAULT_CWD — working dir for exec tools; blank = process.cwd()">
        <input className="nc-input" value={values['EXEC_DEFAULT_CWD'] ?? ''} placeholder="(process.cwd())"
          style={{ maxWidth: 360, fontSize: 13 }} onChange={e => set('EXEC_DEFAULT_CWD', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Bash deny list" hint="EXEC_BASH_DENY — comma-separated prefixes that are blocked">
        <input className="nc-input" value={values['EXEC_BASH_DENY'] ?? ''} placeholder="e.g. rm -rf,dd if="
          style={{ maxWidth: 440, fontSize: 13 }} onChange={e => set('EXEC_BASH_DENY', e.target.value)}/>
      </SettingRow>
      <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} label="Save Exec Config"/>
    </>
  );
};

const DashboardTab = () => {
  const { values, set, dirty, save, saving, saved, err, loading } = useEnvConfig(['DASHBOARD_TOKEN', 'DASHBOARD_PORT']);
  const [showToken, setShowToken] = React.useState(false);
  if (loading) return <div className="mono muted" style={{ fontSize: 12 }}>// loading…</div>;
  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>// {err}</div>}
      <SettingRow label="Dashboard token" hint="DASHBOARD_TOKEN — required on all /dashboard and /api/* routes">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input className="nc-input" value={values['DASHBOARD_TOKEN'] ?? ''} type={showToken ? 'text' : 'password'}
            style={{ flex: 1, maxWidth: 400, fontSize: 12 }} onChange={e => set('DASHBOARD_TOKEN', e.target.value)}/>
          <button className="nc-btn ghost" style={{ padding: 8 }} onClick={() => setShowToken(s => !s)}>
            <Icon name={showToken ? 'eyeoff' : 'eye'} size={14}/>
          </button>
          <span className="tag amber" style={{ fontSize: 9 }}>SECRET</span>
        </div>
      </SettingRow>
      <SettingRow label="Port" hint="DASHBOARD_PORT — restart required to take effect">
        <input className="nc-input" value={values['DASHBOARD_PORT'] ?? '3141'} type="number" min={1024} max={65535}
          style={{ maxWidth: 110, fontSize: 13 }} onChange={e => set('DASHBOARD_PORT', e.target.value)}/>
      </SettingRow>
      <div className="mono muted" style={{ fontSize: 11, marginTop: 10 }}>
        // token changes take effect on next request · port changes require a server restart
      </div>
      <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} label="Save Dashboard Config"/>
    </>
  );
};

const getDashboardToken = () => {
  const urlParams = new URLSearchParams(location.search);
  const token = urlParams.get('token');
  if (token) return token;
  try { return localStorage.getItem('nclaw-token') || ''; } catch { return ''; }
};

/* Mini swatches — same footprint (56×40) across Theme/Layout/Design pickers,
 * mirrored from v2's page-settings.jsx so both dashboards render identically
 * and share the same localStorage keys (theme/layout/design apply live and
 * survive a v3⇄v4 switch). */
const THEME_STORAGE_KEY = 'nc_dashboard_theme';
const LAYOUT_STORAGE_KEY = 'nc_dashboard_layout';
const DESIGN_STORAGE_KEY = 'nc_dashboard_design';
const LEGACY_ACCENT_KEY = 'nc_dashboard_accent';

const ThemeSwatch = ({ theme }) => (
  <div data-theme={theme.id} style={{
    width: 56, height: 40, borderRadius: 8, flexShrink: 0,
    background: 'var(--bg-0, var(--bg-canvas))',
    border: '1px solid var(--line, var(--border-default))',
    position: 'relative', overflow: 'hidden',
  }}>
    <div style={{ position: 'absolute', left: 6, right: 6, bottom: 6, height: 12, borderRadius: 3, background: 'var(--panel, var(--surface-1))' }} />
    <div style={{ position: 'absolute', right: 6, top: 6, width: 10, height: 10, borderRadius: '50%', background: 'var(--accent)' }} />
  </div>
);

const LayoutSwatch = ({ layout }) => {
  const sidebar = parseInt(layout.tokens['--shell-sidebar-width']) || 240;
  const topbar = parseInt(layout.tokens['--shell-topbar-height']) || 56;
  const sbW = Math.round((sidebar / 264) * 20);
  const tbH = Math.round((topbar / 68) * 9);
  return (
    <div style={{
      width: 56, height: 40, borderRadius: 8, flexShrink: 0, overflow: 'hidden',
      border: '1px solid var(--line, var(--border-default))',
      background: 'var(--bg-0, var(--bg-canvas))',
      display: 'grid', gridTemplateColumns: `${sbW}px 1fr`, gridTemplateRows: `${tbH}px 1fr`,
      gap: 2, padding: 3,
    }}>
      <div style={{ gridColumn: '1 / 3', background: 'var(--panel, var(--surface-1))', borderRadius: 2 }} />
      <div style={{ background: 'var(--accent)', opacity: 0.5, borderRadius: 2 }} />
      <div style={{ background: 'var(--panel, var(--surface-1))', borderRadius: 2 }} />
    </div>
  );
};

const DesignSwatch = ({ design }) => (
  <div data-design={design.id} style={{
    width: 56, height: 40, borderRadius: 8, flexShrink: 0, overflow: 'hidden',
    border: '1px solid var(--line, var(--border-default))',
    background: 'var(--bg-0, var(--bg-canvas))',
    position: 'relative', padding: 6,
    display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'center',
  }}>
    <div style={{ height: 14, background: 'var(--panel, var(--surface-1))', border: '1px solid var(--line, var(--border-default))', borderRadius: 'var(--radius-panel)' }} />
    <div style={{ height: 8, width: '70%', background: 'var(--accent)', opacity: 0.55, borderRadius: 'var(--radius-control)' }} />
  </div>
);

const PickerRow = ({ items, activeId, onPick, Swatch, keyProp = 'id' }) => (
  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
    {items.map(item => {
      const active = activeId === item[keyProp];
      return (
        <button
          key={item[keyProp]}
          onClick={() => onPick(item[keyProp])}
          className="nc-btn"
          title={item.description}
          style={{
            alignItems: 'center', gap: 12, padding: 10, minHeight: 0,
            borderColor: active ? 'var(--accent)' : 'var(--line, var(--border-default))',
            background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : undefined,
          }}
        >
          <Swatch theme={item} layout={item} design={item} />
          <div style={{ textAlign: 'left' }}>
            <div style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: 600 }}>{item.label}{active ? ' ✓' : ''}</div>
            <div className="mono muted" style={{ fontSize: 10, maxWidth: 220 }}>{item.description}</div>
          </div>
        </button>
      );
    })}
  </div>
);

const ThemesTab = () => {
  const Section = window.Section;

  const [themeId, setThemeId] = React.useState(() => {
    try { return document.documentElement.dataset.theme || localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME_ID; } catch { return DEFAULT_THEME_ID; }
  });
  const [layoutId, setLayoutId] = React.useState(() => {
    try { return document.documentElement.dataset.layout || localStorage.getItem(LAYOUT_STORAGE_KEY) || DEFAULT_LAYOUT_ID; } catch { return DEFAULT_LAYOUT_ID; }
  });
  const [designId, setDesignId] = React.useState(() => {
    try { return document.documentElement.dataset.design || localStorage.getItem(DESIGN_STORAGE_KEY) || DEFAULT_DESIGN_ID; } catch { return DEFAULT_DESIGN_ID; }
  });

  // One-time cleanup: strip any stale inline --accent override left by the
  // old per-browser accent picker (this tab used to write one directly) so
  // the current theme's registry accent renders on mount.
  React.useEffect(() => {
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-2');
    try { localStorage.removeItem(LEGACY_ACCENT_KEY); } catch {}
  }, []);

  const applyTheme = (id) => {
    document.documentElement.dataset.theme = id;
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-2');
    try { localStorage.setItem(THEME_STORAGE_KEY, id); localStorage.removeItem(LEGACY_ACCENT_KEY); } catch {}
    setThemeId(id);
  };
  const applyLayout = (id) => {
    document.documentElement.dataset.layout = id;
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, id); } catch {}
    setLayoutId(id);
  };
  const applyDesign = (id) => {
    document.documentElement.dataset.design = id;
    try { localStorage.setItem(DESIGN_STORAGE_KEY, id); } catch {}
    setDesignId(id);
  };

  const token = getDashboardToken();
  const v3Href = token ? `/dashboard?token=${encodeURIComponent(token)}` : '/dashboard';

  const groups = [
    { mode: 'dark', label: 'Dark' },
    { mode: 'light', label: 'Light' },
  ].map(g => ({ ...g, themes: THEMES.filter(t => t.mode === g.mode) })).filter(g => g.themes.length);

  return (
    <>
      <Section title="DASHBOARD VERSION">
        <SettingRow label="Active version" hint="Switch between dashboard v4 and the legacy v3 interface">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="mono" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>v4 (current)</span>
            <a href={v3Href} className="nc-btn" style={{ fontSize: 12 }}>
              <Icon name="version-switch" size={14} />
              <span className="mono">v3 (legacy)</span>
            </a>
          </div>
        </SettingRow>
      </Section>

      <Section title="THEME">
        {groups.map(g => (
          <div key={g.mode} style={{ marginBottom: 14 }}>
            {groups.length > 1 && (
              <div className="mono muted" style={{ fontSize: 10, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{g.label}</div>
            )}
            <PickerRow items={g.themes} activeId={themeId} onPick={applyTheme} Swatch={ThemeSwatch}/>
          </div>
        ))}
        <div className="mono muted" style={{ fontSize: 10, marginTop: 4 }}>
          // applies instantly · stored in localStorage · shared with the v3 dashboard
        </div>
      </Section>

      <Section title="LAYOUT">
        <div className="mono muted" style={{ fontSize: 10, marginBottom: 12 }}>
          Density &amp; structure — independent of color. Pair any palette with any layout.
        </div>
        <PickerRow items={LAYOUTS} activeId={layoutId} onPick={applyLayout} Swatch={LayoutSwatch}/>
        <div className="mono muted" style={{ fontSize: 10, marginTop: 10 }}>
          // reshapes the shell live · desktop layout only (mobile stays compact)
        </div>
      </Section>

      <Section title="DESIGN">
        <div className="mono muted" style={{ fontSize: 10, marginBottom: 12 }}>
          Component shape &amp; personality — corner radius and button typography. Independent of color and density; changes the entire dashboard's look.
        </div>
        <PickerRow items={DESIGNS} activeId={designId} onPick={applyDesign} Swatch={DesignSwatch}/>
        <div className="mono muted" style={{ fontSize: 10, marginTop: 10 }}>
          // reshapes buttons/panels/inputs/tags live everywhere · pair any design with any color theme and layout
        </div>
      </Section>
    </>
  );
};

const Settings = () => {
  const SubTabs = window.SubTabs;
  if (!SubTabs) return <div className="mono muted" style={{ padding: 32 }}>// shell loading…</div>;
  const tabs = [
    { id: 'routing', label: 'Routing', render: () => <RoutingTab/> },
    { id: 'spawn', label: 'Spawn', render: () => <SpawnTab/> },
    { id: 'subagents', label: 'Sub-Agents', render: () => <SubAgentsTab/> },
    { id: 'memory', label: 'Memory', render: () => <MemoryTab/> },
    { id: 'dream', label: 'Dream Cycle', render: () => <DreamTab/> },
    { id: 'providers', label: 'Providers', render: () => <ProvidersTab/> },
    { id: 'mcp', label: 'MCP', render: () => <McpTab/> },
    { id: 'exec', label: 'Exec & Safety', render: () => <ExecTab/> },
    { id: 'dashboard', label: 'Dashboard', render: () => <DashboardTab/> },
    { id: 'themes', label: 'Themes', render: () => <ThemesTab/> },
    { id: 'env', label: 'Live .env', render: () => <EnvEditorTab/> },
  ];
  return (
    <div>
      <PageHeader title="Settings" subtitle="// configuration · safety · secrets" right={
        <button className="nc-btn"><Icon name="refresh" size={14}/> Reload .env</button>
      }/>
      <SubTabs pageId="settings" tabs={tabs}/>
    </div>
  );
};

window.Settings = Settings;
