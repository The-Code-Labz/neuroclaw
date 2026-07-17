/* Notebooks — native NotebookLM replacement (spec: 2026-07-06-native-notebook-rag).
 * Global collections of parsed+embedded docs (neuroclaw_kb). Left: notebooks.
 * Right: the selected notebook — its sources, add-source (upload a file or paste
 * a URL/attachment_id), and ask-across-all-docs with cited answers.
 * Backed by /api/notebooks/*. Flag-gated: DOC_NOTEBOOKS_ENABLED. */

const nbRaw = (path, method, body) =>
  fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json().catch(() => ({ ok: r.ok })));

const Notebooks = () => {
  const [enabled, setEnabled] = React.useState(true);
  const [notebooks, setNotebooks] = React.useState([]);
  const [active, setActive]   = React.useState(null);   // notebook id
  const [sources, setSources] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy]       = React.useState('');
  const [msg, setMsg]         = React.useState(null);
  const [creating, setCreating] = React.useState(false);
  const [newTitle, setNewTitle] = React.useState('');
  const [newDesc, setNewDesc]   = React.useState('');
  const [srcInput, setSrcInput] = React.useState('');
  const [question, setQuestion] = React.useState('');
  const [answer, setAnswer]     = React.useState(null);
  const fileRef = React.useRef(null);

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 6000); };

  const load = React.useCallback(async () => {
    const r = await nbRaw('/api/notebooks', 'GET');
    setEnabled(r.enabled !== false);
    setNotebooks(Array.isArray(r.items) ? r.items : []);
    setLoading(false);
  }, []);

  const loadSources = React.useCallback(async (id) => {
    if (!id) { setSources([]); return; }
    const r = await nbRaw(`/api/notebooks/${id}/sources`, 'GET');
    setSources(Array.isArray(r.items) ? r.items : []);
  }, []);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => { loadSources(active); setAnswer(null); setQuestion(''); }, [active, loadSources]);

  const activeNb = notebooks.find(n => n.id === active);

  const create = async () => {
    if (!newTitle.trim()) { flash('title required', false); return; }
    setBusy('create');
    const r = await nbRaw('/api/notebooks', 'POST', { title: newTitle.trim(), description: newDesc.trim() });
    setBusy('');
    if (r.ok) { setCreating(false); setNewTitle(''); setNewDesc(''); flash(`Created "${r.notebook?.title}"`); await load(); setActive(r.notebook?.id || null); }
    else flash(r.error || 'create failed', false);
  };

  const del = async (id, title) => {
    if (!confirm(`Delete notebook "${title}"? (documents stay indexed — only the collection is removed)`)) return;
    await nbRaw(`/api/notebooks/${id}`, 'DELETE');
    if (active === id) setActive(null);
    flash(`Deleted "${title}"`); load();
  };

  const addSource = async () => {
    const source = srcInput.trim();
    if (!source) { flash('paste a URL or attachment_id', false); return; }
    setBusy('addsrc');
    const r = await nbRaw(`/api/notebooks/${active}/sources`, 'POST', { source });
    setBusy('');
    if (r.ok) { setSrcInput(''); flash(`Added source (${r.source?.embedded?.chunks ?? 0} chunks embedded)`); loadSources(active); load(); }
    else flash(r.error || 'add failed', false);
  };

  const uploadFiles = async (files) => {
    if (!files || files.length === 0) return;
    setBusy('upload');
    const fd = new FormData();
    for (const f of files) fd.append('file', f);
    const r = await fetch(`/api/notebooks/${active}/upload`, { method: 'POST', credentials: 'same-origin', body: fd }).then(x => x.json().catch(() => ({ ok: false })));
    setBusy('');
    if (fileRef.current) fileRef.current.value = '';
    if (r.ok) flash(`Uploaded ${r.added} document${r.added === 1 ? '' : 's'}`);
    else flash(`${r.added || 0} added, ${r.failed || 0} failed${r.error ? ' — ' + r.error : ''}`, (r.added || 0) > 0);
    loadSources(active); load();
  };

  const ask = async () => {
    const q = question.trim();
    if (!q) return;
    setBusy('ask'); setAnswer(null);
    const r = await nbRaw(`/api/notebooks/${active}/ask`, 'POST', { question: q });
    setBusy('');
    if (r.ok) setAnswer(r);
    else flash(r.error || 'ask failed', false);
  };

  if (loading) return <div className="mono muted" style={{ padding: 24 }}>loading notebooks…</div>;

  return (
    <div>
      <PageHeader title="Notebooks" subtitle="// native NotebookLM · ask across a collection of documents · neuroclaw_kb" right={<>
        <button className="nc-btn" onClick={load}><Icon name="refresh" size={12}/> Refresh</button>
        {enabled && <button className="nc-btn" onClick={() => setCreating(v => !v)}>{creating ? 'Cancel' : '+ New notebook'}</button>}
      </>}/>

      {!enabled && (
        <div className="mem-panel" style={{ marginBottom: 12 }}>
          <div className="mono" style={{ fontSize: 12, color: 'var(--text-soft)' }}>
            Notebooks are disabled. Set <span className="neonc">DOC_NOTEBOOKS_ENABLED=true</span> (with <span className="neonc">DOC_ARCHIVE_ENABLED</span> + <span className="neonc">DOC_RAG_ENABLED</span>) and restart.
          </div>
        </div>
      )}

      {msg && <div className="mem-panel" style={{ padding: '8px 12px', marginBottom: 12, borderLeft: `2px solid ${msg.ok ? 'var(--accent-2)' : 'var(--danger)'}` }}>
        <span className="mono" style={{ fontSize: 12, color: msg.ok ? 'var(--accent-2)' : 'var(--danger)' }}>{msg.text}</span>
      </div>}

      {creating && enabled && (
        <div className="mem-panel" style={{ marginBottom: 12, display: 'grid', gap: 8, maxWidth: 520 }}>
          <input className="nc-input" placeholder="notebook title" value={newTitle} onChange={e => setNewTitle(e.target.value)} />
          <input className="nc-input" placeholder="description (optional)" value={newDesc} onChange={e => setNewDesc(e.target.value)} />
          <button className="nc-btn" onClick={create} disabled={busy === 'create'} style={{ justifySelf: 'start' }}>{busy === 'create' ? 'Creating…' : 'Create notebook'}</button>
        </div>
      )}

      {enabled && (
      <div className="stack" style={{ gap: 16, alignItems: 'flex-start' }}>
        {/* Notebook list */}
        <div style={{ flex: '0 0 300px', maxWidth: 340, display: 'grid', gap: 8, alignContent: 'start' }}>
          {notebooks.length === 0 && <div className="mem-panel">
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.6 }}>No notebooks yet.<br/><span className="muted">Create one, then add documents to it.</span></div>
          </div>}
          {notebooks.map(n => (
            <div key={n.id} className={`mem-card${active === n.id ? ' is-active' : ''}`} onClick={() => setActive(n.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div className="mono" style={{ fontSize: 13, color: 'var(--text)', wordBreak: 'break-word' }}>{n.title}</div>
                <button className="nc-btn ghost" onClick={e => { e.stopPropagation(); del(n.id, n.title); }} style={{ fontSize: 9, padding: '1px 7px', color: 'var(--danger)' }}>✕</button>
              </div>
              {n.description && <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)', marginTop: 4, lineHeight: 1.5 }}>{n.description}</div>}
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <span className="tag blue" style={{ fontSize: 9 }}>{n.source_count} source{n.source_count === 1 ? '' : 's'}</span>
                {n.updated_at && <span className="tag muted" style={{ fontSize: 9 }}>{new Date(n.updated_at).toLocaleDateString()}</span>}
              </div>
            </div>
          ))}
        </div>

        {/* Selected notebook */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!active && <div className="mem-panel" style={{ textAlign: 'center' }}>
            <div className="mono muted" style={{ fontSize: 11 }}>← select a notebook, or create one</div>
          </div>}
          {active && activeNb && (
            <>
              <div className="mem-panel" style={{ marginBottom: 12 }}>
                <div className="label-tiny" style={{ marginBottom: 6 }}>Notebook</div>
                <div className="mono" style={{ fontSize: 14, color: 'var(--text)' }}>{activeNb.title}</div>
                <div className="mono muted" style={{ fontSize: 10, marginTop: 4 }}>{sources.length} source{sources.length === 1 ? '' : 's'} · ask questions across all of them</div>
              </div>

              {/* Add sources */}
              <div className="mem-panel" style={{ marginBottom: 12 }}>
                <div className="label-tiny" style={{ marginBottom: 8 }}>Add sources</div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  <input className="nc-input" placeholder="paste a URL (PDF/DOCX/HTML/MD) or an attachment_id" value={srcInput} onChange={e => setSrcInput(e.target.value)} style={{ flex: 1, minWidth: 240 }} onKeyDown={e => e.key === 'Enter' && addSource()} />
                  <button className="nc-btn" onClick={addSource} disabled={busy === 'addsrc'}>{busy === 'addsrc' ? 'Adding…' : 'Add'}</button>
                  <button className="nc-btn" onClick={() => fileRef.current && fileRef.current.click()} disabled={busy === 'upload'}>{busy === 'upload' ? 'Uploading…' : '⬆ Upload files'}</button>
                  <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.epub,.txt,.md,.markdown,.html,.htm" style={{ display: 'none' }} onChange={e => uploadFiles(Array.from(e.target.files || []))} />
                </div>
                {sources.length === 0
                  ? <div className="mono muted" style={{ fontSize: 11 }}>no sources yet — upload a document or paste a URL above</div>
                  : <div style={{ display: 'grid', gap: 6 }}>
                      {sources.map(s => (
                        <div key={s.attachment_id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }} className="mono">
                          <span className={`tag ${s.source_kind === 'url' ? 'violet' : 'cyan'}`} style={{ fontSize: 8 }}>{s.source_kind || 'file'}</span>
                          <span style={{ color: 'var(--text-soft)', wordBreak: 'break-word' }}>{s.source_title || s.attachment_id}</span>
                        </div>
                      ))}
                    </div>}
              </div>

              {/* Ask */}
              <div className="mem-panel">
                <div className="label-tiny" style={{ marginBottom: 8 }}>Ask</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="nc-input" placeholder="ask a question across this notebook's documents…" value={question} onChange={e => setQuestion(e.target.value)} style={{ flex: 1 }} onKeyDown={e => e.key === 'Enter' && ask()} disabled={sources.length === 0} />
                  <button className="nc-btn" onClick={ask} disabled={busy === 'ask' || sources.length === 0}>{busy === 'ask' ? 'Thinking…' : 'Ask'}</button>
                </div>
                {sources.length === 0 && <div className="mono muted" style={{ fontSize: 10, marginTop: 6 }}>add at least one source to ask questions</div>}
                {answer && (
                  <div style={{ marginTop: 12 }}>
                    <div className="mono" style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{answer.answer}</div>
                    {answer.citations && answer.citations.length > 0 && (
                      <div style={{ marginTop: 10, borderTop: '1px solid var(--line-soft)', paddingTop: 8 }}>
                        <div className="label-tiny muted" style={{ marginBottom: 6 }}>SOURCES ({answer.retrieved_chunks} chunk{answer.retrieved_chunks === 1 ? '' : 's'})</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {answer.citations.map((ci, i) => (
                            <span key={i} className="tag blue" style={{ fontSize: 9 }}>{ci.title} · {ci.chunks_used}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
};

window.Notebooks = Notebooks;
