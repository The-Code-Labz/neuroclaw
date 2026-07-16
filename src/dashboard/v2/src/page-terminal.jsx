/* Terminal page — WebSocket-backed agent REPL with tabbed sessions */

const CliToolCard = ({ tool }) => {
  const [copied, setCopied] = React.useState(false);

  const statusDot = {
    available: { char: '●', color: 'var(--accent-2)' },
    building:  { char: '●', color: 'var(--amber)'  },
    planned:   { char: '○', color: 'var(--muted)'  },
  }[tool.status] || { char: '○', color: 'var(--muted)' };

  const dim = tool.status === 'planned';

  const copyInstall = () => {
    if (!tool.install) return;
    navigator.clipboard.writeText(tool.install).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 800);
    });
  };

  const borderColor = dim ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'color-mix(in srgb, var(--accent) 35%, transparent)';

  return (
    <div
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 11,
        lineHeight: 1.7,
        opacity: dim ? 0.55 : 1,
      }}
    >
      {/* Top border */}
      <div style={{ color: borderColor }}>{'╭' + '─'.repeat(50) + '╮'}</div>

      {/* Name + status */}
      <div style={{ display: 'flex' }}>
        <span style={{ color: borderColor }}>│ </span>
        <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{tool.name}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: statusDot.color }}>{statusDot.char} {tool.status}</span>
        <span style={{ color: borderColor }}> │</span>
      </div>

      {/* Tagline */}
      <div style={{ display: 'flex' }}>
        <span style={{ color: borderColor }}>│ </span>
        <span style={{ color: 'var(--text-soft)' }}>{tool.tagline}</span>
        <span style={{ color: borderColor }}>{' │'}</span>
      </div>

      {/* Blank row */}
      <div style={{ display: 'flex' }}>
        <span style={{ color: borderColor }}>│</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: borderColor }}>│</span>
      </div>

      {/* Features */}
      {tool.features.map((f, i) => (
        <div key={i} style={{ display: 'flex' }}>
          <span style={{ color: borderColor }}>│ </span>
          <span style={{ color: 'var(--muted)' }}>· </span>
          <span style={{ color: 'var(--text-soft)' }}>{f}</span>
          <span style={{ color: borderColor }}>{' │'}</span>
        </div>
      ))}

      {/* Blank row before install */}
      <div style={{ display: 'flex' }}>
        <span style={{ color: borderColor }}>│</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: borderColor }}>│</span>
      </div>

      {/* Install command (only if present) */}
      {tool.install && (
        <div
          style={{ display: 'flex', cursor: 'pointer' }}
          onClick={copyInstall}
          title="Click to copy"
        >
          <span style={{ color: borderColor }}>│ </span>
          <span style={{ color: copied ? 'var(--accent-2)' : 'var(--accent)', transition: 'color 0.15s' }}>
            $ {tool.install}
          </span>
          <span style={{ color: borderColor }}>{' │'}</span>
        </div>
      )}

      {/* Bottom border */}
      <div style={{ color: borderColor }}>{'╰' + '─'.repeat(50) + '╯'}</div>
    </div>
  );
};

const STATUS_FILTERS = ['all', 'live', 'building', 'planned'];

