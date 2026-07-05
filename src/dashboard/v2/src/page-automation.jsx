/* Automation — cron jobs, outbound webhooks, and inbound webhook triggers */

const JOB_TYPES = [
  { id: 'agent_message',    label: 'Agent',   color: 'var(--accent)' },
  { id: 'outbound_webhook', label: 'Webhook', color: 'var(--accent-2)' },
  { id: 'shell_command',    label: 'Shell',   color: '#f59e0b' },
  { id: 'n8n_workflow',     label: 'n8n',     color: 'var(--violet)' },
];

function jobTypeColor(type) {
  return JOB_TYPES.find(t => t.id === type)?.color ?? 'var(--muted)';
}
function jobTypeLabel(type) {
  return JOB_TYPES.find(t => t.id === type)?.label ?? type;
}

function RunStatusIcon({ status }) {
  if (status === 'running') return <span style={{ color: '#f59e0b', animation: 'blink 1s step-end infinite' }}>●</span>;
  if (status === 'success') return <span style={{ color: 'var(--accent-2)' }}>✓</span>;
  if (status === 'error')   return <span style={{ color: '#ef4444' }}>✗</span>;
  return <span style={{ color: 'var(--muted)' }}>—</span>;
}

function TypeBadge({ type }) {
  return (
    <span style={{
      fontSize: 9, fontFamily: 'var(--mono)', padding: '1px 5px', borderRadius: 3,
      border: `1px solid ${jobTypeColor(type)}`, color: jobTypeColor(type),
      textTransform: 'uppercase', letterSpacing: 1, whiteSpace: 'nowrap',
    }}>
      {jobTypeLabel(type)}
    </span>
  );
}

// ── Cron expression → human-readable ──────────────────────────────────────

const CRON_PRESETS = [
  { expr: '* * * * *',   label: 'every minute' },
  { expr: '*/5 * * * *', label: 'every 5 minutes' },
  { expr: '0 * * * *',   label: 'every hour' },
  { expr: '0 9 * * *',   label: 'daily at 9:00 AM' },
  { expr: '0 0 * * *',   label: 'daily at midnight' },
  { expr: '0 9 * * 1',   label: 'every Monday at 9:00 AM' },
  { expr: '0 9 1 * *',   label: 'monthly on the 1st at 9:00 AM' },
];

function cronHint(expr) {
  if (!expr) return '';
  const match = CRON_PRESETS.find(p => p.expr === expr.trim());
  if (match) return match.label;
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return 'invalid expression';
  const [min, hour, dom, month, dow] = parts;
  if (min === '*' && hour === '*') return 'runs every minute';
  if (hour !== '*' && min !== '*' && dom === '*' && month === '*' && dow === '*')
    return `daily at ${hour}:${min.padStart(2,'0')}`;
  return 'scheduled';
}

// ── Create/Edit Modal ──────────────────────────────────────────────────────

