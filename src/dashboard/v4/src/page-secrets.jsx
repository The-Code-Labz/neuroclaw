/* Secrets v4 — manifest manager for the NC Broker
 *
 * Redesigned for the v4 dark theme. Keeps the v2 data model and API calls,
 * replaces inline hardcoded colors with the v4 design system.
 */

const SECRET_TYPES = ['PAT', 'KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'URL', 'CUSTOM'];

const TYPE_BADGE_COLOR = {
  PAT:     { bg: 'rgba(255,184,108,0.14)', border: 'rgba(255,184,108,0.35)', text: '#ffb86c' },
  KEY:     { bg: 'rgba(139,233,253,0.12)', border: 'rgba(139,233,253,0.30)', text: '#8be9fd' },
  TOKEN:   { bg: 'rgba(189,147,249,0.12)', border: 'rgba(189,147,249,0.30)', text: '#bd93f9' },
  SECRET:  { bg: 'rgba(255,121,198,0.12)', border: 'rgba(255,121,198,0.30)', text: '#ff79c6' },
  PASSWORD:{ bg: 'rgba(252,165,165,0.12)', border: 'rgba(252,165,165,0.30)', text: '#fca5a5' },
  URL:     { bg: 'rgba(110,231,183,0.12)', border: 'rgba(110,231,183,0.30)', text: '#6ee7b7' },
  CUSTOM:  { bg: 'var(--surface-2)',       border: 'var(--border-default)',  text: 'var(--text-secondary)' },
};

const Secrets = () => {
  const [grouped, setGrouped]       = React.useState({});
  const [orphans, setOrphans]       = React.useState([]);
  const [agents, setAgents]         = React.useState([]);
  const [loading, setLoading]       = React.useState(true);
  const [err, setErr]               = React.useState(null);
  const [okMsg, setOkMsg]           = React.useState(null);

  const [filter, setFilter]         = React.useState('');
  const [showAdd, setShowAdd]       = React.useState(false);
  const [showAgents, setShowAgents] = React.useState(false);

  const [revealed, setRevealed]     = React.useState({});
  const [editing, setEditing]       = React.useState(null);
  const [editDraft, setEditDraft]   = React.useState('');

  const [scopeKind, setScopeKind]   = React.useState('SHARED');
  const [scopeAgent, setScopeAgent] = React.useState('');
  const [customScope, setCustomScope] = React.useState('');
  const [service, setService]       = React.useState('');
  const [secType, setSecType]       = React.useState('KEY');
  const [customType, setCustomType] = React.useState('');
  const [newVal, setNewVal]         = React.useState('');
  const [newNotes, setNewNotes]     = React.useState('');
  const [resolvedName, setResolvedName] = React.useState('');
  const [resolveErrs, setResolveErrs]   = React.useState([]);
  const [resolveCollision, setResolveCollision] = React.useState(false);
  const [saving, setSaving]         = React.useState(false);

  const [auditRows, setAuditRows]   = React.useState([]);
  const [auditLoading, setAuditLoading] = React.useState(false);
  const [storage, setStorage]       = React.useState(null);

  const flash = (msg) => { setOkMsg(msg); setTimeout(() => setOkMsg(null), 2500); };

  const loadSecrets = React.useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await window.NC_API.post('/api/broker/admin/list', {});
      setGrouped(res.grouped || {});
      setOrphans(res.orphans || []);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  const loadAgents = React.useCallback(async () => {
    try {
      const res = await window.NC_API.get('/api/broker/admin/agents');
      setAgents(res.agents || []);
    } catch (e) { console.warn('[secrets] loadAgents failed:', e.message); }
  }, []);

  const loadAudit = React.useCallback(async () => {
    setAuditLoading(true);
    try {
      const res = await window.NC_API.get('/api/broker/admin/audit?limit=50');
      setAuditRows(res.rows || []);
    } catch (e) { console.warn('[secrets] loadAudit failed:', e.message); }
    finally { setAuditLoading(false); }
  }, []);

  const loadStorage = React.useCallback(async () => {
    try {
      const res = await window.NC_API.get('/api/broker/admin/storage');
      setStorage(res);
    } catch (e) { console.warn('[secrets] loadStorage failed:', e.message); }
  }, []);

  React.useEffect(() => { loadSecrets(); loadAgents(); loadAudit(); loadStorage(); }, [loadSecrets, loadAgents, loadAudit, loadStorage]);

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
    if (!scope || !service) { setResolvedName(''); setResolveErrs([]); setResolveCollision(false); return; }
    (async () => {
      try {
        const r = await window.NC_API.post('/api/broker/admin/name/preview', { scope, service, type: effectiveType });
        if (cancelled) return;
        setResolvedName(r.name || '');
        setResolveErrs(r.errors || []);
        setResolveCollision(Boolean(r.collision));
      } catch { if (!cancelled) { setResolvedName(''); setResolveErrs(['preview_failed']); } }
    })();
    return () => { cancelled = true; };
  }, [scopeKind, scopeAgent, customScope, service, secType, customType]);

  const reveal = async (name) => {
    if (revealed[name] !== undefined) {
      setRevealed((p) => { const n = { ...p }; delete n[name]; return n; });
      return;
    }
    try {
      const r = await window.NC_API.post('/api/broker/admin/reveal', { name, purpose: 'dashboard reveal' });
      setRevealed((p) => ({ ...p, [name]: r.value ?? '' }));
    } catch (e) { setErr(e.message || String(e)); }
  };

  const copyValue = async (name) => {
    try {
      const r = await window.NC_API.post('/api/broker/admin/reveal', { name, purpose: 'dashboard copy' });
      await navigator.clipboard.writeText(r.value ?? '');
      flash('Copied ' + name);
    } catch (e) { setErr(e.message || String(e)); }
  };

  const beginEdit = async (name) => {
    try {
      const r = await window.NC_API.post('/api/broker/admin/reveal', { name, purpose: 'dashboard edit' });
      setEditDraft(r.value ?? '');
      setEditing(name);
    } catch (e) { setErr(e.message || String(e)); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setSaving(true); setErr(null);
    try {
      await window.NC_API.post('/api/broker/admin/update', { name: editing, value: editDraft });
      flash('Updated ' + editing);
      setEditing(null); setEditDraft('');
      setRevealed((p) => { const n = { ...p }; delete n[editing]; return n; });
      await loadSecrets(); loadAudit();
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  };

  const deleteSecret = async (name) => {
    if (!confirm('Delete ' + name + '?\n\nA timestamped .env backup is written first.')) return;
    setErr(null);
    try {
      await window.NC_API.post('/api/broker/admin/delete', { name });
      flash('Deleted ' + name);
      setRevealed((p) => { const n = { ...p }; delete n[name]; return n; });
      await loadSecrets(); loadAudit();
    } catch (e) { setErr(e.message || String(e)); }
  };

  const rotateSecret = async (name) => {
    const v = prompt('Enter new value for ' + name + ' (leave blank to just mark rotated):', '');
    if (v === null) return;
    try {
      await window.NC_API.post('/api/broker/admin/rotate', { name, ...(v ? { value: v } : {}) });
      flash('Rotated ' + name);
      setRevealed((p) => { const n = { ...p }; delete n[name]; return n; });
      await loadSecrets(); loadAudit();
    } catch (e) { setErr(e.message || String(e)); }
  };

  const addSecret = async () => {
    setErr(null);
    if (resolveErrs.length > 0 || !resolvedName) { setErr('Fix the form errors before saving.'); return; }
    if (resolveCollision) { setErr(`A secret named ${resolvedName} already exists.`); return; }
    if (!newVal) { setErr('Value cannot be empty.'); return; }
    setSaving(true);
    try {
      await window.NC_API.post('/api/broker/admin/create', { name: resolvedName, value: newVal, notes: newNotes, tags: [] });
      flash('Created ' + resolvedName);
      setNewVal(''); setNewNotes(''); setService(''); setShowAdd(false);
      await loadSecrets(); loadAudit();
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  };

  const setAgentPrefix = async (agentId, prefix) => {
    try {
      await window.NC_API.post('/api/broker/admin/agents/prefix', { agent_id: agentId, prefix: prefix === '' ? null : prefix });
      flash('Prefix updated'); await loadAgents();
    } catch (e) { setErr(e.message || String(e)); }
  };

  const lc = filter.toLowerCase();
  const matchesFilter = (s) => !lc || s.name.toLowerCase().includes(lc) || (s.service || '').toLowerCase().includes(lc);

  const allScopes = Object.keys(grouped).sort((a, b) => {
    const order = (k) => (k === 'SHARED' ? 0 : k === 'NEUROCLAW' ? 1 : 2);
    if (order(a) !== order(b)) return order(a) - order(b);
    return a.localeCompare(b);
  });

  const totalManaged = allScopes.reduce((n, k) => n + grouped[k].length, 0);
  const agentPrefixes = agents.map((a) => a.canonical_prefix).filter(Boolean).sort();

  return (
    <>
      <PageHeader title="Secrets" subtitle="NC Broker manifest — scope-gated credentials for every agent" right={
        <button className="nc-btn primary" onClick={() => { setShowAdd((s) => !s); setErr(null); }}>
          <Icon name="plus" size={14}/> {showAdd ? 'Cancel' : 'Add Secret'}
        </button>
      }/>

      {/* Status chips */}
      <div className="flex-wrap-mobile" style={{ marginBottom: 18 }}>
        <StatCardMini label="MANAGED" value={totalManaged} tone="accent"/>
        <StatCardMini label="SCOPES" value={allScopes.length} tone="accent"/>
        <StatCardMini label="UNMANAGED" value={orphans.length} tone={orphans.length > 0 ? 'warning' : 'muted'}/>
        <StatCardMini label="AGENT PREFIXES" value={agentPrefixes.length} tone="accent"/>
        <StorageBackendChip storage={storage} />
      </div>

      {/* Alerts */}
      {err && (
        <div className="nc-panel" style={{ padding: '10px 14px', marginBottom: 14, background: 'rgba(252,165,165,0.10)', borderColor: 'rgba(252,165,165,0.35)' }}>
          <div className="mono" style={{ color: 'var(--error)', fontSize: 11 }}>// error: {err}</div>
        </div>
      )}
      {okMsg && (
        <div className="nc-panel" style={{ padding: '10px 14px', marginBottom: 14, background: 'rgba(110,231,183,0.10)', borderColor: 'rgba(110,231,183,0.35)' }}>
          <div className="mono" style={{ color: 'var(--success)', fontSize: 11 }}>// {okMsg}</div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex-wrap-mobile" style={{ marginBottom: 18 }}>
        <div className="page-header-search" style={{ flex: '1 1 260px', maxWidth: 360 }}>
          <Icon name="search" size={18}/>
          <input placeholder="Filter by name or service…" value={filter} onChange={(e) => setFilter(e.target.value)}/>
        </div>
        <button className="nc-btn" onClick={() => { loadSecrets(); loadAudit(); }} disabled={loading}>
          <Icon name="refresh" size={14}/> Reload
        </button>
        <button className="nc-btn" onClick={() => setShowAgents((s) => !s)}>
          <Icon name="settings" size={14}/> {showAgents ? 'Hide' : 'Manage'} agent prefixes
        </button>
      </div>

      {/* Agent prefix manager */}
      {showAgents && (
        <Section title="AGENT CANONICAL PREFIXES" className="agent-prefix-section" style={{ marginBottom: 20 }}>
          <div className="mono muted" style={{ fontSize: 11, marginBottom: 14 }}>
            // Each agent owns one prefix (e.g. ORACLE, JARVIS). Used by the broker scope resolver to gate access to <code style={{ color: 'var(--accent)' }}>&lt;PREFIX&gt;_*</code> secrets.
          </div>
          {agents.length === 0 ? (
            <div className="mono muted" style={{ fontSize: 11 }}>// no active agents found</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {agents.map((a) => <AgentPrefixRow key={a.id} agent={a} onSave={setAgentPrefix} />)}
            </div>
          )}
        </Section>
      )}

      {/* Add form */}
      {showAdd && (
        <Section title="NEW SECRET" className="new-secret-section" style={{ marginBottom: 20, borderColor: 'var(--accent)' }}>
          <div className="setting-row" style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '10px 16px', alignItems: 'center', marginBottom: 12 }}>
            <span className="mono muted" style={{ fontSize: 11 }}>SCOPE</span>
            <div className="flex-wrap-mobile">
              {[
                { v: 'SHARED',    label: 'Shared',  hint: 'every agent' },
                { v: 'NEUROCLAW', label: 'Project', hint: 'NeuroClaw infra' },
                { v: 'AGENT',     label: 'Agent',   hint: 'single agent only' },
                { v: 'CUSTOM',    label: 'Custom',  hint: 'any prefix' },
              ].map((opt) => (
                <label key={opt.v} className="mono" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="radio" name="scope-kind" checked={scopeKind === opt.v} onChange={() => setScopeKind(opt.v)}/>
                  {opt.label}
                  <span className="muted" style={{ fontSize: 10 }}>({opt.hint})</span>
                </label>
              ))}
            </div>

            {scopeKind === 'AGENT' && (
              <>
                <span className="mono muted" style={{ fontSize: 11 }}>AGENT</span>
                <select className="nc-input" value={scopeAgent} onChange={(e) => setScopeAgent(e.target.value)} style={{ maxWidth: 260, fontSize: 12 }}>
                  <option value="">— pick agent prefix —</option>
                  {agentPrefixes.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </>
            )}
            {scopeKind === 'CUSTOM' && (
              <>
                <span className="mono muted" style={{ fontSize: 11 }}>CUSTOM SCOPE</span>
                <input className="nc-input" placeholder="LIESE" value={customScope}
                  onChange={(e) => setCustomScope(e.target.value.toUpperCase().replace(/\s+/g, '_').replace(/\./g, ''))}
                  style={{ maxWidth: 180, fontSize: 12 }}/>
              </>
            )}

            <span className="mono muted" style={{ fontSize: 11 }}>SERVICE</span>
            <input className="nc-input" placeholder="GITHUB" value={service}
              onChange={(e) => setService(e.target.value.toUpperCase().replace(/\s+/g, '_').replace(/\./g, ''))}
              style={{ maxWidth: 260, fontSize: 12 }}/>

            <span className="mono muted" style={{ fontSize: 11 }}>TYPE</span>
            <select className="nc-input" value={secType} onChange={(e) => { setSecType(e.target.value); if (e.target.value !== 'CUSTOM') setCustomType(''); }} style={{ maxWidth: 200, fontSize: 12 }}>
              {SECRET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>

            {secType === 'CUSTOM' && (
              <>
                <span className="mono muted" style={{ fontSize: 11 }}>CUSTOM TYPE</span>
                <input className="nc-input" placeholder="WEBHOOK" value={customType}
                  onChange={(e) => setCustomType(e.target.value.toUpperCase().replace(/\s+/g, '_').replace(/\./g, ''))}
                  style={{ maxWidth: 260, fontSize: 12 }}/>
              </>
            )}

            <span className="mono muted" style={{ fontSize: 11 }}>RESOLVED NAME</span>
            <div className="mono" style={{
              fontSize: 12, padding: '8px 12px', background: 'var(--bg-base)',
              border: `1px solid ${resolveErrs.length || resolveCollision ? 'var(--error)' : 'var(--accent)'}`,
              color: resolveErrs.length || resolveCollision ? 'var(--error)' : 'var(--accent)',
              borderRadius: 'var(--radius-sm)'
            }}>
              {resolvedName || <span className="muted">// fill out scope, service, and type</span>}
              {resolveCollision && <span style={{ marginLeft: 12, color: 'var(--error)' }}>// name already exists</span>}
              {resolveErrs.length > 0 && <span style={{ marginLeft: 12 }}>// {resolveErrs.join(', ')}</span>}
            </div>

            <span className="mono muted" style={{ fontSize: 11, alignSelf: 'flex-start', paddingTop: 8 }}>VALUE</span>
            <textarea className="nc-input" placeholder="sk-… (paste multiline values like SSH keys here)" value={newVal}
              onChange={(e) => setNewVal(e.target.value)} autoComplete="off" rows={3}
              style={{ fontSize: 12, resize: 'vertical', fontFamily: 'var(--mono)', whiteSpace: 'pre' }}/>

            <span className="mono muted" style={{ fontSize: 11 }}>NOTES</span>
            <input className="nc-input" placeholder="scope: repo, workflow" value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)} style={{ fontSize: 12 }}/>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
            <button className="nc-btn ghost" onClick={() => setShowAdd(false)}>Cancel</button>
            <button className="nc-btn primary" onClick={addSecret}
              disabled={saving || !resolvedName || resolveErrs.length > 0 || resolveCollision || !newVal}>
              {saving ? '…' : 'Add Secret'}
            </button>
          </div>

          <div className="mono muted" style={{ fontSize: 10, marginTop: 12 }}>
            // Stored via broker → encrypted at rest is delegated to the storage adapter. Naming convention enforced server-side.
          </div>
        </Section>
      )}

      {/* Grouped lists */}
      {loading ? (
        <div className="mono muted" style={{ fontSize: 11, padding: 24 }}>// loading secrets…</div>
      ) : totalManaged === 0 && orphans.length === 0 ? (
        <Section className="empty-state" style={{ textAlign: 'center' }}>
          <div className="mono muted" style={{ fontSize: 12 }}>// no secrets yet — click "Add Secret" to create one</div>
        </Section>
      ) : (
        <>
          {allScopes.map((scope) => {
            const visible = grouped[scope].filter(matchesFilter);
            if (visible.length === 0) return null;
            return (
              <Section key={scope} className="secret-scope-section" style={{ marginBottom: 20, padding: 0 }}>
                <div className="secret-scope-header">
                  <span className="tag accent" style={{ fontWeight: 700, fontSize: 10, padding: '3px 8px' }}>{scope}</span>
                  <span className="mono muted" style={{ fontSize: 11 }}>{visible.length} secret{visible.length === 1 ? '' : 's'}</span>
                </div>
                <div>
                  {visible.map((s, idx) => (
                    <SecretRow
                      key={s.name}
                      secret={s}
                      isLast={idx === visible.length - 1}
                      revealedValue={revealed[s.name]}
                      isEditing={editing === s.name}
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
                  ))}
                </div>
              </Section>
            );
          })}

          {orphans.length > 0 && (
            <Section title="UNMANAGED LEGACY ENTRIES" className="orphans-section" style={{ marginBottom: 20, padding: 0, borderColor: 'var(--warning)' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
                <div className="mono muted" style={{ fontSize: 11 }}>
                  // entries in <code style={{ color: 'var(--accent)' }}>.env</code> that don't match the broker naming convention. Migrate them to <code>SCOPE_SERVICE_TYPE</code> form to bring them under broker scope control.
                </div>
              </div>
              {orphans.filter((o) => !lc || o.name.toLowerCase().includes(lc)).map((o, i, arr) => (
                <div key={o.name} className="secret-orphan-row" style={{ borderBottom: i === arr.length - 1 ? 'none' : undefined }}>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--text-primary)' }}>{o.name}</span>
                  <span className="mono muted" style={{ fontSize: 10 }}>// reason: {o.reason}</span>
                </div>
              ))}
            </Section>
          )}
        </>
      )}

      {/* Audit panel */}
      <Section title="RECENT ACCESS" right={
        <button className="nc-btn ghost" style={{ padding: 6 }} onClick={loadAudit} title="Refresh audit log">
          <Icon name="refresh" size={14}/>
        </button>
      } style={{ marginBottom: 20 }}>
        {auditLoading ? (
          <div className="mono muted" style={{ fontSize: 11 }}>// loading audit log…</div>
        ) : auditRows.length === 0 ? (
          <div className="mono muted" style={{ fontSize: 11 }}>// no broker access yet</div>
        ) : (
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            {auditRows.map((row, i) => <AuditRow key={i} row={row} />)}
          </div>
        )}
      </Section>

      {/* Naming convention reference */}
      <Section title="NAMING CONVENTION">
        <div className="mono muted" style={{ fontSize: 11, lineHeight: 1.7 }}>
          // <code style={{ color: 'var(--accent)' }}>&lt;SCOPE&gt;_&lt;SERVICE&gt;_&lt;TYPE&gt;</code> — the name IS the access policy.<br/>
          &nbsp;&nbsp;• <code style={{ color: 'var(--accent)' }}>SHARED_*</code> — every agent (external service keys)<br/>
          &nbsp;&nbsp;• <code style={{ color: 'var(--accent)' }}>NEUROCLAW_*</code> — project infra (database URLs, JWT secrets)<br/>
          &nbsp;&nbsp;• <code style={{ color: 'var(--accent)' }}>&lt;AGENT&gt;_*</code> — that agent only (uses canonical prefix)<br/>
          // Agents access values via <code style={{ color: 'var(--accent)' }}>broker.use(name)</code> or <code style={{ color: 'var(--accent)' }}>broker.exec(...)</code> — values never enter agent context when <code>exec</code> is used.
        </div>
      </Section>
    </>
  );
};

const StatCardMini = ({ label, value, tone }) => (
  <div className="nc-panel" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 160px' }}>
    <span className="mono muted" style={{ fontSize: 10 }}>{label}</span>
    <span className="mono" style={{ fontSize: 20, fontWeight: 600, color: tone === 'warning' ? 'var(--warning)' : 'var(--accent)' }}>{value}</span>
  </div>
);

const StorageBackendChip = ({ storage }) => {
  if (!storage) {
    return (
      <div className="nc-panel" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 200px' }}>
        <span className="mono muted" style={{ fontSize: 10 }}>BACKEND</span>
        <span className="mono muted" style={{ fontSize: 11 }}>// loading…</span>
      </div>
    );
  }
  const isInfisical = storage.backend === 'infisical';
  const color = !storage.ok ? 'var(--error)' : isInfisical ? 'var(--accent)' : 'var(--warning)';
  const label = isInfisical ? 'INFISICAL' : 'ENV-MANAGER';
  return (
    <div className="nc-panel" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 260px' }}>
      <span className="mono muted" style={{ fontSize: 10 }}>BACKEND</span>
      <span className="mono" style={{ fontSize: 12, fontWeight: 600, color }}>{label}</span>
      <span className="mono muted" style={{ fontSize: 10 }}>{storage.detail}</span>
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
    <div className="setting-row" style={{ display: 'grid', gridTemplateColumns: '1fr 220px auto auto', gap: 12, alignItems: 'center' }}>
      <span className="mono" style={{ fontSize: 12, color: 'var(--text-primary)' }}>{agent.name}</span>
      <input className="nc-input" placeholder="ORACLE" value={draft}
        onChange={(e) => setDraft(e.target.value.toUpperCase())} style={{ fontSize: 12 }}/>
      <span className="mono muted" style={{ fontSize: 10 }}>{agent.canonical_prefix ? '✓ set' : '— unset'}</span>
      <button className="nc-btn" style={{ padding: '6px 12px', fontSize: 11 }} onClick={submit} disabled={!dirty || saving}>
        {saving ? '…' : 'Save'}
      </button>
    </div>
  );
};

const SecretRow = ({
  secret, isLast, revealedValue, isEditing, editDraft, onEditDraftChange,
  onReveal, onCopy, onEdit, onSaveEdit, onCancelEdit, onRotate, onDelete, saving,
}) => {
  const typeStyle = TYPE_BADGE_COLOR[secret.type] || TYPE_BADGE_COLOR.CUSTOM;
  const isRevealed = revealedValue !== undefined;
  return (
    <div className="secret-row" style={{ borderBottom: isLast ? 'none' : undefined }}>
      <div className="secret-main">
        <div className="secret-name">
          {secret.name}
          <span className="tag" style={{
            background: typeStyle.bg, borderColor: typeStyle.border, color: typeStyle.text,
            fontSize: 10, padding: '3px 8px', fontWeight: 700, textTransform: 'uppercase'
          }}>{secret.type}</span>
        </div>
        <div className="secret-meta">
          {secret.service}
          {secret.rotated && <> · rotated {fmtAgo(secret.rotated)}</>}
        </div>
        {secret.notes && <div className="secret-notes">{secret.notes}</div>}
      </div>

      <div className="secret-value">
        {isEditing ? (
          <textarea className="nc-input" value={editDraft}
            onChange={(e) => onEditDraftChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onCancelEdit(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSaveEdit(); }}
            autoFocus rows={3}
            style={{ width: '100%', fontSize: 12, resize: 'vertical', fontFamily: 'var(--mono)', whiteSpace: 'pre' }}/>
        ) : (
          <code onClick={() => onEdit(secret.name)}>
            {isRevealed
              ? (revealedValue || <span className="muted" style={{ fontStyle: 'italic' }}>empty</span>)
              : '••••••••••••••••'}
          </code>
        )}
      </div>

      <div className="secret-actions">
        {isEditing ? (
          <>
            <button className="nc-btn primary" style={{ padding: '6px 12px', fontSize: 11 }} onClick={onSaveEdit} disabled={saving}>
              {saving ? '…' : 'Save'}
            </button>
            <button className="nc-btn ghost" style={{ padding: 8 }} onClick={onCancelEdit} title="Cancel">
              <Icon name="close" size={14}/>
            </button>
          </>
        ) : (
          <>
            <button className="nc-btn ghost" style={{ padding: 8 }} onClick={() => onReveal(secret.name)} title={isRevealed ? 'Hide' : 'Reveal'}>
              <Icon name={isRevealed ? 'eyeoff' : 'eye'} size={14}/>
            </button>
            <button className="nc-btn ghost" style={{ padding: 8 }} onClick={() => onCopy(secret.name)} title="Copy value">
              <Icon name="docs" size={14}/>
            </button>
            <button className="nc-btn ghost" style={{ padding: 8 }} onClick={() => onEdit(secret.name)} title="Edit">
              <Icon name="settings" size={14}/>
            </button>
            <button className="nc-btn ghost" style={{ padding: 8 }} onClick={() => onRotate(secret.name)} title="Rotate">
              <Icon name="refresh" size={14}/>
            </button>
            <button className="nc-btn ghost" style={{ padding: 8, color: 'var(--error)' }} onClick={() => onDelete(secret.name)} title="Delete">
              <Icon name="close" size={14}/>
            </button>
          </>
        )}
      </div>
    </div>
  );
};

const AuditRow = ({ row }) => {
  const outcomeColor =
    row.outcome === 'ok'     ? 'var(--accent)' :
    row.outcome === 'denied' ? 'var(--error)' :
    row.outcome === 'error'  ? 'var(--error)' :
    'var(--text-tertiary)';
  const ts = row.ts ? new Date(row.ts).toLocaleTimeString() : '';
  return (
    <div className="audit-row">
      <span className="mono muted" style={{ fontSize: 10 }}>{ts}</span>
      <span className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{row.event}</span>
      <span className="mono" style={{ fontSize: 10, color: 'var(--text-primary)' }}>{row.agent}</span>
      <span className="mono muted" style={{ fontSize: 10, wordBreak: 'break-all' }}>
        {row.secret_name || (row.secrets_requested || []).join(', ') || row.detail || ''}
        {row.purpose && <span style={{ color: 'var(--text-tertiary)' }}> · {row.purpose}</span>}
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

window.Secrets = Secrets;