const CliToolsPanel = () => {
  const [tools, setTools]     = React.useState([]);
  const [filter, setFilter]   = React.useState('all');
  const [error, setError]     = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const load = () => {
    setError(null);
    setLoading(true);
    fetch('/api/cli-tools', { credentials: 'same-origin' })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => { setTools(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => { setError('Failed to load tools'); setLoading(false); });
  };

  React.useEffect(() => { load(); }, []);

  const visible = filter === 'all' ? tools : tools.filter(t => t.status === filter);

  return (
    <div style={{ padding: '14px 16px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {STATUS_FILTERS.map(f => (
          <span key={f} onClick={() => setFilter(f)}
            style={{
              padding: '2px 10px', borderRadius: 3, cursor: 'pointer',
              fontFamily: 'var(--mono)', fontSize: 10,
              background: filter === f ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'rgba(255,255,255,0.04)',
              color: filter === f ? 'var(--accent)' : 'var(--muted)',
              border: filter === f ? '1px solid color-mix(in srgb, var(--accent) 30%, transparent)' : '1px solid var(--line-soft)',
            }}>
            {f}
          </span>
        ))}
        <span className="mono muted" style={{ marginLeft: 'auto', fontSize: 10, alignSelf: 'center' }}>
          {loading ? '…' : `${visible.length} tool${visible.length !== 1 ? 's' : ''}`}
        </span>
      </div>
      {error && (
        <div style={{ color: 'var(--danger)', fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 12 }}>
          {error} — <span style={{ cursor: 'pointer', color: 'var(--accent)' }} onClick={load}>retry</span>
        </div>
      )}
      {!loading && visible.length === 0 && !error && (
        <div className="mono muted" style={{ fontSize: 11, paddingTop: 8 }}>
          // no {filter === 'all' ? '' : filter + ' '}tools
        </div>
      )}
      {visible.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 }}>
          {visible.map(tool => (
            <CliToolCard key={tool.id} tool={{
              ...tool,
              tagline: tool.description,
              features: (() => { try { return JSON.parse(tool.features || '[]'); } catch { return []; } })(),
              install: tool.install_command,
            }} />
          ))}
        </div>
      )}
    </div>
  );
};

const InstallAppButton = () => {
  const [showModal, setShowModal] = React.useState(false);

  const install = () => {
    if (window.__pwaInstallPrompt) {
      window.__pwaInstallPrompt.prompt();
      window.__pwaInstallPrompt.userChoice.then(() => { window.__pwaInstallPrompt = null; });
    } else {
      setShowModal(true);
    }
  };

  return (
    <>
      <div onClick={install}
        style={{
          padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer',
          color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)', borderRadius: 3,
          background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
        }}>
        ⬇ install app
      </div>
      {showModal && (
        <div className="modal-back" onClick={() => setShowModal(false)}>
          <div className="nc-panel glow" onClick={e => e.stopPropagation()} style={{ width: 420 }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)' }}>
              <div className="label-tiny neonc">INSTALL NEUROCLAW PWA</div>
            </div>
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, fontFamily: 'var(--mono)' }}>
              <div>
                <div className="label" style={{ marginBottom: 4 }}>Chrome / Edge</div>
                <div className="muted" style={{ fontSize: 11 }}>Click the install icon (⊕) in the address bar, or open browser Settings → Install NeuroClaw.</div>
              </div>
              <div>
                <div className="label" style={{ marginBottom: 4 }}>Safari — iOS</div>
                <div className="muted" style={{ fontSize: 11 }}>Tap the Share icon → Add to Home Screen.</div>
              </div>
              <div>
                <div className="label" style={{ marginBottom: 4 }}>Safari — macOS</div>
                <div className="muted" style={{ fontSize: 11 }}>File menu → Add to Dock.</div>
              </div>
              <div style={{ paddingTop: 4, borderTop: '1px solid var(--line-soft)', color: 'var(--muted)', fontSize: 10 }}>
                Once installed, open the app on any device and use Remote Control to connect.
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

const makeTabId = () => Math.random().toString(36).slice(2, 8);

const TerminalMessage = ({ msg, agentName }) => {
  if (msg.role === 'user') {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 10 }}>
        <span style={{ color: 'var(--accent-2)', flexShrink: 0 }}>you</span>
        <span className="muted" style={{ fontSize: 10 }}>{msg.time} ›</span>
        <span style={{ color: 'var(--text)' }}>{msg.content}</span>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 4, marginBottom: 6 }}>
      <div>
        <span style={{ color: 'var(--violet)' }}>{agentName.toLowerCase()}</span>
        <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>{msg.time}</span>
        {msg.routeTo && (
          <span className="muted" style={{ fontSize: 10 }}> → {msg.routeTo.toLowerCase()}</span>
        )}
      </div>
      {(msg.toolCalls || []).map((label, i) => (
        <div key={i} style={{ paddingLeft: 12, color: 'var(--muted)', fontSize: 11, lineHeight: 1.7 }}>
          <span style={{ opacity: 0.5, marginRight: 4 }}>⟳</span>{label}
        </div>
      ))}
      {!msg.content && !msg.done && (msg.toolCalls || []).length === 0 && (
        <div style={{ paddingLeft: 12, color: 'var(--muted)', fontSize: 11 }}>
          <span style={{ marginRight: 4 }}>⟳</span>thinking...
        </div>
      )}
      {msg.content && (
        <div style={{ paddingLeft: 12, color: msg.error ? 'var(--danger)' : 'var(--text-soft)', lineHeight: 1.6, marginTop: 3, whiteSpace: 'pre-wrap' }}>
          {msg.error ? `✕ ${msg.error}` : msg.content}
          {!msg.done && !msg.error && <span className="blink neonc" style={{ marginLeft: 4 }}>▌</span>}
        </div>
      )}
    </div>
  );
};

