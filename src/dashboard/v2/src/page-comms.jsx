/* Comms (live-wired) */

/**
 * Convert an ISO timestamp or HH:MM:SS string to a human-readable relative
 * time. If the timestamp is from today it shows "Xs ago / Xm ago / Xh ago".
 */
const relTime = (raw) => {
  if (!raw) return '—';
  try {
    // Support both full ISO strings and bare time strings like "22:14:05"
    const src = raw.includes('T') ? raw : new Date().toISOString().slice(0, 11) + raw;
    const diff = Math.floor((Date.now() - new Date(src).getTime()) / 1000);
    if (diff < 0)  return raw;          // future or bad parse — fallback
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch {
    return raw;
  }
};

/** Badge for comm direction derived from the entry */
const DirBadge = ({ from, to }) => (
  <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
    <span className="neonc" style={{ fontWeight: 600 }}>@{from}</span>
    <span className="muted" style={{ fontSize: 10 }}>→</span>
    <span className="neon2" style={{ fontWeight: 600 }}>@{to}</span>
  </span>
);

/** Badge mapping status to NeuroClaw color classes */
const StatusBadge = ({ status }) => {
  const map = {
    streaming: { cls: 'cyan',   label: 'streaming' },
    ack:       { cls: 'blue',   label: 'ack' },
    closed:    { cls: 'muted',  label: 'closed' },
    sent:      { cls: 'green',  label: 'sent' },
    pending:   { cls: 'amber',  label: 'pending' },
    failed:    { cls: 'red',    label: 'failed' },
  };
  const { cls, label } = map[status] || { cls: '', label: status };
  return <span className={`tag ${cls}`} style={{ fontSize: 9, padding: '1px 7px' }}>{label}</span>;
};

/** Small inline dot for direction */
const DirDot = ({ from, to }) => {
  // "inbound" = something replied to Alfred/orchestrator; "outbound" = Alfred sent
  const isOut = (from || '').toLowerCase() === 'alfred';
  return (
    <span className={`tag ${isOut ? 'blue' : 'green'}`} style={{ fontSize: 8, padding: '1px 5px', letterSpacing: '0.08em' }}>
      {isOut ? 'OUT' : 'IN'}
    </span>
  );
};

const CommRow = ({ c, i }) => (
  <div
    className="mono"
    style={{
      display: 'grid',
      gridTemplateColumns: '72px auto 1fr 80px 70px',
      gap: 10,
      padding: '11px 16px',
      borderBottom: '1px dashed rgba(0,183,255,0.07)',
      fontSize: 11,
      alignItems: 'start',
      background: i % 2 === 0 ? 'transparent' : 'rgba(0,183,255,0.018)',
    }}
  >
    {/* Timestamp */}
    <span className="muted" style={{ fontSize: 10, lineHeight: '20px', whiteSpace: 'nowrap' }} title={c.t}>
      {relTime(c.t)}
    </span>

    {/* Direction badge + route */}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <DirDot from={c.from} to={c.to}/>
      <DirBadge from={c.from} to={c.to}/>
      {c.task && c.task !== '—' && (
        <span className="tag amber" style={{ fontSize: 8, padding: '0 5px', marginTop: 1 }}>{c.task}</span>
      )}
    </div>

    {/* Message + response */}
    <div style={{ minWidth: 0 }}>
      <div style={{ color: 'var(--text)', lineHeight: 1.55, wordBreak: 'break-word' }}>
        <span className="muted" style={{ fontSize: 9 }}>MSG </span>"{c.msg}"
      </div>
      {c.resp && (
        <div className="muted" style={{ fontSize: 10, marginTop: 3, lineHeight: 1.45, wordBreak: 'break-word' }}>
          <span style={{ fontSize: 9 }}>↳ RSP </span>"{c.resp}"
        </div>
      )}
    </div>

    {/* Status */}
    <div style={{ display: 'flex', alignItems: 'flex-start', paddingTop: 2 }}>
      <StatusBadge status={c.status}/>
    </div>

    {/* Streaming pulse indicator */}
    <div style={{ display: 'flex', alignItems: 'center', paddingTop: 2 }}>
      {c.status === 'streaming' && (
        <span style={{ display: 'inline-flex', gap: 2 }}>
          <span className="stream-dot"/>
          <span className="stream-dot"/>
          <span className="stream-dot"/>
        </span>
      )}
    </div>
  </div>
);

const Comms = () => {
  const { COMMS } = window.NC_DATA;
  const list = COMMS || [];
  const [search, setSearch] = React.useState('');
  const [dirFilter, setDirFilter] = React.useState('all'); // all | in | out
  const [statusFilter, setStatusFilter] = React.useState('all');

  const filtered = list.filter(c => {
    if (search && !((c.from + ' ' + c.to + ' ' + c.msg + ' ' + c.resp + ' ' + c.task) || '').toLowerCase().includes(search.toLowerCase())) return false;
    if (dirFilter === 'out' && (c.from || '').toLowerCase() !== 'alfred') return false;
    if (dirFilter === 'in'  && (c.from || '').toLowerCase() === 'alfred') return false;
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    return true;
  });

  // Summary counts (over full list, not filtered)
  const total     = list.length;
  const streaming = list.filter(c => c.status === 'streaming').length;
  const acked     = list.filter(c => c.status === 'ack').length;
  const closed    = list.filter(c => c.status === 'closed').length;
  const failed    = list.filter(c => c.status === 'failed').length;

  // Unique agents involved
  const agents = [...new Set(list.flatMap(c => [c.from, c.to]).filter(Boolean))];

  return (
    <div>
      <PageHeader
        title="Comms"
        subtitle="// agent-to-agent relay · directives · acknowledgments"
        right={<>
          <input className="nc-input" placeholder="search…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 180 }}/>
          <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>
        </>}
      />

      {/* ── Summary bar ── */}
      <div className="nc-panel glow" style={{ display: 'flex', gap: 0, marginBottom: 14, padding: 0, overflow: 'hidden' }}>
        {[
          { label: 'TOTAL',     value: total,     cls: 'blue',   active: statusFilter === 'all',        onClick: () => setStatusFilter('all') },
          { label: 'STREAMING', value: streaming, cls: 'cyan',   active: statusFilter === 'streaming',  onClick: () => setStatusFilter(statusFilter === 'streaming' ? 'all' : 'streaming') },
          { label: 'ACK',       value: acked,     cls: 'blue',   active: statusFilter === 'ack',        onClick: () => setStatusFilter(statusFilter === 'ack'       ? 'all' : 'ack')       },
          { label: 'CLOSED',    value: closed,    cls: 'muted',  active: statusFilter === 'closed',     onClick: () => setStatusFilter(statusFilter === 'closed'    ? 'all' : 'closed')    },
          { label: 'FAILED',    value: failed,    cls: 'red',    active: statusFilter === 'failed',     onClick: () => setStatusFilter(statusFilter === 'failed'    ? 'all' : 'failed')    },
        ].map((s, i) => (
          <div
            key={s.label}
            onClick={s.onClick}
            style={{
              flex: 1,
              padding: '10px 14px',
              borderRight: i < 4 ? '1px solid var(--line-soft)' : 'none',
              cursor: 'pointer',
              background: s.active ? 'rgba(0,183,255,0.07)' : 'transparent',
              transition: 'background .15s ease',
            }}
            onMouseOver={e => { if (!s.active) e.currentTarget.style.background = 'rgba(0,183,255,0.04)'; }}
            onMouseOut={e => { if (!s.active) e.currentTarget.style.background = 'transparent'; }}
          >
            <div className="mono muted" style={{ fontSize: 9, letterSpacing: '0.14em' }}>{s.label}</div>
            <div className={`mono ${s.cls === 'muted' ? 'muted' : s.cls === 'red' ? 'dangerc' : s.cls === 'cyan' ? 'neon2' : 'neonc'}`} style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1, marginTop: 2 }}>
              {s.value}
            </div>
          </div>
        ))}
        {/* Direction quick-filter pills */}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5, padding: '8px 14px', borderLeft: '1px solid var(--line-soft)' }}>
          <div className="mono muted" style={{ fontSize: 9, letterSpacing: '0.14em' }}>DIRECTION</div>
          <div style={{ display: 'flex', gap: 5 }}>
            {['all', 'out', 'in'].map(d => (
              <span
                key={d}
                onClick={() => setDirFilter(d)}
                className={`tag ${dirFilter === d ? (d === 'out' ? 'blue' : d === 'in' ? 'green' : 'blue') : ''}`}
                style={{ cursor: 'pointer', fontSize: 9, padding: '1px 7px' }}
              >{d.toUpperCase()}</span>
            ))}
          </div>
        </div>
      </div>

      {/* ── Agents involved ── */}
      {agents.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="mono muted" style={{ fontSize: 9, letterSpacing: '0.14em' }}>AGENTS IN LOG</span>
          {agents.map(a => (
            <span key={a} className="tag" style={{ fontSize: 9, padding: '1px 7px', cursor: 'pointer' }}
              onClick={() => setSearch(search === a ? '' : a)}>
              @{a}
            </span>
          ))}
        </div>
      )}

      {/* ── Main relay log + graph ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 12 }}>

        {/* Relay log */}
        <Section title={`RELAY LOG  ·  ${filtered.length} entries`} padded={false}>
          {/* Column header */}
          <div className="mono" style={{
            display: 'grid',
            gridTemplateColumns: '72px auto 1fr 80px 70px',
            gap: 10,
            padding: '8px 16px',
            borderBottom: '1px solid var(--line-soft)',
            fontSize: 9,
            color: 'var(--muted)',
            letterSpacing: '0.14em',
            background: 'rgba(0,183,255,0.03)',
          }}>
            <span>TIME</span><span>DIR · ROUTE</span><span>MESSAGE / RESPONSE</span><span>STATUS</span><span></span>
          </div>

          {filtered.length === 0 && (
            <div className="mono muted" style={{ padding: 30, textAlign: 'center', fontSize: 11 }}>
              // no messages match current filters
            </div>
          )}

          {filtered.map((c, i) => <CommRow key={i} c={c} i={i}/>)}
        </Section>

        {/* Right column: graph + legend */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Section title="RELAY GRAPH">
            <div style={{ position: 'relative', height: 340, border: '1px solid var(--line-soft)', borderRadius: 2 }} className="grid-bg">
              <svg viewBox="0 0 400 400" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                <defs>
                  <marker id="arr2" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" fill="#00f5d4"/>
                  </marker>
                </defs>
                <line x1="200" y1="200" x2="100" y2="100" stroke="#00b7ff" strokeWidth="1.4" markerEnd="url(#arr2)"/>
                <line x1="200" y1="200" x2="320" y2="120" stroke="#00b7ff" strokeWidth="1.4" markerEnd="url(#arr2)"/>
                <line x1="200" y1="200" x2="320" y2="300" stroke="#00b7ff" strokeWidth="1.4" markerEnd="url(#arr2)"/>
                <line x1="200" y1="200" x2="80" y2="320" stroke="#00b7ff" strokeWidth="1.4" markerEnd="url(#arr2)"/>
                <line x1="100" y1="100" x2="320" y2="120" stroke="rgba(0,245,212,0.3)" strokeDasharray="3 3" strokeWidth="1"/>
              </svg>
              {[
                { x: 200, y: 200, n: 'Alfred',     active: true },
                { x: 100, y: 100, n: 'Researcher', active: false },
                { x: 320, y: 120, n: 'Coder',      active: true },
                { x: 320, y: 300, n: 'Archivist',  active: false },
                { x: 80,  y: 320, n: 'Planner',    active: false },
              ].map((n, i) => (
                <div key={i} style={{ position: 'absolute', left: `${(n.x/400)*100}%`, top: `${(n.y/400)*100}%`, transform: 'translate(-50%, -50%)', textAlign: 'center' }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%',
                    background: n.active
                      ? 'radial-gradient(circle, var(--neon-2), rgba(0,0,0,0))'
                      : 'radial-gradient(circle, var(--neon), rgba(0,0,0,0))',
                    border: `1px solid ${n.active ? 'var(--neon-2)' : 'var(--neon)'}`,
                    boxShadow: `0 0 10px ${n.active ? 'rgba(0,245,212,0.7)' : 'rgba(0,183,255,0.6)'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'var(--mono)', fontWeight: 700, color: '#fff',
                  }}>{n.n[0]}</div>
                  <div className="mono" style={{ fontSize: 9, marginTop: 4, color: 'var(--text-soft)' }}>{n.n}</div>
                </div>
              ))}
            </div>
          </Section>

          {/* Legend / status key */}
          <Section title="STATUS KEY" padded>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { cls: 'cyan',  label: 'streaming', desc: 'Active relay — response in flight' },
                { cls: 'blue',  label: 'ack',        desc: 'Acknowledged — agent accepted task' },
                { cls: 'muted', label: 'closed',     desc: 'Exchange complete — no further msgs' },
                { cls: 'green', label: 'sent',       desc: 'Message sent, awaiting ack' },
                { cls: 'amber', label: 'pending',    desc: 'Queued — not yet dispatched' },
                { cls: 'red',   label: 'failed',     desc: 'Delivery or response failure' },
              ].map(row => (
                <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <StatusBadge status={row.label}/>
                  <span className="mono muted" style={{ fontSize: 10 }}>{row.desc}</span>
                </div>
              ))}
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed var(--line-soft)' }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                  <span className="tag blue" style={{ fontSize: 8, padding: '1px 5px' }}>OUT</span>
                  <span className="mono muted" style={{ fontSize: 10 }}>Message dispatched by Alfred</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <span className="tag green" style={{ fontSize: 8, padding: '1px 5px' }}>IN</span>
                  <span className="mono muted" style={{ fontSize: 10 }}>Message received by Alfred</span>
                </div>
              </div>
            </div>
          </Section>
        </div>

      </div>
    </div>
  );
};
window.Comms = Comms;
