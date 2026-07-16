/* Logs — live tail of logs/neuroclaw.log with pause/resume */
const Logs = () => {
  const [lines,  setLines]  = React.useState([]);
  const [paused, setPaused] = React.useState(false);
  const [lvl,    setLvl]    = React.useState('ALL');
  const [grep,   setGrep]   = React.useState('');
  const [bufLen, setBufLen] = React.useState(0);
  const [debugLines, setDebugLines] = React.useState([]);
  const [loading, setLoading] = React.useState(false);

  const pausedRef = React.useRef(false);
  const lvlRef = React.useRef(lvl);
  React.useEffect(() => { lvlRef.current = lvl; }, [lvl]);
  const bufRef    = React.useRef([]);
  const bottomRef = React.useRef(null);
  const esRef     = React.useRef(null);

  // Fetch initial lines — branches on DEBUG filter (smaller limit for speed)
  React.useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setLoading(true);
    if (lvl === 'DEBUG') {
      fetch('/api/logs/debug?limit=200', { credentials: 'same-origin', signal })
        .then(r => r.ok ? r.json() : [])
        .then(data => {
          if (!Array.isArray(data)) return;
          setDebugLines(data.map(r => ({
            t:   r.created_at,
            lvl: 'DEBUG',
            src: r.source,
            msg: r.message,
          })));
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    } else {
      fetch('/api/logs/tail?limit=100', { credentials: 'same-origin', signal })
        .then(r => r.ok ? r.json() : [])
        .then(data => { if (Array.isArray(data)) setLines(data); })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
    return () => controller.abort();
  }, [lvl]);

  // SSE live stream with auto-reconnect
  React.useEffect(() => {
    let es;
    let reconnectTimer;
    let lastEventTime = Date.now();

    function connect() {
      try {
        es = new EventSource('/api/logs/stream');
        es.onopen = () => { lastEventTime = Date.now(); };
        es.onmessage = (e) => {
          lastEventTime = Date.now();
          try {
            const ev = JSON.parse(e.data);
            if (ev.type === 'debug') {
              if (lvlRef.current === 'DEBUG') {
                setDebugLines(prev => [...prev.slice(-300), ev.line]);
              }
              return;
            }
            if (ev.type !== 'line') return;
            if (pausedRef.current) {
              bufRef.current.push(ev.line);
              setBufLen(bufRef.current.length);
            } else {
              setLines(prev => [...prev.slice(-300), ev.line]);
            }
          } catch { /* ignore */ }
        };
        es.onerror = () => {
          es.close();
          // Reconnect if still alive and no events for 15s
          if (Date.now() - lastEventTime > 15000) {
            reconnectTimer = setTimeout(connect, 2000);
          } else {
            reconnectTimer = setTimeout(connect, 500);
          }
        };
      } catch { /* SSE not supported */ }
    }

    connect();
    return () => {
      if (es) es.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  // Auto-scroll to bottom when live
  React.useEffect(() => {
    if (!paused && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines, paused]);

  const togglePause = () => {
    const next = !paused;
    pausedRef.current = next;
    setPaused(next);
    if (!next && bufRef.current.length > 0) {
      setLines(prev => [...prev, ...bufRef.current].slice(-300));
      bufRef.current = [];
      setBufLen(0);
    }
  };

  const colorOf = (lv, src) => {
    if (lv === 'DEBUG' && src && (src.startsWith('agent-thought') || src.startsWith('tool-result'))) return 'var(--violet)';
    return ({
      ERROR: 'var(--danger)',
      WARN:  'var(--amber)',
      DEBUG: 'var(--muted)',
    }[lv] || 'var(--accent-2)');
  };

  const activeLines = lvl === 'DEBUG' ? debugLines : lines;
  const filtered = activeLines
    .filter(l => {
      if (lvl === 'ALL') return true;
      if (lvl === 'TRACE') return l.lvl === 'DEBUG';
      if (lvl === 'ARCHIVIST') return (l.src ?? '').toLowerCase().includes('archivist') || (l.msg ?? '').toLowerCase().includes('archivist');
      return l.lvl === lvl;
    })
    .filter(l => !grep || (l.msg + ' ' + l.src).toLowerCase().includes(grep.toLowerCase()));

  return (
    <div>
      <PageHeader
        title="Logs"
        subtitle={`// live tail · America/Los_Angeles · last ${lvl === 'DEBUG' ? 200 : 100} lines`}
        right={<>
          <input
            className="nc-input"
            placeholder="grep..."
            value={grep}
            onChange={e => setGrep(e.target.value)}
            style={{ width: 200 }}
          />
          <button className="nc-btn primary" onClick={togglePause}>
            <Icon name={paused ? 'bolt' : 'pause'} size={12}/>
            {' '}{paused ? `Resume (${bufLen} new)` : 'Pause'}
          </button>
        </>}
      />

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        {['ALL','INFO','WARN','ERROR','DEBUG','TRACE','ARCHIVIST'].map(l => (
          <span
            key={l}
            onClick={() => setLvl(l)}
            className={`tag ${lvl === l ? 'blue' : ''}`}
            style={{ cursor: 'pointer' }}
          >{l}</span>
        ))}
        <span style={{ flex: 1 }}/>
        {paused
          ? <span className="tag amber">PAUSED · {bufLen} buffered</span>
          : <span className="tag cyan"><span className="dot cyan pulse" style={{ marginRight: 4 }}/>LIVE</span>
        }
      </div>

      <div className="nc-panel glow" style={{ padding: 0, position: 'relative', overflow: 'hidden' }}>
        <div className="scan-line"/>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between' }}>
          <div className="mono neonc" style={{ fontSize: 11 }}>$ tail -f logs/neuroclaw.log</div>
          <div className="mono muted" style={{ fontSize: 10 }}>
            {loading ? 'loading...' : `${filtered.length} of ${activeLines.length} lines`}
          </div>
        </div>

        <div style={{ background: 'rgba(0,4,12,0.7)', padding: '10px 14px', maxHeight: 560, overflow: 'auto' }}>
          {loading && (
            <div className="mono muted" style={{ padding: '20px 0', fontSize: 11 }}>// loading logs...</div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="mono muted" style={{ padding: '20px 0', fontSize: 11 }}>// no log lines match</div>
          )}
          {filtered.map((l, i) => (
            <div
              key={i}
              className="mono"
              style={{
                display: 'grid',
                gridTemplateColumns: '160px 58px 120px 1fr',
                gap: 10,
                padding: '3px 0',
                fontSize: 11,
                lineHeight: 1.5,
                borderBottom: '1px dashed color-mix(in srgb, var(--accent) 4%, transparent)',
              }}
            >
              <span className="muted">{l.t}</span>
              <span style={{ color: colorOf(l.lvl, l.src), fontWeight: 700 }}>{l.lvl}</span>
              <span className="neonc" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>[{l.src}]</span>
              <span style={{ color: 'var(--text-soft)', wordBreak: 'break-word' }}>{l.msg}</span>
            </div>
          ))}
          <div ref={bottomRef}/>
          <div className="mono neonc" style={{ paddingTop: 6, fontSize: 11 }}>$ <span className="blink">▌</span></div>
        </div>
      </div>
    </div>
  );
};
window.Logs = Logs;