const TerminalTab = ({ tabId, agentId, agentName, sessionId, remoteUrl, remoteToken, active, onWsStateChange, onSessionChange }) => {
  const [messages,   setMessages]   = React.useState([]);
  const [draft,      setDraft]      = React.useState('');
  const [history,    setHistory]    = React.useState([]);
  const [historyIdx, setHistoryIdx] = React.useState(-1);
  const [wsState,        setWsState]        = React.useState('connecting');
  const [activeSessionId, setActiveSessionId] = React.useState(null);
  const wsRef     = React.useRef(null);
  const inputRef  = React.useRef(null);
  const scrollRef = React.useRef(null);

  const setWs = (state) => {
    setWsState(state);
    onWsStateChange(state);
  };

  React.useEffect(() => {
    const nextSession = activeSessionId || sessionId;
    if (active && nextSession) onSessionChange?.(nextSession);
  }, [active, activeSessionId, sessionId, onSessionChange]);

  React.useEffect(() => {
    const host  = remoteUrl ? new URL(remoteUrl).host : location.host;
    const proto = (remoteUrl ? remoteUrl.startsWith('https:') : location.protocol === 'https:') ? 'wss' : 'ws';
    const sessionParam = (sessionId || activeSessionId) ? `&session=${encodeURIComponent(sessionId || activeSessionId)}` : '';
    const tokenParam   = remoteToken ? `&token=${encodeURIComponent(remoteToken)}` : '';
    const url = `${proto}://${host}/api/terminal?agent=${agentId}${sessionParam}${tokenParam}`;
    let destroyed = false;
    let retryDelay = 1000;
    let ws;

    let inFlight = false;

    const connect = () => {
      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => { setWs('open'); retryDelay = 1000; };

      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === 'session') { setActiveSessionId(msg.sessionId); return; }
        if (msg.type === 'pong' || msg.type === 'agent') return;

        if (msg.type === 'route') {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'agent' || last.done) return prev;
            return [...prev.slice(0, -1), { ...last, routeTo: msg.to }];
          });
          return;
        }
        if (msg.type === 'tool') {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'agent' || last.done) return prev;
            return [...prev.slice(0, -1), { ...last, toolCalls: [...(last.toolCalls || []), msg.label] }];
          });
          return;
        }
        if (msg.type === 'chunk') {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'agent' || last.done) return prev;
            return [...prev.slice(0, -1), { ...last, content: (last.content || '') + msg.content }];
          });
          return;
        }
        if (msg.type === 'done') {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'agent') return prev;
            return [...prev.slice(0, -1), { ...last, done: true }];
          });
          return;
        }
        if (msg.type === 'error') {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'agent') return prev;
            return [...prev.slice(0, -1), { ...last, error: msg.message, done: true }];
          });
        }
      };

      ws.onclose = () => {
        if (destroyed) return;
        inFlight = false;
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'agent' && !last.done) {
            return [...prev.slice(0, -1), { ...last, done: true, error: 'disconnected' }];
          }
          return prev;
        });
        setWs('reconnecting');
        setTimeout(() => {
          if (!destroyed) { retryDelay = Math.min(retryDelay * 2, 8000); connect(); }
        }, retryDelay);
      };

      ws.onerror = () => setWs('error');
    };

    connect();
    return () => { destroyed = true; ws?.close(); wsRef.current = null; };
  }, [agentId]);

  React.useEffect(() => {
    if (active && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, active]);

  React.useEffect(() => {
    if (active && inputRef.current) inputRef.current.focus();
  }, [active]);

  const sendMessage = () => {
    const content = draft.trim();
    if (!content || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'message', content }));
    // in-flight guard is on the backend; UI disables input while waiting
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    setMessages(prev => [
      ...prev,
      { id: makeTabId(), role: 'user',  content, time },
      { id: makeTabId(), role: 'agent', content: '', toolCalls: [], routeTo: null, done: false, error: null, time },
    ]);
    setHistory(h => [content, ...h].slice(0, 100));
    setHistoryIdx(-1);
    setDraft('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(historyIdx + 1, history.length - 1);
      setHistoryIdx(next);
      if (history[next] !== undefined) setDraft(history[next]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.max(historyIdx - 1, -1);
      setHistoryIdx(next);
      setDraft(next === -1 ? '' : (history[next] ?? ''));
    }
  };

  const waiting = messages.length > 0 && messages[messages.length - 1].role === 'agent' && !messages[messages.length - 1].done;
  const dotColor = wsState === 'open' ? 'var(--accent-2)' : (wsState === 'connecting' || wsState === 'reconnecting') ? 'var(--amber)' : 'var(--muted)';
  const placeholder = waiting ? 'waiting...' : wsState !== 'open' ? `${wsState}...` : `message ${agentName.toLowerCase()}...`;

  return (
    <div style={{ display: active ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ padding: '6px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0, display: 'inline-block' }} />
        <span className="mono muted" style={{ fontSize: 10 }}>
          {(activeSessionId || sessionId) ? `session ${(activeSessionId || sessionId).slice(0, 8)}` : 'connecting...'}
        </span>
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', fontFamily: 'var(--mono)', fontSize: 12, display: 'flex', flexDirection: 'column' }}>
        <div className="muted" style={{ fontSize: 10, marginBottom: 10, letterSpacing: '0.08em' }}>
          // NEUROCLAW TERMINAL · {agentName.toLowerCase()}
        </div>
        {messages.map(msg => <TerminalMessage key={msg.id} msg={msg} agentName={agentName} />)}
        {messages.length === 0 && wsState === 'open' && (
          <div className="muted" style={{ fontSize: 11 }}>
            Connected to {agentName}. Type a message below, or try <span style={{ color: 'var(--accent)' }}>@AgentName</span> to delegate.
          </div>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--line)', padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(0,8,20,0.6)', flexShrink: 0 }}>
        <span style={{ color: 'var(--accent)', fontSize: 14 }}>›</span>
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={waiting || wsState !== 'open'}
          placeholder={placeholder}
          style={{ flex: 1, background: 'transparent', border: 0, outline: 0, color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12 }}
        />
        <span className="mono muted hide-mobile" style={{ fontSize: 10 }}>↑↓ history · ↵ send</span>
      </div>
    </div>
  );
};

