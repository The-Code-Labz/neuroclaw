/* Notes — the shared Notepad. Long-form MARKDOWN notes any agent can write or
 * append to (escapes Discord's message-length limit); the human reads, copies,
 * edits them here. Left: note list. Right: rendered markdown / raw / edit, with
 * one-click copy. Backed by /api/notes/*. Always on (no feature flag). */

const noteApi = (path, method, body) =>
  fetch(path, {
    method: method || 'GET', credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json().catch(() => ({ ok: r.ok })));

const renderMd = (src) => {
  if (!src) return '';
  if (!window.marked) return null; // caller falls back to <pre>
  try {
    const fn = window.marked.parse || window.marked;
    return fn(src, { mangle: false, headerIds: true });
  } catch { return null; }
};

const fmtWhen = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const Notes = () => {
  const [notes, setNotes]     = React.useState([]);
  const [activeId, setActiveId] = React.useState(null);
  const [note, setNote]       = React.useState(null);   // full active note
  const [loading, setLoading] = React.useState(true);
  const [mode, setMode]       = React.useState('view'); // view | raw | edit
  const [busy, setBusy]       = React.useState('');
  const [msg, setMsg]         = React.useState(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [draft, setDraft]     = React.useState({ title: '', content: '' });
  const [mobilePane, setMobilePane] = React.useState('list'); // 'list' | 'note' — narrow-viewport toggle

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 4000); };

  const load = React.useCallback(async () => {
    const r = await noteApi(`/api/notes${showArchived ? '?archived=1' : ''}`);
    setNotes(Array.isArray(r.items) ? r.items : []);
    setLoading(false);
  }, [showArchived]);

  const loadNote = React.useCallback(async (id) => {
    if (!id) { setNote(null); return; }
    const r = await noteApi(`/api/notes/${id}`);
    if (r.ok) setNote(r.note);
  }, []);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => { loadNote(activeId); setMode('view'); }, [activeId, loadNote]);

  // Live refresh so notes an agent writes/append show up. Pause while editing.
  React.useEffect(() => {
    const t = setInterval(() => {
      if (mode === 'edit') return;
      load();
      if (activeId) loadNote(activeId);
    }, 8000);
    return () => clearInterval(t);
  }, [mode, activeId, load, loadNote]);

  const createNote = async () => {
    setBusy('new');
    const r = await noteApi('/api/notes', 'POST', { title: 'Untitled note', content: '', author: 'User' });
    setBusy('');
    if (r.ok) { await load(); setActiveId(r.note.id); setDraft({ title: r.note.title, content: r.note.content }); setMode('edit'); setMobilePane('note'); }
    else flash('create failed', false);
  };

  const startEdit = () => { if (note) { setDraft({ title: note.title, content: note.content }); setMode('edit'); } };

  const save = async () => {
    if (!note) return;
    setBusy('save');
    const r = await noteApi(`/api/notes/${note.id}`, 'PATCH', { title: draft.title, content: draft.content });
    setBusy('');
    if (r.ok) { setNote(r.note); setMode('view'); flash('Saved'); load(); }
    else flash('save failed', false);
  };

  const patch = async (fields) => {
    if (!note) return;
    const r = await noteApi(`/api/notes/${note.id}`, 'PATCH', fields);
    if (r.ok) { setNote(r.note); load(); }
  };

  const del = async () => {
    if (!note || !confirm(`Delete note "${note.title}"? This can't be undone.`)) return;
    await noteApi(`/api/notes/${note.id}`, 'DELETE');
    setActiveId(null); setNote(null); flash('Deleted'); load();
  };

  const copy = async () => {
    if (!note) return;
    try { await navigator.clipboard.writeText(note.content || ''); flash('Copied markdown to clipboard'); }
    catch { flash('copy failed — select & copy manually', false); }
  };

  const html = mode === 'view' && note ? renderMd(note.content) : null;

  return (
    <div>
      <PageHeader title="Notes" subtitle="// shared notepad · long-form markdown agents write & you copy · no length limit" right={<>
        <label className="mono" style={{ fontSize: 10, color: 'var(--text-soft)', display: 'flex', alignItems: 'center', gap: 5 }}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> archived
        </label>
        <button className="nc-btn" onClick={load}><Icon name="refresh" size={12}/> Refresh</button>
        <button className="nc-btn" onClick={createNote} disabled={busy === 'new'}>+ New note</button>
      </>}/>

      {msg && <div className="nc-panel" style={{ padding: '8px 12px', marginBottom: 12, borderColor: msg.ok ? 'var(--accent-2)' : 'var(--danger)' }}>
        <span className="mono" style={{ fontSize: 12, color: msg.ok ? 'var(--accent-2)' : 'var(--danger)' }}>{msg.text}</span>
      </div>}

      {loading ? <div className="mono muted" style={{ padding: 24 }}>loading notes…</div> : (
      <>
      <div className="nt-mobile-tabs">
        <button className={`nc-btn ghost ${mobilePane === 'list' ? 'active' : ''}`} onClick={() => setMobilePane('list')}><Icon name="sessions" size={12}/> List</button>
        <button className={`nc-btn ghost ${mobilePane === 'note' ? 'active' : ''}`} onClick={() => setMobilePane('note')} disabled={!note}><Icon name="docs" size={12}/> Note</button>
      </div>
      <div className="nt-split">
        {/* Note list */}
        <div className={`nt-list ${mobilePane === 'note' ? 'nt-mobile-hide' : ''}`}>
          {notes.length === 0 && <div className="nt-card" style={{ cursor: 'default' }}>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.6 }}>No notes yet.<br/><span className="muted">Agents can write here with <span className="neonc">write_note</span> / <span className="neonc">append_note</span>, or make one yourself.</span></div>
          </div>}
          {notes.map(n => (
            <div key={n.id}
              className={`nt-card ${activeId === n.id ? 'is-active' : ''} ${n.pinned ? 'is-pinned' : ''} ${n.archived ? 'is-archived' : ''}`}
              onClick={() => { setActiveId(n.id); setMobilePane('note'); }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div className="mono" style={{ fontSize: 13, color: 'var(--text)', wordBreak: 'break-word' }}>
                  {n.pinned ? <Icon name="pin" size={11} style={{ color: 'var(--accent-2)', marginRight: 4, verticalAlign: -1 }} /> : null}{n.title}
                </div>
              </div>
              {n.preview && <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)', marginTop: 4, lineHeight: 1.5, maxHeight: 30, overflow: 'hidden' }}>{n.preview}</div>}
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <span className="tag violet" style={{ fontSize: 9 }}>{n.author}</span>
                <span className="tag blue" style={{ fontSize: 9 }}>{n.chars} char{n.chars === 1 ? '' : 's'}</span>
                {n.archived ? <span className="tag muted" style={{ fontSize: 9 }}>archived</span> : null}
                <span className="tag muted" style={{ fontSize: 9 }}>{fmtWhen(n.updated_at)}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Selected note */}
        <div style={{ minWidth: 0 }} className={mobilePane === 'list' ? 'nt-mobile-hide' : ''}>
          {!note && <div className="nt-panel" style={{ textAlign: 'center' }}>
            <div className="mono muted" style={{ fontSize: 11 }}>← select a note, or create one</div>
          </div>}
          {note && (
            <div className="nt-panel nt-panel--flush">
              {/* Toolbar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--line-soft)', flexWrap: 'wrap' }}>
                {mode === 'edit'
                  ? <input className="nc-input" value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} placeholder="note title" style={{ flex: 1, minWidth: 160 }} />
                  : <div className="mono" style={{ flex: 1, minWidth: 160, fontSize: 14, color: 'var(--text)', wordBreak: 'break-word' }}>{note.title}</div>}
                {mode === 'edit' ? (
                  <>
                    <button className="nc-btn" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : <><Icon name="save" size={12}/> Save</>}</button>
                    <button className="nc-btn ghost" onClick={() => { setMode('view'); loadNote(note.id); }}>Cancel</button>
                  </>
                ) : (
                  <>
                    <div className="seg" style={{ display: 'flex', gap: 2 }}>
                      <button className={`nc-btn ghost ${mode === 'view' ? 'active' : ''}`} onClick={() => setMode('view')} style={{ fontSize: 10 }}>Rendered</button>
                      <button className={`nc-btn ghost ${mode === 'raw' ? 'active' : ''}`} onClick={() => setMode('raw')} style={{ fontSize: 10 }}>Raw</button>
                    </div>
                    <button className="nt-toolbar-btn" onClick={copy} title="Copy markdown"><Icon name="copy" size={14}/></button>
                    <button className="nt-toolbar-btn" onClick={startEdit} title="Edit"><Icon name="edit" size={14}/></button>
                    <button className={`nt-toolbar-btn ${note.pinned ? 'is-active' : ''}`} onClick={() => patch({ pinned: !note.pinned })} title={note.pinned ? 'Unpin' : 'Pin'}><Icon name="pin" size={14}/></button>
                    <button className={`nt-toolbar-btn ${note.archived ? 'is-active' : ''}`} onClick={() => patch({ archived: !note.archived })} title={note.archived ? 'Unarchive' : 'Archive'}><Icon name="archive" size={14}/></button>
                    <button className="nt-toolbar-btn is-danger" onClick={del} title="Delete"><Icon name="trash" size={14}/></button>
                  </>
                )}
              </div>

              {/* Meta */}
              <div className="mono muted" style={{ fontSize: 10, padding: '6px 14px', borderBottom: '1px solid var(--line-soft)' }}>
                {note.author} · updated {fmtWhen(note.updated_at)} · {(note.content || '').length} chars
              </div>

              {/* Body */}
              <div style={{ padding: 16 }}>
                {mode === 'edit' && (
                  <textarea className="nc-input" value={draft.content} onChange={e => setDraft(d => ({ ...d, content: e.target.value }))}
                    placeholder="write markdown here…" spellCheck={false}
                    style={{ width: '100%', minHeight: '55vh', fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6, resize: 'vertical' }} />
                )}
                {mode === 'raw' && (
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6, margin: 0 }}>{note.content || <span className="muted">— empty —</span>}</pre>
                )}
                {mode === 'view' && (
                  (note.content || '').trim() === ''
                    ? <div className="mono muted" style={{ fontSize: 12 }}>— empty note —</div>
                    : html != null
                      ? <div className="nc-prose" dangerouslySetInnerHTML={{ __html: html }} />
                      : <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6, margin: 0 }}>{note.content}</pre>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      </>
      )}
    </div>
  );
};

window.Notes = Notes;
