/* Connect → Machines — SSH remote-machine registry (spec: ssh-machines-feature #6).
 *
 * Metadata only. Credentials live in the NC Broker (Security → Secrets) as
 * restricted SSH secrets; this tab stores just the broker secret NAME.
 * Flow: add machine → Test Connection (captures host key) → Verify fingerprint
 * → grant agents → they can ssh_run. Fail-closed: empty allow-list = no access.
 */

const SENS_COLOR = { low: 'var(--muted)', high: 'var(--amber)', critical: 'var(--danger)' };
const FP_COLOR   = { verified: 'var(--accent-2)', pending_verification: 'var(--amber)', mismatch: 'var(--danger)' };

const raw = (path, method, body) =>
  fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json().catch(() => ({ ok: r.ok })));

const SshMachines = () => {
  const [machines, setMachines] = React.useState([]);
  const [agents,   setAgents]   = React.useState([]);
  const [secrets,  setSecrets]  = React.useState([]);   // SSH-class broker secret names
  const [pending,  setPending]  = React.useState([]);   // TOFU + critical-run approvals
  const [loading,  setLoading]  = React.useState(true);
  const [busy,     setBusy]     = React.useState('');
  const [msg,      setMsg]      = React.useState(null);
  const [showAdd,  setShowAdd]  = React.useState(false);
  const [expanded, setExpanded] = React.useState(null);

  const blank = { name: '', host: '', port: 22, username: '', auth_method: 'key', secret_name: '', passphrase_secret_name: '', sensitivity: 'low', legacy_algos: false, jump_host: '', notes: '' };
  const [form, setForm] = React.useState(blank);
  const [editing,  setEditing]  = React.useState(null);   // machine id being edited
  const [editForm, setEditForm] = React.useState(blank);

  const load = React.useCallback(() => {
    Promise.all([
      window.NC_API.get('/api/ssh/machines').catch(() => ({ items: [] })),
      window.NC_API.get('/api/agents').catch(() => []),
      window.NC_API.get('/api/ssh/confirmations').catch(() => ({ items: [] })),
      raw('/api/broker/admin/list', 'POST', {}).catch(() => ({ grouped: {} })),
    ]).then(([m, a, p, s]) => {
      setMachines(Array.isArray(m.items) ? m.items : []);
      setAgents(Array.isArray(a) ? a : []);
      setPending(Array.isArray(p.items) ? p.items.filter(x => x.status === 'pending') : []);
      // Broker /list → { grouped: { scope: [{name, service}] } }. Keep SSH-class only.
      const flat = Object.values(s.grouped || {}).flat();
      setSecrets(flat.filter(x => x && x.service === 'SSH').map(x => x.name));
      setLoading(false);
    });
  }, []);

  React.useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 6000); };

  const create = async () => {
    if (!form.name || !form.host || !form.username || !form.secret_name) { flash('name, host, username and secret are required', false); return; }
    setBusy('create');
    const r = await raw('/api/ssh/machines', 'POST', form);
    setBusy('');
    if (r.ok) { setShowAdd(false); setForm(blank); flash(`Added ${form.name}`); load(); }
    else flash(r.error || 'create failed', false);
  };

  const patch = async (id, fields) => { await raw(`/api/ssh/machines/${id}`, 'PATCH', fields); load(); };
  const del   = async (id, name) => { if (!confirm(`Delete machine "${name}"?`)) return; await raw(`/api/ssh/machines/${id}`, 'DELETE'); flash(`Deleted ${name}`); load(); };

  const startEdit = (m) => {
    setEditForm({
      name: m.name || '', host: m.host || '', port: m.port ?? 22, username: m.username || '',
      auth_method: m.auth_method || 'key', secret_name: m.secret_name || '',
      passphrase_secret_name: m.passphrase_secret_name || '', sensitivity: m.sensitivity || 'low',
      legacy_algos: !!m.legacy_algos, jump_host: m.jump_host || '', notes: m.notes || '',
    });
    setEditing(m.id);
  };
  const saveEdit = async (id) => {
    if (!editForm.name || !editForm.host || !editForm.username || !editForm.secret_name) { flash('name, host, username and secret are required', false); return; }
    setBusy('edit:' + id);
    const r = await raw(`/api/ssh/machines/${id}`, 'PATCH', { ...editForm, port: Number(editForm.port) });
    setBusy('');
    if (r.ok) { setEditing(null); flash(r.reverified ? 'Config saved — endpoint changed, host key must be re-verified (Test connection).' : 'Config saved'); load(); }
    else flash(r.error || 'save failed', false);
  };

  const test = async (id, name) => {
    setBusy('test:' + id);
    const r = await raw(`/api/ssh/machines/${id}/test`, 'POST', {});
    setBusy('');
    if (r.result?.ok) flash(`${name}: connection OK`);
    else if (r.fingerprint) flash(`${name}: host key captured — verify the fingerprint below`, false);
    else flash(`${name}: ${r.result?.error || r.error || 'test failed'}`, false);
    load();
  };

  const verifyFp = async (id, name) => { const r = await raw(`/api/ssh/machines/${id}/verify-fingerprint`, 'POST', {}); if (r.ok) flash(`${name}: host key verified & pinned`); else flash(r.error || 'verify failed', false); load(); };
  const resolveConfirm = async (id, decision) => { await raw(`/api/ssh/confirmations/${id}`, 'POST', { decision }); load(); };

  const toggleAgent = async (m, agentId) => {
    let allowed = [];
    try { allowed = JSON.parse(m.allowed_agents || '[]'); } catch { allowed = []; }
    const next = allowed.includes(agentId) ? allowed.filter(x => x !== agentId) : [...allowed, agentId];
    await patch(m.id, { allowed_agents: next });
  };
  const toggleAgentSsh = async (agent) => {
    await fetch(`/api/agents/${agent.id}`, { method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ssh_enabled: !agent.ssh_enabled }) });
    load();
  };

  if (loading) return <div style={{ padding: 24, color: 'var(--muted)' }}>Loading machines…</div>;

  return (
    <div style={{ padding: '16px 20px', maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>Machines</h2>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            Remote SSH targets. Keys/passwords live in the broker as <code>SSH</code>-class secrets — this only stores the secret name. Enable an agent below, then grant it per machine.
          </div>
        </div>
        <button onClick={() => setShowAdd(v => !v)} style={{ padding: '7px 14px', background: 'var(--accent)', color: 'var(--icon-on-accent, #fff)', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
          {showAdd ? 'Cancel' : '+ Add machine'}
        </button>
      </div>

      {msg && <div style={{ padding: '8px 12px', marginBottom: 12, borderRadius: 6, fontSize: 13, background: msg.ok ? 'color-mix(in srgb, var(--accent-2) 15%, transparent)' : 'color-mix(in srgb, var(--danger) 15%, transparent)', color: msg.ok ? 'var(--accent-2)' : 'var(--danger)' }}>{msg.text}</div>}

      {/* Pending human approvals — TOFU pins + critical-run confirms block here */}
      {pending.length > 0 && (
        <div style={{ marginBottom: 16, border: '1px solid var(--amber)', borderRadius: 8, padding: 12 }}>
          <div style={{ fontWeight: 600, color: 'var(--amber)', marginBottom: 8 }}>⏳ Pending approvals ({pending.length})</div>
          {pending.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12 }}>
                <span style={{ color: 'var(--amber)' }}>{p.kind === 'ssh_tofu_pin' ? 'Host-key pin' : 'Critical-run'}</span>
                {' · '}<code style={{ fontSize: 11 }}>{(() => { try { return JSON.stringify(JSON.parse(p.payload || '{}')).slice(0, 90); } catch { return p.subject_ref || ''; } })()}</code>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => resolveConfirm(p.id, 'approve')} style={{ padding: '4px 10px', background: 'var(--accent-2)', color: 'var(--icon-on-accent, #fff)', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 12 }}>Approve</button>
                <button onClick={() => resolveConfirm(p.id, 'deny')} style={{ padding: '4px 10px', background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 5, cursor: 'pointer', fontSize: 12 }}>Deny</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add machine form */}
      {showAdd && (
        <div style={{ marginBottom: 16, border: '1px solid var(--border)', borderRadius: 8, padding: 14, display: 'grid', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 80px', gap: 8 }}>
            <input placeholder="Display name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inp} />
            <input placeholder="host (ip / dns)" value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} style={inp} />
            <input placeholder="port" type="number" value={form.port} onChange={e => setForm({ ...form, port: e.target.value })} style={inp} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 2fr', gap: 8 }}>
            <input placeholder="username" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} style={inp} />
            <select value={form.auth_method} onChange={e => setForm({ ...form, auth_method: e.target.value })} style={inp}>
              <option value="key">key</option><option value="password">password</option>
            </select>
            {secrets.length > 0
              ? <select value={form.secret_name} onChange={e => setForm({ ...form, secret_name: e.target.value })} style={inp}>
                  <option value="">— broker SSH secret —</option>
                  {secrets.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              : <input placeholder="broker secret name (SHARED_SSH_…)" value={form.secret_name} onChange={e => setForm({ ...form, secret_name: e.target.value })} style={inp} />}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
            <input placeholder="passphrase secret name (optional)" value={form.passphrase_secret_name} onChange={e => setForm({ ...form, passphrase_secret_name: e.target.value })} style={inp} />
            <select value={form.sensitivity} onChange={e => setForm({ ...form, sensitivity: e.target.value })} style={inp}>
              <option value="low">low</option><option value="high">high</option><option value="critical">critical</option>
            </select>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={form.legacy_algos} onChange={e => setForm({ ...form, legacy_algos: e.target.checked })} /> legacy algos
            </label>
          </div>
          <textarea placeholder="notes (no credentials — they get rejected)" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={{ ...inp, minHeight: 44 }} />
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>Tip: create a dedicated least-privilege <code>neuroclaw</code> login on the target — not root, not your personal account.</div>
          <button onClick={create} disabled={busy === 'create'} style={{ padding: '8px 14px', background: 'var(--accent)', color: 'var(--icon-on-accent, #fff)', border: 'none', borderRadius: 6, cursor: 'pointer', justifySelf: 'start' }}>
            {busy === 'create' ? 'Adding…' : 'Add machine'}
          </button>
        </div>
      )}

      {/* Machine list */}
      {machines.length === 0
        ? <div style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>No machines yet. Add one, store its key in the broker as an <code>SSH</code>-class secret, then Test Connection.</div>
        : machines.map(m => {
          let allowed = []; try { allowed = JSON.parse(m.allowed_agents || '[]'); } catch { allowed = []; }
          const open = expanded === m.id;
          return (
            <div key={m.id} className="cn-row" style={{ padding: 0, opacity: m.disabled ? 0.6 : 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer' }} onClick={() => setExpanded(open ? null : m.id)}>
                <span style={{ fontWeight: 600 }}>{m.name}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{m.username}@{m.host}:{m.port}</span>
                <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 10, border: `1px solid ${SENS_COLOR[m.sensitivity]}`, color: SENS_COLOR[m.sensitivity] }}>{m.sensitivity}</span>
                <span style={{ fontSize: 11, color: FP_COLOR[m.fingerprint_status] || 'var(--muted)' }}>● {m.fingerprint_status}</span>
                {m.disabled ? <span style={{ fontSize: 11, color: 'var(--danger)' }}>quarantined</span> : null}
                <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>{allowed.length} agent{allowed.length === 1 ? '' : 's'}</span>
              </div>

              {open && (
                <div style={{ padding: '4px 14px 14px', borderTop: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
                    <button onClick={() => test(m.id, m.name)} disabled={busy === 'test:' + m.id} style={btn}>{busy === 'test:' + m.id ? 'Testing…' : 'Test connection'}</button>
                    <button onClick={() => (editing === m.id ? setEditing(null) : startEdit(m))} style={{ ...btn, borderColor: editing === m.id ? 'var(--accent)' : 'var(--border)', color: editing === m.id ? 'var(--accent)' : 'var(--text)' }}>{editing === m.id ? 'Close edit' : 'Edit config'}</button>
                    {m.host_fingerprint && m.fingerprint_status !== 'verified' && <button onClick={() => verifyFp(m.id, m.name)} style={{ ...btn, borderColor: 'var(--accent-2)', color: 'var(--accent-2)' }}>Verify fingerprint</button>}
                    <button onClick={() => patch(m.id, { disabled: !m.disabled })} style={btn}>{m.disabled ? 'Un-quarantine' : 'Quarantine'}</button>
                    <select value={m.sensitivity} onChange={e => patch(m.id, { sensitivity: e.target.value })} style={{ ...inp, width: 'auto' }}>
                      <option value="low">low</option><option value="high">high</option><option value="critical">critical</option>
                    </select>
                    <button onClick={() => del(m.id, m.name)} style={{ ...btn, borderColor: 'var(--danger)', color: 'var(--danger)', marginLeft: 'auto' }}>Delete</button>
                  </div>

                  {/* Edit config — change host/IP, user, port, key secret, auth, jump host */}
                  {editing === m.id && (
                    <div style={{ margin: '10px 0 4px', border: '1px solid var(--accent)', borderRadius: 8, padding: 12, display: 'grid', gap: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>Edit configuration</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 80px', gap: 8 }}>
                        <input placeholder="Display name" value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} style={inp} />
                        <input placeholder="host (ip / dns)" value={editForm.host} onChange={e => setEditForm({ ...editForm, host: e.target.value })} style={inp} />
                        <input placeholder="port" type="number" value={editForm.port} onChange={e => setEditForm({ ...editForm, port: e.target.value })} style={inp} />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 2fr', gap: 8 }}>
                        <input placeholder="username" value={editForm.username} onChange={e => setEditForm({ ...editForm, username: e.target.value })} style={inp} />
                        <select value={editForm.auth_method} onChange={e => setEditForm({ ...editForm, auth_method: e.target.value })} style={inp}>
                          <option value="key">key</option><option value="password">password</option>
                        </select>
                        {secrets.length > 0
                          ? <select value={editForm.secret_name} onChange={e => setEditForm({ ...editForm, secret_name: e.target.value })} style={inp}>
                              <option value="">— broker SSH secret —</option>
                              {secrets.map(n => <option key={n} value={n}>{n}</option>)}
                              {editForm.secret_name && !secrets.includes(editForm.secret_name) && <option value={editForm.secret_name}>{editForm.secret_name}</option>}
                            </select>
                          : <input placeholder="broker secret name (SHARED_SSH_…)" value={editForm.secret_name} onChange={e => setEditForm({ ...editForm, secret_name: e.target.value })} style={inp} />}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr', gap: 8 }}>
                        <input placeholder="passphrase secret name (optional)" value={editForm.passphrase_secret_name} onChange={e => setEditForm({ ...editForm, passphrase_secret_name: e.target.value })} style={inp} />
                        <input placeholder="jump / bastion host (optional)" value={editForm.jump_host} onChange={e => setEditForm({ ...editForm, jump_host: e.target.value })} style={inp} />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'center' }}>
                        <select value={editForm.sensitivity} onChange={e => setEditForm({ ...editForm, sensitivity: e.target.value })} style={inp}>
                          <option value="low">low</option><option value="high">high</option><option value="critical">critical</option>
                        </select>
                        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input type="checkbox" checked={editForm.legacy_algos} onChange={e => setEditForm({ ...editForm, legacy_algos: e.target.checked })} /> legacy algos
                        </label>
                      </div>
                      <textarea placeholder="notes (no credentials — they get rejected)" value={editForm.notes} onChange={e => setEditForm({ ...editForm, notes: e.target.value })} style={{ ...inp, minHeight: 40 }} />
                      <div style={{ fontSize: 11, color: 'var(--amber)' }}>Changing host or port clears the pinned host key — you'll re-verify via Test connection.</div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={() => saveEdit(m.id)} disabled={busy === 'edit:' + m.id} style={{ padding: '7px 14px', background: 'var(--accent)', color: 'var(--icon-on-accent, #fff)', border: 'none', borderRadius: 6, cursor: 'pointer' }}>{busy === 'edit:' + m.id ? 'Saving…' : 'Save config'}</button>
                        <button onClick={() => setEditing(null)} style={btn}>Cancel</button>
                      </div>
                    </div>
                  )}

                  {m.host_fingerprint && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10, wordBreak: 'break-all' }}>
                      Host key: <code>{m.host_fingerprint}</code>
                      {m.fingerprint_status === 'pending_verification' && <span style={{ color: 'var(--amber)' }}> — verify out-of-band, then click “Verify fingerprint”.</span>}
                      {m.fingerprint_status === 'mismatch' && <span style={{ color: 'var(--danger)' }}> — MISMATCH: quarantined. If you re-imaged this box, delete and re-add it.</span>}
                    </div>
                  )}

                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Agents allowed on this machine</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {agents.map(a => {
                      const on = allowed.includes(a.id);
                      return (
                        <button key={a.id} onClick={() => toggleAgent(m, a.id)} title={a.ssh_enabled ? '' : 'agent SSH not enabled — toggle below'}
                          style={{ padding: '3px 9px', borderRadius: 12, fontSize: 12, cursor: 'pointer', border: `1px solid ${on ? 'var(--accent-2)' : 'var(--border)'}`, background: on ? 'color-mix(in srgb, var(--accent-2) 15%, transparent)' : 'transparent', color: on ? 'var(--accent-2)' : (a.ssh_enabled ? 'var(--text)' : 'var(--muted)') }}>
                          {on ? '✓ ' : ''}{a.name}{!a.ssh_enabled ? ' ⚠' : ''}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}

      {/* Per-agent SSH enablement (gate #2) */}
      <div style={{ marginTop: 22, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Agents with SSH enabled</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>An agent needs SSH enabled here <em>and</em> a per-machine grant above. ⚠ on a chip above = that agent isn’t SSH-enabled yet.</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {agents.map(a => (
            <button key={a.id} onClick={() => toggleAgentSsh(a)} style={{ padding: '3px 9px', borderRadius: 12, fontSize: 12, cursor: 'pointer', border: `1px solid ${a.ssh_enabled ? 'var(--accent)' : 'var(--border)'}`, background: a.ssh_enabled ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'transparent', color: a.ssh_enabled ? 'var(--accent)' : 'var(--muted)' }}>
              {a.ssh_enabled ? '✓ ' : ''}{a.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

const inp = { padding: '6px 8px', background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 };
const btn = { padding: '5px 11px', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 12 };

window.SshMachines = SshMachines;
