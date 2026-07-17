/* Secrets — manifest manager for the NC Broker (spec v3 §10)
 *
 * Replaces the old free-form .env editor with a structured, manifest-style UI:
 *   - Add Secret form uses scope/service/type pickers → resolved name preview
 *   - Secrets are grouped by scope (SHARED / NEUROCLAW / per-agent)
 *   - Unmanaged orphans (names that don't match the SCOPE_SERVICE_TYPE
 *     convention) appear in a separate panel so the user can migrate them
 *   - Reveal, edit, rotate, delete actions all hit /api/broker/admin/*
 *   - Audit log viewer panel at the bottom shows broker access history
 *
 * Backend: /api/broker/admin/* — gated by the dashboard token already.
 * The legacy /api/env* endpoints still exist for the Settings page; this
 * page deliberately does NOT touch them.
 */

const SECRET_TYPES = ['PAT', 'KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'URL', 'CUSTOM'];

const SCOPE_BADGE_COLOR = {
  SHARED: 'var(--accent)',
  NEUROCLAW: 'var(--accent-2)',
};

const TYPE_BADGE_COLOR = {
  PAT: '#ffb86c',
  KEY: '#8be9fd',
  TOKEN: '#bd93f9',
  SECRET: '#ff79c6',
  PASSWORD: '#ff5555',
  URL: '#50fa7b',
  CUSTOM: 'var(--muted)',
};

const Secrets = () => {
  // ── Top-level state ─────────────────────────────────────────────────────
  const [grouped, setGrouped]       = React.useState({});       // scope -> [secret]
  const [orphans, setOrphans]       = React.useState([]);
  const [agents, setAgents]         = React.useState([]);       // [{ id, name, canonical_prefix }]
  const [loading, setLoading]       = React.useState(true);
  const [err, setErr]               = React.useState(null);
  const [okMsg, setOkMsg]           = React.useState(null);

  // ── Toolbar state ───────────────────────────────────────────────────────
  const [filter, setFilter]         = React.useState('');
  const [showAdd, setShowAdd]       = React.useState(false);
  const [showAgents, setShowAgents] = React.useState(false);

  // ── Reveal cache: { name: value } ──────────────────────────────────────
  const [revealed, setRevealed]     = React.useState({});

  // ── Inline-edit drafts ──────────────────────────────────────────────────
  const [editing, setEditing]       = React.useState(null);     // currently editing name
  const [editDraft, setEditDraft]   = React.useState('');

  // ── Add-form state ──────────────────────────────────────────────────────
  const [scopeKind, setScopeKind]   = React.useState('SHARED'); // SHARED | NEUROCLAW | AGENT | CUSTOM
  const [scopeAgent, setScopeAgent] = React.useState('');       // selected agent prefix (UPPER)
  const [customScope, setCustomScope] = React.useState('');     // free-text custom scope
  const [service, setService]       = React.useState('');
  const [secType, setSecType]       = React.useState('KEY');
  const [customType, setCustomType] = React.useState('');       // free-text custom type (when secType=CUSTOM)
  const [newVal, setNewVal]         = React.useState('');
  const [newNotes, setNewNotes]     = React.useState('');
  const [resolvedName, setResolvedName] = React.useState('');
  const [resolveErrs, setResolveErrs]   = React.useState([]);
  const [resolveCollision, setResolveCollision] = React.useState(false);
  const [saving, setSaving]         = React.useState(false);

  // ── Audit panel ─────────────────────────────────────────────────────────
  const [auditRows, setAuditRows]   = React.useState([]);
  const [auditLoading, setAuditLoading] = React.useState(false);

  // ── Storage backend banner ─────────────────────────────────────────────
  const [storage, setStorage]       = React.useState(null);

  const flash = (msg) => { setOkMsg(msg); setTimeout(() => setOkMsg(null), 2500); };

  // ── Loaders ─────────────────────────────────────────────────────────────
  const loadSecrets = React.useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await window.NC_API.post('/api/broker/admin/list', {});
      setGrouped(res.grouped || {});
      setOrphans(res.orphans || []);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAgents = React.useCallback(async () => {
    try {
      const res = await window.NC_API.get('/api/broker/admin/agents');
      setAgents(res.agents || []);
    } catch (e) {
      // Non-fatal: the page can still show secrets, just no per-agent scope picker.
      console.warn('[secrets] loadAgents failed:', e.message);
    }
  }, []);

  const loadAudit = React.useCallback(async () => {
    setAuditLoading(true);
    try {
      const res = await window.NC_API.get('/api/broker/admin/audit?limit=50');
      setAuditRows(res.rows || []);
    } catch (e) {
      console.warn('[secrets] loadAudit failed:', e.message);
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const loadStorage = React.useCallback(async () => {
    try {
      const res = await window.NC_API.get('/api/broker/admin/storage');
      setStorage(res);
    } catch (e) {
      console.warn('[secrets] loadStorage failed:', e.message);
    }
  }, []);

  React.useEffect(() => {
    loadSecrets();
    loadAgents();
    loadAudit();
    loadStorage();
  }, [loadSecrets, loadAgents, loadAudit, loadStorage]);

  // ── Resolved-name live preview ─────────────────────────────────────────
  React.useEffect(() => {
    let cancelled = false;
    let scope = '';
    if (scopeKind === 'SHARED')         scope = 'SHARED';
    else if (scopeKind === 'NEUROCLAW') scope = 'NEUROCLAW';
    else if (scopeKind === 'CUSTOM')    scope = customScope.toUpperCase().replace(/\s+/g, '_').replace(/\./g, '');
    else                                scope = scopeAgent;
    const effectiveType = secType === 'CUSTOM'
      ? (customType.toUpperCase().replace(/\s+/g, '_').replace(/\./g, '') || 'CUSTOM')
      : secType;
    if (!scope || !service) {
      setResolvedName(''); setResolveErrs([]); setResolveCollision(false);
      return;
    }
    (async () => {
      try {
        const r = await window.NC_API.post('/api/broker/admin/name/preview', {
          scope, service, type: effectiveType,
        });
        if (cancelled) return;
        setResolvedName(r.name || '');
        setResolveErrs(r.errors || []);
        setResolveCollision(Boolean(r.collision));
      } catch {
        if (!cancelled) { setResolvedName(''); setResolveErrs(['preview_failed']); }
      }
    })();
    return () => { cancelled = true; };
  }, [scopeKind, scopeAgent, customScope, service, secType, customType]);

  // ── Mutations ───────────────────────────────────────────────────────────
  const reveal = async (name) => {
    if (revealed[name] !== undefined) {
      setRevealed((p) => { const n = { ...p }; delete n[name]; return n; });
      return;
    }
    try {
      const r = await window.NC_API.post('/api/broker/admin/reveal', { name, purpose: 'dashboard reveal' });
      setRevealed((p) => ({ ...p, [name]: r.value ?? '' }));
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  const copyValue = async (name) => {
    try {
      const r = await window.NC_API.post('/api/broker/admin/reveal', { name, purpose: 'dashboard copy' });
      await navigator.clipboard.writeText(r.value ?? '');
      flash('Copied ' + name);
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  const beginEdit = async (name) => {
    try {
      const r = await window.NC_API.post('/api/broker/admin/reveal', { name, purpose: 'dashboard edit' });
      setEditDraft(r.value ?? '');
      setEditing(name);
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setSaving(true); setErr(null);
    try {
      await window.NC_API.post('/api/broker/admin/update', { name: editing, value: editDraft });
      flash('Updated ' + editing);
      setEditing(null); setEditDraft('');
      setRevealed((p) => { const n = { ...p }; delete n[editing]; return n; });
      await loadSecrets();
      loadAudit();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const deleteSecret = async (name) => {
    if (!confirm('Delete ' + name + '?\n\nA timestamped .env backup is written first.')) return;
    setErr(null);
    try {
      await window.NC_API.post('/api/broker/admin/delete', { name });
      flash('Deleted ' + name);
      setRevealed((p) => { const n = { ...p }; delete n[name]; return n; });
      await loadSecrets();
      loadAudit();
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  const rotateSecret = async (name) => {
    const v = prompt('Enter new value for ' + name + ' (leave blank to just mark rotated):', '');
    if (v === null) return;
    try {
      await window.NC_API.post('/api/broker/admin/rotate', { name, ...(v ? { value: v } : {}) });
      flash('Rotated ' + name);
      setRevealed((p) => { const n = { ...p }; delete n[name]; return n; });
      await loadSecrets();
      loadAudit();
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  const addSecret = async () => {
    setErr(null);
    if (resolveErrs.length > 0 || !resolvedName) {
      setErr('Fix the form errors before saving.');
      return;
    }
    if (resolveCollision) {
      setErr(`A secret named ${resolvedName} already exists.`);
      return;
    }
    if (!newVal) { setErr('Value cannot be empty.'); return; }
    setSaving(true);
    try {
      await window.NC_API.post('/api/broker/admin/create', {
        name: resolvedName,
        value: newVal,
        notes: newNotes,
        tags: [],
      });
      flash('Created ' + resolvedName);
      setNewVal(''); setNewNotes(''); setService(''); setShowAdd(false);
      await loadSecrets();
      loadAudit();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Agent prefix management ─────────────────────────────────────────────
  const setAgentPrefix = async (agentId, prefix) => {
    try {
      await window.NC_API.post('/api/broker/admin/agents/prefix', {
        agent_id: agentId,
        prefix: prefix === '' ? null : prefix,
      });
      flash('Prefix updated');
      await loadAgents();
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  // ── Derived view data ───────────────────────────────────────────────────
  const lc = filter.toLowerCase();
  const matchesFilter = (s) => !lc || s.name.toLowerCase().includes(lc) ||
                               (s.service || '').toLowerCase().includes(lc);

  const allScopes = Object.keys(grouped).sort((a, b) => {
    const order = (k) => (k === 'SHARED' ? 0 : k === 'NEUROCLAW' ? 1 : 2);
    if (order(a) !== order(b)) return order(a) - order(b);
    return a.localeCompare(b);
  });

  const totalManaged = allScopes.reduce((n, k) => n + grouped[k].length, 0);
  const agentPrefixes = agents
    .map((a) => a.canonical_prefix)
    .filter(Boolean)
    .sort();

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <>
      {typeof PageHeader !== 'undefined' && (
        <PageHeader
          title="Secrets"
          subtitle="NC Broker manifest — scope-gated credentials for every agent"
        />
      )}

      {/* Status bar */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <StatChip label="MANAGED"      value={totalManaged}        color="var(--accent)" />
        <StatChip label="SCOPES"       value={allScopes.length}    color="var(--accent-2)" />
        <StatChip label="UNMANAGED"    value={orphans.length}      color="#ffb86c" />
        <StatChip label="AGENT PREFIXES" value={agentPrefixes.length} color="#bd93f9" />
        <StorageBackendChip storage={storage} />
      </div>

      {/* Alerts */}
      {err && (
        <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10, padding: '8px 12px', background: 'rgba(251,59,95,0.1)', border: '1px solid rgba(251,59,95,0.3)', borderRadius: 4 }}>
          // error: {err}
        </div>
      )}
      {okMsg && (
        <div className="mono" style={{ color: 'var(--accent-2)', fontSize: 11, marginBottom: 10, padding: '8px 12px', background: 'color-mix(in srgb, var(--accent-2) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-2) 30%, transparent)', borderRadius: 4 }}>
          // {okMsg}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className="nc-input"
          placeholder="Filter by name or service…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: '1 1 240px', maxWidth: 320, fontSize: 12 }}
        />
        <button className="nc-btn" onClick={() => { loadSecrets(); loadAudit(); }} disabled={loading}>
          <Icon name="refresh" size={12}/> Reload
        </button>
        <button className="nc-btn" onClick={() => setShowAgents((s) => !s)}>
          <Icon name="settings" size={12}/> {showAgents ? 'Hide' : 'Manage'} agent prefixes
        </button>
        <button className="nc-btn primary" onClick={() => { setShowAdd((s) => !s); setErr(null); }}>
          <Icon name="plus" size={12}/> {showAdd ? 'Cancel' : 'Add Secret'}
        </button>
      </div>

      {/* Agent prefix manager */}
      {showAgents && (
        <div className="nc-panel" style={{ padding: 16, marginBottom: 16 }}>
          <div className="label-tiny neonc" style={{ marginBottom: 10 }}>AGENT CANONICAL PREFIXES</div>
          <div className="mono muted" style={{ fontSize: 10, marginBottom: 12 }}>
            // Each agent owns one prefix (e.g. ORACLE, JARVIS). Used by the broker scope resolver to gate access to <code style={{ color: 'var(--accent-2)' }}>&lt;PREFIX&gt;_*</code> secrets.
            <br/>// Strip dots, replace spaces with underscores, uppercase. SHARED and NEUROCLAW are reserved.
          </div>
          {agents.length === 0 ? (
            <div className="mono muted" style={{ fontSize: 11 }}>// no active agents found</div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {agents.map((a) => (
                <AgentPrefixRow key={a.id} agent={a} onSave={setAgentPrefix} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Add form */}
      {showAdd && (
        <div className="nc-panel" style={{ padding: 16, marginBottom: 16, borderColor: 'var(--accent)' }}>
          <div className="label-tiny neonc" style={{ marginBottom: 10 }}>NEW SECRET</div>

          {/* Scope picker */}
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'center', marginBottom: 10 }}>
            <span className="mono muted" style={{ fontSize: 10 }}>SCOPE</span>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              {[
                { v: 'SHARED',    label: 'Shared',  hint: 'every agent' },
                { v: 'NEUROCLAW', label: 'Project', hint: 'NeuroClaw infra' },
                { v: 'AGENT',     label: 'Agent',   hint: 'single agent only' },
                { v: 'CUSTOM',    label: 'Custom',  hint: 'any prefix' },
              ].map((opt) => (
                <label key={opt.v} className="mono" style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="radio" name="scope-kind" checked={scopeKind === opt.v} onChange={() => setScopeKind(opt.v)} />
                  {opt.label}
                  <span className="muted" style={{ fontSize: 10 }}>({opt.hint})</span>
                </label>
              ))}
              {scopeKind === 'AGENT' && (
                <select
                  className="nc-input"
                  value={scopeAgent}
                  onChange={(e) => setScopeAgent(e.target.value)}
                  style={{ fontSize: 11, padding: '4px 8px' }}
                >
                  <option value="">— pick agent prefix —</option>
                  {agentPrefixes.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              )}
              {scopeKind === 'CUSTOM' && (
                <input
                  className="nc-input"
                  placeholder="LIESE"
                  value={customScope}
                  onChange={(e) => setCustomScope(e.target.value.toUpperCase().replace(/\s+/g, '_').replace(/\./g, ''))}
                  style={{ fontSize: 11, padding: '4px 8px', width: 140 }}
                />
              )}
            </div>
          </div>

          {/* Service + Type */}
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr', gap: 10, alignItems: 'center', marginBottom: secType === 'CUSTOM' ? 4 : 10 }}>
            <span className="mono muted" style={{ fontSize: 10 }}>SERVICE / TYPE</span>
            <input
              className="nc-input"
              placeholder="GITHUB"
              value={service}
              onChange={(e) => setService(e.target.value.toUpperCase().replace(/\s+/g, '_').replace(/\./g, ''))}
              style={{ fontSize: 12 }}
            />
            <select
              className="nc-input"
              value={secType}
              onChange={(e) => { setSecType(e.target.value); if (e.target.value !== 'CUSTOM') setCustomType(''); }}
              style={{ fontSize: 12 }}
            >
              {SECRET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          {secType === 'CUSTOM' && (
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr', gap: 10, alignItems: 'center', marginBottom: 10 }}>
              <span className="mono muted" style={{ fontSize: 10 }}>CUSTOM TYPE</span>
              <div style={{ gridColumn: '2 / -1' }}>
                <input
                  className="nc-input"
                  placeholder="WEBHOOK"
                  value={customType}
                  onChange={(e) => setCustomType(e.target.value.toUpperCase().replace(/\s+/g, '_').replace(/\./g, ''))}
                  style={{ fontSize: 12, width: '100%' }}
                />
              </div>
            </div>
          )}

          {/* Resolved name preview */}
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'center', marginBottom: 10 }}>
            <span className="mono muted" style={{ fontSize: 10 }}>RESOLVED NAME</span>
            <div style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              padding: '6px 10px',
              background: 'rgba(2,6,23,0.7)',
              border: `1px solid ${resolveErrs.length || resolveCollision ? 'var(--danger)' : 'var(--accent)'}`,
              color: resolveErrs.length || resolveCollision ? 'var(--danger)' : 'var(--accent)',
              borderRadius: 2,
            }}>
              {resolvedName || <span className="muted">// fill out scope, service, and type</span>}
              {resolveCollision && <span style={{ marginLeft: 12, color: 'var(--danger)' }}>// name already exists</span>}
              {resolveErrs.length > 0 && <span style={{ marginLeft: 12 }}>// {resolveErrs.join(', ')}</span>}
            </div>
          </div>

          {/* Value */}
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'flex-start', marginBottom: 10 }}>
            <span className="mono muted" style={{ fontSize: 10, paddingTop: 8 }}>VALUE</span>
            <textarea
              className="nc-input"
              placeholder="sk-… (paste multiline values like SSH keys here)"
              value={newVal}
              onChange={(e) => setNewVal(e.target.value)}
              autoComplete="off"
              rows={3}
              style={{ fontSize: 12, resize: 'vertical', fontFamily: 'var(--mono)', whiteSpace: 'pre' }}
            />
          </div>

          {/* Notes */}
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'center', marginBottom: 10 }}>
            <span className="mono muted" style={{ fontSize: 10 }}>NOTES</span>
            <input
              className="nc-input"
              placeholder="scope: repo, workflow"
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              style={{ fontSize: 12 }}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="nc-btn ghost" onClick={() => setShowAdd(false)}>Cancel</button>
            <button
              className="nc-btn primary"
              onClick={addSecret}
              disabled={saving || !resolvedName || resolveErrs.length > 0 || resolveCollision || !newVal}
            >
              {saving ? '…' : 'Add Secret'}
            </button>
          </div>

          <div className="mono muted" style={{ fontSize: 10, marginTop: 10 }}>
            // Stored via broker → encrypted at rest is delegated to the storage adapter. Naming convention enforced server-side.
          </div>
        </div>
      )}

      {/* Grouped lists */}
      {loading ? (
        <div className="mono muted" style={{ fontSize: 11, padding: 20 }}>// loading secrets…</div>
      ) : totalManaged === 0 && orphans.length === 0 ? (
        <div className="nc-panel" style={{ padding: 28, textAlign: 'center' }}>
          <div className="mono muted" style={{ fontSize: 11 }}>// no secrets yet — click "Add Secret" to create one</div>
        </div>
      ) : (
        <>
          {allScopes.map((scope) => {
            const visible = grouped[scope].filter(matchesFilter);
            if (visible.length === 0) return null;
            return (
              <ScopeSection
                key={scope}
                scope={scope}
                secrets={visible}
                revealed={revealed}
                editing={editing}
                editDraft={editDraft}
                onEditDraftChange={setEditDraft}
                onReveal={reveal}
                onCopy={copyValue}
                onEdit={beginEdit}
                onSaveEdit={saveEdit}
                onCancelEdit={() => { setEditing(null); setEditDraft(''); }}
                onRotate={rotateSecret}
                onDelete={deleteSecret}
                saving={saving}
              />
            );
          })}

          {orphans.length > 0 && (
            <OrphansSection
              orphans={orphans.filter((o) => !lc || o.name.toLowerCase().includes(lc))}
            />
          )}
        </>
      )}

      {/* Audit panel */}
      <div className="nc-panel" style={{ marginTop: 24, padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div className="label-tiny neonc">RECENT ACCESS</div>
          <button className="nc-btn ghost" style={{ padding: 4 }} onClick={loadAudit} title="Refresh audit log">
            <Icon name="refresh" size={11}/>
          </button>
        </div>
        {auditLoading ? (
          <div className="mono muted" style={{ fontSize: 11 }}>// loading audit log…</div>
        ) : auditRows.length === 0 ? (
          <div className="mono muted" style={{ fontSize: 11 }}>// no broker access yet</div>
        ) : (
          <div style={{ maxHeight: 280, overflow: 'auto' }}>
            {auditRows.map((row, i) => <AuditRow key={i} row={row} />)}
          </div>
        )}
      </div>

      {/* Naming convention reference */}
      <div className="nc-panel" style={{ marginTop: 16, padding: 14 }}>
        <div className="label-tiny neonc" style={{ marginBottom: 8 }}>NAMING CONVENTION</div>
        <div className="mono muted" style={{ fontSize: 10, lineHeight: 1.6 }}>
          // <code style={{ color: 'var(--accent)' }}>&lt;SCOPE&gt;_&lt;SERVICE&gt;_&lt;TYPE&gt;</code> — the name IS the access policy.<br/>
          &nbsp;&nbsp;• <code style={{ color: 'var(--accent-2)' }}>SHARED_*</code> — every agent (external service keys)<br/>
          &nbsp;&nbsp;• <code style={{ color: 'var(--accent-2)' }}>NEUROCLAW_*</code> — project infra (database URLs, JWT secrets)<br/>
          &nbsp;&nbsp;• <code style={{ color: 'var(--accent-2)' }}>&lt;AGENT&gt;_*</code> — that agent only (uses canonical prefix)<br/>
          // Agents access values via <code style={{ color: 'var(--accent)' }}>broker.use(name)</code> or <code style={{ color: 'var(--accent)' }}>broker.exec(...)</code> — values never enter agent context when <code>exec</code> is used.
        </div>
      </div>
    </>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────────

const StatChip = ({ label, value, color }) => (
  <div className="nc-panel" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
    <span className="mono muted" style={{ fontSize: 10 }}>{label}</span>
    <span className="mono" style={{ fontSize: 16, color }}>{value}</span>
  </div>
);

const StorageBackendChip = ({ storage }) => {
  if (!storage) {
    return (
      <div className="nc-panel" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="mono muted" style={{ fontSize: 10 }}>BACKEND</span>
        <span className="mono muted" style={{ fontSize: 11 }}>// loading…</span>
      </div>
    );
  }
  const isInfisical = storage.backend === 'infisical';
  const color = !storage.ok          ? 'var(--danger)' :
                isInfisical          ? 'var(--accent-2)' :
                /* env-manager */      '#ffb86c';
  const label = isInfisical ? 'INFISICAL' : 'ENV-MANAGER';
  return (
    <div className="nc-panel" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="mono muted" style={{ fontSize: 10 }}>BACKEND</span>
      <span className="mono" style={{ fontSize: 11, color }}>{label}</span>
      <span className="mono muted" style={{ fontSize: 9 }}>{storage.detail}</span>
    </div>
  );
};

const AgentPrefixRow = ({ agent, onSave }) => {
  const [draft, setDraft] = React.useState(agent.canonical_prefix || '');
  const [saving, setSaving] = React.useState(false);
  const dirty = draft !== (agent.canonical_prefix || '');
  const submit = async () => {
    setSaving(true);
    try { await onSave(agent.id, draft.toUpperCase().replace(/\s+/g, '_').replace(/\./g, '')); }
    finally { setSaving(false); }
  };
  return (
    <div className="split-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 220px auto auto', gap: 10, alignItems: 'center' }}>
      <span className="mono" style={{ fontSize: 11 }}>{agent.name}</span>
      <input
        className="nc-input"
        placeholder="ORACLE"
        value={draft}
        onChange={(e) => setDraft(e.target.value.toUpperCase())}
        style={{ fontSize: 11 }}
      />
      <span className="mono muted" style={{ fontSize: 10 }}>
        {agent.canonical_prefix ? '✓ set' : '— unset'}
      </span>
      <button className="nc-btn" style={{ padding: '4px 10px', fontSize: 10 }} onClick={submit} disabled={!dirty || saving}>
        {saving ? '…' : 'Save'}
      </button>
    </div>
  );
};

const ScopeSection = ({
  scope, secrets, revealed, editing, editDraft, onEditDraftChange,
  onReveal, onCopy, onEdit, onSaveEdit, onCancelEdit, onRotate, onDelete, saving,
}) => {
  const color = SCOPE_BADGE_COLOR[scope] || '#bd93f9';
  return (
    <div className="nc-panel" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)',
        background: 'rgba(2,6,23,0.4)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span className="tag" style={{ background: color, color: '#020617', fontWeight: 700, fontSize: 9, padding: '2px 6px' }}>
          {scope}
        </span>
        <span className="mono muted" style={{ fontSize: 10 }}>{secrets.length} secret{secrets.length === 1 ? '' : 's'}</span>
      </div>
      {secrets.map((s, idx) => (
        <SecretRow
          key={s.name}
          secret={s}
          isLast={idx === secrets.length - 1}
          revealedValue={revealed[s.name]}
          isEditing={editing === s.name}
          editDraft={editDraft}
          onEditDraftChange={onEditDraftChange}
          onReveal={onReveal}
          onCopy={onCopy}
          onEdit={onEdit}
          onSaveEdit={onSaveEdit}
          onCancelEdit={onCancelEdit}
          onRotate={onRotate}
          onDelete={onDelete}
          saving={saving}
        />
      ))}
    </div>
  );
};

const SecretRow = ({
  secret, isLast, revealedValue, isEditing, editDraft, onEditDraftChange,
  onReveal, onCopy, onEdit, onSaveEdit, onCancelEdit, onRotate, onDelete, saving,
}) => {
  const typeColor = TYPE_BADGE_COLOR[secret.type] || 'var(--muted)';
  const isRevealed = revealedValue !== undefined;
  return (
    <div className="split-grid" style={{
      display: 'grid',
      gridTemplateColumns: '260px 1fr auto',
      gap: 12,
      padding: '12px 14px',
      borderBottom: isLast ? 'none' : '1px dashed color-mix(in srgb, var(--accent) 8%, transparent)',
      alignItems: 'center',
    }}>
      <div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {secret.name}
          <span className="tag" style={{ background: typeColor, color: '#020617', fontSize: 8, padding: '1px 5px', fontWeight: 700 }}>
            {secret.type}
          </span>
        </div>
        <div className="mono muted" style={{ fontSize: 9, marginTop: 3 }}>
          {secret.service}
          {secret.rotated && <> · rotated {fmtAgo(secret.rotated)}</>}
        </div>
        {secret.notes && (
          <div className="mono" style={{ fontSize: 9, marginTop: 3, color: 'var(--text-soft)', fontStyle: 'italic' }}>
            {secret.notes}
          </div>
        )}
      </div>

      <div style={{ minWidth: 0 }}>
        {isEditing ? (
          <textarea
            className="nc-input"
            value={editDraft}
            onChange={(e) => onEditDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancelEdit();
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSaveEdit();
            }}
            autoFocus
            rows={3}
            style={{ width: '100%', fontSize: 11, resize: 'vertical', fontFamily: 'var(--mono)', whiteSpace: 'pre' }}
          />
        ) : (
          <code className="mono" style={{
            display: 'block',
            background: 'rgba(2,6,23,0.7)',
            border: '1px solid var(--line)',
            padding: '6px 10px',
            fontSize: 11,
            color: isRevealed ? 'var(--text-soft)' : 'var(--muted)',
            borderRadius: 2,
            wordBreak: 'break-all',
            maxHeight: 60,
            overflow: 'auto',
          }}>
            {isRevealed
              ? (revealedValue || <span className="muted" style={{ fontStyle: 'italic' }}>empty</span>)
              : '••••••••••••••••'}
          </code>
        )}
      </div>

      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {isEditing ? (
          <>
            <button className="nc-btn primary" style={{ padding: '4px 10px', fontSize: 10 }} onClick={onSaveEdit} disabled={saving}>
              {saving ? '…' : 'Save'}
            </button>
            <button className="nc-btn ghost" style={{ padding: 6 }} onClick={onCancelEdit} title="Cancel">
              <Icon name="close" size={12}/>
            </button>
          </>
        ) : (
          <>
            <button className="nc-btn ghost" style={{ padding: 6 }} onClick={() => onReveal(secret.name)} title={isRevealed ? 'Hide' : 'Reveal'}>
              <Icon name={isRevealed ? 'eyeoff' : 'eye'} size={12}/>
            </button>
            <button className="nc-btn ghost" style={{ padding: 6 }} onClick={() => onCopy(secret.name)} title="Copy value">
              <Icon name="docs" size={12}/>
            </button>
            <button className="nc-btn ghost" style={{ padding: 6 }} onClick={() => onEdit(secret.name)} title="Edit">
              <Icon name="settings" size={12}/>
            </button>
            <button className="nc-btn ghost" style={{ padding: 6 }} onClick={() => onRotate(secret.name)} title="Rotate">
              <Icon name="refresh" size={12}/>
            </button>
            <button className="nc-btn ghost" style={{ padding: 6, color: 'var(--danger)' }} onClick={() => onDelete(secret.name)} title="Delete">
              <Icon name="close" size={12}/>
            </button>
          </>
        )}
      </div>
    </div>
  );
};

const OrphansSection = ({ orphans }) => {
  if (orphans.length === 0) return null;
  return (
    <div className="nc-panel" style={{ padding: 0, overflow: 'hidden', marginBottom: 16, borderColor: '#ffb86c' }}>
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid rgba(255,184,108,0.3)',
        background: 'rgba(255,184,108,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="tag" style={{ background: '#ffb86c', color: '#020617', fontWeight: 700, fontSize: 9, padding: '2px 6px' }}>UNMANAGED</span>
          <span className="mono muted" style={{ fontSize: 10 }}>{orphans.length} legacy entr{orphans.length === 1 ? 'y' : 'ies'}</span>
        </div>
        <div className="mono muted" style={{ fontSize: 10, marginTop: 6 }}>
          // entries in <code style={{ color: 'var(--accent-2)' }}>.env</code> that don't match the broker naming convention. Migrate them to <code>SCOPE_SERVICE_TYPE</code> form to bring them under broker scope control.
        </div>
      </div>
      {orphans.map((o, i) => (
        <div key={o.name} style={{
          padding: '10px 14px',
          borderBottom: i === orphans.length - 1 ? 'none' : '1px dashed rgba(255,184,108,0.15)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--text)' }}>{o.name}</span>
          <span className="mono muted" style={{ fontSize: 9 }}>// reason: {o.reason}</span>
        </div>
      ))}
    </div>
  );
};

const AuditRow = ({ row }) => {
  const outcomeColor =
    row.outcome === 'ok'    ? 'var(--accent-2)' :
    row.outcome === 'denied' ? 'var(--danger)' :
    row.outcome === 'error'  ? 'var(--danger)' :
    'var(--muted)';
  const ts = row.ts ? new Date(row.ts).toLocaleTimeString() : '';
  return (
    <div className="audit-row" style={{
      padding: '6px 0',
      borderBottom: '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)',
      display: 'grid',
      gridTemplateColumns: '80px 80px 110px 1fr 70px',
      gap: 8,
      alignItems: 'center',
    }}>
      <span className="mono muted" style={{ fontSize: 10 }}>{ts}</span>
      <span className="mono" style={{ fontSize: 10, color: 'var(--text-soft)' }}>{row.event}</span>
      <span className="mono" style={{ fontSize: 10, color: 'var(--text)' }}>{row.agent}</span>
      <span className="mono muted" style={{ fontSize: 10, wordBreak: 'break-all' }}>
        {row.secret_name || (row.secrets_requested || []).join(', ') || row.detail || ''}
        {row.purpose && <span style={{ color: 'var(--muted)' }}> · {row.purpose}</span>}
      </span>
      <span className="mono" style={{ fontSize: 10, color: outcomeColor, textAlign: 'right' }}>{row.outcome}</span>
    </div>
  );
};

function fmtAgo(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// Make sure the component is discoverable by the global PAGES registry.
window.Secrets = Secrets;
