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

const InteractiveToggle = ({ value, onChange }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} onClick={() => onChange(!value)}>
    <span style={{ width: 32, height: 16, borderRadius: 999, background: value ? 'rgba(0,183,255,0.4)' : 'rgba(100,116,139,0.3)', border: '1px solid var(--line)', position: 'relative', boxShadow: value ? '0 0 8px rgba(0,183,255,0.5)' : 'none' }}>
      <span style={{ position: 'absolute', top: 1, left: value ? 17 : 2, width: 12, height: 12, borderRadius: '50%', background: value ? 'var(--accent)' : '#334155', boxShadow: value ? '0 0 6px var(--accent)' : 'none', transition: 'left 0.15s' }}/>
    </span>
    <span className="mono" style={{ fontSize: 10, color: value ? 'var(--accent-2)' : 'var(--muted)' }}>{value ? 'ENABLED' : 'DISABLED'}</span>
  </span>
);

/* Shared hook — loads specific env keys and exposes save */
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
      setValues(relevant);
      setOriginal(relevant);
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
      setOriginal({ ...values });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return { values, set, dirty, save, saving, saved, err, loading };
};

const SaveBar = ({ dirty, saving, saved, onSave, label = 'Save' }) => (
  <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
    <button className="nc-btn primary" disabled={!dirty || saving} onClick={onSave}>
      {saving ? '…' : saved ? '✓ Saved' : label}
    </button>
    {dirty && <span className="mono" style={{ fontSize: 10, color: 'var(--amber)' }}>// unsaved changes</span>}
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

      <SaveBar dirty={isDirty} saving={saving} saved={saved} onSave={save} label="Save Spawn Config"/>

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
                <span className="mono" style={{ fontSize: 12, color: 'var(--accent-2)', flex: 1 }}>{a.name}</span>
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

/* ── Env Editor Tab (live .env management) ─────────────────────────────── */
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

  // Load env vars and schema
  React.useEffect(() => {
    const load = async () => {
      setLoading(true);
      setErr(null);
      try {
        const [envRes, schemaRes] = await Promise.all([
          window.NC_API.get('/api/env'),
          window.NC_API.get('/api/env/schema'),
        ]);
        if (envRes && envRes.error) throw new Error(envRes.error);
        // API returns array directly, not wrapped in { variables: [] }
        const variables = Array.isArray(envRes) ? envRes : (envRes.variables || []);
        const schemaArr = Array.isArray(schemaRes) ? schemaRes : (schemaRes.schema || []);
        // Convert schema array to lookup map keyed by variable name
        const schemaMap = {};
        if (Array.isArray(schemaArr)) {
          schemaArr.forEach(s => { schemaMap[s.key] = s; });
        } else {
          Object.assign(schemaMap, schemaArr);
        }
        setEnvVars(variables);
        setSchema(schemaMap);
        // Initialize draft with current values
        const draftObj = {};
        variables.forEach(v => { draftObj[v.key] = v.value; });
        setDraft(draftObj);
      } catch (e) {
        setErr(e.message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Check if any value has changed
  const dirtyKeys = React.useMemo(() => {
    const dirty = [];
    envVars.forEach(v => {
      if (draft[v.key] !== undefined && draft[v.key] !== v.value) {
        dirty.push(v.key);
      }
    });
    return dirty;
  }, [envVars, draft]);

  const isDirty = dirtyKeys.length > 0;

  // Save changes
  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const updates = {};
      dirtyKeys.forEach(key => { updates[key] = draft[key]; });
      const res = await window.NC_API.patch('/api/env', { updates });
      if (res && res.error) throw new Error(res.error + (res.details ? ': ' + JSON.stringify(res.details) : ''));
      if (!res || !res.success) throw new Error('Save failed — no success response');
      // Update local state with saved values
      setEnvVars(prev => prev.map(v => dirtyKeys.includes(v.key) ? { ...v, value: draft[v.key] } : v));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  // Reload from server
  const reload = async () => {
    setLoading(true);
    setErr(null);
    try {
      const envRes = await window.NC_API.get('/api/env');
      if (envRes && envRes.error) throw new Error(envRes.error);
      const variables = Array.isArray(envRes) ? envRes : (envRes.variables || []);
      setEnvVars(variables);
      const draftObj = {};
      variables.forEach(v => { draftObj[v.key] = v.value; });
      setDraft(draftObj);
      setEditingKey(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Filter variables
  const filtered = React.useMemo(() => {
    if (!filter) return envVars;
    const lc = filter.toLowerCase();
    return envVars.filter(v => 
      v.key.toLowerCase().includes(lc) || 
      (schema[v.key]?.description || '').toLowerCase().includes(lc)
    );
  }, [envVars, filter, schema]);

  // Group by category (from schema or env response) with prefix fallback
  const grouped = React.useMemo(() => {
    const groups = {};
    filtered.forEach(v => {
      const cat = v.category || schema[v.key]?.category || (v.key.includes('_') ? v.key.split('_')[0] : 'OTHER');
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(v);
    });
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered, schema]);

  const toggleSecret = (key) => {
    setShowSecrets(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const updateDraft = (key, value) => {
    setDraft(prev => ({ ...prev, [key]: value }));
  };

  const resetKey = (key) => {
    const original = envVars.find(v => v.key === key);
    if (original) {
      setDraft(prev => ({ ...prev, [key]: original.value }));
    }
    setEditingKey(null);
  };

  if (loading) {
    return <div className="mono muted" style={{ fontSize: 11, padding: 20 }}>// loading environment variables…</div>;
  }

  return (
    <>
      {err && (
        <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10, padding: '8px 12px', background: 'rgba(251,59,95,0.1)', border: '1px solid rgba(251,59,95,0.3)', borderRadius: 4 }}>
          // error: {err}
        </div>
      )}

      {/* Header controls */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <input
          className="nc-input"
          placeholder="Filter variables…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{ flex: 1, maxWidth: 300 }}
        />
        <button className="nc-btn" onClick={reload} disabled={loading}>
          <Icon name="refresh" size={12}/> Reload
        </button>
        <button className="nc-btn primary" onClick={save} disabled={!isDirty || saving}>
          {saving ? '…' : saved ? '✓ Saved' : `Save${isDirty ? ` (${dirtyKeys.length})` : ''}`}
        </button>
      </div>

      {isDirty && (
        <div className="mono" style={{ fontSize: 10, color: 'var(--amber)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="alert" size={12}/> {dirtyKeys.length} unsaved change{dirtyKeys.length > 1 ? 's' : ''}: {dirtyKeys.join(', ')}
        </div>
      )}

      {/* Grouped variables */}
      {grouped.map(([prefix, vars]) => (
        <div key={prefix} style={{ marginBottom: 20 }}>
          <div className="label-tiny neonc" style={{ marginBottom: 8, borderBottom: '1px solid var(--line-soft)', paddingBottom: 4 }}>
            {prefix}
          </div>
          {vars.map(v => {
            const desc = schema[v.key]?.description;
            const isSecret = v.isSecret;
            const isEditing = editingKey === v.key;
            const isModified = dirtyKeys.includes(v.key);
            const currentValue = draft[v.key] ?? v.value;
            const showValue = !isSecret || showSecrets[v.key];

            return (
              <div key={v.key} style={{ 
                display: 'grid', 
                gridTemplateColumns: '200px 1fr auto', 
                gap: 12, 
                padding: '10px 0', 
                borderBottom: '1px dashed rgba(0,183,255,0.06)',
                alignItems: 'center',
                background: isModified ? 'rgba(250,204,21,0.03)' : 'transparent'
              }}>
                {/* Key + description */}
                <div>
                  <div className="mono" style={{ fontSize: 11, color: isModified ? 'var(--amber)' : '#fff', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {v.key}
                    {isModified && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--amber)' }}/>}
                  </div>
                  {desc && <div className="mono muted" style={{ fontSize: 9, marginTop: 2 }}>{desc}</div>}
                </div>

                {/* Value editor */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {isEditing ? (
                    <input
                      className="nc-input"
                      value={currentValue}
                      onChange={e => updateDraft(v.key, e.target.value)}
                      onBlur={() => setEditingKey(null)}
                      onKeyDown={e => { if (e.key === 'Escape') resetKey(v.key); if (e.key === 'Enter') setEditingKey(null); }}
                      autoFocus
                      style={{ flex: 1, fontSize: 11 }}
                      type={isSecret && !showValue ? 'password' : 'text'}
                    />
                  ) : (
                    <code 
                      className="mono" 
                      onClick={() => setEditingKey(v.key)}
                      style={{ 
                        background: 'rgba(2,6,23,0.7)', 
                        border: `1px solid ${isModified ? 'var(--amber)' : 'var(--line)'}`, 
                        padding: '6px 10px', 
                        fontSize: 11, 
                        color: 'var(--text-soft)', 
                        borderRadius: 2, 
                        flex: 1,
                        cursor: 'pointer',
                        transition: 'border-color 0.15s',
                        wordBreak: 'break-all'
                      }}
                    >
                      {isSecret && !showValue ? '••••••••' : (currentValue || <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>empty</span>)}
                    </code>
                  )}
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {isSecret && (
                    <button className="nc-btn ghost" style={{ padding: 6 }} onClick={() => toggleSecret(v.key)} title={showValue ? 'Hide' : 'Show'}>
                      <Icon name={showValue ? 'eye-off' : 'eye'} size={12}/>
                    </button>
                  )}
                  {isModified && (
                    <button className="nc-btn ghost" style={{ padding: 6, color: 'var(--muted)' }} onClick={() => resetKey(v.key)} title="Reset">
                      <Icon name="x" size={12}/>
                    </button>
                  )}
                  {isSecret && <span className="tag amber" style={{ fontSize: 8 }}>SECRET</span>}
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {filtered.length === 0 && (
        <div className="mono muted" style={{ fontSize: 11, padding: 20, textAlign: 'center' }}>
          // no variables match "{filter}"
        </div>
      )}

      {/* Footer info */}
      <div className="mono muted" style={{ fontSize: 10, marginTop: 20, padding: '12px 0', borderTop: '1px solid var(--line-soft)' }}>
        // {envVars.length} variables loaded from .env · click value to edit · changes require save to persist
      </div>
    </>
  );
};

/* ── Routing Tab ────────────────────────────────────────────────────────── */
const RoutingTab = () => {
  const { values, set, dirty, save, saving, saved, err, loading } = useEnvConfig([
    'AUTO_DELEGATION_ENABLED', 'AUTO_DELEGATION_MIN_CONFIDENCE', 'ROUTER_MODEL',
  ]);
  if (loading) return <div className="mono muted" style={{ fontSize: 11 }}>// loading…</div>;
  const enabled = values['AUTO_DELEGATION_ENABLED'] === 'true';
  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>// {err}</div>}
      <SettingRow label="Auto-delegation" hint="AUTO_DELEGATION_ENABLED — routes ambiguous msgs to specialists">
        <InteractiveToggle value={enabled} onChange={v => set('AUTO_DELEGATION_ENABLED', String(v))}/>
      </SettingRow>
      <SettingRow label="Confidence threshold" hint="AUTO_DELEGATION_MIN_CONFIDENCE — below this, falls back to Alfred">
        <input className="nc-input" value={values['AUTO_DELEGATION_MIN_CONFIDENCE'] ?? '0.65'} type="number"
          min={0} max={1} step={0.05} style={{ maxWidth: 120 }}
          onChange={e => set('AUTO_DELEGATION_MIN_CONFIDENCE', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Router model" hint="ROUTER_MODEL — leave blank to use VOIDAI_MODEL">
        <input className="nc-input" value={values['ROUTER_MODEL'] ?? ''} placeholder="(uses VOIDAI_MODEL)"
          style={{ maxWidth: 280 }} onChange={e => set('ROUTER_MODEL', e.target.value)}/>
      </SettingRow>
      <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} label="Save Routing Config"/>
    </>
  );
};

/* ── Memory Tab ─────────────────────────────────────────────────────────── */
const MemoryTab = () => {
  const { values, set, dirty, save, saving, saved, err, loading } = useEnvConfig([
    'MEMORY_IMPORTANCE_THRESHOLD', 'MEMORY_PREINJECT_ENABLED', 'MEMORY_PREINJECT_MAX',
    'MEMORY_EXTRACT_MIN_CHARS', 'MEMORY_PER_SESSION_MAX', 'MEMORY_PER_HOUR_MAX',
  ]);
  if (loading) return <div className="mono muted" style={{ fontSize: 11 }}>// loading…</div>;
  const preinject = (values['MEMORY_PREINJECT_ENABLED'] ?? 'true') !== 'false';
  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>// {err}</div>}
      <SettingRow label="Pre-inject enabled" hint="MEMORY_PREINJECT_ENABLED — inject top memories into every turn">
        <InteractiveToggle value={preinject} onChange={v => set('MEMORY_PREINJECT_ENABLED', String(v))}/>
      </SettingRow>
      <SettingRow label="Pre-inject top-N" hint="MEMORY_PREINJECT_MAX — max memories injected per turn">
        <input className="nc-input" value={values['MEMORY_PREINJECT_MAX'] ?? '5'} type="number" min={1} max={50}
          style={{ maxWidth: 80 }} onChange={e => set('MEMORY_PREINJECT_MAX', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Importance threshold" hint="MEMORY_IMPORTANCE_THRESHOLD — min score to persist a memory (0–1)">
        <input className="nc-input" value={values['MEMORY_IMPORTANCE_THRESHOLD'] ?? '0.6'} type="number"
          min={0} max={1} step={0.05} style={{ maxWidth: 100 }}
          onChange={e => set('MEMORY_IMPORTANCE_THRESHOLD', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Extract min chars" hint="MEMORY_EXTRACT_MIN_CHARS — skip extraction on short turns">
        <input className="nc-input" value={values['MEMORY_EXTRACT_MIN_CHARS'] ?? '200'} type="number" min={0}
          style={{ maxWidth: 100 }} onChange={e => set('MEMORY_EXTRACT_MIN_CHARS', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Per-session cap" hint="MEMORY_PER_SESSION_MAX — max memories stored per session">
        <input className="nc-input" value={values['MEMORY_PER_SESSION_MAX'] ?? '50'} type="number" min={1}
          style={{ maxWidth: 80 }} onChange={e => set('MEMORY_PER_SESSION_MAX', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Per-hour cap" hint="MEMORY_PER_HOUR_MAX — max memories stored per hour">
        <input className="nc-input" value={values['MEMORY_PER_HOUR_MAX'] ?? '200'} type="number" min={1}
          style={{ maxWidth: 80 }} onChange={e => set('MEMORY_PER_HOUR_MAX', e.target.value)}/>
      </SettingRow>
      <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} label="Save Memory Config"/>
    </>
  );
};

/* ── Dream Cycle Tab ────────────────────────────────────────────────────── */
const DreamTab = () => {
  const { values, set, dirty, save, saving, saved, err, loading } = useEnvConfig([
    'DREAM_ENABLED', 'DREAM_RUN_TIME', 'DREAM_LOOKBACK_HOURS', 'DREAM_MODEL',
  ]);
  if (loading) return <div className="mono muted" style={{ fontSize: 11 }}>// loading…</div>;
  const enabled = values['DREAM_ENABLED'] === 'true';
  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>// {err}</div>}
      <SettingRow label="Enabled" hint="DREAM_ENABLED — nightly cognitive consolidation loop">
        <InteractiveToggle value={enabled} onChange={v => set('DREAM_ENABLED', String(v))}/>
      </SettingRow>
      <SettingRow label="Run time" hint="DREAM_RUN_TIME — 24h HH:MM format (e.g. 03:00)">
        <input className="nc-input" value={values['DREAM_RUN_TIME'] ?? '03:00'} placeholder="03:00"
          style={{ maxWidth: 120 }} onChange={e => set('DREAM_RUN_TIME', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Lookback hours" hint="DREAM_LOOKBACK_HOURS — how far back to scan sessions">
        <input className="nc-input" value={values['DREAM_LOOKBACK_HOURS'] ?? '24'} type="number" min={1} max={168}
          style={{ maxWidth: 100 }} onChange={e => set('DREAM_LOOKBACK_HOURS', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Model override" hint="DREAM_MODEL — blank to use VOIDAI_MODEL">
        <input className="nc-input" value={values['DREAM_MODEL'] ?? ''} placeholder="(uses VOIDAI_MODEL)"
          style={{ maxWidth: 280 }} onChange={e => set('DREAM_MODEL', e.target.value)}/>
      </SettingRow>
      <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} label="Save Dream Config"/>
    </>
  );
};

/* ── Providers Tab ──────────────────────────────────────────────────────── */
const ProvidersTab = () => {
  const KEYS = ['ANTHROPIC_API_KEY','VOIDAI_API_KEY','VOIDAI_BASE_URL','VOIDAI_MODEL','CLAUDE_CLI_COMMAND','GEMINI_API_KEY'];
  const { values, set, dirty, save, saving, saved, err, loading } = useEnvConfig(KEYS);
  const [show, setShow] = React.useState({});
  if (loading) return <div className="mono muted" style={{ fontSize: 11 }}>// loading…</div>;

  const SecretRow = ({ envKey, label, hint, prefix }) => {
    const val = values[envKey] ?? '';
    const revealed = show[envKey];
    return (
      <SettingRow label={label} hint={hint}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input className="nc-input" value={val} type={revealed ? 'text' : 'password'}
            style={{ flex: 1, maxWidth: 360, fontSize: 11 }}
            onChange={e => set(envKey, e.target.value)}
            placeholder={val ? '' : `${prefix}…`}/>
          <button className="nc-btn ghost" style={{ padding: 6 }}
            onClick={() => setShow(s => ({ ...s, [envKey]: !s[envKey] }))}>
            <Icon name={revealed ? 'eye-off' : 'eye'} size={12}/>
          </button>
          <span className="tag amber" style={{ fontSize: 8 }}>SECRET</span>
        </div>
      </SettingRow>
    );
  };

  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>// {err}</div>}
      <SecretRow envKey="ANTHROPIC_API_KEY" label="Anthropic API key" hint="ANTHROPIC_API_KEY" prefix="sk-ant-"/>
      <SecretRow envKey="GEMINI_API_KEY" label="Gemini API key" hint="GEMINI_API_KEY — required for voice_provider=gemini_live" prefix="AIza"/>
      <SecretRow envKey="VOIDAI_API_KEY" label="VoidAI API key" hint="VOIDAI_API_KEY" prefix="sk-voidai-"/>
      <SettingRow label="VoidAI base URL" hint="VOIDAI_BASE_URL">
        <input className="nc-input" value={values['VOIDAI_BASE_URL'] ?? ''} style={{ maxWidth: 360 }}
          onChange={e => set('VOIDAI_BASE_URL', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Default model" hint="VOIDAI_MODEL — used by all agents unless overridden">
        <input className="nc-input" value={values['VOIDAI_MODEL'] ?? ''} style={{ maxWidth: 280 }}
          onChange={e => set('VOIDAI_MODEL', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Claude CLI command" hint="CLAUDE_CLI_COMMAND — binary name or full path">
        <input className="nc-input" value={values['CLAUDE_CLI_COMMAND'] ?? 'claude'} style={{ maxWidth: 280 }}
          onChange={e => set('CLAUDE_CLI_COMMAND', e.target.value)}/>
      </SettingRow>
      <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} label="Save Provider Config"/>
    </>
  );
};

/* ── MCP Tab ────────────────────────────────────────────────────────────── */
const McpTab = () => {
  const KEYS = ['NEUROVAULT_MCP_URL','NEUROVAULT_DEFAULT_VAULT','RESEARCHLM_MCP_URL','RESEARCHLM_SEARCH_TOOL','INSIGHTSLM_MCP_URL','INSIGHTSLM_SEARCH_TOOL'];
  const { values, set, dirty, save, saving, saved, err, loading } = useEnvConfig(KEYS);
  const [show, setShow] = React.useState({});
  if (loading) return <div className="mono muted" style={{ fontSize: 11 }}>// loading…</div>;

  const SecretRow = ({ envKey, label, hint }) => {
    const val = values[envKey] ?? '';
    const revealed = show[envKey];
    return (
      <SettingRow label={label} hint={hint}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input className="nc-input" value={val} type={revealed ? 'text' : 'password'}
            style={{ flex: 1, maxWidth: 400, fontSize: 11 }}
            onChange={e => set(envKey, e.target.value)}
            placeholder="not set"/>
          <button className="nc-btn ghost" style={{ padding: 6 }}
            onClick={() => setShow(s => ({ ...s, [envKey]: !s[envKey] }))}>
            <Icon name={revealed ? 'eye-off' : 'eye'} size={12}/>
          </button>
        </div>
      </SettingRow>
    );
  };

  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>// {err}</div>}
      <SecretRow envKey="NEUROVAULT_MCP_URL" label="NeuroVault URL" hint="NEUROVAULT_MCP_URL — WebSocket URL of the vault server"/>
      <SettingRow label="Default vault" hint="NEUROVAULT_DEFAULT_VAULT — vault name for uncategorized writes">
        <input className="nc-input" value={values['NEUROVAULT_DEFAULT_VAULT'] ?? ''} style={{ maxWidth: 280 }}
          placeholder="not set" onChange={e => set('NEUROVAULT_DEFAULT_VAULT', e.target.value)}/>
      </SettingRow>
      <SecretRow envKey="RESEARCHLM_MCP_URL" label="ResearchLM URL" hint="RESEARCHLM_MCP_URL"/>
      <SettingRow label="ResearchLM tool name" hint="RESEARCHLM_SEARCH_TOOL — must match the tool the server exposes">
        <input className="nc-input" value={values['RESEARCHLM_SEARCH_TOOL'] ?? ''} style={{ maxWidth: 280 }}
          placeholder="not set" onChange={e => set('RESEARCHLM_SEARCH_TOOL', e.target.value)}/>
      </SettingRow>
      <SecretRow envKey="INSIGHTSLM_MCP_URL" label="InsightsLM URL" hint="INSIGHTSLM_MCP_URL"/>
      <SettingRow label="InsightsLM tool name" hint="INSIGHTSLM_SEARCH_TOOL — must match the tool the server exposes">
        <input className="nc-input" value={values['INSIGHTSLM_SEARCH_TOOL'] ?? ''} style={{ maxWidth: 280 }}
          placeholder="not set" onChange={e => set('INSIGHTSLM_SEARCH_TOOL', e.target.value)}/>
      </SettingRow>
      <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} label="Save MCP Config"/>
    </>
  );
};

/* ── Exec & Safety Tab ──────────────────────────────────────────────────── */
const ExecTab = () => {
  const { values, set, dirty, save, saving, saved, err, loading } = useEnvConfig([
    'EXEC_TIMEOUT_MS', 'EXEC_OUTPUT_MAX_BYTES', 'EXEC_ROOT', 'EXEC_DEFAULT_CWD', 'EXEC_BASH_DENY',
  ]);
  if (loading) return <div className="mono muted" style={{ fontSize: 11 }}>// loading…</div>;
  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>// {err}</div>}
      <SettingRow label="Timeout (ms)" hint="EXEC_TIMEOUT_MS — max ms a bash_run command can run">
        <input className="nc-input" value={values['EXEC_TIMEOUT_MS'] ?? '60000'} type="number" min={1000}
          style={{ maxWidth: 120 }} onChange={e => set('EXEC_TIMEOUT_MS', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Output cap (bytes)" hint="EXEC_OUTPUT_MAX_BYTES — truncate stdout above this">
        <input className="nc-input" value={values['EXEC_OUTPUT_MAX_BYTES'] ?? '200000'} type="number" min={1024}
          style={{ maxWidth: 120 }} onChange={e => set('EXEC_OUTPUT_MAX_BYTES', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Sandbox root" hint="EXEC_ROOT — fs boundary; blank = no restriction">
        <input className="nc-input" value={values['EXEC_ROOT'] ?? ''} placeholder="(no restriction)"
          style={{ maxWidth: 320 }} onChange={e => set('EXEC_ROOT', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Default CWD" hint="EXEC_DEFAULT_CWD — working dir for exec tools; blank = process.cwd()">
        <input className="nc-input" value={values['EXEC_DEFAULT_CWD'] ?? ''} placeholder="(process.cwd())"
          style={{ maxWidth: 320 }} onChange={e => set('EXEC_DEFAULT_CWD', e.target.value)}/>
      </SettingRow>
      <SettingRow label="Bash deny list" hint="EXEC_BASH_DENY — comma-separated prefixes that are blocked">
        <input className="nc-input" value={values['EXEC_BASH_DENY'] ?? ''} placeholder="e.g. rm -rf,dd if="
          style={{ maxWidth: 400 }} onChange={e => set('EXEC_BASH_DENY', e.target.value)}/>
      </SettingRow>
      <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} label="Save Exec Config"/>
    </>
  );
};

/* ── Dashboard Tab ──────────────────────────────────────────────────────── */
const DashboardTab = () => {
  const { values, set, dirty, save, saving, saved, err, loading } = useEnvConfig([
    'DASHBOARD_TOKEN', 'DASHBOARD_PORT',
  ]);
  const [showToken, setShowToken] = React.useState(false);
  if (loading) return <div className="mono muted" style={{ fontSize: 11 }}>// loading…</div>;
  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>// {err}</div>}
      <SettingRow label="Dashboard token" hint="DASHBOARD_TOKEN — required on all /dashboard and /api/* routes">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input className="nc-input" value={values['DASHBOARD_TOKEN'] ?? ''} type={showToken ? 'text' : 'password'}
            style={{ flex: 1, maxWidth: 360, fontSize: 11 }} onChange={e => set('DASHBOARD_TOKEN', e.target.value)}/>
          <button className="nc-btn ghost" style={{ padding: 6 }} onClick={() => setShowToken(s => !s)}>
            <Icon name={showToken ? 'eye-off' : 'eye'} size={12}/>
          </button>
          <span className="tag amber" style={{ fontSize: 8 }}>SECRET</span>
        </div>
      </SettingRow>
      <SettingRow label="Port" hint="DASHBOARD_PORT — restart required to take effect">
        <input className="nc-input" value={values['DASHBOARD_PORT'] ?? '3141'} type="number" min={1024} max={65535}
          style={{ maxWidth: 100 }} onChange={e => set('DASHBOARD_PORT', e.target.value)}/>
      </SettingRow>
      <div className="mono muted" style={{ fontSize: 10, marginTop: 8 }}>
        // token changes take effect on next request · port changes require a server restart
      </div>
      <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save} label="Save Dashboard Config"/>
    </>
  );
};

const Settings = () => {
  const tabs = ['Routing','Spawn','Memory','Dream Cycle','Providers','MCP','Exec & Safety','Dashboard','Live .env'];
  const [tab, setTab] = React.useState('Routing');
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
        {tab === 'Routing'    && <RoutingTab/>}
        {tab === 'Spawn'      && <SpawnTab/>}
        {tab === 'Memory'     && <MemoryTab/>}
        {tab === 'Dream Cycle'&& <DreamTab/>}
        {tab === 'Providers'  && <ProvidersTab/>}
        {tab === 'MCP'        && <McpTab/>}
        {tab === 'Exec & Safety' && <ExecTab/>}
        {tab === 'Dashboard'  && <DashboardTab/>}
        {tab === 'Live .env'  && <EnvEditorTab/>}
      </div>
    </div>
  );
};
window.Settings = Settings;
