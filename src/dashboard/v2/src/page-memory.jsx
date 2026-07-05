/* Memory page (live-wired) with infinite scroll */
const PAGE_SIZE = 100;

const IMPORT_SOURCES = [
  { id: 'chatgpt',    label: 'ChatGPT',     hint: 'conversations.json' },
  { id: 'claude_code', label: 'Claude Code', hint: '.json / .jsonl' },
  { id: 'gemini',     label: 'Gemini',       hint: 'Gemini Apps Activity.json' },
  { id: 'generic',    label: 'Generic',      hint: '{role,content}[] or {user,assistant}[]' },
];

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
    setSummary(null);
    setError(null);

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
      try { await window.NC_API.del(`/api/memory/import/${activeId}`); } catch { /* non-fatal */ }
      setActiveId(null);
    }
    setStatus(null);
  };

  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  return (
    <div className="nc-panel" style={{ marginBottom: 16 }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', cursor: 'pointer' }}
        onClick={() => setOpen(o => !o)}
      >
        <span className="mono" style={{ fontSize: 12, letterSpacing: 1 }}>// IMPORT MEMORIES</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
      </div>

      {open && (
        <div style={{ padding: '0 16px 16px' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {IMPORT_SOURCES.map(s => (
              <button
                key={s.id}
                className={`nc-btn${source === s.id ? ' active' : ''}`}
                onClick={() => setSource(s.id)}
                disabled={status === 'running'}
                title={s.hint}
                style={{ fontSize: 11 }}
              >{s.label}</button>
            ))}
          </div>

          {status !== 'running' && (
            <div
              onDrop={handleDrop}
              onDragOver={e => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onClick={() => document.getElementById('nc-import-file').click()}
              style={{
                border: `1px dashed ${dragging ? 'var(--nc-accent)' : 'var(--nc-border)'}`,
                borderRadius: 6, padding: 20, textAlign: 'center', cursor: 'pointer',
                marginBottom: 12,
                background: dragging ? 'var(--nc-surface-alt)' : 'transparent',
                transition: 'all 0.15s',
              }}
            >
              <div className="mono muted" style={{ fontSize: 12 }}>
                {dragging ? 'drop to import' : 'drag & drop or click to select file'}
              </div>
              <div className="mono muted" style={{ fontSize: 10, marginTop: 4 }}>
                {IMPORT_SOURCES.find(s => s.id === source)?.hint}
              </div>
              <input id="nc-import-file" type="file" accept=".json,.jsonl" style={{ display: 'none' }} onChange={handleFileInput} />
            </div>
          )}

          {status === 'running' && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span className="mono" style={{ fontSize: 11 }}>{progress.processed} / {progress.total} exchanges</span>
                <span className="mono" style={{ fontSize: 11 }}>{progress.created} stored · {progress.skipped} skipped</span>
              </div>
              <div style={{ height: 4, background: 'var(--nc-border)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: 'var(--nc-accent)', transition: 'width 0.3s' }} />
              </div>
              <div style={{ marginTop: 8, textAlign: 'right' }}>
                <button className="nc-btn" onClick={handleCancel} style={{ fontSize: 11 }}>Cancel</button>
              </div>
            </div>
          )}

          {status === 'done' && summary && (
            <div className="nc-panel glow" style={{ padding: '10px 14px', marginBottom: 12, borderColor: 'var(--nc-accent)' }}>
              <span className="mono" style={{ fontSize: 12 }}>
                // {summary.created} memories extracted from {summary.total} exchanges · {summary.skipped} skipped
              </span>
            </div>
          )}

          {status === 'failed' && error && (
            <div className="nc-panel" style={{ padding: '10px 14px', marginBottom: 12, borderColor: '#ef4444' }}>
              <span className="mono" style={{ fontSize: 11, color: '#ef4444' }}>{error}</span>
            </div>
          )}

          {pastImports.length > 0 && (
            <div>
              <div className="mono muted" style={{ fontSize: 10, marginBottom: 6 }}>// recent imports</div>
              {pastImports.map(imp => (
                <div key={imp.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--nc-border)' }}>
                  <span className="mono muted" style={{ fontSize: 10 }}>{imp.filename} · {imp.source}</span>
                  <span className="mono" style={{ fontSize: 10, color: imp.status === 'done' ? 'var(--nc-accent)' : imp.status === 'failed' ? '#ef4444' : 'inherit' }}>
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

  // Initial load and filter/search changes
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
        type: m.type || 'unknown',
        title: m.title || '(untitled)',
        summary: m.summary || '',
        tags: m.tags ? m.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        importance: m.importance ?? 0.5,
        salience: m.salience ?? 0.5,
        agent: m.agent_id?.slice(0, 8) || '—',
        state: (m.salience ?? 0.5) > 0.3 ? 'active' : 'low-salience',
        lastSeen: m.last_accessed ? new Date(m.last_accessed).toLocaleDateString() : new Date(m.created_at).toLocaleDateString(),
        decay: false,
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

  // Load on mount and when filter changes
  React.useEffect(() => {
    loadMemories(true);
  }, [filter]);

  // Infinite scroll observer
  React.useEffect(() => {
    if (!loaderRef.current) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          loadMemories(false);
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(loaderRef.current);
    return () => observer.disconnect();
  }, [hasMore, loading, offset]);

  // Set first memory as active
  React.useEffect(() => {
    if (memories.length > 0 && !activeRaw) setActive(memories[0]);
  }, [memories]);

  const empty = memories.length === 0 && !loading;

  if (empty) {
    return (
      <div>
        <PageHeader title="Memory" subtitle="// supabase pgvector · salience · recall" right={<>
          <button className="nc-btn" onClick={() => loadMemories(true)}><Icon name="refresh" size={12}/> Refresh</button>
        </>}/>
        <MemoryImport />
        <div className="nc-panel glow" style={{ padding: 30, textAlign: 'center' }}>
          <div className="mono muted">// no memories yet — they appear automatically after assistant turns</div>
        </div>
      </div>
    );
  }

  const active = activeRaw || memories[0];
  const types = ['all','working','episodic','semantic','procedural','preference','insight','session_summary','project','plan'];

  // Filter by search (client-side on loaded memories)
  const list = memories.filter(m => !search || (m.title + ' ' + m.summary).toLowerCase().includes(search.toLowerCase()));

  const onDelete = async (m) => {
    if (!confirm(`Delete memory "${m.title}"? This removes it from long-term memory.`)) return;
    try {
      await fetch('/api/memory/index/' + (m._raw?.id || m.id), { method: 'DELETE', credentials: 'same-origin' });
      setMemories(prev => prev.filter(x => (x._raw?.id || x.id) !== (m._raw?.id || m.id)));
      if (activeRaw && (activeRaw._raw?.id || activeRaw.id) === (m._raw?.id || m.id)) setActive(null);
    } catch (e) { alert('Failed: ' + e.message); }
  };

  // Get type counts from MEM_STATS if available
  const getTypeCount = (t) => {
    if (t === 'all') return totalCount;
    if (MEM_STATS?.byType) {
      const found = MEM_STATS.byType.find(x => x.type === t);
      return found?.n ?? 0;
    }
    return memories.filter(m => m.type === t).length;
  };

  return (
    <div>
      <PageHeader title="Memory" subtitle="// neural archive · salience · promotion" right={<>
        <input className="nc-input" placeholder="search…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 200 }}/>
        <button className="nc-btn" onClick={() => loadMemories(true)}><Icon name="refresh" size={12}/> Refresh</button>
      </>}/>
      <MemoryImport />

      <div className="stack" style={{ gap: 12 }}>
        {/* Type filters - collapsible on mobile */}
        <div className="nc-panel glow hide-mobile" style={{ padding: 12, minWidth: 180, flex: '0 0 180px' }}>
          <div className="label-tiny neonc" style={{ marginBottom: 10 }}>TYPES</div>
          {types.map(t => (
            <div key={t} onClick={() => setFilter(t)} style={{ padding: '7px 10px', borderRadius: 2, cursor: 'pointer', background: filter === t ? 'rgba(0,183,255,0.12)' : 'transparent', border: filter === t ? '1px solid var(--line-hard)' : '1px solid transparent', marginBottom: 3, fontFamily: 'var(--mono)', fontSize: 11, color: filter === t ? '#fff' : 'var(--text-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{t}</span>
              <span className="mono muted" style={{ fontSize: 9 }}>{getTypeCount(t)}</span>
            </div>
          ))}
          <hr className="nc-hr" style={{ margin: '12px 0' }}/>
          <div className="label-tiny" style={{ marginBottom: 8 }}>LOADED</div>
          <div className="mono" style={{ fontSize: 11, padding: '4px 6px', color: 'var(--accent-2)' }}>{memories.length} / {totalCount}</div>
        </div>

        {/* Cards */}
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10, alignContent: 'start' }}>
          {list.map(m => {
            const dim = m.decay;
            return (
              <div key={m._raw?.id || m.id} className="nc-panel glow tilt" onClick={() => setActive(m)} style={{ padding: 12, cursor: 'pointer', opacity: dim ? 0.55 : 1, position: 'relative', boxShadow: m.salience > 0.7 ? '0 0 0 1px var(--accent), 0 0 20px rgba(0,183,255,0.25)' : undefined }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span className={`tag ${m.type === 'preference' ? 'violet' : m.type === 'insight' ? 'cyan' : m.type === 'procedural' ? 'blue' : 'muted'}`} style={{ fontSize: 9 }}>{m.type}</span>
                  <span className="mono muted" style={{ fontSize: 9 }}>{m.id}</span>
                </div>
                <div className="mono" style={{ fontSize: 12, color: '#fff', marginBottom: 4, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <span>{m.title}</span>
                </div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)', lineHeight: 1.5, marginBottom: 8 }}>{m.summary}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 6 }}>
                  <div>
                    <div className="label-tiny" style={{ fontSize: 8 }}>IMPORTANCE</div>
                    <div className="bar-track" style={{ marginTop: 3 }}><div className="bar-fill" style={{ width: `${m.importance*100}%` }}/></div>
                  </div>
                  <div>
                    <div className="label-tiny" style={{ fontSize: 8 }}>SALIENCE</div>
                    <div className="bar-track" style={{ marginTop: 3 }}><div className="bar-fill" style={{ width: `${m.salience*100}%`, background: 'linear-gradient(90deg, var(--accent-2), var(--violet))' }}/></div>
                  </div>
                </div>
                <div className="mono muted" style={{ fontSize: 9, display: 'flex', justifyContent: 'space-between' }}>
                  <span>@{m.agent}</span><span>{m.lastSeen}</span>
                </div>
              </div>
            );
          })}

          {/* Infinite scroll loader */}
          <div ref={loaderRef} style={{ gridColumn: '1 / -1', padding: 20, textAlign: 'center' }}>
            {loading && <div className="mono muted" style={{ fontSize: 11 }}>loading more...</div>}
            {!loading && hasMore && <div className="mono muted" style={{ fontSize: 10 }}>scroll for more</div>}
            {!loading && !hasMore && memories.length > 0 && <div className="mono muted" style={{ fontSize: 10 }}>— all {memories.length} memories loaded —</div>}
          </div>
        </div>

        {/* Inspector - hidden on mobile, visible on tablet+ */}
        {active && (
          <div className="nc-panel glow hide-tablet" style={{ padding: 14, alignSelf: 'start', position: 'sticky', top: 0, minWidth: 280, maxWidth: 320 }}>
            <div className="label-tiny neonc" style={{ marginBottom: 10 }}>MEMORY INSPECTOR</div>
            <div className="mono" style={{ fontSize: 12, color: '#fff', marginBottom: 4, display: 'flex', gap: 6 }}>
              {active.title}
            </div>
            <div className="mono muted" style={{ fontSize: 10, marginBottom: 10 }}>{active.id} · {active.type}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.6, marginBottom: 12 }}>{active.summary}</div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}>
              {active.tags.map(t => <span key={t} className="tag" style={{ fontSize: 9 }}>#{t}</span>)}
            </div>
            {[
              ['IMPORTANCE', active.importance, 'var(--accent)'],
              ['SALIENCE', active.salience, 'var(--accent-2)'],
            ].map(([l, v, c], i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div className="mono" style={{ fontSize: 10, display: 'flex', justifyContent: 'space-between', color: 'var(--text-soft)' }}><span>{l}</span><span>{(v*100).toFixed(0)}%</span></div>
                <div className="bar-track" style={{ marginTop: 3 }}><div className="bar-fill" style={{ width: `${v*100}%`, background: `linear-gradient(90deg, ${c}, var(--accent-2))` }}/></div>
              </div>
            ))}
            <hr className="nc-hr" style={{ margin: '12px 0' }}/>
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)', lineHeight: 1.7 }}>
              <div><span className="muted">backend:</span> <span className="neonc">supabase pgvector</span></div>
              <div><span className="muted">agent:</span> @{active.agent}</div>
              <div><span className="muted">state:</span> {active.state}</div>
              <div><span className="muted">last:</span> {active.lastSeen}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
              <button className="nc-btn ghost" style={{ flex: 1, fontSize: 10, color: 'var(--danger)' }} onClick={() => onDelete(active)}>Delete</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
window.Memory = Memory;