const AgentPickerModal = ({ onPick, onClose }) => {
  const agents = (window.NC_DATA.AGENTS || []).filter(a => a.status === 'active' || a.status === 'live');
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="nc-panel glow" onClick={e => e.stopPropagation()} style={{ width: 400 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)' }}>
          <div className="label-tiny neonc">NEW TERMINAL TAB · SELECT AGENT</div>
        </div>
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {agents.length === 0 && (
            <div className="mono muted" style={{ padding: '18px 16px', fontSize: 11 }}>// no active agents</div>
          )}
          {agents.map(a => (
            <div key={a.id}
              onClick={() => { onPick(a); onClose(); }}
              className="mono"
              style={{ padding: '10px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)', fontSize: 12 }}
              onMouseOver={e => e.currentTarget.style.background = 'color-mix(in srgb, var(--accent) 8%, transparent)'}
              onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
              <span className="dot cyan pulse" />
              <span style={{ flex: 1 }}>{a.name}</span>
              <span className="muted" style={{ fontSize: 10 }}>{a.role || 'agent'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const SessionPicker = ({ onClose, onResume }) => {
  const server = window.__ncServer;
  const [sessions, setSessions] = React.useState([]);
  const [loading,  setLoading]  = React.useState(true);
  const [error,    setError]    = React.useState(null);

  const baseUrl   = server && server !== 'local' ? server.url   : '';
  const authToken = server && server !== 'local' ? server.token : null;

  React.useEffect(() => {
    const url     = baseUrl ? `${baseUrl}/api/sessions` : '/api/sessions';
    const headers = authToken ? { 'x-dashboard-token': authToken } : {};
    fetch(url, { credentials: baseUrl ? 'omit' : 'same-origin', headers })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => { setSessions(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => { setError('Failed to load sessions'); setLoading(false); });
  }, []);

  const relativeTime = (iso) => {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60)   return `${Math.round(diff)}s ago`;
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    return `${Math.round(diff / 3600)}h ago`;
  };

  const isActive = (s) => (Date.now() - new Date(s.updated_at).getTime()) < 5 * 60 * 1000;

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="nc-panel glow" onClick={e => e.stopPropagation()}
        style={{ width: 480, maxHeight: '75vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="label-tiny neonc">
            SESSIONS{baseUrl ? ` · ${new URL(baseUrl).hostname}` : ''}
          </div>
          {baseUrl && (
            <span className="muted mono" style={{ fontSize: 9, cursor: 'pointer' }}
              onClick={() => { localStorage.removeItem('nclaw_server'); window.__ncServer = null; window.location.reload(); }}>
              change server
            </span>
          )}
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading && <div className="mono muted" style={{ padding: '18px 16px', fontSize: 11 }}>// loading…</div>}
          {error   && <div style={{ padding: '18px 16px', color: 'var(--danger)', fontFamily: 'var(--mono)', fontSize: 11 }}>{error}</div>}
          {!loading && !error && sessions.length === 0 && (
            <div className="mono muted" style={{ padding: '18px 16px', fontSize: 11 }}>// no sessions yet</div>
          )}
          {sessions.map(s => (
            <div key={s.id} className="mono"
              style={{ padding: '10px 16px', borderBottom: '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.title || s.id.slice(0, 12) + '…'}
                </div>
                <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
                  {s.message_count} msg · {relativeTime(s.updated_at)}
                </div>
              </div>
              {isActive(s) && (
                <span style={{ padding: '2px 6px', background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)', borderRadius: 3, fontSize: 9 }}>active</span>
              )}
              <button className="nc-btn" onClick={() => onResume(s)}
                style={{ padding: '4px 10px', fontSize: 10, flexShrink: 0 }}>
                Resume
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const Terminal = () => {
  const [tabs, setTabs] = React.useState(() => {
    const agents = window.NC_DATA.AGENTS || [];
    const agent = agents.find(a => a.name === 'A.S.A.G.I' && (a.status === 'active' || a.status === 'live'))
      ?? agents.find(a => a.name === 'Alfred' && (a.status === 'active' || a.status === 'live'))
      ?? agents.find(a => a.status === 'active' || a.status === 'live');
    return agent ? [{ id: makeTabId(), agentId: agent.id, agentName: agent.name }] : [];
  });
  const [activeTabId, setActiveTabId] = React.useState(() => tabs[0]?.id ?? null);
  const [pickerOpen,  setPickerOpen]  = React.useState(false);
  const [sessionPickerOpen, setSessionPickerOpen] = React.useState(false);
  const [wsStates,    setWsStates]    = React.useState({});
  const activeTab = tabs.find(t => t.id === activeTabId);
  const activeAgent = activeTab
    ? (window.NC_DATA.AGENTS || []).find(a => (a._raw?.id || a.id) === activeTab.agentId || a.name === activeTab.agentName)
    : null;

  // Once live agents load via nc-data-tick, upgrade the default tab to A.S.A.G.I
  // if it opened on a fallback agent (live data wasn't ready at mount time).
  React.useEffect(() => {
    const onTick = () => {
      const agents = window.NC_DATA.AGENTS || [];
      const asagi = agents.find(a => a.name === 'A.S.A.G.I' && (a.status === 'active' || a.status === 'live'));
      if (!asagi) return;
      setTabs(prev => {
        if (prev.length !== 1 || prev[0].agentName === 'A.S.A.G.I') return prev;
        const newTab = { ...prev[0], agentId: asagi.id, agentName: asagi.name };
        setActiveTabId(newTab.id);
        return [newTab];
      });
    };
    window.addEventListener('nc-data-tick', onTick);
    return () => window.removeEventListener('nc-data-tick', onTick);
  }, []);

  const addTab = (agent, opts = {}) => {
    const tab = {
      id: makeTabId(),
      agentId: agent.id,
      agentName: agent.name,
      sessionId:   opts.sessionId   ?? null,
      remoteUrl:   opts.remoteUrl   ?? null,
      remoteToken: opts.remoteToken ?? null,
    };
    setTabs(prev => [...prev, tab]);
    setActiveTabId(tab.id);
  };

  const resumeSession = (session) => {
    const server = window.__ncServer;
    const agents = window.NC_DATA.AGENTS || [];
    const agent = (session.agent_id && agents.find(a => a.id === session.agent_id))
      ?? agents.find(a => a.name === 'Alfred' && (a.status === 'active' || a.status === 'live'))
      ?? agents.find(a => a.status === 'active' || a.status === 'live');
    if (!agent) return;
    addTab(agent, {
      sessionId:   session.id,
      remoteUrl:   server && server !== 'local' ? server.url   : null,
      remoteToken: server && server !== 'local' ? server.token : null,
    });
    setSessionPickerOpen(false);
  };

  const closeTab = (tabId, e) => {
    e.stopPropagation();
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      if (activeTabId === tabId && next.length > 0) setActiveTabId(next[next.length - 1].id);
      return next;
    });
    setWsStates(prev => { const s = { ...prev }; delete s[tabId]; return s; });
  };

  const dotColor = (tabId) => {
    const s = wsStates[tabId] ?? 'connecting';
    return s === 'open' ? 'var(--accent-2)' : (s === 'connecting' || s === 'reconnecting') ? 'var(--amber)' : 'var(--muted)';
  };

  React.useEffect(() => {
    if (!activeTab) {
      if (window.NC_STATUS_CONTEXT?.source === 'terminal') {
        window.NC_STATUS_CONTEXT = null;
        window.dispatchEvent(new CustomEvent('nc-status-context'));
      }
      return;
    }
    window.NC_STATUS_CONTEXT = {
      source:     'terminal',
      mode:       'terminal',
      agentId:    activeTab.agentId,
      agentName:  activeAgent?.name || activeTab.agentName,
      agentRole:  activeAgent?.role,
      model:      activeAgent?.model,
      sessionId:  activeTab.sessionId,
    };
    window.dispatchEvent(new CustomEvent('nc-status-context'));
    return () => {
      if (window.NC_STATUS_CONTEXT?.source === 'terminal') {
        window.NC_STATUS_CONTEXT = null;
        window.dispatchEvent(new CustomEvent('nc-status-context'));
      }
    };
  }, [activeTab?.id, activeTab?.agentId, activeTab?.agentName, activeTab?.sessionId, activeAgent?.name, activeAgent?.role, activeAgent?.model, wsStates[activeTab?.id]]);

  return (
    <>
      <PageHeader title="Terminal" subtitle="WebSocket agent REPL · nrclw CLI tools" />

      {/* Outer container: full height, flex column */}
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 140px)', background: '#020617', borderRadius: 4, border: '1px solid var(--line)', overflow: 'hidden' }}>

        {/* TOP HALF — REPL */}
        <div style={{ display: 'flex', flexDirection: 'column', flex: '0 0 50%', minHeight: 0, borderBottom: '1px solid var(--line)' }}>
          {/* Tab bar */}
          <div style={{ background: '#060f1e', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'stretch', flexShrink: 0, overflowX: 'auto' }}>
            {tabs.map(tab => (
              <div key={tab.id} onClick={() => setActiveTabId(tab.id)}
                style={{ padding: '8px 14px', borderBottom: `2px solid ${activeTabId === tab.id ? 'var(--accent)' : 'transparent'}`, color: activeTabId === tab.id ? 'var(--text)' : 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor(tab.id), display: 'inline-block', flexShrink: 0 }} />
                {tab.agentName.toLowerCase()}
                {tabs.length > 1 && (
                  <span onClick={e => closeTab(tab.id, e)} style={{ marginLeft: 4, opacity: 0.4, cursor: 'pointer', fontSize: 10, lineHeight: 1 }}>×</span>
                )}
              </div>
            ))}
            <div onClick={() => setPickerOpen(true)}
              style={{ padding: '8px 12px', color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: 11, display: 'flex', alignItems: 'center', cursor: 'pointer', borderBottom: '2px solid transparent' }}>
              + new
            </div>
            {window.__ncServer && (
              <div onClick={() => setSessionPickerOpen(true)}
                style={{ padding: '8px 12px', color: 'var(--accent-2)', fontFamily: 'var(--mono)', fontSize: 11, display: 'flex', alignItems: 'center', cursor: 'pointer', borderBottom: '2px solid transparent' }}>
                sessions
              </div>
            )}
            <div style={{ marginLeft: 'auto', padding: '0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="mono muted hide-mobile" style={{ fontSize: 10 }}>⌘K cmd</span>
              <InstallAppButton />
            </div>
          </div>

          {/* Tab content */}
          {tabs.length === 0 ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div className="mono muted" style={{ fontSize: 12, textAlign: 'center' }}>
                <div>// no tabs open</div>
                <button className="nc-btn" style={{ marginTop: 12 }} onClick={() => setPickerOpen(true)}>+ new tab</button>
              </div>
            </div>
          ) : (
            tabs.map(tab => (
              <TerminalTab
                key={tab.id}
                tabId={tab.id}
                agentId={tab.agentId}
                agentName={tab.agentName}
                sessionId={tab.sessionId}
                remoteUrl={tab.remoteUrl}
                remoteToken={tab.remoteToken}
                active={activeTabId === tab.id}
                onWsStateChange={(state) => setWsStates(prev => ({ ...prev, [tab.id]: state }))}
                onSessionChange={(sessionId) => setTabs(prev => prev.map(t => (
                  t.id === tab.id && t.sessionId !== sessionId ? { ...t, sessionId } : t
                )))}
              />
            ))
          )}
        </div>

        {/* DIVIDER */}
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', height: 28, background: '#060f1e', borderBottom: '1px solid var(--line-soft)' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent-2)', letterSpacing: '0.06em' }}>› nrclw --list-tools</span>
          <div style={{ flex: 1, height: 1, background: 'var(--line-soft)' }} />
        </div>

        {/* BOTTOM HALF — CLI Tools Panel */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <CliToolsPanel />
        </div>
      </div>

      {pickerOpen && <AgentPickerModal onPick={addTab} onClose={() => setPickerOpen(false)} />}
      {sessionPickerOpen && (
        <SessionPicker
          onClose={() => setSessionPickerOpen(false)}
          onResume={resumeSession}
        />
      )}
    </>
  );
};

window.Terminal = Terminal;
