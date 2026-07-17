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
    <div style={{ padding: '16px 18px', maxWidth: 1200 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h2 className="mono" style={{ margin: 0, letterSpacing: '0.06em' }}>COMPOSIO · CONNECTIONS</h2>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Manage OAuth connections + tier policy. Re-tag owner, flip shared, revoke, or initiate new entity-scoped OAuth.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="nc-btn" onClick={refresh} disabled={busy}>
            <Icon name="refresh" size={14} /> Refresh
          </button>
          <button className="nc-btn primary" onClick={() => setShowAdd(true)} disabled={busy}>
            <Icon name="plus" size={14} /> Add connection
          </button>
        </div>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--red)', color: 'var(--red)', padding: 10, marginBottom: 12 }}>
          <span className="mono" style={{ fontSize: 11 }}>ERROR:</span> {error}
        </div>
      )}

      {/* ── pending queue ───────────────────────────────────────── */}
      {pending.length > 0 && (
        <section style={{ marginBottom: 18 }}>
          <h3 className="mono" style={{ fontSize: 13, letterSpacing: '0.08em', marginBottom: 6 }}>
            ⚠ PENDING DECISIONS ({pending.length})
          </h3>
          <div className="card" style={{ padding: 0 }}>
            <table className="nc-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Agent</th><th>Toolkit</th><th>Tier</th><th>Reason</th><th>Conflict</th><th>Resolve</th>
                </tr>
              </thead>
              <tbody>
                {pending.map(p => (
                  <tr key={p.id}>
                    <td className="mono">{p.requesting_agent}</td>
                    <td>{p.toolkit}</td>
                    <td><span className={`tag ${tierTone(p.tier)}`}>{p.tier}</span></td>
                    <td className="muted" style={{ fontSize: 11 }}>{p.reason}</td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {p.conflict_owner ? `${p.conflict_owner} → ${p.conflict_account?.slice(0,12) ?? ''}…` : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {p.reason === 'user_decision_required' && (
                          <>
                            <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 6px' }}
                                    onClick={() => resolvePending(p.id, 'use_existing_shared', true)}>
                              Share existing
                            </button>
                            <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 6px' }}
                                    onClick={() => resolvePending(p.id, 'create_new_owned')}>
                              New per-agent
                            </button>
                          </>
                        )}
                        {p.reason === 'admin_approval_required' && (
                          <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 6px', borderColor: 'var(--green)' }}
                                  onClick={() => resolvePending(p.id, 'create_new_owned')}>
                            Approve new
                          </button>
                        )}
                        <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 6px', color: 'var(--red)' }}
                                onClick={() => resolvePending(p.id, 'rejected')}>
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── connections table ────────────────────────────────── */}
      <section>
        <h3 className="mono" style={{ fontSize: 13, letterSpacing: '0.08em', marginBottom: 6 }}>
          CONNECTIONS ({accounts.length})
        </h3>
        <div className="card" style={{ padding: 0 }}>
          <table className="nc-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Account ID</th>
                <th>Toolkit</th>
                <th>Owner</th>
                <th>Tier</th>
                <th>Shared</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 && !busy && (
                <tr><td colSpan={7} className="muted" style={{ padding: 24, textAlign: 'center' }}>
                  No connections found. Click "Add connection" to OAuth a new app scoped to an agent.
                </td></tr>
              )}
              {accounts.map(a => (
                <tr key={a.id}>
                  <td className="mono" style={{ fontSize: 11 }}>{a.id}</td>
                  <td>{a.toolkit}</td>
                  <td>
                    <OwnerCell value={a.owner} agents={agents}
                               onChange={(owner) => patchAccount(a.id, { owner, toolkit: a.toolkit })} />
                  </td>
                  <td>
                    <span className={`tag ${tierTone(a.tier)}`} title={tierBlurb(a.tier)}>{a.tier}</span>
                  </td>
                  <td>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <input type="checkbox" checked={!!a.shared}
                             onChange={(e) => patchAccount(a.id, { shared: e.target.checked, toolkit: a.toolkit })}/>
                      <span className="muted" style={{ fontSize: 11 }}>{a.shared ? 'shared' : 'private'}</span>
                    </label>
                  </td>
                  <td>
                    <span className={`tag ${a.status === 'ACTIVE' ? 'green' : 'amber'}`}>{a.status}</span>
                  </td>
                  <td>
                    <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 6px', color: 'var(--red)' }}
                            onClick={() => revoke(a.id, a.toolkit)} disabled={busy}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── tier legend ───────────────────────────────────── */}
      <section style={{ marginTop: 18 }}>
        <h3 className="mono" style={{ fontSize: 13, letterSpacing: '0.08em', marginBottom: 6 }}>TIER POLICY</h3>
        <div className="card stat-grid" style={{ padding: 12, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          {['T1','T2','T3'].map(t => (
            <div key={t} style={{ padding: 8, border: '1px solid var(--line-soft)', borderRadius: 4 }}>
              <span className={`tag ${tierTone(t)}`}>{t}</span>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{tierBlurb(t)}</div>
            </div>
          ))}
        </div>
      </section>

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
    <div className="nc-modal-overlay" onClick={onClose}>
      <div className="nc-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="nc-modal-header">
          <h3 className="mono" style={{ margin: 0 }}>NEW COMPOSIO CONNECTION</h3>
          <button className="nc-btn ghost" onClick={onClose}><Icon name="close" size={14}/></button>
        </div>
        <div className="nc-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
