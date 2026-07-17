/* Settings */
import { THEMES, DEFAULT_THEME_ID, LAYOUTS, DEFAULT_LAYOUT_ID } from './themes/registry.ts';

const SettingRow = ({ label, hint, children }) => (
  <div className="setting-row" style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, padding: '12px 0', borderBottom: '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)', alignItems: 'center' }}>
    <div>
      <div className="mono" style={{ fontSize: 12, color: 'var(--text)' }}>{label}</div>
      {hint && <div className="mono muted" style={{ fontSize: 10, marginTop: 2 }}>{hint}</div>}
    </div>
    <div>{children}</div>
  </div>
);

const InteractiveToggle = ({ value, onChange }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} onClick={() => onChange(!value)}>
    <span style={{ width: 32, height: 16, borderRadius: 999, background: value ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'rgba(100,116,139,0.3)', border: '1px solid var(--line)', position: 'relative', boxShadow: value ? '0 0 8px color-mix(in srgb, var(--accent) 50%, transparent)' : 'none' }}>
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
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)' }}>
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
              <div key={v.key} className="setting-row" style={{
                display: 'grid',
                gridTemplateColumns: '200px 1fr auto',
                gap: 12,
                padding: '10px 0', 
                borderBottom: '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)',
                alignItems: 'center',
                background: isModified ? 'rgba(250,204,21,0.03)' : 'transparent'
              }}>
                {/* Key + description */}
                <div>
                  <div className="mono" style={{ fontSize: 11, color: isModified ? 'var(--amber)' : 'var(--text)', display: 'flex', alignItems: 'center', gap: 6 }}>
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

/* ── Themes Tab (live theme picker) ──────────────────────────────────────── */
// NOTE: the legacy per-browser "Accent Color" override (ACCENTS swatches +
// nc_dashboard_accent localStorage key) was removed — it wrote --accent/
// --accent-2 as an inline style on <html>, which always wins over the
// registry's :root[data-theme] rules and silently reset every non-Neon-Grid
// theme's accent back to cyan on mount/revisit. applyTheme below now clears
// any stale inline override + the legacy key defensively.
const THEME_STORAGE_KEY = 'nc_dashboard_theme';
const LAYOUT_STORAGE_KEY = 'nc_dashboard_layout';
const LEGACY_ACCENT_KEY = 'nc_dashboard_accent';

