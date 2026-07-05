/* Board Discipline — read-only panel showing per-agent task-board engagement.
 * Fetches GET /api/tasks/discipline which returns:
 *   { agents: [{ agentId, agentName, claimed, selfUpdated, openTasks, byStatus }], totals }
 * Data-fetch pattern: window.NC_API.get() — same as AgentActivityPanel in page-tasks.jsx.
 * Token is handled transparently by NC_API (injected via _withToken in live-data.jsx). */

const BoardDiscipline = () => {
  const [data,    setData]    = React.useState(null);   // { agents: [], totals: {} }
  const [loading, setLoading] = React.useState(false);
  const [err,     setErr]     = React.useState(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await window.NC_API.get('/api/tasks/discipline');
      setData(res);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const agents = data?.agents || [];
  const totals = data?.totals || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 56px - 32px - 44px)' }}>
      <PageHeader
        title="Board Discipline"
        subtitle="// How much each agent drives the task board (claims + self-updates) vs pipeline-driven work."
        right={
          <button className="nc-btn" onClick={load} disabled={loading}>
            <Icon name="refresh" size={12}/> Refresh
          </button>
        }
      />

      <div className="nc-panel table-responsive" style={{ padding: 0 }}>
        {/* Panel header */}
        <div style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--line-soft)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span className="label-tiny neonc">AGENT ENGAGEMENT</span>
          {loading && <span className="dot cyan pulse" style={{ width: 6, height: 6 }}/>}
          {err && (
            <span className="mono dangerc" style={{ fontSize: 10 }}>// {err}</span>
          )}
          <span className="mono muted" style={{ fontSize: 10, marginLeft: 'auto' }}>
            {agents.length} agent{agents.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Body */}
        {!loading && !err && agents.length === 0 ? (
          <div className="mono muted" style={{ padding: 24, textAlign: 'center', fontSize: 11 }}>
            // no discipline data yet — agents need to claim or update tasks first
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11 }}>
            <thead>
              <tr style={{ background: 'rgba(0,183,255,0.06)', textAlign: 'left' }}>
                {['Agent', 'Claimed', 'Self-updated', 'Open tasks'].map(h => (
                  <th key={h} style={{
                    padding: '8px 10px',
                    borderBottom: '1px solid var(--line-soft)',
                    fontSize: 10, color: 'var(--text-soft)',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map(a => (
                  <tr key={a.agentId}
                      style={{ borderBottom: '1px dashed rgba(0,183,255,0.06)' }}>
                    <td style={{ padding: '8px 10px', color: 'var(--accent)' }}>
                      {a.agentName || a.agentId?.slice(0, 8) || '?'}
                    </td>
                    <td style={{ padding: '8px 10px', color: a.claimed > 0 ? 'var(--text)' : 'var(--muted)' }}>
                      {a.claimed ?? 0}
                    </td>
                    <td style={{ padding: '8px 10px', color: a.selfUpdated > 0 ? 'var(--text)' : 'var(--muted)' }}>
                      {a.selfUpdated ?? 0}
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      {(a.openTasks ?? 0) > 0
                        ? <span className="tag blue" style={{ fontSize: 9 }}>{a.openTasks}</span>
                        : <span className="muted">—</span>}
                    </td>
                  </tr>
              ))}
            </tbody>
            {/* Totals footer */}
            {agents.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: '1px solid var(--line-soft)', background: 'rgba(0,183,255,0.04)' }}>
                  <td style={{ padding: '6px 10px', color: 'var(--text-soft)', fontSize: 10 }}>
                    TOTALS
                  </td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-soft)', fontSize: 10 }}>
                    {totals.claimed ?? 0}
                  </td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-soft)', fontSize: 10 }}>
                    {totals.selfUpdated ?? 0}
                  </td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-soft)', fontSize: 10 }}>
                    {totals.openTasks ?? 0}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>
    </div>
  );
};

window.BoardDiscipline = BoardDiscipline;
