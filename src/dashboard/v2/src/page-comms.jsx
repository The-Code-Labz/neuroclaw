/* Comms (live-wired) — agent-to-agent relay log + user injection + notes.
 *
 * v2.x adds:
 *   - Composer: user can send a message to any active agent. Backend runs the
 *     recipient via alfred.chatStream so they actually receive and respond.
 *     Posts to POST /api/agent-messages with from_name='User'.
 *   - Notes: private (UI annotations) or shared (injected into agent system
 *     prompts). CRUD against /api/comms/notes.
 *   - SSE: subscribes to /api/hive/stream and forces a refresh on relevant
 *     events so user sends + agent replies appear without waiting 15s.
 */

/**
 * Convert an ISO timestamp or HH:MM:SS string to a human-readable relative
 * time. If the timestamp is from today it shows "Xs ago / Xm ago / Xh ago".
 */
const relTime = (raw) => {
  if (!raw) return '—';
  try {
    const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (isNaN(diff) || diff < 0) return '—';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch {
    return '—';
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
    delivered: { cls: 'blue',   label: 'delivered' },
    responded: { cls: 'green',  label: 'responded' },
    failed:    { cls: 'red',    label: 'failed' },
  };
  const { cls, label } = map[status] || { cls: '', label: status };
  return <span className={`tag ${cls}`} style={{ fontSize: 9, padding: '1px 7px' }}>{label}</span>;
};

/** Small inline badge classifying the row's source. User-originated rows get
 *  their own pink "USER" tag so they're easy to spot in the relay log. */
const DirDot = ({ from, to }) => {
  const fromLower = (from || '').toLowerCase();
  if (fromLower === 'user') {
    return (
      <span className="tag" style={{
        fontSize: 8, padding: '1px 5px', letterSpacing: '0.08em',
        background: 'rgba(244, 63, 94, 0.15)', color: '#f43f5e',
        border: '1px solid rgba(244, 63, 94, 0.4)',
      }}>USER</span>
    );
  }
  // "inbound" = something replied to Alfred/orchestrator; "outbound" = Alfred sent
  const isOut = fromLower === 'alfred';
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
      {relTime(c._raw?.created_at)}
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
      {c.resp && c.resp !== '—' && (
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

// ── Composer: user → agent ─────────────────────────────────────────────────

const CommsComposer = ({ agents, onSent }) => {
  const [recipient, setRecipient] = React.useState('');
  const [text, setText] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [err, setErr] = React.useState(null);

  // Default recipient: first active agent (or Alfred if present)
  React.useEffect(() => {
    if (recipient || agents.length === 0) return;
    const alfred = agents.find(a => (a.name || '').toLowerCase() === 'alfred' && a.status === 'live');
    const firstActive = agents.find(a => a.status === 'live');
    setRecipient((alfred || firstActive || agents[0])?.name || '');
  }, [agents, recipient]);

  const send = async () => {
    setErr(null);
    const body = text.trim();
    if (!body)      { setErr('message is empty'); return; }
    if (!recipient) { setErr('pick a recipient');  return; }
    setSending(true);
    try {
      await window.NC_API.post('/api/agent-messages', { to: recipient, message: body });
      setText('');
      onSent?.();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e) => {
    // Cmd/Ctrl+Enter sends; plain Enter inserts a newline.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
  };

  return (
    <Section title="SEND MESSAGE  ·  user → agent" padded>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="mono muted" style={{ fontSize: 9, letterSpacing: '0.14em' }}>TO</span>
          <select
            className="nc-input"
            value={recipient}
            onChange={e => setRecipient(e.target.value)}
            style={{ minWidth: 180, fontSize: 11 }}
          >
            {agents.length === 0 && <option value="">no agents</option>}
            {agents.length > 0 && (
              <option value="*">@all — broadcast to all agents</option>
            )}
            {agents.map(a => (
              <option key={a.id} value={a.name} disabled={a.status !== 'live'}>
                @{a.name}{a.status !== 'live' ? ' (idle)' : ''}{a.role ? ` · ${a.role}` : ''}
              </option>
            ))}
          </select>
          <span className="mono muted" style={{ fontSize: 9 }}>
            ⌘/Ctrl+Enter to send
          </span>
          {recipient === '*' && (
            <span
              className="tag"
              style={{
                fontSize: 9, padding: '1px 6px', letterSpacing: '0.08em',
                background: 'rgba(244, 63, 94, 0.15)', color: '#f43f5e',
                border: '1px solid rgba(244, 63, 94, 0.4)',
              }}
              title="Every active agent will receive this message and reply in turn. Each later agent sees prior replies and can build on them."
            >
              BROADCAST
            </span>
          )}
        </div>
        <textarea
          className="nc-input mono"
          placeholder={recipient === '*'
            ? '// broadcast — every active agent runs this in turn; each sees prior replies and can build on them'
            : '// message text — gets injected as a real comms turn; recipient runs and replies'}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          style={{ fontSize: 12, lineHeight: 1.5, resize: 'vertical', width: '100%' }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="mono" style={{ fontSize: 10, color: err ? '#fb3b5f' : 'var(--muted)' }}>
            {err ? `// ${err}` : sending ? '// dispatching…' : `// ${text.length} chars`}
          </span>
          <button className="nc-btn" onClick={send} disabled={sending || !text.trim() || !recipient}>
            <Icon name="send" size={12}/> {sending ? 'sending…' : 'Send'}
          </button>
        </div>
      </div>
    </Section>
  );
};

// ── Notes panel ────────────────────────────────────────────────────────────

const NoteItem = ({ note, onDelete, onTogglePin, onToggleVisibility }) => {
  const isShared = note.visibility === 'shared';
  return (
    <div
      className="mono"
      style={{
        padding: '8px 10px',
        borderBottom: '1px dashed rgba(0,183,255,0.07)',
        fontSize: 11,
        background: note.pinned ? 'rgba(250, 204, 21, 0.05)' : 'transparent',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`tag ${isShared ? 'cyan' : 'muted'}`} style={{ fontSize: 8, padding: '1px 5px' }}>
            {isShared ? 'SHARED' : 'PRIVATE'}
          </span>
          {note.pinned ? <span style={{ fontSize: 11 }}>📌</span> : null}
          <span className="muted" style={{ fontSize: 9 }}>{note.author}</span>
          <span className="muted" style={{ fontSize: 9 }}>· {relTime(note.created_at)}</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className="nc-btn"
            style={{ fontSize: 9, padding: '2px 6px' }}
            title={note.pinned ? 'unpin' : 'pin'}
            onClick={() => onTogglePin(note)}
          >{note.pinned ? 'unpin' : 'pin'}</button>
          <button
            className="nc-btn"
            style={{ fontSize: 9, padding: '2px 6px' }}
            title={isShared ? 'make private' : 'share with agents'}
            onClick={() => onToggleVisibility(note)}
          >{isShared ? '→ private' : '→ shared'}</button>
          <button
            className="nc-btn"
            style={{ fontSize: 9, padding: '2px 6px', color: '#fb3b5f' }}
            title="delete"
            onClick={() => onDelete(note)}
          >×</button>
        </div>
      </div>
      <div style={{ color: 'var(--text)', lineHeight: 1.5, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
        {note.body}
      </div>
    </div>
  );
};

const NotesPanel = ({ notes, onChanged }) => {
  const [text, setText] = React.useState('');
  const [shared, setShared] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const [filter, setFilter] = React.useState('all'); // all | private | shared

  const create = async () => {
    setErr(null);
    const body = text.trim();
    if (!body) { setErr('note is empty'); return; }
    setBusy(true);
    try {
      await window.NC_API.post('/api/comms/notes', {
        body,
        visibility: shared ? 'shared' : 'private',
        pinned,
      });
      setText('');
      setPinned(false);
      onChanged?.();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (note) => {
    try {
      await window.NC_API.del(`/api/comms/notes/${note.id}`);
      onChanged?.();
    } catch (e) { setErr(e.message || String(e)); }
  };
  const onTogglePin = async (note) => {
    try {
      const patch = { pinned: !note.pinned };
      // Pinning makes a note visible to agents; unpinning keeps current visibility.
      if (patch.pinned) patch.visibility = 'shared';
      await window.NC_API.patch(`/api/comms/notes/${note.id}`, patch);
      onChanged?.();
    } catch (e) { setErr(e.message || String(e)); }
  };
  const onToggleVisibility = async (note) => {
    try {
      await window.NC_API.patch(`/api/comms/notes/${note.id}`, {
        visibility: note.visibility === 'shared' ? 'private' : 'shared',
      });
      onChanged?.();
    } catch (e) { setErr(e.message || String(e)); }
  };

  const filtered = notes.filter(n => filter === 'all' ? true : n.visibility === filter);

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); create(); }
  };

  return (
    <Section
      title={`NOTES  ·  ${notes.length} total`}
      padded={false}
      right={
        <div style={{ display: 'flex', gap: 4 }}>
          {['all', 'private', 'shared'].map(f => (
            <span
              key={f}
              onClick={() => setFilter(f)}
              className={`tag ${filter === f ? (f === 'shared' ? 'cyan' : f === 'private' ? 'muted' : 'blue') : ''}`}
              style={{ cursor: 'pointer', fontSize: 9, padding: '1px 6px' }}
            >{f.toUpperCase()}</span>
          ))}
        </div>
      }
    >
      {/* Composer */}
      <div style={{ padding: 10, borderBottom: '1px solid var(--line-soft)' }}>
        <textarea
          className="nc-input mono"
          placeholder="// jot a note — private (you) or shared (injected into agent prompts)"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          style={{ fontSize: 11, lineHeight: 1.5, resize: 'vertical', width: '100%', marginBottom: 6 }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="mono" style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} />
              shared with agents
            </label>
            <label className="mono" style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={pinned} onChange={e => {
                setPinned(e.target.checked);
                if (e.target.checked) setShared(true);
              }} />
              📌 pinned
            </label>
            {err && <span className="mono" style={{ fontSize: 10, color: '#fb3b5f' }}>// {err}</span>}
          </div>
          <button className="nc-btn" onClick={create} disabled={busy || !text.trim()}>
            <Icon name="plus" size={12}/> {busy ? 'saving…' : 'Add note'}
          </button>
        </div>
      </div>

      {/* List */}
      {filtered.length === 0 && (
        <div className="mono muted" style={{ padding: 20, textAlign: 'center', fontSize: 11 }}>
          // no notes
        </div>
      )}
      {filtered.map(n => (
        <NoteItem key={n.id} note={n}
          onDelete={onDelete}
          onTogglePin={onTogglePin}
          onToggleVisibility={onToggleVisibility}
        />
      ))}
    </Section>
  );
};

// ── Notifications panel (agent → user messages) ─────────────────────────────

const KindBadge = ({ kind }) => {
  const map = {
    info:     { cls: 'blue',  label: 'INFO' },
    question: { cls: 'cyan',  label: 'QUESTION' },
    alert:    { cls: 'amber', label: 'ALERT' },
    update:   { cls: 'green', label: 'UPDATE' },
  };
  const { cls, label } = map[kind] || { cls: '', label: kind?.toUpperCase() || 'INFO' };
  return <span className={`tag ${cls}`} style={{ fontSize: 8, padding: '1px 5px' }}>{label}</span>;
};

const NotificationItem = ({ notif, onRead, onDismiss }) => {
  const isUnread = !notif.read_at;
  return (
    <div
      className="mono"
      style={{
        padding: '10px 12px',
        borderBottom: '1px dashed rgba(0,183,255,0.07)',
        fontSize: 11,
        background: isUnread ? 'rgba(0,183,255,0.04)' : 'transparent',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <KindBadge kind={notif.kind}/>
          {isUnread && (
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: 'var(--accent)', boxShadow: '0 0 6px var(--accent)',
            }}/>
          )}
          <span className="neonc" style={{ fontWeight: 600 }}>@{notif.from_name}</span>
          <span className="muted" style={{ fontSize: 9 }}>{relTime(notif.created_at)}</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {isUnread && (
            <button
              className="nc-btn"
              style={{ fontSize: 9, padding: '2px 6px' }}
              title="mark as read"
              onClick={() => onRead(notif)}
            >mark read</button>
          )}
          <button
            className="nc-btn"
            style={{ fontSize: 9, padding: '2px 6px', color: '#fb3b5f' }}
            title="dismiss"
            onClick={() => onDismiss(notif)}
          >×</button>
        </div>
      </div>
      <div style={{ color: 'var(--text)', lineHeight: 1.55, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
        {notif.body}
      </div>
    </div>
  );
};

const NotificationsPanel = ({ onChanged }) => {
  const notifications = window.NC_DATA.NOTIFICATIONS || [];
  const unreadCount = window.NC_DATA.NOTIFICATIONS_UNREAD || 0;
  const [filter, setFilter] = React.useState('all'); // all | unread | info | question | alert | update
  const [busy, setBusy] = React.useState(false);

  const onRead = async (notif) => {
    setBusy(true);
    try {
      await window.NC_API.post(`/api/notifications/${notif.id}/read`);
      onChanged?.();
    } catch (e) { console.error(e); }
    finally { setBusy(false); }
  };

  const onDismiss = async (notif) => {
    setBusy(true);
    try {
      await window.NC_API.post(`/api/notifications/${notif.id}/dismiss`);
      onChanged?.();
    } catch (e) { console.error(e); }
    finally { setBusy(false); }
  };

  const onMarkAllRead = async () => {
    setBusy(true);
    const unread = notifications.filter(n => !n.read_at);
    for (const n of unread) {
      try { await window.NC_API.post(`/api/notifications/${n.id}/read`); }
      catch { /* continue */ }
    }
    onChanged?.();
    setBusy(false);
  };

  const filtered = notifications.filter(n => {
    if (filter === 'unread') return !n.read_at;
    if (['info', 'question', 'alert', 'update'].includes(filter)) return n.kind === filter;
    return true;
  });

  return (
    <Section
      title={`MESSAGE NOTIFICATIONS  ·  ${notifications.length} total${unreadCount > 0 ? ` · ${unreadCount} unread` : ''}`}
      padded={false}
      right={
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {unreadCount > 0 && (
            <button
              className="nc-btn"
              style={{ fontSize: 9, padding: '2px 8px' }}
              onClick={onMarkAllRead}
              disabled={busy}
            >mark all read</button>
          )}
          {['all', 'unread', 'alert', 'question', 'info', 'update'].map(f => (
            <span
              key={f}
              onClick={() => setFilter(f)}
              className={`tag ${filter === f ? (f === 'alert' ? 'amber' : f === 'question' ? 'cyan' : f === 'unread' ? 'blue' : f === 'info' ? 'blue' : f === 'update' ? 'green' : 'blue') : ''}`}
              style={{ cursor: 'pointer', fontSize: 9, padding: '1px 6px' }}
            >{f.toUpperCase()}</span>
          ))}
        </div>
      }
    >
      {filtered.length === 0 && (
        <div className="mono muted" style={{ padding: 30, textAlign: 'center', fontSize: 11 }}>
          // no notifications{filter !== 'all' ? ` matching "${filter}"` : ''}
        </div>
      )}
      {filtered.map(n => (
        <NotificationItem key={n.id} notif={n} onRead={onRead} onDismiss={onDismiss}/>
      ))}
    </Section>
  );
};

// ── Main page ──────────────────────────────────────────────────────────────

const Comms = () => {
  const { COMMS, COMMS_NOTES, AGENTS, NOTIFICATIONS_UNREAD } = window.NC_DATA;
  const list  = COMMS || [];
  const notes = COMMS_NOTES || [];
  const agents = (AGENTS || []).filter(Boolean);
  const unreadNotifs = NOTIFICATIONS_UNREAD || 0;
  const [search, setSearch] = React.useState('');
  const [dirFilter, setDirFilter] = React.useState('all'); // all | in | out | user
  const [statusFilter, setStatusFilter] = React.useState('all');
  const [rightTab, setRightTab] = React.useState('notifications'); // notifications | notes

  // ── Live updates: subscribe to /api/hive/stream and force refresh on any
  //    event that affects this page (user messages, agent replies, notes, notifications).
  React.useEffect(() => {
    let es;
    try {
      es = new EventSource('/api/hive/stream');
      const refreshActions = new Set([
        'user_message_sent', 'user_note_added', 'user_note_deleted',
        'agent_message_sent', 'agent_response',
        'agent_task_assigned',
        'agent_notified_user', 'user_dismissed_notification',
      ]);
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === 'hive_event' && data.event && refreshActions.has(data.event.action)) {
            window.NC_LIVE?.refresh();
          }
        } catch { /* ignore non-JSON pings */ }
      };
      es.onerror = () => { /* browser auto-reconnects */ };
    } catch { /* EventSource unavailable */ }
    return () => { try { es?.close(); } catch { /* ignore */ } };
  }, []);

  const filtered = list.filter(c => {
    if (search && !((c.from + ' ' + c.to + ' ' + c.msg + ' ' + c.resp + ' ' + c.task) || '').toLowerCase().includes(search.toLowerCase())) return false;
    const fromLower = (c.from || '').toLowerCase();
    if (dirFilter === 'user' && fromLower !== 'user') return false;
    if (dirFilter === 'out'  && fromLower !== 'alfred') return false;
    if (dirFilter === 'in'   && (fromLower === 'alfred' || fromLower === 'user')) return false;
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    return true;
  });

  // Summary counts (over full list, not filtered) — collapse to backend-real
  // statuses. The earlier `streaming/ack/closed/sent` filter pills never
  // matched anything because the backend only emits pending/delivered/
  // responded/failed; those are now what we surface.
  const total      = list.length;
  const pending    = list.filter(c => c.status === 'pending').length;
  const responded  = list.filter(c => c.status === 'responded').length;
  const failed     = list.filter(c => c.status === 'failed').length;
  const userCount  = list.filter(c => (c.from || '').toLowerCase() === 'user').length;

  // Unique agents involved in the relay log
  const agentsInLog = [...new Set(list.flatMap(c => [c.from, c.to]).filter(Boolean))];

  return (
    <div>
      <PageHeader
        title="Comms"
        subtitle="// agent-to-agent relay · user injection · operator notes · message notifications"
        right={<>
          <input className="nc-input" placeholder="search…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 180 }}/>
          <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>
        </>}
      />

      {/* ── Summary bar ── */}
      <div className="nc-panel glow" style={{ display: 'flex', gap: 0, marginBottom: 14, padding: 0, overflow: 'hidden' }}>
        {[
          { label: 'TOTAL',     value: total,      cls: 'blue',   active: statusFilter === 'all',        onClick: () => setStatusFilter('all') },
          { label: 'PENDING',   value: pending,    cls: 'amber',  active: statusFilter === 'pending',    onClick: () => setStatusFilter(statusFilter === 'pending'   ? 'all' : 'pending') },
          { label: 'RESPONDED', value: responded,  cls: 'green',  active: statusFilter === 'responded',  onClick: () => setStatusFilter(statusFilter === 'responded' ? 'all' : 'responded') },
          { label: 'FAILED',    value: failed,     cls: 'red',    active: statusFilter === 'failed',     onClick: () => setStatusFilter(statusFilter === 'failed'    ? 'all' : 'failed') },
          { label: 'FROM USER', value: userCount,  cls: 'pink',   active: dirFilter === 'user',          onClick: () => setDirFilter(dirFilter === 'user' ? 'all' : 'user') },
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
            <div className={`mono ${s.cls === 'muted' ? 'muted' : s.cls === 'red' ? 'dangerc' : s.cls === 'pink' ? 'dangerc' : s.cls === 'green' ? 'okc' : s.cls === 'amber' ? 'warnc' : 'neonc'}`} style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1, marginTop: 2 }}>
              {s.value}
            </div>
          </div>
        ))}
        {/* Direction quick-filter pills */}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5, padding: '8px 14px', borderLeft: '1px solid var(--line-soft)' }}>
          <div className="mono muted" style={{ fontSize: 9, letterSpacing: '0.14em' }}>DIRECTION</div>
          <div style={{ display: 'flex', gap: 5 }}>
            {['all', 'out', 'in', 'user'].map(d => (
              <span
                key={d}
                onClick={() => setDirFilter(d)}
                className={`tag ${dirFilter === d ? (d === 'user' ? '' : d === 'out' ? 'blue' : d === 'in' ? 'green' : 'blue') : ''}`}
                style={{
                  cursor: 'pointer', fontSize: 9, padding: '1px 7px',
                  ...(dirFilter === d && d === 'user' ? {
                    background: 'rgba(244, 63, 94, 0.15)', color: '#f43f5e',
                    border: '1px solid rgba(244, 63, 94, 0.4)',
                  } : {}),
                }}
              >{d.toUpperCase()}</span>
            ))}
          </div>
        </div>
      </div>

      {/* ── Composer (full width) ── */}
      <div style={{ marginBottom: 12 }}>
        <CommsComposer agents={agents} onSent={() => window.NC_LIVE?.refresh()}/>
      </div>

      {/* ── Agents involved ── */}
      {agentsInLog.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="mono muted" style={{ fontSize: 9, letterSpacing: '0.14em' }}>AGENTS IN LOG</span>
          {agentsInLog.map(a => (
            <span key={a} className="tag" style={{ fontSize: 9, padding: '1px 7px', cursor: 'pointer' }}
              onClick={() => setSearch(search === a ? '' : a)}>
              @{a}
            </span>
          ))}
        </div>
      )}

      {/* ── Main grid: relay log + notes/notifications ── */}
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

          {filtered.map((c, i) => <CommRow key={c._raw?.id || i} c={c} i={i}/>)}
        </Section>

        {/* Right panel: tabs for Notes vs Notifications */}
        <div>
          {/* Tab switcher */}
          <div style={{ display: 'flex', gap: 0, marginBottom: 8 }}>
            <button
              className={`nc-btn ${rightTab === 'notifications' ? '' : 'muted'}`}
              style={{
                borderRadius: '6px 0 0 6px',
                padding: '6px 14px',
                fontSize: 11,
                background: rightTab === 'notifications' ? 'rgba(0,183,255,0.1)' : 'transparent',
                borderRight: 'none',
                position: 'relative',
              }}
              onClick={() => setRightTab('notifications')}
            >
              <Icon name="comms" size={12}/> Notifications
              {unreadNotifs > 0 && (
                <span style={{
                  position: 'absolute', top: 4, right: 4,
                  minWidth: 14, height: 14, borderRadius: 7,
                  background: 'var(--danger)', color: '#fff',
                  fontSize: 9, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '0 4px',
                }}>{unreadNotifs > 99 ? '99+' : unreadNotifs}</span>
              )}
            </button>
            <button
              className={`nc-btn ${rightTab === 'notes' ? '' : 'muted'}`}
              style={{
                borderRadius: '0 6px 6px 0',
                padding: '6px 14px',
                fontSize: 11,
                background: rightTab === 'notes' ? 'rgba(0,183,255,0.1)' : 'transparent',
              }}
              onClick={() => setRightTab('notes')}
            >
              <Icon name="edit" size={12}/> Notes ({notes.length})
            </button>
          </div>

          {/* Panel content */}
          {rightTab === 'notifications' && (
            <NotificationsPanel onChanged={() => window.NC_LIVE?.refresh()}/>
          )}
          {rightTab === 'notes' && (
            <NotesPanel notes={notes} onChanged={() => window.NC_LIVE?.refresh()}/>
          )}
        </div>
      </div>
    </div>
  );
};
window.Comms = Comms;
