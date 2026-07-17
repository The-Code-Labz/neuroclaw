/* page-connections.jsx — Composio connections panel
 *
 * Lists every Composio connected account with owner / shared / tier
 * metadata, lets the user re-tag owner, flip shared on/off, revoke, and
 * start a new OAuth flow that gets entity-stamped correctly (so we never
 * create orphan accounts from this page).
 *
 * Also surfaces the pending decision queue — T2 conflicts and T3 admin
 * approvals raised by the connection-policy middleware when an agent's
 * manage-connections call hits a rule.
 *
 * APIs consumed:
 *   GET    /api/composio/connections
 *   PATCH  /api/composio/connections/:id   { owner?, shared? }
 *   DELETE /api/composio/connections/:id
 *   GET    /api/composio/auth-configs
 *   POST   /api/composio/connections/initiate  { userId, authConfigId, toolkit, share }
 *   GET    /api/composio/pending
 *   POST   /api/composio/pending/:id/resolve   { resolution, resolved_by, share_existing }
 *   GET    /api/agents                          (for owner picker)
 */

const Connections = () => {
  const [accounts,    setAccounts]    = React.useState([]);
  const [pending,     setPending]     = React.useState([]);
  const [agents,      setAgents]      = React.useState([]);
  const [authConfigs, setAuthConfigs] = React.useState([]);
  const [busy,        setBusy]        = React.useState(false);
  const [error,       setError]       = React.useState(null);
  const [showAdd,     setShowAdd]     = React.useState(false);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const [c, p, ac, ag] = await Promise.all([
        window.NC_API.get('/api/composio/connections'),
        window.NC_API.get('/api/composio/pending'),
        window.NC_API.get('/api/composio/auth-configs'),
        window.NC_API.get('/api/agents'),
      ]);
      if (c?.ok)  setAccounts(c.accounts || []);
      if (p?.ok)  setPending(p.pending || []);
      if (ac?.ok) setAuthConfigs(ac.configs || []);
      if (Array.isArray(ag?.agents)) setAgents(ag.agents);
      else if (Array.isArray(ag))    setAgents(ag);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  React.useEffect(() => { refresh(); }, []);

  // ── action handlers ───────────────────────────────────────────────────
  const patchAccount = async (id, fields) => {
    setBusy(true);
    try {
      const r = await window.NC_API.patch(`/api/composio/connections/${encodeURIComponent(id)}`, fields);
      if (!r?.ok) throw new Error(r?.error || 'patch failed');
      await refresh();
    } catch (e) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const revoke = async (id, toolkit) => {
    if (!confirm(`Revoke Composio connection ${id} (${toolkit})? This deletes it at Composio's side.`)) return;
    setBusy(true);
    try {
      const r = await window.NC_API.del(`/api/composio/connections/${encodeURIComponent(id)}`);
      if (!r?.ok) throw new Error(r?.error || 'revoke failed');
      await refresh();
    } catch (e) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const resolvePending = async (pendingId, resolution, share_existing) => {
    setBusy(true);
    try {
      const r = await window.NC_API.post(`/api/composio/pending/${encodeURIComponent(pendingId)}/resolve`, {
        resolution, share_existing: !!share_existing, resolved_by: 'user',
      });
      if (!r?.ok) throw new Error(r?.error || 'resolve failed');
      await refresh();
    } catch (e) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  // ── filters / derived ─────────────────────────────────────────────────
  const tierTone = (t) => t === 'T1' ? 'green' : t === 'T2' ? 'amber' : t === 'T3' ? 'red' : 'muted';
  const tierBlurb = (t) =>
    t === 'T1' ? 'Auto-share — one OAuth, all agents'
    : t === 'T2' ? 'Ask at connect — same-agent reuse, other-agent prompt'
    : t === 'T3' ? 'Locked — every connect needs approval'
    : 'Unknown';

  // ── render ────────────────────────────────────────────────────────────
  return (
    <div>
      <PageHeader title="Composio · Connections" subtitle="// OAuth connections + tier policy · re-tag owner · flip shared · revoke · initiate new entity-scoped OAuth" right={<>
        <button className="nc-btn" onClick={refresh} disabled={busy}><Icon name="refresh" size={14} /> Refresh</button>
        <button className="nc-btn primary" onClick={() => setShowAdd(true)} disabled={busy}><Icon name="plus" size={14} /> Add connection</button>
      </>}/>

      {error && (
        <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 12 }}>// {error}</div>
      )}

      {/* ── pending queue ───────────────────────────────────────── */}
      {pending.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div className="label-tiny" style={{ marginBottom: 8 }}>PENDING DECISIONS ({pending.length})</div>
          {pending.map(p => (
            <div key={p.id} className="cn-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontSize: 12 }}>{p.requesting_agent}</span>
                <span className="muted" style={{ fontSize: 11 }}>· {p.toolkit}</span>
                <span className={`tag ${tierTone(p.tier)}`}>{p.tier}</span>
                <span className="muted" style={{ fontSize: 11 }}>{p.reason}</span>
                {p.conflict_owner && (
                  <span className="mono muted" style={{ fontSize: 10 }}>{p.conflict_owner} → {p.conflict_account?.slice(0,12) ?? ''}…</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                {p.reason === 'user_decision_required' && (
                  <>
                    <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 8px' }}
                            onClick={() => resolvePending(p.id, 'use_existing_shared', true)}>
                      Share existing
                    </button>
                    <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 8px' }}
                            onClick={() => resolvePending(p.id, 'create_new_owned')}>
                      New per-agent
                    </button>
                  </>
                )}
                {p.reason === 'admin_approval_required' && (
                  <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 8px', color: 'var(--accent-2)' }}
                          onClick={() => resolvePending(p.id, 'create_new_owned')}>
                    Approve new
                  </button>
                )}
                <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 8px', color: 'var(--danger)' }}
                        onClick={() => resolvePending(p.id, 'rejected')}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── connections list ────────────────────────────────── */}
      <div style={{ marginBottom: 18 }}>
        <div className="label-tiny" style={{ marginBottom: 8 }}>CONNECTIONS ({accounts.length})</div>
        {accounts.length === 0 && !busy && (
          <div className="cn-panel" style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
            No connections found. Click "Add connection" to OAuth a new app scoped to an agent.
          </div>
        )}
        {accounts.map(a => (
          <div key={a.id} className="cn-row">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
                <strong>{a.toolkit}</strong>
                <span className="mono muted" style={{ fontSize: 10 }}>{a.id}</span>
                <span className={`tag ${tierTone(a.tier)}`} title={tierBlurb(a.tier)}>{a.tier}</span>
                <span className={`tag ${a.status === 'ACTIVE' ? 'green' : 'amber'}`}>{a.status}</span>
              </div>
              <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 8px', color: 'var(--danger)' }}
                      onClick={() => revoke(a.id, a.toolkit)} disabled={busy}>
                Revoke
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="muted" style={{ fontSize: 10 }}>owner</span>
                <OwnerCell value={a.owner} agents={agents}
                           onChange={(owner) => patchAccount(a.id, { owner, toolkit: a.toolkit })} />
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={!!a.shared}
                       onChange={(e) => patchAccount(a.id, { shared: e.target.checked, toolkit: a.toolkit })}/>
                <span className="muted" style={{ fontSize: 11 }}>{a.shared ? 'shared' : 'private'}</span>
              </label>
            </div>
          </div>
        ))}
      </div>

      {/* ── tier legend ───────────────────────────────────── */}
      <div>
        <div className="label-tiny" style={{ marginBottom: 8 }}>TIER POLICY</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          {['T1','T2','T3'].map(t => (
            <div key={t} className="cn-panel" style={{ padding: 10 }}>
              <span className={`tag ${tierTone(t)}`}>{t}</span>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{tierBlurb(t)}</div>
            </div>
          ))}
        </div>
      </div>

      {showAdd && (
        <AddConnectionModal
          agents={agents}
          authConfigs={authConfigs}
          onClose={() => setShowAdd(false)}
          onDone={async () => { setShowAdd(false); await refresh(); }}
          setError={setError}
        />
      )}
    </div>
  );
};

const OwnerCell = ({ value, agents, onChange }) => {
  // Build the dropdown from agents.composio_user_id (the actual entity tag).
  // If multiple agents share a user_id, dedupe.
  const opts = React.useMemo(() => {
    const set = new Set();
    for (const a of agents) {
      const uid = (a.composio_user_id || a._raw?.composio_user_id || '').trim();
      if (uid) set.add(uid);
    }
    return Array.from(set).sort();
  }, [agents]);
  return (
    <select className="nc-input" style={{ fontSize: 11, padding: '2px 4px' }}
            value={value ?? ''}
            onChange={e => onChange(e.target.value || null)}>
      <option value="">— unassigned —</option>
      {opts.map(o => <option key={o} value={o}>{o}</option>)}
      {value && !opts.includes(value) && <option value={value}>{value} (manual)</option>}
    </select>
  );
};

const AddConnectionModal = ({ agents, authConfigs, onClose, onDone, setError }) => {
  const [userId,       setUserId]       = React.useState('');
  const [authConfigId, setAuthConfigId] = React.useState('');
  const [share,        setShare]        = React.useState(false);
  const [submitting,   setSubmitting]   = React.useState(false);
  const [redirectUrl,  setRedirectUrl]  = React.useState(null);

  const userIdOpts = React.useMemo(() => {
    const set = new Set();
    for (const a of agents) {
      const uid = (a.composio_user_id || a._raw?.composio_user_id || '').trim();
      if (uid) set.add(uid);
    }
    return Array.from(set).sort();
  }, [agents]);

  const submit = async () => {
    if (!userId || !authConfigId) { setError('Pick a user_id and an auth config'); return; }
    const cfg = authConfigs.find(c => c.id === authConfigId);
    setSubmitting(true);
    try {
      const r = await window.NC_API.post('/api/composio/connections/initiate', {
        userId, authConfigId,
        toolkit: cfg?.toolkit ?? 'unknown',
        share,
      });
      if (!r?.ok) throw new Error(r?.error || 'initiate failed');
      if (r.redirectUrl) {
        setRedirectUrl(r.redirectUrl);
        window.open(r.redirectUrl, '_blank', 'noopener');
      } else {
        // No redirect URL means the toolkit didn't need OAuth (e.g. API-key only).
        await onDone();
      }
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="cn-panel" onClick={e => e.stopPropagation()} style={{ width: '90%', maxWidth: 480 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="label-tiny neonc">NEW COMPOSIO CONNECTION</div>
          <button className="nc-btn ghost" onClick={onClose}><Icon name="close" size={14}/></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!redirectUrl ? (
            <>
              <label>
                <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                  Agent user_id (the entity Composio will stamp on this account)
                </div>
                <select className="nc-input" value={userId} onChange={e => setUserId(e.target.value)}>
                  <option value="">— pick agent identity —</option>
                  {userIdOpts.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                <input className="nc-input" placeholder="…or type a custom user_id"
                       value={userIdOpts.includes(userId) ? '' : userId}
                       onChange={e => setUserId(e.target.value)}
                       style={{ marginTop: 4 }}/>
              </label>
              <label>
                <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Auth config (toolkit)</div>
                <select className="nc-input" value={authConfigId} onChange={e => setAuthConfigId(e.target.value)}>
                  <option value="">— pick an auth config —</option>
                  {authConfigs.map(c => (
                    <option key={c.id} value={c.id}>{c.name} · {c.toolkit} · {c.id}</option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={share} onChange={e => setShare(e.target.checked)}/>
                <span className="muted" style={{ fontSize: 12 }}>
                  Mark as shared (any agent that needs this toolkit can use it)
                </span>
              </label>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
                <button className="nc-btn ghost" onClick={onClose} disabled={submitting}>Cancel</button>
                <button className="nc-btn primary" onClick={submit} disabled={submitting}>
                  {submitting ? 'Starting…' : 'Start OAuth'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="muted" style={{ fontSize: 12 }}>
                A browser tab opened with the OAuth flow. Complete it, then click "Done" below — we'll refresh the connection list.
              </div>
              <a href={redirectUrl} target="_blank" rel="noopener" className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                {redirectUrl}
              </a>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
                <button className="nc-btn primary" onClick={onDone}>Done</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

window.Connections = Connections;