// Miniature shell preview for a layout — proportional sidebar/topbar/footer
// blocks so the density difference reads at a glance without full dimensions.
const LayoutSwatch = ({ layout }) => {
  const sidebar = parseInt(layout.tokens['--shell-sidebar-width']) || 240;
  const topbar = parseInt(layout.tokens['--shell-topbar-height']) || 56;
  // Map real px onto a 56x40 chip (same footprint as ThemeSwatch).
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

const ThemeSwatch = ({ theme }) => (
  <div
    data-theme={theme.id}
    style={{
      width: 56, height: 40, borderRadius: 8, flexShrink: 0,
      background: 'var(--bg-0, var(--bg-canvas))',
      border: '1px solid var(--line, var(--border-default))',
      position: 'relative', overflow: 'hidden',
    }}
  >
    <div style={{ position: 'absolute', left: 6, right: 6, bottom: 6, height: 12, borderRadius: 3, background: 'var(--panel, var(--surface-1))' }} />
    <div style={{ position: 'absolute', right: 6, top: 6, width: 10, height: 10, borderRadius: '50%', background: 'var(--accent)' }} />
  </div>
);

const ThemesTab = () => {
  const [themeId, setThemeId] = React.useState(() => {
    try {
      return document.documentElement.dataset.theme || localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME_ID;
    } catch { return DEFAULT_THEME_ID; }
  });

  const [layoutId, setLayoutId] = React.useState(() => {
    try {
      return document.documentElement.dataset.layout || localStorage.getItem(LAYOUT_STORAGE_KEY) || DEFAULT_LAYOUT_ID;
    } catch { return DEFAULT_LAYOUT_ID; }
  });

  const applyTheme = (id) => {
    document.documentElement.dataset.theme = id;
    // Defensively clear any stale inline --accent/--accent-2 override (e.g.
    // from the removed legacy accent picker in an already-open tab) so the
    // registry's :root[data-theme] rule always wins.
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-2');
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
      localStorage.removeItem(LEGACY_ACCENT_KEY);
    } catch {}
    setThemeId(id);
  };

  const applyLayout = (id) => {
    // Sets data-layout on <html>; the registry's :root[data-layout] rule
    // re-drives the .app grid's --shell-* tokens live (no reload).
    document.documentElement.dataset.layout = id;
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, id); } catch {}
    setLayoutId(id);
  };

  // One-time cleanup: strip any inline override left by the old accent
  // picker (or a stale TWEAK_DEFAULTS write) so the current theme's registry
  // accent renders on mount.
  React.useEffect(() => {
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-2');
    try { localStorage.removeItem(LEGACY_ACCENT_KEY); } catch {}
  }, []);

  const groups = [
    { mode: 'dark', label: 'Dark' },
    { mode: 'light', label: 'Light' },
  ].map(g => ({ ...g, themes: THEMES.filter(t => t.mode === g.mode) })).filter(g => g.themes.length);

  return (
    <>
      <div className="nc-panel glow" style={{ padding: 18, marginBottom: 16 }}>
        <div className="label-tiny neonc" style={{ marginBottom: 12 }}>Theme</div>
        {groups.map(g => (
          <div key={g.mode} style={{ marginBottom: 14 }}>
            {groups.length > 1 && (
              <div className="mono muted" style={{ fontSize: 10, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{g.label}</div>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {g.themes.map(t => {
                const active = themeId === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => applyTheme(t.id)}
                    className="nc-btn"
                    title={t.description}
                    style={{
                      alignItems: 'center', gap: 12, padding: 10, minHeight: 0,
                      borderColor: active ? 'var(--accent)' : 'var(--line)',
                      background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : undefined,
                    }}
                  >
                    <ThemeSwatch theme={t} />
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ color: active ? 'var(--text)' : 'var(--text-soft)', fontWeight: 600 }}>{t.label}{active ? ' ✓' : ''}</div>
                      <div className="mono muted" style={{ fontSize: 10, maxWidth: 220 }}>{t.description}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="mono muted" style={{ fontSize: 10, marginTop: 4 }}>
          // applies instantly · stored in localStorage · more palettes drop into themes/registry.ts
        </div>
      </div>

      <div className="nc-panel glow" style={{ padding: 18, marginBottom: 16 }}>
        <div className="label-tiny neonc" style={{ marginBottom: 4 }}>Layout</div>
        <div className="mono muted" style={{ fontSize: 10, marginBottom: 12 }}>
          Density &amp; structure — independent of color. Pair any palette with any layout.
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {LAYOUTS.map(l => {
            const active = layoutId === l.id;
            return (
              <button
                key={l.id}
                onClick={() => applyLayout(l.id)}
                className="nc-btn"
                title={l.description}
                style={{
                  alignItems: 'center', gap: 12, padding: 10, minHeight: 0,
                  borderColor: active ? 'var(--accent)' : 'var(--line)',
                  background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : undefined,
                }}
              >
                <LayoutSwatch layout={l} />
                <div style={{ textAlign: 'left' }}>
                  <div style={{ color: active ? 'var(--text)' : 'var(--text-soft)', fontWeight: 600 }}>{l.label}{active ? ' ✓' : ''}</div>
                  <div className="mono muted" style={{ fontSize: 10, maxWidth: 220 }}>{l.description}</div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="mono muted" style={{ fontSize: 10, marginTop: 10 }}>
          // reshapes the shell live · desktop layout only (mobile stays compact) · add presets in themes/registry.ts
        </div>
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

/* ── Sub-Agents Tab (live provider + model selection) ──────────────────── */
// Per-family editor: enable toggle + model override + endpoint (base URL)
// override. Each override is live (no restart) and blank = env default.
const FamilyEditor = ({ p, onSaved, onError }) => {
  const [model, setModel]     = React.useState(p.modelOverride ?? '');
  const [baseURL, setBaseURL] = React.useState(p.baseURLOverride ?? '');
  const [busy, setBusy]       = React.useState(null); // 'toggle' | 'model' | 'baseURL'
  const [showAdv, setShowAdv] = React.useState(!!p.baseURLOverride);

  // Re-sync local fields whenever the server state changes (after any save).
  React.useEffect(() => {
    setModel(p.modelOverride ?? '');
    setBaseURL(p.baseURLOverride ?? '');
  }, [p.modelOverride, p.baseURLOverride]);

  const patch = async (kind, body) => {
    setBusy(kind); onError(null);
    try {
      const res = await window.NC_API.patch(`/api/subagent-providers/${p.family}`, body);
      if (!res?.ok) throw new Error(res?.error || 'save failed');
      onSaved(res.providers);
    } catch (e) { onError(e.message); }
    finally { setBusy(null); }
  };

  const noKey        = !p.keyPresent;
  const modelDirty   = (model.trim() || null) !== (p.modelOverride ?? null);
  const baseURLDirty = (baseURL.trim() || null) !== (p.baseURLOverride ?? null);

  return (
    <div style={{ padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
      {/* Header row: name · role · enable toggle · key badge */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{p.label}</div>
          <div className="mono muted" style={{ fontSize: 10 }}>{p.role}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {noKey ? (
            <span className="mono" style={{ fontSize: 10, color: 'var(--amber)' }}>
              ⚠ no key ({p.keyEnv}) — set it in Live .env
            </span>
          ) : busy === 'toggle' ? (
            <span className="mono muted" style={{ fontSize: 10 }}>// saving…</span>
          ) : (
            <InteractiveToggle value={p.enabled} onChange={v => patch('toggle', { enabled: v })}/>
          )}
          <span className="tag" style={{ fontSize: 8, opacity: 0.8 }}>{p.keyPresent ? 'KEY ✓' : 'NO KEY'}</span>
          {p.enabledOverride !== null && (
            <span className="tag amber" style={{ fontSize: 8 }} title="enable state overrides the .env default">ENABLED OVERRIDE</span>
          )}
        </div>
      </div>

      {/* Model row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <span className="mono muted" style={{ fontSize: 10, width: 54 }}>model</span>
        <input className="nc-input" value={model} style={{ flex: 1, maxWidth: 320, fontSize: 11 }}
          placeholder={`default: ${p.modelDefault || 'n/a'}`}
          onChange={e => setModel(e.target.value)}/>
        <button className="nc-btn" disabled={!modelDirty || busy === 'model'} style={{ fontSize: 10, padding: '4px 10px' }}
          onClick={() => patch('model', { model: model.trim() || null })}>
          {busy === 'model' ? 'saving…' : 'Save'}
        </button>
        {p.modelOverride && (
          <button className="nc-btn ghost" style={{ fontSize: 10, padding: '4px 8px' }}
            title="clear override → use env default"
            onClick={() => { setModel(''); patch('model', { model: null }); }}>Reset</button>
        )}
        {p.modelOverride && <span className="tag amber" style={{ fontSize: 8 }}>OVERRIDE</span>}
      </div>

      {/* Advanced: endpoint (base URL) */}
      <div style={{ marginTop: 8 }}>
        {!showAdv ? (
          <button className="nc-btn ghost" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => setShowAdv(true)}>
            ▸ advanced: change provider endpoint
          </button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="mono muted" style={{ fontSize: 10, width: 54 }}>endpoint</span>
            <input className="nc-input" value={baseURL} style={{ flex: 1, maxWidth: 320, fontSize: 11 }}
              placeholder={`default: ${p.baseURLDefault || 'n/a'}`}
              onChange={e => setBaseURL(e.target.value)}/>
            <button className="nc-btn" disabled={!baseURLDirty || busy === 'baseURL'} style={{ fontSize: 10, padding: '4px 10px' }}
              onClick={() => patch('baseURL', { baseURL: baseURL.trim() || null })}>
              {busy === 'baseURL' ? 'saving…' : 'Save'}
            </button>
            {p.baseURLOverride && (
              <button className="nc-btn ghost" style={{ fontSize: 10, padding: '4px 8px' }}
                title="clear override → use env default"
                onClick={() => { setBaseURL(''); patch('baseURL', { baseURL: null }); }}>Reset</button>
            )}
            {p.baseURLOverride && <span className="tag amber" style={{ fontSize: 8 }}>OVERRIDE</span>}
          </div>
        )}
        {showAdv && (
          <div className="mono muted" style={{ fontSize: 9, marginTop: 4, marginLeft: 62 }}>
            // repoints this family's <b>{p.keyEnv}</b> key at any OpenAI-compatible endpoint (VoidAI / OpenRouter / DeepSeek / Ollama…).
            The key is unchanged — make sure it's valid for the endpoint you pick.
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

  if (err && !providers) return <div className="mono" style={{ color: 'var(--danger)', fontSize: 11 }}>// {err}</div>;
  if (!providers) return <div className="mono muted" style={{ fontSize: 11 }}>// loading sub-agent providers…</div>;

  const anyEnabled = providers.some(p => p.enabled);

  return (
    <>
      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>// {err}</div>}
      <div className="mono muted" style={{ fontSize: 10, marginBottom: 8 }}>
        // choose the provider + model for your sub-agents. Every change is live — no restart.
        Code tasks prefer Kimi, prose tasks prefer MiniMax; whatever's enabled forms the fallback
        chain. A family with no API key can't be enabled. Blank field = the .env default.
      </div>

      {providers.map(p => (
        <FamilyEditor key={p.family} p={p} onSaved={setProviders} onError={setErr}/>
      ))}

      {!anyEnabled && (
        <div className="mono" style={{ fontSize: 10, color: 'var(--danger)', marginTop: 14, padding: '8px 12px', background: 'rgba(251,59,95,0.1)', border: '1px solid rgba(251,59,95,0.3)', borderRadius: 4 }}>
          ⚠ no sub-agent provider is enabled — every run_subtask call will fail. Enable at least one family above.
        </div>
      )}

      <div className="mono muted" style={{ fontSize: 10, marginTop: 20, padding: '12px 0', borderTop: '1px solid var(--line-soft)' }}>
        // OVERRIDE = set here, taking precedence over the SUBAGENT_* env default ·
        API keys are managed in the Live .env tab · this panel never shows a key itself
      </div>
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

/* ── Canva Connect Card (Settings → MCP tab) ─────────────────────────────
 * Drives the existing Canva OAuth 2.1 + PKCE backend (mcp/canva-oauth.ts +
 * routes.ts /api/oauth/canva/*) — presentation + wiring only, no OAuth/PKCE/
 * token-storage logic lives here.
 *
 * PATH A (loopback + manual code paste), reworked 2026-07-15: Canva's
 * /authorize step rejects any non-loopback redirect_uri host outright, so
 * there is no way for Canva to ever redirect back to a real dashboard route.
 * Instead the redirect_uri is a fixed http://127.0.0.1/callback that nothing
 * listens on — after the operator signs in + consents, their browser tries
 * to load it and fails ("can't connect"), but the address bar still holds
 * ?code=&state=. The operator copies that URL and pastes it into the field
 * below; onExchange() POSTs it to /api/oauth/canva/exchange, which parses,
 * validates state, and exchanges it server-side. No polling/focus-listener
 * needed anymore (that was for the old same-tab-return flow) — status only
 * changes in response to an explicit action here, so we just re-fetch it
 * after each one. The authorize link opens in a NEW TAB (not window.open()
 * — a genuine <a target="_blank"> click is a user gesture, popup blockers
 * don't touch it) so the Settings tab stays put for the paste step.
 *
 * register-dcr persists the DCR client creds to the broker AND live
 * process.env itself (single authoritative write path — see
 * mcp/canva-oauth.ts), so this card just re-polls status after registering;
 * it never writes secrets directly. config.canva.configured flips true in
 * the same request — no restart step between Register and Connect.
 * pendingRestart only appears as a fallback for creds landed out-of-band
 * (e.g. via the Live .env tab).
 *
 * loopbackReady gate (2026-07-15, proven live): `configured` only means
 * SOME client_id/secret pair is present — it does NOT mean that client was
 * ever registered against the loopback redirect_uri. A stale non-loopback
 * client left in .env from an earlier attempt is `configured:true` but
 * pairing it with the loopback redirect_uri at /authorize gets a 500 from
 * Canva. So the authorize link is gated on `status.loopbackReady`
 * (backed by mcp/canva-oauth.ts isLoopbackClientRegistered()), never on
 * `configured` alone — when configured but not loopbackReady we show the
 * Register button again instead of a link that would 500. */
const CanvaConnectCard = () => {
  const [status, setStatus]   = React.useState(null); // { configured, loopbackReady, hasToken, pendingRestart, serverStatus, toolsCount }
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy]       = React.useState(null);  // 'register' | 'restart' | 'exchange' | null
  const [pasted, setPasted]   = React.useState('');
  const [err, setErr]         = React.useState(null);

  const refreshStatus = React.useCallback(async () => {
    try {
      const res = await window.NC_API.get('/api/oauth/canva/status');
      if (res?.error) throw new Error(res.error);
      setStatus(res);
      return res;
    } catch (e) { setErr(e.message); return null; }
    finally { setLoading(false); }
  }, []);

  React.useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const authorizeHref = React.useMemo(() => {
    const path = '/api/oauth/canva/start';
    return window.NC_API.token ? `${path}?token=${encodeURIComponent(window.NC_API.token)}` : path;
  }, []);

  const register = async () => {
    setBusy('register'); setErr(null);
    try {
      const res = await window.NC_API.post('/api/oauth/canva/register-dcr', {});
      if (!res?.ok) throw new Error(res?.error || 'DCR registration failed');
      await refreshStatus();
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const restart = async () => {
    setBusy('restart'); setErr(null);
    try {
      await window.NC_API.post('/api/system/restart', {});
      setTimeout(refreshStatus, 8000); // give the process manager time to bring it back up
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const exchange = async () => {
    const value = pasted.trim();
    if (!value) { setErr('Paste the redirected URL (or its code=...&state=... query string) first.'); return; }
    setBusy('exchange'); setErr(null);
    try {
      const res = await window.NC_API.post('/api/oauth/canva/exchange', { pasted: value });
      if (!res?.ok) throw new Error(res?.error || 'Exchange failed');
      setPasted('');
      await refreshStatus();
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  if (loading) return <div className="mono muted" style={{ fontSize: 11, marginBottom: 20 }}>// checking Canva connection…</div>;

  const connected = !!status?.hasToken;
  const configured = !!status?.configured;
  const loopbackReady = !!status?.loopbackReady;
  const pendingRestart = !!status?.pendingRestart;
  // Stale client: creds present, not pending a restart, but NOT registered
  // against the loopback redirect_uri — the authorize link must never show
  // for this state (see loopbackReady gate note above the component).
  const staleClient = configured && !pendingRestart && !loopbackReady;
  const awaitingPaste = configured && !pendingRestart && loopbackReady && !connected;

  return (
    <div className="nc-panel" style={{ padding: 16, marginBottom: 20, border: '1px solid var(--line-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            Canva
            {connected ? (
              <span className="tag" style={{ fontSize: 8, color: 'var(--accent-2)', borderColor: 'var(--accent-2)' }}>CONNECTED</span>
            ) : pendingRestart ? (
              <span className="tag amber" style={{ fontSize: 8 }}>RESTART REQUIRED</span>
            ) : staleClient ? (
              <span className="tag amber" style={{ fontSize: 8 }}>RE-REGISTER REQUIRED</span>
            ) : (
              <span className="tag" style={{ fontSize: 8, color: 'var(--muted)' }}>NOT CONNECTED</span>
            )}
          </div>
          <div className="mono muted" style={{ fontSize: 10, marginTop: 2 }}>
            {connected
              ? `Official Canva MCP (mcp.canva.com) · ${status.toolsCount} tool${status.toolsCount === 1 ? '' : 's'} registered${status.serverStatus ? ` · ${status.serverStatus}` : ''}`
              : pendingRestart
                ? 'DCR client saved out-of-band — restart the server to load it before connecting'
                : staleClient
                  ? 'Saved client was not registered against the loopback redirect — click Register to get a fresh one before connecting'
                  : configured
                    ? 'App registered — sign in on Canva, then paste the redirected URL back here'
                    : 'One-time DCR self-registration required before the consent screen can be shown'}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {(!configured || staleClient) && !pendingRestart && (
            <button className="nc-btn primary" disabled={busy === 'register'} onClick={register}>
              {busy === 'register' ? 'registering…' : staleClient ? 'Re-register Canva App' : 'Register Canva App'}
            </button>
          )}
          {pendingRestart && (
            <button className="nc-btn" disabled={busy === 'restart'}
              style={{ color: 'var(--amber)', borderColor: 'var(--amber)' }} onClick={restart}>
              {busy === 'restart' ? 'restarting…' : 'Restart Server to Apply'}
            </button>
          )}
          {awaitingPaste && (
            <a className="nc-btn primary" href={authorizeHref} target="_blank" rel="noopener noreferrer"
              onClick={() => setErr(null)}>
              1. Sign in on Canva ↗
            </a>
          )}
          {connected && loopbackReady && (
            <a className="nc-btn ghost" href={authorizeHref} target="_blank" rel="noopener noreferrer"
              onClick={() => setErr(null)}
              title="Re-run consent, e.g. after a scope change">
              Reconnect ↗
            </a>
          )}
          <button className="nc-btn ghost" style={{ padding: 6 }} onClick={refreshStatus} title="Refresh status">
            <Icon name="refresh" size={12}/>
          </button>
        </div>
      </div>

      {awaitingPaste && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
          <div className="mono muted" style={{ fontSize: 10, marginBottom: 6 }}>
            // "Sign in on Canva" opens a new tab — approve the consent screen there. It'll then try to
            // load a 127.0.0.1 address and fail to connect; that's expected. Copy the FULL url from
            // that tab's address bar and paste it below.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="text"
              className="nc-input mono"
              style={{ flex: '1 1 320px', fontSize: 11 }}
              placeholder="http://127.0.0.1:.../callback?code=...&state=..."
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              disabled={busy === 'exchange'}
            />
            <button className="nc-btn primary" disabled={busy === 'exchange' || !pasted.trim()} onClick={exchange}>
              {busy === 'exchange' ? 'connecting…' : '2. Complete Connection'}
            </button>
          </div>
        </div>
      )}

      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 10, marginTop: 10 }}>// {err}</div>}
    </div>
  );
};

/* ── MCP Tab ────────────────────────────────────────────────────────────── */
const SystemUpdateCard = () => {
  const [chk, setChk] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [log, setLog] = React.useState([]);
  const [err, setErr] = React.useState(null);

  const check = async () => {
    setBusy('check'); setErr(null); setLog([]);
    try {
      const res = await window.NC_API.get('/api/system/update/check');
      setChk(res);
      if (res.error) setErr(res.error);
    } catch (e) { setErr(e.message); } finally { setBusy(null); }
  };

  const doUpdate = async () => {
    if (!chk?.nonce) return;
    if (!window.confirm(`Update ${(chk.current || '').slice(0, 8)} → latest (${chk.behind} commit${chk.behind === 1 ? '' : 's'}) and restart the server?`)) return;
    setBusy('update'); setErr(null); setLog([]);
    const tok = window.NC_API.token;
    const url = tok ? `/api/system/update?token=${encodeURIComponent(tok)}` : '/api/system/update';
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ nonce: chk.nonce }),
      });
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n'); buf = parts.pop();
        for (const p of parts) {
          const ev = (/event:\s*(\S+)/.exec(p) || [])[1];
          const dm = (/data:\s*([\s\S]+)/.exec(p) || [])[1];
          let d = {}; try { d = JSON.parse(dm); } catch { /* keep {} */ }
          if (ev === 'progress') setLog(x => [...x, `${d.phase}: ${d.message}`].slice(-14));
          else if (ev === 'result') setLog(x => [...x, `→ ${d.status}: ${d.message}`]);
          else if (ev === 'restarting') setLog(x => [...x, '↻ restarting…']);
          else if (ev === 'error') setErr(d.message);
        }
      }
    } catch {
      // The server exits mid-stream on a successful update — a dropped
      // connection here is expected, not a failure.
      setLog(x => [...x, '↻ server restarting (connection closed)']);
    } finally {
      setBusy(null);
      setTimeout(check, 10000); // re-check once it's back up
    }
  };

  const disabled = chk && chk.enabled === false;
  const upToDate = chk && chk.ok && chk.upToDate;
  const available = chk && chk.ok && !chk.upToDate && chk.behind > 0;

  return (
    <div className="nc-panel" style={{ padding: 16, marginBottom: 20, border: '1px solid var(--line-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            System Update
            {disabled && <span className="tag" style={{ fontSize: 8, color: 'var(--muted)' }}>DISABLED</span>}
            {upToDate && <span className="tag" style={{ fontSize: 8, color: 'var(--accent-2)', borderColor: 'var(--accent-2)' }}>UP TO DATE</span>}
            {available && <span className="tag amber" style={{ fontSize: 8 }}>{chk.behind} BEHIND</span>}
          </div>
          <div className="mono muted" style={{ fontSize: 10, marginTop: 2 }}>
            {disabled
              ? 'Self-update is disabled — set UPDATE_ENABLED=true in .env and restart to enable.'
              : chk
                ? `${chk.remote}/${chk.branch} · current ${(chk.current || '').slice(0, 8)}${chk.dirty ? ' · ⚠ uncommitted tracked changes' : ''}`
                : 'Pull the latest release from GitHub, rebuild, and restart — with automatic rollback.'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="nc-btn" disabled={!!busy} onClick={check}>
            {busy === 'check' ? 'Checking…' : 'Check for updates'}
          </button>
          {available && (
            <button className="nc-btn" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }} disabled={!!busy} onClick={doUpdate}>
              {busy === 'update' ? 'Updating…' : 'Update & restart'}
            </button>
          )}
        </div>
      </div>

      {available && chk.commits?.length > 0 && (
        <div className="mono" style={{ fontSize: 10, marginTop: 10, maxHeight: 120, overflow: 'auto', opacity: 0.85 }}>
          {chk.commits.slice(0, 12).map((c, i) => (
            <div key={i}><span style={{ color: 'var(--accent)' }}>{c.sha}</span> {c.subject}</div>
          ))}
        </div>
      )}
      {log.length > 0 && (
        <div className="mono" style={{ fontSize: 10, marginTop: 10, maxHeight: 160, overflow: 'auto', color: 'var(--accent-2)' }}>
          {log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 8 }}>// {err}</div>}
    </div>
  );
};

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
      <SystemUpdateCard/>
      <CanvaConnectCard/>
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
  const tabs = ['Themes','Routing','Spawn','Sub-Agents','Memory','Dream Cycle','Providers','MCP','Exec & Safety','Dashboard','Live .env'];
  const [tab, setTab] = React.useState('Themes');
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
        {tab === 'Themes'     && <ThemesTab/>}
        {tab === 'Routing'    && <RoutingTab/>}
        {tab === 'Spawn'      && <SpawnTab/>}
        {tab === 'Sub-Agents' && <SubAgentsTab/>}
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
