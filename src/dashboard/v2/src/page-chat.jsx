/* Chat page - command center */

const Chat = () => {
  const { AGENTS, SESSIONS } = window.NC_DATA;
  const [activeSession, setActiveSession] = React.useState('s-1042');
  const [activeAgent, setActiveAgent] = React.useState('alfred');
  const [draft, setDraft] = React.useState('');
  const [streaming, setStreaming] = React.useState(true);

  const messages = [
    { kind: 'user', who: 'Mark', t: '22:11:30', body: 'Why is Claude rate-limiting us at 21:50 each night?' },
    { kind: 'event', tone: 'blue', text: 'Alfred routed this to Coder · confidence 0.84' },
    { kind: 'agent', agent: 'coder', model: 'sonnet-4', provider: 'Anthropic API', mem: 2, t: '22:11:34',
      body: 'Pulling logs from the gateway. I see 12 × 429 between 21:48–21:53 — concentrated on /messages with model=opus-4.1.\nMost retries succeeded after 2s. Looks like a queue spike when the dream-cycle pre-warm runs.' },
    { kind: 'event', tone: 'violet', text: 'Temporary agent spawned: Debugger-42 · ttl 15m' },
    { kind: 'event', tone: 'cyan', text: 'Coder used bash_run · grep "429" /var/log/neuroclaw/*.log' },
    { kind: 'agent', agent: 'debugger-42', model: 'sonnet-4', provider: 'VoidAI', mem: 0, t: '22:12:02',
      body: 'Tail confirms a retry storm at 21:50:11 — 14 concurrent /messages calls. Suggest jittering the dream-cycle warmup by ±90s and capping concurrency at 4.' },
    { kind: 'event', tone: 'blue', text: 'Alfred messaged Researcher · "find anthropic guidance on backoff"' },
    { kind: 'agent', agent: 'researcher', model: 'sonnet-4', provider: 'Claude CLI', mem: 1, t: '22:12:35',
      body: 'Anthropic\'s docs recommend exponential backoff with full jitter and a hard concurrency limit per key.\nAdded note to insights/2026-04-29-mcp-latency.md.' },
    { kind: 'agent', agent: 'alfred', model: 'opus-4.1', provider: 'Claude CLI', mem: 3, t: '22:13:10',
      body: 'Plan:\n  1. Jitter dream warmup ±90s\n  2. Cap concurrency=4 on opus calls\n  3. Promote insight as procedural memory\nShall I open T-204 + T-205 and assign to Coder?', streaming: streaming },
  ];

  const session = SESSIONS.find(s => s.id === activeSession);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr 280px', gap: 12, height: 'calc(100vh - 56px - 32px - 32px)', minHeight: 580 }}>
      {/* Session list */}
      <div className="nc-panel glow" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="label-tiny neonc">SESSIONS</span>
          <button className="nc-btn ghost" style={{ padding: '4px 6px' }}><Icon name="plus" size={12}/></button>
        </div>
        <div style={{ padding: 10, borderBottom: '1px solid var(--line-soft)' }}>
          <div style={{ position: 'relative' }}>
            <input className="nc-input" placeholder="filter sessions..." style={{ paddingLeft: 28, fontSize: 11 }}/>
            <Icon name="search" size={12} style={{ position: 'absolute', left: 9, top: 11, color: 'var(--muted)' }}/>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {SESSIONS.map(s => (
            <div key={s.id} onClick={() => setActiveSession(s.id)} style={{
              padding: '10px 14px',
              borderLeft: `2px solid ${activeSession === s.id ? 'var(--neon)' : 'transparent'}`,
              background: activeSession === s.id ? 'rgba(0,183,255,0.08)' : 'transparent',
              borderBottom: '1px dashed rgba(0,183,255,0.06)',
              cursor: 'pointer',
            }}>
              <div className="mono" style={{ fontSize: 11, color: activeSession === s.id ? '#fff' : 'var(--text-soft)', display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                {s.active && <span className="dot cyan pulse" />}
              </div>
              <div className="mono muted" style={{ fontSize: 10, marginTop: 2 }}>
                {s.agents.length} agt · {s.msgs} msg · {s.last}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main thread */}
      <div className="nc-panel glow" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="mono" style={{ fontSize: 12, color: '#fff' }}>{session?.title}</div>
            <div className="mono muted" style={{ fontSize: 10, marginTop: 2, display: 'flex', gap: 10 }}>
              <span><Icon name="agents" size={10} style={{ verticalAlign: -1 }}/> alfred · coder · researcher</span>
              <span>·</span>
              <span>{session?.msgs} msgs</span>
              <span>·</span>
              <span style={{ color: 'var(--neon-2)' }}>● live</span>
            </div>
          </div>
          <select className="nc-select" value={activeAgent} onChange={e => setActiveAgent(e.target.value)} style={{ width: 140 }}>
            {AGENTS.map(a => <option key={a.id} value={a.id}>@{a.name}</option>)}
          </select>
          <span className="tag blue">CLAUDE-CLI · OPUS-4.1</span>
          <button className="nc-btn ghost" style={{ padding: 6 }} title="Inspector"><Icon name="eye" size={13}/></button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
          {messages.map((m, i) => {
            if (m.kind === 'event') {
              const toneCls = m.tone === 'blue' ? 'blue' : m.tone === 'violet' ? 'violet' : 'cyan';
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'center', margin: '14px 0' }}>
                  <div className={`tag ${toneCls}`} style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em' }}>
                    <span className="blink">▸</span> {m.text}
                  </div>
                </div>
              );
            }
            if (m.kind === 'user') {
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
                  <div style={{ maxWidth: '70%', padding: '10px 14px', background: 'linear-gradient(180deg, rgba(0,183,255,0.18), rgba(0,183,255,0.08))', border: '1px solid rgba(0,183,255,0.4)', borderRadius: '8px 8px 2px 8px', boxShadow: '0 0 0 1px rgba(0,183,255,0.1), 0 4px 12px rgba(0,183,255,0.08)' }}>
                    <div style={{ display: 'flex', gap: 8, fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--neon-2)', marginBottom: 4 }}>
                      <span>@{m.who}</span><span className="muted">·</span><span className="muted">{m.t}</span>
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: '#fff', lineHeight: 1.55 }}>{m.body}</div>
                  </div>
                </div>
              );
            }
            // agent
            const isTemp = m.agent.includes('-');
            return (
              <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                <div style={{ width: 32, height: 32, flex: 'none', borderRadius: 6, background: isTemp ? 'radial-gradient(circle, rgba(139,92,246,0.55), rgba(139,92,246,0.1))' : 'radial-gradient(circle, rgba(0,183,255,0.55), rgba(0,183,255,0.05))', border: `1px solid ${isTemp ? 'rgba(139,92,246,0.6)' : 'var(--line-hard)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, marginTop: 2 }}>
                  {m.agent[0].toUpperCase()}
                </div>
                <div style={{ maxWidth: '78%', padding: '10px 14px', background: 'linear-gradient(180deg, rgba(7,17,31,0.9), rgba(2,6,23,0.6))', border: '1px solid var(--line)', borderRadius: '8px 8px 8px 2px' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                    <span className="mono" style={{ color: isTemp ? 'var(--violet)' : 'var(--neon)', fontSize: 11 }}>@{m.agent}</span>
                    <span className="tag muted" style={{ fontSize: 9, padding: '1px 5px' }}>{m.provider}</span>
                    <span className="tag muted" style={{ fontSize: 9, padding: '1px 5px' }}>{m.model}</span>
                    {m.mem > 0 && <span className="tag cyan" style={{ fontSize: 9, padding: '1px 5px' }}>+{m.mem} memory</span>}
                    <span className="mono muted" style={{ fontSize: 10, marginLeft: 'auto' }}>{m.t}</span>
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-soft)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                    {m.body}{m.streaming && <span className="blink neonc">▌</span>}
                  </div>
                  {m.streaming && (
                    <div style={{ marginTop: 8 }}>
                      <span className="stream-dot"></span><span className="stream-dot"></span><span className="stream-dot"></span>
                      <span className="mono muted" style={{ fontSize: 10, marginLeft: 8 }}>streaming · 142 tok/s</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Composer */}
        <div style={{ padding: 12, borderTop: '1px solid var(--line-soft)', background: 'rgba(0,8,20,0.6)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <span className="tag cyan">@{activeAgent}</span>
            <span className="tag blue">claude-cli</span>
            <span className="tag muted">memory: shared</span>
            <span className="tag muted">exec: enabled</span>
            <span style={{ flex: 1 }}/>
            <button className="nc-btn ghost" style={{ padding: '4px 8px', fontSize: 10 }}>+ attach</button>
            <button className="nc-btn ghost" style={{ padding: '4px 8px', fontSize: 10 }}>/slash</button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(2,6,23,0.85)', border: '1px solid var(--line)', borderRadius: 2, padding: '6px 10px' }}>
            <span className="neonc mono" style={{ fontSize: 14 }}>▸</span>
            <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Send command to NeuroClaw — try @Coder fix the retry policy" style={{ flex: 1, background: 'transparent', border: 0, outline: 0, color: '#fff', fontFamily: 'var(--mono)', fontSize: 13 }}/>
            <span className="blink neonc">▌</span>
            <button className="nc-btn primary" style={{ marginLeft: 6 }}><Icon name="send" size={12}/> SEND</button>
          </div>
        </div>
      </div>

      {/* Inspector */}
      <div className="nc-panel glow" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-soft)' }}>
          <div className="label-tiny neonc">INSPECTOR · ROUTE TRACE</div>
        </div>
        <div style={{ padding: 14, flex: 1, overflow: 'auto' }}>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.7 }}>
            <div style={{ color: 'var(--neon)' }}># last route</div>
            <div>intent: <span className="amberc">debug.investigate</span></div>
            <div>scope: <span className="neon2">session</span></div>
            <div>confidence: <span className="greenc">0.84</span></div>
            <div>winner: <span className="neonc">coder</span></div>
            <div>reasons: ['exec','log_read']</div>
          </div>
          <hr className="nc-hr" style={{ margin: '14px 0' }}/>
          <div className="label-tiny" style={{ marginBottom: 8 }}>TOOL CALLS</div>
          {[
            ['bash_run', 'grep 429', '84ms', 'ok'],
            ['vault_search', 'mcp retry', '120ms', 'ok'],
            ['researchlm_search', 'backoff', '1.2s', 'ok'],
          ].map(([t, p, l, s], i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px dashed rgba(0,183,255,0.08)' }}>
              <div className="mono" style={{ fontSize: 11 }}>
                <div className="neonc">{t}</div>
                <div className="muted" style={{ fontSize: 10 }}>{p}</div>
              </div>
              <div className="mono" style={{ fontSize: 10, textAlign: 'right' }}>
                <div className="greenc">{s}</div>
                <div className="muted">{l}</div>
              </div>
            </div>
          ))}
          <hr className="nc-hr" style={{ margin: '14px 0' }}/>
          <div className="label-tiny" style={{ marginBottom: 8 }}>MEMORY USED</div>
          {['M-9930 mcp-retry', 'M-9911 latency-insight', 'M-9931 routing-pref'].map((m, i) => (
            <div key={i} className="mono" style={{ fontSize: 10, padding: '4px 0', color: 'var(--text-soft)' }}>↳ {m}</div>
          ))}
          <hr className="nc-hr" style={{ margin: '14px 0' }}/>
          <div className="label-tiny" style={{ marginBottom: 8 }}>SPAWNED</div>
          <div className="mono violetc" style={{ fontSize: 11 }}>· debugger-42 (ttl 11m)</div>
        </div>
      </div>
    </div>
  );
};

window.Chat = Chat;
