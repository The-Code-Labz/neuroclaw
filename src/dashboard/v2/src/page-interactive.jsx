/* Interactive — live read-only watch view of the claude-interactive +
 * antigravity REPL tmux sessions (Studio sub-tab). Polls /api/tmux/sessions
 * for the live list and /api/tmux/sessions/:name/capture for the pane. */

const Interactive = () => {
  const [sessions, setSessions] = React.useState([]);
  const [sel, setSel]   = React.useState(null);
  const [pane, setPane] = React.useState('');
  const [alive, setAlive] = React.useState(true);
  const paneRef = React.useRef(null);

  const loadList = React.useCallback(() =>
    window.NC_API.get('/api/tmux/sessions')
      .then(d => setSessions(Array.isArray(d?.sessions) ? d.sessions : []))
      .catch(() => {}), []);

  React.useEffect(() => {
    loadList();
    const t = setInterval(loadList, 3000);
    return () => clearInterval(t);
  }, [loadList]);

  // Keep a valid selection: default to the first session, drop a dead one.
  React.useEffect(() => {
    if (!sessions.length) { if (sel) setSel(null); return; }
    if (!sel || !sessions.some(s => s.name === sel)) setSel(sessions[0].name);
  }, [sessions, sel]);

  // Poll the selected session's pane.
  React.useEffect(() => {
    if (!sel) { setPane(''); return; }
    let stop = false;
    const cap = () => window.NC_API.get(`/api/tmux/sessions/${encodeURIComponent(sel)}/capture?scrollback=400`)
      .then(d => { if (stop) return; setPane(d?.pane || ''); setAlive(d?.alive !== false); })
      .catch(() => {});
    cap();
    const t = setInterval(cap, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [sel]);

  React.useEffect(() => { const el = paneRef.current; if (el) el.scrollTop = el.scrollHeight; }, [pane]);

  const sessTitle = (s) => {
    if (s.kind === 'claude') {
      const m = (window.NC_DATA.SESSIONS || []).find(x => (x._raw?.id || x.id) === s.sessionId);
      return m?.title || (s.sessionId ? s.sessionId.slice(0, 8) : s.name);
    }
    return 'agy ' + s.name.replace('nclaw-agy-', '').slice(0, 10);
  };

  return (
    <div>
      <PageHeader
        title="Interactive"
        subtitle="// live claude + antigravity REPL sessions · tmux watch (read-only)"
        right={<button className="nc-btn" onClick={loadList}><Icon name="refresh" size={12}/> Refresh</button>}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16, height: '70vh', minHeight: 420 }}>
        {/* Session list */}
        <div className="nc-panel" style={{ padding: 0, overflow: 'auto' }}>
          <div className="label-tiny" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-soft)', color: 'var(--accent)' }}>SESSIONS · {sessions.length}</div>
          {sessions.length === 0 && (
            <div className="mono muted" style={{ padding: 18, fontSize: 11, textAlign: 'center' }}>// no live interactive sessions</div>
          )}
          {sessions.map(s => (
            <div key={s.name} onClick={() => setSel(s.name)} style={{
              padding: '10px 14px', cursor: 'pointer',
              borderLeft: `2px solid ${sel === s.name ? 'var(--accent)' : 'transparent'}`,
              background: sel === s.name ? 'rgba(0,183,255,0.08)' : 'transparent',
              borderBottom: '1px dashed var(--line-soft)',
            }}>
              <div className="mono" style={{ fontSize: 11, color: sel === s.name ? '#fff' : 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sessTitle(s)}</div>
              <div className="mono muted" style={{ fontSize: 9, marginTop: 3, display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className={`tag ${s.kind === 'claude' ? 'blue' : 'violet'}`} style={{ fontSize: 8, padding: '0 4px' }}>{s.kind === 'claude' ? 'CLAUDE' : 'AGY'}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Pane viewer */}
        <div className="nc-panel" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 11, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sel || 'no session'}</span>
            <span className="mono" style={{ fontSize: 10, color: sel ? (alive ? 'var(--green)' : 'var(--muted)') : 'transparent', whiteSpace: 'nowrap' }}>{sel ? (alive ? '● live · 2s' : '○ ended') : ''}</span>
          </div>
          <pre ref={paneRef} className="mono" style={{ flex: 1, margin: 0, padding: '12px 14px', overflow: 'auto', fontSize: 11, lineHeight: 1.45, color: 'var(--text-soft)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg-0)' }}>
            {sel ? (pane || '// waiting for output…') : '// select a session to watch its REPL'}
          </pre>
        </div>
      </div>
    </div>
  );
};

window.Interactive = Interactive;