function JobModal({ job, agents, onSave, onClose }) {
  const isEdit = !!job;
  const [name,        setName]        = React.useState(job?.name ?? '');
  const [desc,        setDesc]        = React.useState(job?.description ?? '');
  const [type,        setType]        = React.useState(job?.job_type ?? 'agent_message');
  const [schedule,    setSchedule]    = React.useState(job?.schedule ?? '');
  const [enabled,     setEnabled]     = React.useState(job ? !!job.enabled : true);
  const [inbound,     setInbound]     = React.useState(false);
  const [onComplete,  setOnComplete]  = React.useState(job?.on_complete_webhook_url ?? '');
  const [saving,      setSaving]      = React.useState(false);
  const [err,         setErr]         = React.useState(null);

  // type-specific config
  const initialCfg = React.useMemo(() => {
    try { return job?.config ? JSON.parse(job.config) : {}; } catch { return {}; }
  }, [job]);

  const [agentId,      setAgentId]      = React.useState(initialCfg.agentId ?? '');
  const [agentMsg,     setAgentMsg]     = React.useState(initialCfg.message ?? '');
  const [whUrl,        setWhUrl]        = React.useState(initialCfg.url ?? '');
  const [whMethod,     setWhMethod]     = React.useState(initialCfg.method ?? 'POST');
  const [whHeaders,    setWhHeaders]    = React.useState(initialCfg.headers ? JSON.stringify(initialCfg.headers, null, 2) : '');
  const [whBody,       setWhBody]       = React.useState(initialCfg.body ? JSON.stringify(initialCfg.body, null, 2) : '');
  const [shellCmd,     setShellCmd]     = React.useState(initialCfg.command ?? '');
  const [shellTimeout, setShellTimeout] = React.useState(initialCfg.timeout ?? 30000);
  const [n8nBase,      setN8nBase]      = React.useState(initialCfg.baseUrl ?? '');
  const [n8nKey,       setN8nKey]       = React.useState(initialCfg.apiKey ?? '');
  const [n8nWorkflow,  setN8nWorkflow]  = React.useState(initialCfg.workflowId ?? '');
  const [n8nPayload,   setN8nPayload]   = React.useState(initialCfg.payload ? JSON.stringify(initialCfg.payload, null, 2) : '');

  function buildConfig() {
    switch (type) {
      case 'agent_message':    return JSON.stringify({ agentId, message: agentMsg });
      case 'outbound_webhook': {
        const cfg = { url: whUrl, method: whMethod };
        try { if (whHeaders.trim()) cfg.headers = JSON.parse(whHeaders); } catch { throw new Error('Headers must be valid JSON'); }
        try { if (whBody.trim())    cfg.body    = JSON.parse(whBody);    } catch { throw new Error('Body must be valid JSON'); }
        return JSON.stringify(cfg);
      }
      case 'shell_command':    return JSON.stringify({ command: shellCmd, timeout: shellTimeout });
      case 'n8n_workflow': {
        const cfg = { baseUrl: n8nBase, apiKey: n8nKey, workflowId: n8nWorkflow };
        try { if (n8nPayload.trim()) cfg.payload = JSON.parse(n8nPayload); } catch { throw new Error('Payload must be valid JSON'); }
        return JSON.stringify(cfg);
      }
      default: return '{}';
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErr(null);
    if (!name.trim())  return setErr('Name is required');
    let config;
    try { config = buildConfig(); } catch (ex) { return setErr(ex.message); }

    const payload = {
      name: name.trim(), description: desc.trim() || null, job_type: type,
      schedule: schedule.trim() || null, enabled: enabled ? 1 : 0,
      config, on_complete_webhook_url: onComplete.trim() || null,
    };
    if (!isEdit && inbound) payload.enable_inbound = true;

    setSaving(true);
    try {
      await onSave(payload, job?.id);
      onClose();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setSaving(false);
    }
  }

  const inputStyle = { fontFamily: 'var(--mono)', fontSize: 12, background: 'rgba(0,183,255,0.04)', border: '1px solid rgba(0,183,255,0.2)', borderRadius: 4, padding: '6px 10px', color: '#fff', width: '100%', boxSizing: 'border-box' };
  const labelStyle = { fontSize: 10, color: 'var(--accent)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: 1, display: 'block', marginBottom: 4 };
  const rowStyle   = { marginBottom: 14 };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="nc-panel glow" onClick={e => e.stopPropagation()}
           style={{ width: 560, maxHeight: '88vh', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="mono" style={{ fontSize: 13, color: 'var(--accent)' }}>{isEdit ? 'EDIT JOB' : 'NEW JOB'}</span>
          <button className="nc-btn ghost" style={{ fontSize: 16, padding: '0 6px' }} onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: 18 }}>
          <div style={rowStyle}>
            <label style={labelStyle}>Name</label>
            <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="Daily brief" />
          </div>

          <div style={rowStyle}>
            <label style={labelStyle}>Description</label>
            <input style={inputStyle} value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional" />
          </div>

          <div style={rowStyle}>
            <label style={labelStyle}>Job Type</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {JOB_TYPES.map(t => (
                <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', padding: '5px 10px', borderRadius: 4, border: `1px solid ${type === t.id ? t.color : 'rgba(255,255,255,0.1)'}`, background: type === t.id ? `${t.color}18` : 'transparent', fontSize: 11, fontFamily: 'var(--mono)', color: type === t.id ? t.color : 'rgba(255,255,255,0.5)' }}>
                  <input type="radio" value={t.id} checked={type === t.id} onChange={() => setType(t.id)} style={{ display: 'none' }} />
                  {t.label}
                </label>
              ))}
            </div>
          </div>

          <div style={rowStyle}>
            <label style={labelStyle}>Schedule <span style={{ color: 'rgba(255,255,255,0.35)', textTransform: 'none', letterSpacing: 0, marginLeft: 4 }}>(cron expression — leave blank for inbound-only)</span></label>
            <input style={inputStyle} value={schedule} onChange={e => setSchedule(e.target.value)} placeholder="0 9 * * *" />
            {schedule.trim() && <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 3, fontFamily: 'var(--mono)' }}>{cronHint(schedule)}</div>}
          </div>

          {type === 'agent_message' && (
            <>
              <div style={rowStyle}>
                <label style={labelStyle}>Agent</label>
                <select style={{ ...inputStyle, cursor: 'pointer' }} value={agentId} onChange={e => setAgentId(e.target.value)}>
                  <option value="">— select agent —</option>
                  {(agents || []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div style={rowStyle}>
                <label style={labelStyle}>Message</label>
                <textarea style={{ ...inputStyle, minHeight: 72, resize: 'vertical' }} value={agentMsg} onChange={e => setAgentMsg(e.target.value)} placeholder="Summarize overnight activity" />
              </div>
            </>
          )}

          {type === 'outbound_webhook' && (
            <>
              <div style={rowStyle}>
                <label style={labelStyle}>URL</label>
                <input style={inputStyle} value={whUrl} onChange={e => setWhUrl(e.target.value)} placeholder="https://..." />
              </div>
              <div style={{ ...rowStyle, display: 'flex', gap: 10 }}>
                <div style={{ flex: '0 0 80px' }}>
                  <label style={labelStyle}>Method</label>
                  <select style={{ ...inputStyle, cursor: 'pointer' }} value={whMethod} onChange={e => setWhMethod(e.target.value)}>
                    {['GET','POST','PUT','PATCH','DELETE'].map(m => <option key={m}>{m}</option>)}
                  </select>
                </div>
              </div>
              <div style={rowStyle}>
                <label style={labelStyle}>Headers (JSON)</label>
                <textarea style={{ ...inputStyle, minHeight: 56, resize: 'vertical' }} value={whHeaders} onChange={e => setWhHeaders(e.target.value)} placeholder={'{"Authorization": "Bearer ..."}'} />
              </div>
              <div style={rowStyle}>
                <label style={labelStyle}>Body (JSON)</label>
                <textarea style={{ ...inputStyle, minHeight: 56, resize: 'vertical' }} value={whBody} onChange={e => setWhBody(e.target.value)} placeholder='{"key": "value"}' />
              </div>
            </>
          )}

          {type === 'shell_command' && (
            <>
              <div style={rowStyle}>
                <label style={labelStyle}>Command</label>
                <input style={inputStyle} value={shellCmd} onChange={e => setShellCmd(e.target.value)} placeholder="node scripts/cleanup.js" />
              </div>
              <div style={rowStyle}>
                <label style={labelStyle}>Timeout (ms)</label>
                <input style={inputStyle} type="number" value={shellTimeout} onChange={e => setShellTimeout(Number(e.target.value))} />
              </div>
            </>
          )}

          {type === 'n8n_workflow' && (
            <>
              <div style={rowStyle}>
                <label style={labelStyle}>n8n Base URL</label>
                <input style={inputStyle} value={n8nBase} onChange={e => setN8nBase(e.target.value)} placeholder="https://n8n.example.com" />
              </div>
              <div style={rowStyle}>
                <label style={labelStyle}>API Key</label>
                <input type="password" style={inputStyle} value={n8nKey} onChange={e => setN8nKey(e.target.value)} placeholder="n8n API key" />
              </div>
              <div style={rowStyle}>
                <label style={labelStyle}>Workflow ID</label>
                <input style={inputStyle} value={n8nWorkflow} onChange={e => setN8nWorkflow(e.target.value)} placeholder="wf-1234" />
              </div>
              <div style={rowStyle}>
                <label style={labelStyle}>Payload (JSON)</label>
                <textarea style={{ ...inputStyle, minHeight: 56, resize: 'vertical' }} value={n8nPayload} onChange={e => setN8nPayload(e.target.value)} placeholder='{"key": "value"}' />
              </div>
            </>
          )}

          <div style={{ ...rowStyle, borderTop: '1px solid var(--line-soft)', paddingTop: 14 }}>
            <label style={labelStyle}>On-Completion Webhook URL <span style={{ color: 'rgba(255,255,255,0.35)', textTransform: 'none', letterSpacing: 0 }}>(optional, any type)</span></label>
            <input style={inputStyle} value={onComplete} onChange={e => setOnComplete(e.target.value)} placeholder="https://..." />
          </div>

          {!isEdit && (
            <div style={{ ...rowStyle, display: 'flex', alignItems: 'center', gap: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, fontFamily: 'var(--mono)', color: 'rgba(255,255,255,0.7)' }}>
                <input type="checkbox" checked={inbound} onChange={e => setInbound(e.target.checked)} />
                Generate inbound webhook URL
              </label>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, fontFamily: 'var(--mono)', color: 'rgba(255,255,255,0.7)' }}>
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              Enabled
            </label>
          </div>

          {err && <div style={{ fontSize: 11, color: '#ef4444', marginBottom: 10, fontFamily: 'var(--mono)' }}>{err}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="nc-btn" disabled={saving} style={{ flex: 1 }}>
              {saving ? '…' : isEdit ? 'Save Changes' : 'Create Job'}
            </button>
            <button type="button" className="nc-btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

function Automation() {
  const TOKEN = new URLSearchParams(location.search).get('token')
    ?? document.cookie.match(/dashboard-token=([^;]+)/)?.[1] ?? '';

  const [jobs,          setJobs]          = React.useState([]);
  const [selectedJobId, setSelectedJobId] = React.useState(null);
  const [runs,          setRuns]          = React.useState([]);
  const [selectedRunId, setSelectedRunId] = React.useState(null);
  const [filter,        setFilter]        = React.useState('all');
  const [showModal,     setShowModal]     = React.useState(false);
  const [editJob,       setEditJob]       = React.useState(null);
  const [liveOutput,    setLiveOutput]    = React.useState('');
  const [runningJobId,  setRunningJobId]  = React.useState(null);
  const [loading,       setLoading]       = React.useState(false);
  const [error,         setError]         = React.useState(null);
  const [agents,        setAgents]        = React.useState([]);

  const api = (path, opts) =>
    fetch(path + (path.includes('?') ? '&' : '?') + `token=${TOKEN}`, opts)
      .then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); });

  function fetchJobs() {
    api('/api/crons').then(data => setJobs(Array.isArray(data) ? data : [])).catch(() => {});
  }

  function fetchRuns(jobId) {
    api(`/api/crons/${jobId}/runs?limit=10`)
      .then(data => {
        const arr = Array.isArray(data) ? data : [];
        setRuns(arr);
        if (arr.length > 0) setSelectedRunId(arr[0].id);
        else setSelectedRunId(null);
      }).catch(() => {});
  }

  React.useEffect(() => {
    fetchJobs();
    api('/api/agents').then(data => setAgents(Array.isArray(data) ? data.filter(a => a.status === 'active') : [])).catch(() => {});
  }, []);

  React.useEffect(() => {
    if (!selectedJobId) { setRuns([]); setSelectedRunId(null); return; }
    fetchRuns(selectedJobId);
  }, [selectedJobId]);

  React.useEffect(() => {
    const es = new EventSource(`/api/crons/stream?token=${TOKEN}`);
    es.addEventListener('run_started', e => {
      const d = JSON.parse(e.data);
      setRunningJobId(d.jobId);
      if (d.jobId === selectedJobId) setLiveOutput('');
    });
    es.addEventListener('run_chunk', e => {
      const d = JSON.parse(e.data);
      if (d.jobId === selectedJobId) setLiveOutput(prev => prev + d.text);
    });
    es.addEventListener('run_done', e => {
      const d = JSON.parse(e.data);
      setRunningJobId(prev => prev === d.jobId ? null : prev);
      if (d.jobId === selectedJobId) fetchRuns(d.jobId);
      fetchJobs();
    });
    es.addEventListener('run_error', e => {
      const d = JSON.parse(e.data);
      setRunningJobId(prev => prev === d.jobId ? null : prev);
      if (d.jobId === selectedJobId) fetchRuns(d.jobId);
    });
    return () => es.close();
  }, [selectedJobId]);

  async function handleRunNow() {
    if (!selectedJobId) return;
    setLoading(true); setError(null); setLiveOutput('');
    try {
      await api(`/api/crons/${selectedJobId}/trigger`, { method: 'POST' });
    } catch (ex) { setError(ex.message); }
    finally { setLoading(false); }
  }

  async function handleToggle(job, e) {
    e.stopPropagation();
    await api(`/api/crons/${job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: job.enabled ? 0 : 1 }),
    }).catch(() => {});
    fetchJobs();
  }

  async function handleDelete(job, e) {
    e.stopPropagation();
    if (!confirm(`Delete job "${job.name}"?`)) return;
    await api(`/api/crons/${job.id}`, { method: 'DELETE' }).catch(() => {});
    if (selectedJobId === job.id) { setSelectedJobId(null); setRuns([]); }
    fetchJobs();
  }

  async function handleSave(payload, jobId) {
    if (jobId) {
      await api(`/api/crons/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      const job = await api('/api/crons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setSelectedJobId(job.id);
    }
    fetchJobs();
  }

  function copyWebhookUrl(slug) {
    const url = `${location.origin}/webhooks/${slug}`;
    navigator.clipboard.writeText(url).catch(() => {});
  }

  const filteredJobs  = jobs.filter(j => filter === 'all' || j.job_type === filter);
  const selectedJob   = jobs.find(j => j.id === selectedJobId);
  const selectedRun   = runs.find(r => r.id === selectedRunId);
  const isLive        = runningJobId === selectedJobId && !!liveOutput;

  const logText = isLive ? liveOutput
    : selectedRun?.error_text ?? selectedRun?.output ?? '';

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* ── Left pane: job list ── */}
      <div style={{ width: 300, minWidth: 220, flexShrink: 0, borderRight: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 2, color: 'var(--accent)', textTransform: 'uppercase' }}>AUTOMATION</span>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-2)', flexShrink: 0, boxShadow: '0 0 4px var(--accent-2)' }} />
        </div>

        {/* Filter tabs */}
        <div style={{ display: 'flex', gap: 4, padding: '8px 10px', borderBottom: '1px solid var(--line-soft)', flexWrap: 'wrap' }}>
          {[{ id: 'all', label: 'All' }, ...JOB_TYPES.map(t => ({ id: t.id, label: t.label }))].map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              style={{ fontSize: 9, fontFamily: 'var(--mono)', padding: '2px 7px', borderRadius: 3, border: `1px solid ${filter === f.id ? 'var(--accent)' : 'rgba(255,255,255,0.1)'}`, background: filter === f.id ? 'rgba(0,183,255,0.12)' : 'transparent', color: filter === f.id ? 'var(--accent)' : 'rgba(255,255,255,0.45)', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: 1 }}>
              {f.label}
            </button>
          ))}
        </div>

        {/* Job list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
          {filteredJobs.length === 0 && (
            <div className="mono muted" style={{ padding: '20px 16px', fontSize: 11, textAlign: 'center' }}>No jobs{filter !== 'all' ? ' matching filter' : ''}</div>
          )}
          {filteredJobs.map(job => {
            const isSelected = job.id === selectedJobId;
            const isRunning  = runningJobId === job.id;
            return (
              <div key={job.id} onClick={() => setSelectedJobId(job.id)}
                style={{ padding: '10px 14px', cursor: 'pointer', borderLeft: `2px solid ${isSelected ? 'var(--accent)' : 'transparent'}`, background: isSelected ? 'rgba(0,183,255,0.06)' : 'transparent', position: 'relative' }}
                onMouseOver={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                onMouseOut={e =>  { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}>

                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: isRunning ? '#f59e0b' : job.enabled ? 'var(--accent-2)' : 'rgba(255,255,255,0.2)', flexShrink: 0, boxShadow: isRunning ? '0 0 5px #f59e0b' : job.enabled ? '0 0 4px var(--accent-2)' : 'none' }} />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#fff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.name}</span>
                  <TypeBadge type={job.job_type} />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 14 }}>
                  <span style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'rgba(255,255,255,0.35)' }}>
                    {job.schedule ?? 'manual'}
                  </span>
                </div>

                {/* Hover actions */}
                <div className="job-hover-actions" style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: 4, opacity: isSelected ? 1 : 0, transition: 'opacity 0.15s' }}>
                  <button title={job.enabled ? 'Disable' : 'Enable'}
                    onClick={e => handleToggle(job, e)}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 11, color: job.enabled ? 'var(--accent-2)' : 'rgba(255,255,255,0.3)', padding: '2px 4px' }}>
                    {job.enabled ? '⏸' : '▶'}
                  </button>
                  <button title="Delete" onClick={e => handleDelete(job, e)}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 11, color: 'rgba(255,255,255,0.3)', padding: '2px 4px' }}>
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* New job button */}
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--line-soft)' }}>
          <button className="nc-btn" style={{ width: '100%', fontSize: 11 }}
            onClick={() => { setEditJob(null); setShowModal(true); }}>
            + New Job
          </button>
        </div>
      </div>

      {/* ── Right pane: log panel ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!selectedJob ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10 }}>
            <div className="mono muted" style={{ fontSize: 12 }}>Select a job to view logs</div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)', fontFamily: 'var(--mono)' }}>{jobs.length} job{jobs.length !== 1 ? 's' : ''} total</div>
          </div>
        ) : (
          <>
            {/* Job header */}
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: '#fff', fontWeight: 600 }}>{selectedJob.name}</span>
              <TypeBadge type={selectedJob.job_type} />
              {runs.length > 0 && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--mono)' }}>{runs.length} run{runs.length !== 1 ? 's' : ''}</span>}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 9px' }}
                  onClick={() => { setEditJob(selectedJob); setShowModal(true); }}>
                  ✎ Edit
                </button>
                {selectedJob.inbound_slug && (
                  <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 9px' }}
                    onClick={() => copyWebhookUrl(selectedJob.inbound_slug)}
                    title={`${location.origin}/webhooks/${selectedJob.inbound_slug}`}>
                    ⧉ Copy Webhook
                  </button>
                )}
                <button className="nc-btn" style={{ fontSize: 11, padding: '4px 12px' }}
                  onClick={handleRunNow} disabled={loading || runningJobId === selectedJobId}>
                  {loading || runningJobId === selectedJobId ? '…' : '▶ Run Now'}
                </button>
              </div>
            </div>

            {/* Run selector tabs */}
            {runs.length > 0 && (
              <div style={{ display: 'flex', gap: 4, padding: '8px 18px', borderBottom: '1px solid var(--line-soft)', overflowX: 'auto', flexShrink: 0 }}>
                {runs.map((run, i) => (
                  <button key={run.id} onClick={() => setSelectedRunId(run.id)}
                    style={{ fontFamily: 'var(--mono)', fontSize: 10, padding: '3px 9px', borderRadius: 3, border: `1px solid ${selectedRunId === run.id ? 'var(--accent)' : 'rgba(255,255,255,0.1)'}`, background: selectedRunId === run.id ? 'rgba(0,183,255,0.1)' : 'transparent', color: selectedRunId === run.id ? 'var(--accent)' : 'rgba(255,255,255,0.45)', cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <RunStatusIcon status={run.status} />
                    #{runs.length - i}
                  </button>
                ))}
              </div>
            )}

            {/* Log body */}
            <div style={{ flex: 1, overflow: 'auto', padding: 18 }}>
              {error && <div style={{ fontSize: 11, color: '#ef4444', marginBottom: 10, fontFamily: 'var(--mono)' }}>{error}</div>}

              {logText ? (
                <pre style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'rgba(255,255,255,0.8)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, lineHeight: 1.6 }}>
                  {logText}{isLive ? <span style={{ opacity: 0.7, animation: 'blink 1s step-end infinite' }}>▌</span> : null}
                </pre>
              ) : (
                <div className="mono muted" style={{ fontSize: 11 }}>
                  {runs.length === 0 ? 'No runs yet — click ▶ Run Now to execute' : 'No output'}
                </div>
              )}
            </div>

            {/* Metadata strip */}
            {selectedRun && !isLive && (
              <div style={{ padding: '8px 18px', borderTop: '1px solid var(--line-soft)', display: 'flex', gap: 16, fontSize: 10, fontFamily: 'var(--mono)', color: 'rgba(255,255,255,0.4)', flexWrap: 'wrap' }}>
                <span>triggered: <span style={{ color: 'rgba(255,255,255,0.6)' }}>{selectedRun.triggered_by}</span></span>
                {selectedRun.duration_ms != null && <span>duration: <span style={{ color: 'rgba(255,255,255,0.6)' }}>{selectedRun.duration_ms}ms</span></span>}
                {selectedRun.outbound_webhook_status != null && <span>webhook: <span style={{ color: selectedRun.outbound_webhook_status < 300 ? 'var(--accent-2)' : '#ef4444' }}>{selectedRun.outbound_webhook_status}</span></span>}
                <span>started: <span style={{ color: 'rgba(255,255,255,0.6)' }}>{selectedRun.started_at?.replace('T', ' ').slice(0, 19)}</span></span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <JobModal
          job={editJob}
          agents={agents}
          onSave={handleSave}
          onClose={() => { setShowModal(false); setEditJob(null); }}
        />
      )}
    </div>
  );
}

window.Automation = Automation;
