/* MCP Servers — DB-backed registry (live-wired) */

const MCP = () => {
  const { MCP_SERVERS } = window.NC_DATA;
  const [editing, setEditing]   = React.useState(null);     // {id?, name, url, headers:[], enabled} | null
  const [expanded, setExpanded] = React.useState({});       // server_id → bool
  const [probing, setProbing]   = React.useState({});       // server_id → bool
  const [err, setErr]           = React.useState(null);

  const refresh = () => window.NC_LIVE?.refresh?.();

  const startNew = () => setEditing({ id: null, name: '', url: '', transport: 'auto', headers: [{ k: '', v: '' }], enabled: true });
  const startEdit = (s) => setEditing({
    id:        s.id,
    name:      s.name,
    url:       s.url,
    transport: s.transport || 'auto',
    enabled:   !!s.enabled,
    headers:   s.has_headers ? [{ k: '', v: '' }] : [{ k: '', v: '' }],   // headers are write-only; user re-enters to overwrite
    _replaceHeaders: false,
  });

  const submit = async () => {
    setErr(null);
    if (!editing.name.trim() || !editing.url.trim()) { setErr('name and URL are required'); return; }
    try { new URL(editing.url.trim()); } catch { setErr('URL is not a valid URL'); return; }
    const headers = {};
    for (const { k, v } of editing.headers) {
      if (k.trim() && v.trim()) headers[k.trim()] = v.trim();
    }
    try {
      if (editing.id) {
        const body = { name: editing.name.trim(), url: editing.url.trim(), transport: editing.transport || 'auto', enabled: editing.enabled };
        if (editing._replaceHeaders) body.headers = Object.keys(headers).length > 0 ? headers : null;
        const r = await fetch(`/api/mcp/servers/${editing.id}`, {
          method: 'PATCH', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
      } else {
        const r = await fetch('/api/mcp/servers', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: editing.name.trim(), url: editing.url.trim(), transport: editing.transport || 'auto', enabled: editing.enabled, headers: Object.keys(headers).length > 0 ? headers : undefined }),
        });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
      }
      setEditing(null);
      refresh();
    } catch (e) { setErr(e.message); }
  };

  const probe = async (s) => {
    setProbing(p => ({ ...p, [s.id]: true }));
    try {
      await fetch(`/api/mcp/servers/${s.id}/probe`, { method: 'POST', credentials: 'same-origin' });
      refresh();
    } finally { setProbing(p => ({ ...p, [s.id]: false })); }
  };

  const remove = async (s) => {
    if (!confirm(`Delete MCP server "${s.name}"? Its tools stop being available to all agents immediately.`)) return;
    await fetch(`/api/mcp/servers/${s.id}`, { method: 'DELETE', credentials: 'same-origin' });
    refresh();
  };

  const toggleEnabled = async (s) => {
    await fetch(`/api/mcp/servers/${s.id}`, {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    refresh();
  };

  const statusColor = (s) => ({
    ready:      'var(--neon-2)',
    connecting: 'var(--amber)',
    error:      'var(--danger)',
    unknown:    'var(--muted)',
  }[s] || 'var(--muted)');

  const statusTagClass = (s) => ({
    ready:      'green',
    connecting: 'amber',
    error:      'red',
    unknown:    '',
  }[s] || '');

  return (
    <div className="page page-mcp">
      <PageHeader title="MCP Servers" subtitle="// model context protocol · DB-backed registry · live-probed" right={<>
        <button className="nc-btn" onClick={refresh}><Icon name="refresh" size={12}/> Refresh</button>
        <button className="nc-btn primary" onClick={startNew}>+ Add Server</button>
      </>}/>

      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>// {err}</div>}

      {editing && (
        <div className="nc-panel glow" style={{ padding: 16, marginBottom: 14 }}>
          <div className="label-tiny neonc" style={{ marginBottom: 10 }}>{editing.id ? 'EDIT MCP SERVER' : 'NEW MCP SERVER'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr', gap: 10 }}>
            <div className="field">
              <label>Name <span className="muted" style={{ fontSize: 10 }}>(tool prefix)</span></label>
              <input className="nc-input" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="archon"/>
            </div>
            <div className="field">
              <label>URL <span className="muted" style={{ fontSize: 10 }}>(MCP endpoint)</span></label>
              <input className="nc-input" value={editing.url} onChange={e => setEditing({ ...editing, url: e.target.value })} placeholder="https://api.example.com/mcp"/>
            </div>
            <div className="field">
              <label>Transport <span className="muted" style={{ fontSize: 10 }}>(auto detects /sse)</span></label>
              <select className="nc-select" value={editing.transport || 'auto'} onChange={e => setEditing({ ...editing, transport: e.target.value })}>
                <option value="auto">Auto-detect</option>
                <option value="http">Streamable HTTP</option>
                <option value="sse">SSE (n8n, FastAPI)</option>
              </select>
            </div>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label>Headers <span className="muted" style={{ fontSize: 10 }}>(key/value pairs · e.g. Authorization: Bearer ...)</span></label>
            {editing.headers.map((h, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input className="nc-input" style={{ flex: 1 }} placeholder="key" value={h.k} onChange={e => {
                  const next = [...editing.headers]; next[i] = { ...next[i], k: e.target.value };
                  setEditing({ ...editing, headers: next, _replaceHeaders: true });
                }}/>
                <input className="nc-input" style={{ flex: 2 }} placeholder="value" value={h.v} onChange={e => {
                  const next = [...editing.headers]; next[i] = { ...next[i], v: e.target.value };
                  setEditing({ ...editing, headers: next, _replaceHeaders: true });
                }}/>
                <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => {
                  const next = editing.headers.filter((_, j) => j !== i);
                  setEditing({ ...editing, headers: next.length > 0 ? next : [{ k: '', v: '' }], _replaceHeaders: true });
                }}>×</button>
              </div>
            ))}
            <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => setEditing({ ...editing, headers: [...editing.headers, { k: '', v: '' }] })}>+ Add header</button>
            {editing.id && !editing._replaceHeaders && (
              <div className="muted mono" style={{ fontSize: 10, marginTop: 6 }}>// existing headers preserved · edit any field above to overwrite</div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              <input type="checkbox" checked={editing.enabled} onChange={e => setEditing({ ...editing, enabled: e.target.checked })} style={{ width: 'auto' }}/>
              <span>enabled</span>
            </label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button className="nc-btn ghost" onClick={() => { setEditing(null); setErr(null); }}>Cancel</button>
            <button className="nc-btn primary" onClick={submit}>{editing.id ? 'Save' : 'Add server'}</button>
          </div>
        </div>
      )}

      {(!MCP_SERVERS || MCP_SERVERS.length === 0) && !editing && (
        <div className="nc-panel" style={{ padding: 24, textAlign: 'center' }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>// no MCP servers registered</div>
          <div className="muted" style={{ fontSize: 10 }}>
            Click "+ Add Server" to register a remote streamable-HTTP MCP endpoint. Once probed and ready, its tools become available to every NeuroClaw agent (OpenAI, Claude, Codex) under <code>mcp__&lt;name&gt;__&lt;tool&gt;</code>.
          </div>
        </div>
      )}

      {(MCP_SERVERS || []).map(s => (
        <div key={s.id} className="nc-panel" style={{ marginBottom: 10, padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(s.status), display: 'inline-block' }}/>
                <strong>{s.name}</strong>
                <span className={`tag ${statusTagClass(s.status)}`} style={{ fontSize: 9 }}>{s.status}</span>
                {!s.enabled && <span className="tag" style={{ fontSize: 9, background: 'var(--muted)' }}>disabled</span>}
                <span className="muted" style={{ fontSize: 10 }}>· {s.tools_count} tool{s.tools_count === 1 ? '' : 's'}</span>
              </div>
              <div className="muted mono" style={{ fontSize: 10, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.url}
                {s.last_probed_at && <span> · probed {new Date(s.last_probed_at).toLocaleTimeString()}</span>}
              </div>
              {s.status === 'error' && s.status_detail && (
                <div className="mono" style={{ fontSize: 10, color: 'var(--danger)', marginTop: 4 }}>// {s.status_detail}</div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => setExpanded(p => ({ ...p, [s.id]: !p[s.id] }))}>
                {expanded[s.id] ? 'Hide tools' : 'Tools'}
              </button>
              <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => probe(s)} disabled={!!probing[s.id]}>
                {probing[s.id] ? 'Probing…' : 'Probe'}
              </button>
              <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => toggleEnabled(s)}>
                {s.enabled ? 'Disable' : 'Enable'}
              </button>
              <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => startEdit(s)}>Edit</button>
              <button className="nc-btn ghost" style={{ fontSize: 10, color: 'var(--danger)' }} onClick={() => remove(s)}>×</button>
            </div>
          </div>

          {expanded[s.id] && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              {(s.tools || []).length === 0 && (
                <div className="muted mono" style={{ fontSize: 10 }}>
                  // no cached tools · {s.status === 'ready' ? 'this server reports zero tools' : 'probe the server to load its tool list'}
                </div>
              )}
              {(s.tools || []).map((t, i) => (
                <McpToolRow key={i} serverId={s.id} tool={t}/>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

const McpToolRow = ({ serverId, tool }) => {
  const [open, setOpen]     = React.useState(false);
  const [schema, setSchema] = React.useState(null);

  const showSchema = async () => {
    if (open) { setOpen(false); return; }
    if (!schema) {
      try {
        const r = await window.NC_API.get(`/api/mcp/servers/${serverId}/tools`);
        const found = (r?.tools || []).find(x => x.name === tool.name);
        setSchema(found?.inputSchema ?? {});
      } catch { setSchema({}); }
    }
    setOpen(true);
  };

  return (
    <div style={{ marginBottom: 6, paddingBottom: 6, borderBottom: '1px dashed rgba(0,183,255,0.06)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <code className="neonc" style={{ fontSize: 11 }}>{tool.name}</code>
        <button className="nc-btn ghost" style={{ fontSize: 10, marginLeft: 'auto' }} onClick={showSchema}>{open ? 'hide schema' : 'schema'}</button>
      </div>
      {tool.description && (
        <div className="muted" style={{ fontSize: 10, marginTop: 3 }}>{tool.description}</div>
      )}
      {open && (
        <pre className="mono" style={{ fontSize: 10, background: 'var(--bg-2)', padding: 8, borderRadius: 3, marginTop: 6, maxHeight: 240, overflow: 'auto' }}>
          {JSON.stringify(schema ?? {}, null, 2)}
        </pre>
      )}
    </div>
  );
};

window.MCP = MCP;
