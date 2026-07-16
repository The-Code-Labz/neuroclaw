/* Approvals — remote tool-call approval queue */
const Approvals = () => {
  const [pending,  setPending]  = React.useState([]);
  const [resolved, setResolved] = React.useState([]);
  const [busy,     setBusy]     = React.useState({});
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [err,      setErr]      = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const [p, r] = await Promise.all([
        window.NC_API.get('/api/approvals?status=pending&limit=50'),
        window.NC_API.get('/api/approvals?limit=20'),
      ]);
      setPending(Array.isArray(p) ? p : []);
      setResolved(Array.isArray(r) ? r.filter(a => a.status !== 'pending') : []);
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  // Initial load + SSE stream for real-time pending notifications.
  React.useEffect(() => {
    load();
    let es;
    try {
      const token = new URLSearchParams(location.search).get('token') || '';
      es = new EventSource(`/api/approvals/stream${token ? '?token=' + token : ''}`);
      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.type === 'pending') load();
        } catch { /* ignore malformed */ }
      };
      es.onerror = () => es.close();
    } catch { /* SSE not supported or blocked */ }
    return () => { if (es) es.close(); };
  }, [load]);

  const resolve = async (id, status) => {
    setBusy(b => ({ ...b, [id]: true }));
    try {
      await window.NC_API.post(`/api/approvals/${id}/resolve`, { status });
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(b => ({ ...b, [id]: false }));
    }
  };

  const approveAll = async () => {
    if (bulkBusy || pending.length === 0) return;
    if (!window.confirm(`Approve all ${pending.length} pending request${pending.length === 1 ? '' : 's'}?`)) return;
    setBulkBusy(true);
    try {
      await window.NC_API.post('/api/approvals/resolve-all', { status: 'approved' });
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBulkBusy(false);
    }
  };

  const fmtInput = (raw) => {
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const s = obj?.command || obj?.query || obj?.input || JSON.stringify(obj);
      return String(s).slice(0, 100) + (String(s).length > 100 ? '…' : '');
    } catch { return String(raw).slice(0, 100); }
  };

  const fmtTime = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: true });
  };

  const statusColor = (s) =>
    s === 'approved' ? 'var(--green)' : s === 'denied' ? 'var(--danger)' : 'var(--amber)';

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="// remote tool-call permission queue"
        right={<>
          <button className="nc-btn" onClick={load}><Icon name="refresh" size={12}/> Refresh</button>
        </>}
      />

      {err && (
        <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 12 }}>// {err}</div>
      )}

      {/* Pending */}
      <div className="nc-panel glow" style={{ padding: 0, marginBottom: 16, overflow: 'hidden' }}>
        <div className="scan-line"/>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="label-tiny neonc">
            <span className={`dot ${pending.length > 0 ? 'amber pulse' : 'muted'}`} style={{ marginRight: 6 }}/>
            PENDING · {pending.length}
          </div>
          {pending.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="mono muted" style={{ fontSize: 10 }}>agents are waiting for your decision</span>
              <button
                className="nc-btn primary"
                style={{ fontSize: 10, padding: '4px 10px' }}
                disabled={bulkBusy}
                onClick={approveAll}
              >
                {bulkBusy ? '…' : `✓ Approve all (${pending.length})`}
              </button>
            </div>
          )}
        </div>

        {pending.length === 0 ? (
          <div className="mono muted" style={{ padding: 28, textAlign: 'center', fontSize: 12 }}>
            // no pending approvals — agents are running freely
          </div>
        ) : (
          <div>
            {pending.map((a) => {
              const rawInput = (() => { try { return JSON.parse(a.tool_input); } catch { return a.tool_input; } })();
              const inputPreview = fmtInput(a.tool_input);
              const fullInput = typeof rawInput === 'object' ? JSON.stringify(rawInput, null, 2) : String(rawInput);
              return (
                <div key={a.id} style={{ padding: '14px 16px', borderBottom: '1px dashed color-mix(in srgb, var(--accent) 8%, transparent)', display: 'grid', gridTemplateColumns: '80px 120px 100px 1fr auto', gap: 12, alignItems: 'center' }}>
                  <span className="mono muted" style={{ fontSize: 10 }}>{fmtTime(a.created_at)}</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--accent-2)' }}>@{a.agent_name || a.agent_id?.slice(0, 8) || '—'}</span>
                  <span className="tag amber" style={{ fontSize: 9, justifySelf: 'start' }}>{a.tool_name}</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-soft)' }} title={fullInput}>{inputPreview}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className="nc-btn primary"
                      style={{ fontSize: 10, padding: '4px 10px' }}
                      disabled={busy[a.id]}
                      onClick={() => resolve(a.id, 'approved')}
                    >
                      {busy[a.id] ? '…' : '✓ Approve'}
                    </button>
                    <button
                      className="nc-btn"
                      style={{ fontSize: 10, padding: '4px 10px', color: 'var(--danger)', borderColor: 'var(--danger)' }}
                      disabled={busy[a.id]}
                      onClick={() => resolve(a.id, 'denied')}
                    >
                      {busy[a.id] ? '…' : '✗ Deny'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Resolved history */}
      <div className="nc-panel glow" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)' }}>
          <div className="label-tiny neonc">RECENT RESOLVED · {resolved.length}</div>
        </div>
        {resolved.length === 0 ? (
          <div className="mono muted" style={{ padding: 20, textAlign: 'center', fontSize: 12 }}>// no history yet</div>
        ) : (
          resolved.map((a) => (
            <div key={a.id} style={{ padding: '10px 16px', borderBottom: '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)', display: 'grid', gridTemplateColumns: '80px 120px 100px 80px 1fr', gap: 12, alignItems: 'center' }}>
              <span className="mono muted" style={{ fontSize: 10 }}>{fmtTime(a.resolved_at || a.created_at)}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-soft)' }}>@{a.agent_name || a.agent_id?.slice(0, 8) || '—'}</span>
              <span className="tag" style={{ fontSize: 9, justifySelf: 'start' }}>{a.tool_name}</span>
              <span className="mono" style={{ fontSize: 11, color: statusColor(a.status) }}>{a.status}</span>
              <span className="mono muted" style={{ fontSize: 11 }} title={fmtInput(a.tool_input)}>{fmtInput(a.tool_input)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

window.Approvals = Approvals;
