/* Sentinel — background task manager dashboard + background agents roster */

const ESCALATION_LABELS = ['Watching', 'Checked In', 'Reassigned', 'Blocked'];
const ESCALATION_TONES  = ['muted', 'amber', 'violet', 'danger'];

const BG_AVATARS = {
  sentinel:      `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 4L6 10v12c0 8 6.5 14.5 14 16 7.5-1.5 14-8 14-16V10L20 4z" stroke="currentColor" stroke-width="2" fill="none"/><path d="M14 20l4 4 8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  heartbeat:     `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><polyline points="2,20 10,20 14,8 18,32 22,16 26,24 30,20 38,20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  dream:         `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M28 12a12 12 0 1 1-16 16A12 12 0 0 0 28 12z" stroke="currentColor" stroke-width="2"/><circle cx="30" cy="8" r="2" fill="currentColor"/><circle cx="34" cy="14" r="1.5" fill="currentColor"/><circle cx="28" cy="6" r="1" fill="currentColor"/></svg>`,
  config_watcher:`<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="12" stroke="currentColor" stroke-width="2"/><circle cx="20" cy="20" r="4" stroke="currentColor" stroke-width="2"/><line x1="20" y1="4" x2="20" y2="10" stroke="currentColor" stroke-width="2"/><line x1="20" y1="30" x2="20" y2="36" stroke="currentColor" stroke-width="2"/><line x1="4" y1="20" x2="10" y2="20" stroke="currentColor" stroke-width="2"/><line x1="30" y1="20" x2="36" y2="20" stroke="currentColor" stroke-width="2"/></svg>`,
  cleanup:       `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 6h12l2 6H12l2-6z" stroke="currentColor" stroke-width="2"/><rect x="10" y="12" width="20" height="22" rx="2" stroke="currentColor" stroke-width="2"/><line x1="16" y1="18" x2="16" y2="28" stroke="currentColor" stroke-width="2"/><line x1="20" y1="18" x2="20" y2="28" stroke="currentColor" stroke-width="2"/><line x1="24" y1="18" x2="24" y2="28" stroke="currentColor" stroke-width="2"/></svg>`,
  model_catalog: `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="6" width="12" height="12" rx="1" stroke="currentColor" stroke-width="2"/><rect x="22" y="6" width="12" height="12" rx="1" stroke="currentColor" stroke-width="2"/><rect x="6" y="22" width="12" height="12" rx="1" stroke="currentColor" stroke-width="2"/><rect x="22" y="22" width="12" height="12" rx="1" stroke="currentColor" stroke-width="2"/></svg>`,
  stephanie:     `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="14" r="6" stroke="currentColor" stroke-width="2"/><path d="M20 8v6l4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><ellipse cx="20" cy="28" rx="10" ry="5" stroke="currentColor" stroke-width="2"/><line x1="10" y1="28" x2="10" y2="34" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="30" y1="28" x2="30" y2="34" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  session_cleanup:`<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="6" width="24" height="28" rx="2" stroke="currentColor" stroke-width="2"/><line x1="12" y1="12" x2="28" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="18" x2="28" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.5"/><line x1="12" y1="24" x2="28" y2="24" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.3"/><path d="M30 28l4 4m0-4l-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  db_backup:     `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><ellipse cx="20" cy="10" rx="12" ry="4" stroke="currentColor" stroke-width="2"/><path d="M8 10v20c0 2.2 5.4 4 12 4s12-1.8 12-4V10" stroke="currentColor" stroke-width="2"/><ellipse cx="20" cy="20" rx="12" ry="4" stroke="currentColor" stroke-width="2" opacity="0.5"/><path d="M26 26l4-4m0 0l-4-4m4 4H18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  herald:        `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 14h6l8-8v28l-8-8H8V14z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M28 16a6 6 0 0 1 0 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M32 12a12 12 0 0 1 0 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.5"/></svg>`,
  task_archivist:`<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="10" width="28" height="6" rx="1" stroke="currentColor" stroke-width="2"/><path d="M8 16v16h24V16" stroke="currentColor" stroke-width="2"/><path d="M16 22h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 10V6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16 6h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};

// Map of agent keys to their manual run endpoints
const BG_AGENT_RUN_ENDPOINTS = {
  session_cleanup: '/api/session-cleanup/run',
  db_backup: '/api/backup/run',
};

const AvatarDisplay = ({ agent, size = 56 }) => {
  if (agent.avatar) {
    return (
      <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', border: '2px solid var(--line)', flexShrink: 0 }}>
        <img src={agent.avatar} alt={agent.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </div>
    );
  }
  const svg = BG_AVATARS[agent.key] ?? BG_AVATARS.sentinel;
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', border: '2px solid var(--line)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--accent) 6%, transparent)', color: 'var(--accent)', padding: 10 }}
         dangerouslySetInnerHTML={{ __html: svg }} />
  );
};

const AvatarEditor = ({ agentKey, onSaved }) => {
  const [open, setOpen] = React.useState(false);
  const [url, setUrl] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const saveUrl = async () => {
    if (!url.trim()) return;
    setSaving(true);
    try {
      await window.NC_API.patch(`/api/bg-agents/${agentKey}/avatar`, { avatar: url.trim() });
      onSaved(url.trim());
      setOpen(false);
      setUrl('');
    } catch (e) {
      alert('Failed to save avatar: ' + e.message);
    } finally { setSaving(false); }
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result;
      if (!dataUrl) return;
      setSaving(true);
      try {
        await window.NC_API.patch(`/api/bg-agents/${agentKey}/avatar`, { avatar: dataUrl });
        onSaved(dataUrl);
        setOpen(false);
      } catch (err) {
        alert('Failed to save avatar: ' + err.message);
      } finally { setSaving(false); }
    };
    e.target.value = '';
    reader.readAsDataURL(file);
  };

  if (!open) return <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => setOpen(true)}>Edit Avatar</button>;

  return (
    <div style={{ marginTop: 8, padding: 10, background: 'color-mix(in srgb, var(--accent) 6%, transparent)', borderRadius: 6, border: '1px solid var(--line-soft)' }}>
      <div style={{ marginBottom: 6, fontSize: 11, color: 'var(--accent)' }}>Set avatar</div>
      <input
        className="nc-input"
        placeholder="Paste image URL..."
        value={url}
        onChange={e => setUrl(e.target.value)}
        style={{ width: '100%', marginBottom: 6 }}
      />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button className="nc-btn primary" onClick={saveUrl} disabled={saving || !url.trim()} style={{ fontSize: 10 }}>Save URL</button>
        <label className="nc-btn" style={{ fontSize: 10, cursor: 'pointer' }}>
          Upload File
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFile} disabled={saving} />
        </label>
        <button className="nc-btn ghost" onClick={() => setOpen(false)} style={{ fontSize: 10 }}>Cancel</button>
      </div>
    </div>
  );
};

const BgAgentCard = ({ agent, onRefresh }) => {
  const [avatar, setAvatar] = React.useState(agent.avatar);
  const [running, setRunning] = React.useState(false);
  const [lastResult, setLastResult] = React.useState(null);
  const displayAgent = { ...agent, avatar };

  const runEndpoint = BG_AGENT_RUN_ENDPOINTS[agent.key];
  const canRun = !!runEndpoint;

  const handleRun = async () => {
    if (!runEndpoint) return;
    setRunning(true);
    setLastResult(null);
    try {
      const result = await window.NC_API.post(runEndpoint, {});
      setLastResult(result);
      if (onRefresh) onRefresh();
    } catch (err) {
      setLastResult({ ok: false, error: err.message });
    } finally {
      setRunning(false);
    }
  };

  const statusColor = agent.enabled ? 'green' : 'muted';
  const statusLabel = agent.enabled ? 'ACTIVE' : 'DISABLED';

  return (
    <div className="nc-panel glow" style={{ padding: 14 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <AvatarDisplay agent={displayAgent} size={52} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
            <span style={{ fontFamily: 'var(--display)', fontWeight: 600, fontSize: 14 }}>{agent.name}</span>
            <span className={`tag ${statusColor}`} style={{ fontSize: 9 }}>{statusLabel}</span>
            {canRun && (
              <button
                className="nc-btn ghost"
                style={{ fontSize: 9, padding: '2px 8px', marginLeft: 'auto' }}
                onClick={handleRun}
                disabled={running}
              >
                {running ? 'Running...' : 'Run Now'}
              </button>
            )}
          </div>
          <div className="muted mono" style={{ fontSize: 10, marginBottom: 8, lineHeight: 1.4 }}>{agent.description}</div>
          {lastResult && (
            <div
              className="mono"
              style={{
                fontSize: 10,
                marginBottom: 8,
                padding: '6px 8px',
                borderRadius: 4,
                background: lastResult.ok ? 'rgba(0,255,136,0.1)' : 'rgba(255,68,68,0.1)',
                color: lastResult.ok ? 'var(--success)' : 'var(--danger)',
              }}
            >
              {lastResult.ok
                ? (lastResult.filename 
                    ? `Backup created: ${lastResult.filename}` 
                    : `Cleaned ${lastResult.deleted ?? 0} session(s), ${lastResult.messagesDeleted ?? 0} message(s)`)
                : `Error: ${lastResult.error}`}
            </div>
          )}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div className="label-tiny" style={{ fontSize: 9 }}>LAST RUN</div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)' }}>
                {agent.lastRunAt ? new Date(agent.lastRunAt).toLocaleTimeString() : '—'}
              </div>
            </div>
            <div>
              <div className="label-tiny" style={{ fontSize: 9 }}>{(agent.keyStat?.label ?? 'STAT').toUpperCase()}</div>
              <div className="mono neonc" style={{ fontSize: 11 }}>{agent.keyStat?.value ?? '—'}</div>
            </div>
            {agent.intervalSec && (
              <div>
                <div className="label-tiny" style={{ fontSize: 9 }}>INTERVAL</div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)' }}>
                  {agent.intervalSec < 60 ? `${agent.intervalSec}s` : `${Math.round(agent.intervalSec / 60)}m`}
                </div>
              </div>
            )}
          </div>
          <AvatarEditor agentKey={agent.key} onSaved={url => setAvatar(url)} />
        </div>
      </div>
    </div>
  );
};

const StephanieAlerts = () => {
  const [alerts, setAlerts]       = React.useState([]);
  const [loading, setLoading]     = React.useState(true);
  const [dismissing, setDismissing] = React.useState(null);

  const load = async () => {
    try {
      const data = await window.NC_API.get('/api/analyst/alerts?limit=50');
      setAlerts(Array.isArray(data) ? data : []);
    } catch { /* silent */ }
    setLoading(false);
  };

  React.useEffect(() => { load(); const i = setInterval(load, 15000); return () => clearInterval(i); }, []);

  const dismiss = async (id) => {
    setDismissing(id);
    try {
      await window.NC_API.post(`/api/analyst/alerts/${id}/dismiss`);
      setAlerts(a => a.map(x => x.id === id ? { ...x, dismissed_at: new Date().toISOString() } : x));
    } catch { /* silent */ }
    setDismissing(null);
  };

  const sevColor = (s) => s === 'critical' ? 'red' : s === 'warn' ? 'amber' : 'cyan';
  const unread = alerts.filter(a => !a.dismissed_at);
  const dismissed = alerts.filter(a => a.dismissed_at);

  return (
    <div style={{ marginTop: 24 }}>
      <div className="label-tiny" style={{ color: 'var(--accent)', marginBottom: 10 }}>
        STEPHANIE · TEAM INTEL
        {unread.length > 0 && <span className="tag amber" style={{ fontSize: 9, marginLeft: 8 }}>{unread.length} OPEN</span>}
      </div>
      <div className="nc-panel glow" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div className="mono muted" style={{ padding: '14px 16px', fontSize: 11 }}>loading...</div>
        ) : unread.length === 0 ? (
          <div className="mono muted" style={{ padding: '14px 16px', fontSize: 11 }}>// all clear — no open alerts</div>
        ) : (
          unread.map((a, i) => (
            <div key={a.id} style={{ padding: '12px 14px', borderBottom: i < unread.length - 1 ? '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)' : 'none' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <span className={`dot ${sevColor(a.severity)} pulse`} />
                <span className={`tag ${sevColor(a.severity)}`} style={{ fontSize: 9 }}>{a.type}</span>
                {a.agent_id && <span className="mono muted" style={{ fontSize: 10 }}>{a.agent_id.slice(0, 8)}</span>}
                <span className="mono muted" style={{ fontSize: 10, marginLeft: 'auto' }}>
                  {a.created_at ? new Date(a.created_at).toLocaleString() : '—'}
                </span>
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.5, marginBottom: 8 }}>{a.message}</div>
              <button
                className="nc-btn ghost"
                style={{ fontSize: 9, padding: '2px 8px' }}
                disabled={dismissing === a.id}
                onClick={() => dismiss(a.id)}
              >
                {dismissing === a.id ? 'dismissing...' : 'dismiss'}
              </button>
            </div>
          ))
        )}
        {dismissed.length > 0 && (
          <div className="mono muted" style={{ padding: '8px 14px', fontSize: 10, borderTop: '1px solid var(--line-soft)' }}>
            {dismissed.length} dismissed alert{dismissed.length !== 1 ? 's' : ''} hidden
          </div>
        )}
      </div>
    </div>
  );
};

const Sentinel = () => {
  const [status, setStatus]         = React.useState(null);
  const [escalations, setEscalations] = React.useState([]);
  const [bgAgents, setBgAgents]     = React.useState([]);
  const [running, setRunning]       = React.useState(false);
  const [error, setError]           = React.useState(null);

  const load = async () => {
    setError(null);
    try {
      const [s, e, bg] = await Promise.all([
        window.NC_API.get('/api/sentinel/status'),
        window.NC_API.get('/api/sentinel/active'),
        window.NC_API.get('/api/bg-agents'),
      ]);
      setStatus(s);
      setEscalations(Array.isArray(e) ? e : []);
      setBgAgents(Array.isArray(bg) ? bg : []);
    } catch (err) {
      setError(err.message);
    }
  };

  React.useEffect(() => { load(); const i = setInterval(load, 15000); return () => clearInterval(i); }, []);

  const runNow = async () => {
    setRunning(true);
    setError(null);
    try {
      await window.NC_API.post('/api/sentinel/run', {});
      await load();
    } catch (err) {
      setError(err.message);
    } finally { setRunning(false); }
  };

  return (
    <div>
      <PageHeader
        title="Sentinel"
        subtitle="// background task manager · escalation engine"
        right={
          <button className="nc-btn primary" onClick={runNow} disabled={running}>
            {running ? 'Scanning...' : 'Run Scan Now'}
          </button>
        }
      />

      {error && (
        <div className="nc-panel" style={{ padding: 10, marginBottom: 12, borderColor: 'var(--danger)', color: 'var(--danger)', fontSize: 11 }}>
          Error: {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
        <StatCard label="STATUS" value={status?.enabled ? 'ACTIVE' : 'PAUSED'} tone={status?.enabled ? 'cyan' : 'muted'} icon="shield" />
        <StatCard label="CHECK-INS SENT" value={status?.checkInsTotal ?? '—'} tone="cyan" />
        <StatCard label="REASSIGNMENTS" value={status?.reassignmentsTotal ?? '—'} tone="violet" />
        <StatCard label="TASKS BLOCKED" value={status?.blockedTotal ?? '—'} tone="amber" />
      </div>

      {status && (
        <div className="nc-panel glow" style={{ padding: '10px 14px', marginBottom: 16, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div className="mono" style={{ fontSize: 11 }}>
            <span className="muted">last run: </span>
            <span style={{ color: 'var(--accent-2)' }}>{status.lastRun ? new Date(status.lastRun).toLocaleTimeString() : '—'}</span>
          </div>
          <div className="mono" style={{ fontSize: 11 }}>
            <span className="muted">next run: </span>
            <span style={{ color: 'var(--accent-2)' }}>{status.nextRun ? new Date(status.nextRun).toLocaleTimeString() : '—'}</span>
          </div>
          <div className="mono" style={{ fontSize: 11 }}>
            <span className="muted">interval: </span>
            <span style={{ color: 'var(--accent-2)' }}>{status.intervalSec != null ? `${status.intervalSec}s` : '—'}</span>
          </div>
          <div className="mono" style={{ fontSize: 11 }}>
            <span className="muted">stale threshold: </span>
            <span style={{ color: 'var(--accent-2)' }}>{status.staleMinutes != null ? `${status.staleMinutes}m` : '—'}</span>
          </div>
          <div className="mono" style={{ fontSize: 11 }}>
            <span className="muted">model: </span>
            <span style={{ color: 'var(--accent-2)' }}>{status.model}</span>
          </div>
        </div>
      )}

      <Section title="ACTIVE ESCALATIONS" right={
        <span className="tag cyan" style={{ fontSize: 9 }}>{escalations.length} TASKS</span>
      }>
        {escalations.length === 0 ? (
          <div className="mono muted" style={{ padding: '16px 0', fontSize: 11 }}>// no tasks currently in escalation</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line-soft)' }}>
                {['Task', 'Level', 'Agent', 'Last Check-In', 'Agent Response'].map(h => (
                  <th key={h} className="label-tiny" style={{ padding: '4px 8px', textAlign: 'left', fontWeight: 400 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {escalations.map((e, i) => (
                <tr key={e.taskId} style={{ borderBottom: '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)' }}>
                  <td className="mono" style={{ padding: '6px 8px', color: 'var(--text)' }}>{e.taskTitle}</td>
                  <td style={{ padding: '6px 8px' }}>
                    <span className={`tag ${ESCALATION_TONES[e.escalationLevel] ?? 'muted'}`} style={{ fontSize: 9 }}>
                      {ESCALATION_LABELS[e.escalationLevel] ?? e.escalationLevel}
                    </span>
                  </td>
                  <td className="mono" style={{ padding: '6px 8px', color: 'var(--accent-2)' }}>{e.assignedAgentName ?? '—'}</td>
                  <td className="mono muted" style={{ padding: '6px 8px', fontSize: 10 }}>
                    {e.lastCheckInAt ? new Date(e.lastCheckInAt).toLocaleTimeString() : '—'}
                  </td>
                  <td className="mono muted" style={{ padding: '6px 8px', fontSize: 10, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.agentResponse ? e.agentResponse.slice(0, 100) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <div className="label-tiny" style={{ color: 'var(--accent)', marginBottom: 10 }}>BACKGROUND AGENTS</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
        {bgAgents.map(a => <BgAgentCard key={a.key} agent={a} onRefresh={load} />)}
      </div>
      <StephanieAlerts />
    </div>
  );
};

window.Sentinel = Sentinel;
