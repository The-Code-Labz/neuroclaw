/* Health — uptime timeline, error breakdown, downtime events, LogAnalyst chat */
const Health = () => {
  const health  = window.NC_DATA.HEALTH;
  const summary = health?.summary;
  const downtime = health?.downtime ?? [];
  const timeline = health?.timeline ?? [];
  const errors   = window.NC_DATA.RECENT_ERRORS ?? [];

  // LogAnalyst mini-chat state
  const [chatMsgs, setChatMsgs] = React.useState([]);
  const [chatInput, setChatInput] = React.useState('');
  const [chatBusy, setChatBusy] = React.useState(false);
  const chatBottomRef = React.useRef(null);

  React.useEffect(() => {
    if (chatBottomRef.current) chatBottomRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [chatMsgs]);

  const sendChat = async () => {
    const msg = chatInput.trim();
    if (!msg || chatBusy) return;
    setChatInput('');
    setChatMsgs(prev => [...prev, { role: 'user', text: msg }]);
    setChatBusy(true);

    try {
      const agents = window.NC_DATA.AGENTS ?? [];
      const analyst = agents.find(a => a.name === 'LogAnalyst');
      const resp = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, agentId: analyst?.id ?? null }),
      });

      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let reply = '';

      setChatMsgs(prev => [...prev, { role: 'assistant', text: '' }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'chunk') {
              reply += ev.content ?? '';
              setChatMsgs(prev => {
                const next = [...prev];
                next[next.length - 1] = { role: 'assistant', text: reply };
                return next;
              });
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      setChatMsgs(prev => [...prev, { role: 'assistant', text: `Error: ${err.message}` }]);
    } finally {
      setChatBusy(false);
    }
  };

  const sevColor = (sev) => sev === 'critical' ? 'var(--danger)' : 'var(--amber)';
  const typeLabel = (t) => ({ heartbeat_gap: 'Heartbeat Gap', error_spike: 'Error Spike', discord_offline: 'Discord Offline', provider_failure: 'Provider Failure' }[t] || t);

  const TimelineBar = () => {
    if (timeline.length === 0) return (
      <div className="grid-bg" style={{ height: 24, border: '1px solid var(--line-soft)', borderRadius: 2, background: 'rgba(0,255,100,0.08)' }}/>
    );
    const tStart = new Date(timeline[0].started_at).getTime();
    const tEnd   = new Date(timeline[timeline.length - 1].ended_at).getTime();
    const total  = tEnd - tStart || 1;
    return (
      <div style={{ display: 'flex', height: 24, gap: 1 }}>
        {timeline.map((seg, i) => {
          const s = new Date(seg.started_at).getTime();
          const e = new Date(seg.ended_at).getTime();
          const pct = ((e - s) / total) * 100;
          const bg = seg.status === 'up' ? 'rgba(0,255,100,0.5)'
                   : seg.status === 'down' ? 'var(--danger)'
                   : 'var(--amber)';
          const tip = seg.status === 'up' ? 'Online'
                    : `${typeLabel(seg.event_type)} — ${seg.duration_minutes ?? '?'}m`;
          return (
            <div key={i} title={tip}
                 style={{ width: `${Math.max(0.5, pct)}%`, background: bg, borderRadius: 1, cursor: 'default' }}/>
          );
        })}
      </div>
    );
  };

  const errorsBySource = React.useMemo(() => {
    const map = {};
    errors.forEach(e => {
      const src = e.source || 'unknown';
      map[src] = (map[src] || 0) + 1;
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([src, count]) => ({ src, count }));
  }, [errors]);
  const maxErrCount = errorsBySource[0]?.count || 1;

  const uptimePct  = summary?.uptime_pct ?? 100;
  const dtCount    = summary?.downtime_count ?? downtime.length;
  const errors24h  = summary?.errors_24h ?? 0;
  const warnings24h = summary?.warnings_24h ?? 0;
  const lastAt     = summary?.last_incident_at;
  const lastLabel  = lastAt ? (() => {
    const diffMin = Math.round((Date.now() - new Date(lastAt).getTime()) / 60000);
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffMin < 1440) return `${Math.round(diffMin / 60)}h ago`;
    return `${Math.round(diffMin / 1440)}d ago`;
  })() : 'None';

  return (
    <div>
      <PageHeader title="Health" subtitle="// uptime · errors · downtime · log analyst" right={
        <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}>
          <Icon name="refresh" size={12}/> Refresh
        </button>
      }/>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 16 }}>
        <StatCard label="UPTIME 7D" value={`${uptimePct}%`} tone={uptimePct >= 99 ? 'green' : uptimePct >= 95 ? 'amber' : 'red'}/>
        <StatCard label="DOWNTIME EVENTS" value={dtCount} tone={dtCount === 0 ? 'cyan' : 'red'}/>
        <StatCard label="ERRORS 24H" value={errors24h} tone={errors24h === 0 ? 'cyan' : 'amber'}/>
        <StatCard label="WARNINGS 24H" value={warnings24h} tone="cyan"/>
        <StatCard label="LAST INCIDENT" value={lastLabel} tone="cyan"/>
      </div>

      <Section title="UPTIME TIMELINE · 7 DAYS">
        <TimelineBar/>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
          <span>7 days ago</span><span>now</span>
        </div>
      </Section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <Section title="ERRORS BY SOURCE">
          {errorsBySource.length === 0 && <div className="mono muted" style={{ fontSize: 11 }}>No errors recorded.</div>}
          {errorsBySource.map(({ src, count }) => (
            <div key={src} style={{ marginBottom: 8 }}>
              <div className="mono" style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span>{src}</span>
                <span style={{ color: 'var(--danger)' }}>{count}</span>
              </div>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${(count / maxErrCount) * 100}%`, background: 'var(--danger)' }}/>
              </div>
            </div>
          ))}
        </Section>

        <Section title="DOWNTIME EVENTS">
          {downtime.length === 0 && <div className="mono muted" style={{ fontSize: 11 }}>No downtime detected.</div>}
          {downtime.slice(0, 8).map((d, i) => (
            <div key={d.id ?? i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <span style={{ color: sevColor(d.severity), fontSize: 9 }}>●</span>
              <div style={{ flex: 1 }}>
                <div className="mono" style={{ fontSize: 11 }}>{typeLabel(d.type)}</div>
                <div className="mono muted" style={{ fontSize: 9 }}>
                  {new Date(d.started_at).toLocaleString()} — {d.duration_minutes ? `${d.duration_minutes}m` : 'ongoing'}
                </div>
              </div>
              <span style={{ background: `${sevColor(d.severity)}22`, color: sevColor(d.severity), padding: '2px 6px', fontSize: 9, borderRadius: 1 }}>
                {d.severity}
              </span>
            </div>
          ))}
        </Section>
      </div>

      <Section title="RECENT ERRORS">
        {errors.length === 0 && <div className="mono muted" style={{ fontSize: 11 }}>No recent errors.</div>}
        {errors.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'var(--mono)' }}>
              <thead>
                <tr style={{ color: 'var(--muted)', fontSize: 9, textTransform: 'uppercase' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px 4px 0', whiteSpace: 'nowrap' }}>Time</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', whiteSpace: 'nowrap' }}>Level</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', whiteSpace: 'nowrap' }}>Source</th>
                  <th style={{ textAlign: 'left', padding: '4px 0' }}>Message</th>
                </tr>
              </thead>
              <tbody>
                {errors.slice(0, 50).map((e, i) => (
                  <tr key={e.id ?? i} style={{ borderTop: '1px solid var(--line-soft)' }}>
                    <td style={{ padding: '4px 8px 4px 0', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                      {new Date(e.created_at).toLocaleString()}
                    </td>
                    <td style={{ padding: '4px 8px', color: e.level === 'error' ? 'var(--danger)' : 'var(--amber)', whiteSpace: 'nowrap' }}>
                      {(e.level || 'ERROR').toUpperCase()}
                    </td>
                    <td style={{ padding: '4px 8px', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                      {e.source || '—'}
                    </td>
                    <td style={{ padding: '4px 0', color: 'var(--text)', overflow: 'hidden', maxWidth: 400 }}>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.message || '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="⬥ LOG ANALYST">
        <div style={{ minHeight: 120, maxHeight: 300, overflowY: 'auto', marginBottom: 8 }}>
          {chatMsgs.length === 0 && (
            <div className="mono muted" style={{ fontSize: 11, padding: '8px 0' }}>
              Ask about errors, downtime patterns, or root causes...
            </div>
          )}
          {chatMsgs.map((m, i) => (
            <div key={i} style={{ borderLeft: `2px solid ${m.role === 'user' ? 'var(--accent)' : 'var(--violet)'}`, padding: '4px 8px', marginBottom: 6, background: 'rgba(255,255,255,0.02)' }}>
              <span className="mono muted" style={{ fontSize: 9 }}>{m.role === 'user' ? 'you' : 'loganalyst'} · </span>
              <span className="mono" style={{ fontSize: 11 }}>{m.text}{m.role === 'assistant' && chatBusy && i === chatMsgs.length - 1 && <span className="blink">▌</span>}</span>
            </div>
          ))}
          <div ref={chatBottomRef}/>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="nc-input"
            style={{ flex: 1, fontSize: 12 }}
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendChat()}
            placeholder="ask about errors, downtime, patterns..."
            disabled={chatBusy}
          />
          <button className="nc-btn" onClick={sendChat} disabled={chatBusy}>
            {chatBusy ? '...' : 'Send'}
          </button>
        </div>
      </Section>
    </div>
  );
};

Object.assign(window, { Health });
