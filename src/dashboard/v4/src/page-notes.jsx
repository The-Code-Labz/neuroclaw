/* Notes v4 — shared notepad with a real left/right split layout.
 * Long-form markdown any agent can write; the human edits/copies here.
 * Left: note list. Right: rendered markdown / raw / edit with one-click copy.
 * Backed by /api/notes/*. */

const noteApi = (path, method, body) =>
  fetch(path, {
    method: method || 'GET', credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json().catch(() => ({ ok: r.ok })));

const renderMd = (src) => {
  if (!src) return '';
  if (!window.marked) return null;
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
  const [note, setNote]       = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [mode, setMode]       = React.useState('view');
  const [busy, setBusy]       = React.useState('');
  const [msg, setMsg]         = React.useState(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [draft, setDraft]     = React.useState({ title: '', content: '' });

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
    if (r.ok) { await load(); setActiveId(r.note.id); setDraft({ title: r.note.title, content: r.note.content }); setMode('edit'); }
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader title="Notes" subtitle="// shared notepad · long-form markdown agents write & you copy · no length limit" right={<>
        <label className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 5 }}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> archived
        </label>
        <button className="nc-btn" onClick={load}><Icon name="refresh" size={12}/> Refresh</button>
        <button className="nc-btn" onClick={createNote} disabled={busy === 'new'}>+ New note</button>
      </>}/>

      {msg && <div className="nc-panel" style={{ padding: '8px 12px', marginBottom: 12, borderColor: msg.ok ? 'var(--accent)' : 'var(--error)' }}>
        <span className="mono" style={{ fontSize: 12, color: msg.ok ? 'var(--accent)' : 'var(--error)' }}>{msg.text}</span>
      </div>}

      {loading ? <div className="mono muted" style={{ padding: 24 }}>loading notes…</div> : (
      <div className="split-view">
        {/* Note list */}
        <div className="split-sidebar notes-list">
          {notes.length === 0 && <div className="nc-panel" style={{ padding: 14 }}>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>No notes yet.<br/><span className="muted">Agents can write here with <span className="neonc">write_note</span> / <span className="neonc">append_note</span>, or make one yourself.</span></div>
          </div>}
          {notes.map(n => (
            <div key={n.id} className="nc-panel glow tilt notes-list-item" onClick={() => setActiveId(n.id)}
              style={{
                padding: 12, cursor: 'pointer', position: 'relative',
                opacity: n.archived ? 0.6 : 1,
                boxShadow: activeId === n.id ? '0 0 0 1px var(--accent)' : undefined,
                borderColor: activeId === n.id ? 'var(--accent)' : undefined,
              }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div className="mono" style={{ fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                  {n.pinned ? <span title="pinned" style={{ color: 'var(--accent)' }}>📌 </span> : null}{n.title}
                </div>
              </div>
              {n.preview && <div className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5, maxHeight: 30, overflow: 'hidden' }}>{n.preview}</div>}
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <span className="tag accent" style={{ fontSize: 9 }}>{n.author}</span>
                <span className="tag blue" style={{ fontSize: 9 }}>{n.chars} char{n.chars === 1 ? '' : 's'}</span>
                {n.archived ? <span className="tag muted" style={{ fontSize: 9 }}>archived</span> : null}
                <span className="tag muted" style={{ fontSize: 9 }}>{fmtWhen(n.updated_at)}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Selected note */}
        <div className="split-main notes-editor">
          {!note && <div className="nc-panel" style={{ padding: 20, textAlign: 'center', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="mono muted" style={{ fontSize: 11 }}>← select a note, or create one</div>
          </div>}
          {note && (
            <div className="nc-panel glow" style={{ padding: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
              {/* Toolbar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap', flexShrink: 0 }}>
                {mode === 'edit'
                  ? <input className="nc-input" value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} placeholder="note title" style={{ flex: 1, minWidth: 160 }} />
                  : <div className="mono" style={{ flex: 1, minWidth: 160, fontSize: 14, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{note.title}</div>}
                {mode === 'edit' ? (
                  <>
                    <button className="nc-btn" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : '💾 Save'}</button>
                    <button className="nc-btn ghost" onClick={() => { setMode('view'); loadNote(note.id); }}>Cancel</button>
                  </>
                ) : (
                  <>
                    <div className="seg" style={{ display: 'flex', gap: 2 }}>
                      <button className={`nc-btn ghost ${mode === 'view' ? 'active' : ''}`} onClick={() => setMode('view')} style={{ fontSize: 10 }}>Rendered</button>
                      <button className={`nc-btn ghost ${mode === 'raw' ? 'active' : ''}`} onClick={() => setMode('raw')} style={{ fontSize: 10 }}>Raw</button>
                    </div>
                    <button className="nc-btn" onClick={copy}>📋 Copy</button>
                    <button className="nc-btn ghost" onClick={startEdit}>✎ Edit</button>
                    <button className="nc-btn ghost" onClick={() => patch({ pinned: !note.pinned })} title="pin">{note.pinned ? '📌' : '📍'}</button>
                    <button className="nc-btn ghost" onClick={() => patch({ archived: !note.archived })} title="archive">{note.archived ? '⇧' : '🗄'}</button>
                    <button className="nc-btn ghost" onClick={del} style={{ color: 'var(--error)' }}>✕</button>
                  </>
                )}
              </div>

              {/* Meta */}
              <div className="mono muted" style={{ fontSize: 10, padding: '6px 14px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
                {note.author} · updated {fmtWhen(note.updated_at)} · {(note.content || '').length} chars
              </div>

              {/* Body */}
              <div style={{ padding: 16, flex: 1, overflowY: 'auto', minHeight: 0 }}>
                {mode === 'edit' && (
                  <textarea className="nc-input" value={draft.content} onChange={e => setDraft(d => ({ ...d, content: e.target.value }))}
                    placeholder="write markdown here…" spellCheck={false}
                    style={{ width: '100%', minHeight: '100%', fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.6, resize: 'none' }} />
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
      )}
    </div>
  );
};

window.Notes = Notes;
