/* v4 Memory page — split-view layout inspired by Odysseus / Linear
 * Left: filters + memory list   Right: inspector
 */
const PAGE_SIZE = 100;

const IMPORT_SOURCES = [
  { id: 'chatgpt',     label: 'ChatGPT',     hint: 'conversations.json' },
  { id: 'claude_code', label: 'Claude Code', hint: '.json / .jsonl' },
  { id: 'gemini',      label: 'Gemini',      hint: 'Gemini Apps Activity.json' },
  { id: 'generic',     label: 'Generic',     hint: '{role,content}[] or {user,assistant}[]' },
];

const typeIcons = {
  all: 'overview', working: 'bolt', episodic: 'memory', semantic: 'memory',
  procedural: 'cmd', preference: 'star', insight: 'eye', session_summary: 'sessions',
  project: 'para', plan: 'tasks',
};

const MemoryImport = () => {
  const [open, setOpen]         = React.useState(false);
  const [source, setSource]     = React.useState('chatgpt');
  const [dragging, setDrag]     = React.useState(false);
  const [status, setStatus]     = React.useState(null);
  const [progress, setProgress] = React.useState({ processed: 0, total: 0, created: 0, skipped: 0 });
  const [summary, setSummary]   = React.useState(null);
  const [error, setError]       = React.useState(null);
  const [pastImports, setPast]  = React.useState([]);
  const [activeId, setActiveId] = React.useState(null);
  const esRef = React.useRef(null);

  const loadPast = async () => {
    try { setPast((await window.NC_API.get('/api/memory/imports')) || []); } catch { /* non-fatal */ }
  };
  React.useEffect(() => { loadPast(); }, []);

  const doImport = async (file) => {
    setStatus('running');
    setProgress({ processed: 0, total: 0, created: 0, skipped: 0 });
    setSummary(null); setError(null);

    const form = new FormData();
    form.append('file', file);
    form.append('source', source);

    let importId;
    try {
      const tok = window.NC_API.token;
      const tq  = tok ? `?token=${tok}` : '';
      const res  = await fetch(`/api/memory/import${tq}`, { method: 'POST', body: form, credentials: 'same-origin' });
      const json = await res.json();
      if (!res.ok) { setError(json.error || 'Upload failed'); setStatus('failed'); loadPast(); return; }
      importId = json.importId;
      setActiveId(importId);
    } catch (e) { setError(String(e)); setStatus('failed'); loadPast(); return; }

    const tok = window.NC_API.token;
    const tq  = tok ? `?token=${tok}` : '';
    const es = new EventSource(`/api/memory/import/watch/${importId}${tq}`);
    esRef.current = es;

    es.addEventListener('progress', (e) => {
      const d = JSON.parse(e.data);
      setProgress({ processed: d.processed, total: d.total, created: d.created, skipped: d.skipped });
    });
    es.addEventListener('done', (e) => {
      const d = JSON.parse(e.data);
      es.close(); esRef.current = null;
      if (d.cancelled) { setStatus(null); } else {
        setStatus('done'); setSummary(d);
        setProgress(p => ({ ...p, processed: d.total, created: d.created, skipped: d.skipped }));
      }
      loadPast();
    });
    es.addEventListener('failed', (e) => {
      const d = JSON.parse(e.data);
      es.close(); esRef.current = null;
      setStatus('failed'); setError(d.error || 'Import failed');
      loadPast();
    });
    es.onerror = () => { if (esRef.current) { es.close(); esRef.current = null; setStatus('failed'); } };
  };

  const handleDrop = (e) => {
    e.preventDefault(); setDrag(false);
    const file = e.dataTransfer.files[0];
    if (file) doImport(file);
  };
  const handleFileInput = (e) => {
    const file = e.target.files[0];
    if (file) doImport(file);
    e.target.value = '';
  };
  const handleCancel = async () => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    if (activeId) {
      try { await window.NC_API.del(`/api/memory/import/${activeId}`); } catch { }
      setActiveId(null);
    }
    setStatus(null);
  };

  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  return (
    <div className="nc-panel memory-import-panel">
      <button className="memory-import-toggle" onClick={() => setOpen(o => !o)}>
        <span className="label-tiny">Import memories</span>
        <Icon name={open ? 'caret-down' : 'chevron'} size={12} style={{ transform: open ? '' : 'rotate(-90deg)' }}/>
      </button>

      {open && (
        <div className="memory-import-body">
          <div className="memory-import-sources">
            {IMPORT_SOURCES.map(s => (
              <button
                key={s.id}
                className={`nc-btn ${source === s.id ? 'active' : 'ghost'}`}
                onClick={() => setSource(s.id)}
                disabled={status === 'running'}
                title={s.hint}
              >{s.label}</button>
            ))}
          </div>

          {status !== 'running' && (
            <div
              className={`memory-dropzone ${dragging ? 'dragging' : ''}`}
              onDrop={handleDrop}
              onDragOver={e => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onClick={() => document.getElementById('nc-import-file').click()}
            >
              <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {dragging ? 'Drop to import' : 'Drag & drop or click to select file'}
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                {IMPORT_SOURCES.find(s => s.id === source)?.hint}
              </div>
              <input id="nc-import-file" type="file" accept=".json,.jsonl" style={{ display: 'none' }} onChange={handleFileInput} />
            </div>
          )}

          {status === 'running' && (
            <div className="memory-import-progress">
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span className="mono" style={{ fontSize: 11 }}>{progress.processed} / {progress.total} exchanges</span>
                <span className="mono" style={{ fontSize: 11 }}>{progress.created} stored · {progress.skipped} skipped</span>
              </div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%` }}/></div>
              <div style={{ marginTop: 10, textAlign: 'right' }}>
                <button className="nc-btn ghost" onClick={handleCancel} style={{ fontSize: 11 }}>Cancel</button>
              </div>
            </div>
          )}

          {status === 'done' && summary && (
            <div className="memory-import-done">
              <span className="mono" style={{ fontSize: 12 }}>
                {summary.created} memories extracted from {summary.total} exchanges · {summary.skipped} skipped
              </span>
            </div>
          )}

          {status === 'failed' && error && (
            <div className="memory-import-error">
              <span className="mono" style={{ fontSize: 11 }}>{error}</span>
            </div>
          )}

          {pastImports.length > 0 && (
            <div className="memory-import-history">
              <div className="label-tiny" style={{ marginBottom: 8 }}>Recent imports</div>
              {pastImports.map(imp => (
                <div key={imp.id} className="memory-import-history-row">
                  <span className="mono muted" style={{ fontSize: 10 }}>{imp.filename} · {imp.source}</span>
                  <span className="mono" style={{ fontSize: 10, color: imp.status === 'done' ? 'var(--success)' : imp.status === 'failed' ? 'var(--error)' : 'var(--text-tertiary)' }}>
                    {imp.status === 'done' ? `${imp.created} created` : imp.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const Memory = () => {
  const { MEM_STATS } = window.NC_DATA;
  const [memories, setMemories] = React.useState([]);
  const [filter, setFilter] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [activeRaw, setActive] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(true);
  const [offset, setOffset] = React.useState(0);
  const loaderRef = React.useRef(null);

  const totalCount = MEM_STATS?.total ?? memories.length ?? 0;

  const loadMemories = async (reset = false) => {
    if (loading) return;
    const newOffset = reset ? 0 : offset;
    if (!reset && !hasMore) return;

    setLoading(true);
    try {
      const typeParam = filter !== 'all' ? `&type=${filter}` : '';
      const resp = await window.NC_API.get(`/api/memory/index?limit=${PAGE_SIZE}&offset=${newOffset}${typeParam}`);
      const mapped = (resp || []).map(m => ({
        id: m.id?.slice(0, 8) || '?',
        fullId: m.id,
        type: m.type || 'unknown',
        title: m.title || '(untitled)',
        summary: m.summary || '',
        tags: m.tags ? m.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        importance: m.importance ?? 0.5,
        salience: m.salience ?? 0.5,
        agent: m.agent_id?.slice(0, 8) || '—',
        state: (m.salience ?? 0.5) > 0.3 ? 'active' : 'low-salience',
        lastSeen: m.last_accessed ? new Date(m.last_accessed).toLocaleDateString() : new Date(m.created_at).toLocaleDateString(),
        _raw: m,
      }));

      if (reset) {
        setMemories(mapped);
        setOffset(PAGE_SIZE);
      } else {
        setMemories(prev => [...prev, ...mapped]);
        setOffset(prev => prev + PAGE_SIZE);
      }
      setHasMore(mapped.length === PAGE_SIZE);
    } catch (err) {
      console.error('Failed to load memories:', err);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => { loadMemories(true); }, [filter]);

  React.useEffect(() => {
    if (!loaderRef.current) return;
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting && hasMore && !loading) loadMemories(false); },
      { threshold: 0.1 }
    );
    observer.observe(loaderRef.current);
    return () => observer.disconnect();
  }, [hasMore, loading, offset]);

  React.useEffect(() => {
    if (memories.length > 0 && !activeRaw) setActive(memories[0]);
  }, [memories]);

  const types = ['all','working','episodic','semantic','procedural','preference','insight','session_summary','project','plan'];
  const list = memories.filter(m => !search || (m.title + ' ' + m.summary).toLowerCase().includes(search.toLowerCase()));
  const active = activeRaw || memories[0];

  const getTypeCount = (t) => {
    if (t === 'all') return totalCount;
    if (MEM_STATS?.byType) {
      const found = MEM_STATS.byType.find(x => x.type === t);
      return found?.n ?? 0;
    }
    return memories.filter(m => m.type === t).length;
  };

  const onDelete = async (m) => {
    if (!confirm(`Delete memory "${m.title}"? This removes it from long-term memory.`)) return;
    try {
      await fetch('/api/memory/index/' + (m._raw?.id || m.id), { method: 'DELETE', credentials: 'same-origin' });
      setMemories(prev => prev.filter(x => (x._raw?.id || x.id) !== (m._raw?.id || m.id)));
      if (activeRaw && (activeRaw._raw?.id || activeRaw.id) === (m._raw?.id || m.id)) setActive(null);
    } catch (e) { alert('Failed: ' + e.message); }
  };

  if (memories.length === 0 && !loading) {
    return (
      <div className="page">
        <PageHeader title="Memory" subtitle="Neural archive · salience · promotion" right={<>
          <button className="nc-btn ghost" onClick={() => loadMemories(true)}><Icon name="refresh" size={12}/> Refresh</button>
        </>}/>
        <MemoryImport />
        <div className="nc-panel" style={{ padding: 40, textAlign: 'center' }}>
          <div className="mono muted">No memories yet — they appear automatically after assistant turns</div>
        </div>
      </div>
    );
  }

  return (
    <div className="page memory-page">
      <PageHeader title="Memory" subtitle="Neural archive · salience · promotion" right={<>
        <div className="page-header-search">
          <Icon name="search" size={14}/>
          <input placeholder="Search memories…" value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
        <button className="nc-btn ghost" onClick={() => loadMemories(true)}><Icon name="refresh" size={12}/> Refresh</button>
      </>}/>

      <MemoryImport />

      <div className="memory-layout">
        {/* Left sidebar: type filters */}
        <aside className="memory-sidebar hide-mobile">
          <div className="label-tiny" style={{ marginBottom: 10 }}>Types</div>
          {types.map(t => (
            <div key={t} onClick={() => setFilter(t)} className={`memory-filter-row ${filter === t ? 'active' : ''}`}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name={typeIcons[t] || 'memory'} size={14}/>
                <span>{t.replace(/_/g, ' ')}</span>
              </span>
              <span className="mono memory-filter-count">{getTypeCount(t)}</span>
            </div>
          ))}
          <div className="memory-loaded-count">
            <div className="label-tiny">Loaded</div>
            <div className="mono" style={{ fontSize: 12, color: 'var(--accent)', marginTop: 4 }}>{memories.length} / {totalCount}</div>
          </div>
        </aside>

        {/* Center: memory list */}
        <div className="memory-main">
          <div className="memory-list">
            {list.map(m => (
              <div
                key={m._raw?.id || m.id}
                className={`memory-row ${active && (active._raw?.id || active.id) === (m._raw?.id || m.id) ? 'active' : ''}`}
                onClick={() => setActive(m)}
              >
                <div className="memory-row-header">
                  <span className={`tag ${m.type === 'preference' ? 'accent' : m.type === 'insight' ? 'accent' : m.type === 'procedural' ? 'accent' : 'muted'}`}>{m.type}</span>
                  <span className="mono muted" style={{ fontSize: 10 }}>{m.id}</span>
                </div>
                <div className="memory-row-title">{m.title}</div>
                <div className="memory-row-summary">{m.summary}</div>
                <div className="memory-row-meta">
                  <span className="mono muted">@{m.agent}</span>
                  <span className="mono muted">{m.lastSeen}</span>
                </div>
                <div className="memory-row-bars">
                  <div>
                    <div className="label-tiny" style={{ fontSize: 8 }}>Importance</div>
                    <div className="bar-track"><div className="bar-fill" style={{ width: `${m.importance*100}%` }}/></div>
                  </div>
                  <div>
                    <div className="label-tiny" style={{ fontSize: 8 }}>Salience</div>
                    <div className="bar-track"><div className="bar-fill" style={{ width: `${m.salience*100}%`, opacity: 0.8 }}/></div>
                  </div>
                </div>
              </div>
            ))}

            <div ref={loaderRef} className="memory-loader">
              {loading && <span className="mono muted">loading more…</span>}
              {!loading && hasMore && <span className="mono muted">scroll for more</span>}
              {!loading && !hasMore && memories.length > 0 && <span className="mono muted">— all {memories.length} memories loaded —</span>}
            </div>
          </div>
        </div>

        {/* Right: inspector */}
        {active && (
          <aside className="memory-inspector hide-tablet">
            <div className="label-tiny" style={{ marginBottom: 14 }}>Memory inspector</div>
            <div className="memory-inspector-title">{active.title}</div>
            <div className="mono muted" style={{ fontSize: 11, marginBottom: 14 }}>{active.id} · {active.type}</div>
            <div className="memory-inspector-summary">{active.summary}</div>
            <div className="memory-inspector-tags">
              {active.tags.map(t => <span key={t} className="tag muted" style={{ fontSize: 9 }}>#{t}</span>)}
            </div>

            {[
              ['Importance', active.importance, 'var(--accent)'],
              ['Salience', active.salience, 'var(--success)'],
            ].map(([l, v, c], i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div className="mono" style={{ fontSize: 10, display: 'flex', justifyContent: 'space-between', color: 'var(--text-tertiary)' }}>
                  <span>{l}</span><span>{(v*100).toFixed(0)}%</span>
                </div>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${v*100}%`, background: c }}/></div>
              </div>
            ))}

            <div className="memory-inspector-meta">
              <div><span className="muted">backend:</span> <span style={{ color: 'var(--accent)' }}>supabase pgvector</span></div>
              <div><span className="muted">agent:</span> @{active.agent}</div>
              <div><span className="muted">state:</span> {active.state}</div>
              <div><span className="muted">last:</span> {active.lastSeen}</div>
            </div>

            <button className="nc-btn danger" style={{ width: '100%', marginTop: 14, fontSize: 11 }} onClick={() => onDelete(active)}>
              Delete memory
            </button>
          </aside>
        )}
      </div>
    </div>
  );
};
window.Memory = Memory;
