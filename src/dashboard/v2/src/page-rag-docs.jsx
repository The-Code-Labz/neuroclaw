/* RAG Docs — browse the Supabase knowledge base (neuroclaw_kb).
 * Left: every indexed source (like Archon's KB list). Click → right pane lists
 * that source's pages/chunks with content + embedding status. */

const RAGChunk = ({ p }) => {
  const [open, setOpen] = React.useState(false);
  const long = (p.content || '').length > 280;
  const body = open || !long ? p.content : (p.content || '').slice(0, 280) + '…';
  return (
    <div className="nc-panel" style={{ padding: 10, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <a href={p.url} target="_blank" rel="noreferrer" className="mono neonc" style={{ fontSize: 10, wordBreak: 'break-all', textDecoration: 'none' }}>{p.url}</a>
        <div className="mono muted" style={{ fontSize: 9, whiteSpace: 'nowrap', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>chunk {p.chunk_number}</span>
          <span className={`tag ${p.embedding_ready ? 'cyan' : 'muted'}`} style={{ fontSize: 8 }}>
            {p.embedding_ready ? 'embedded' : 'pending'}
          </span>
        </div>
      </div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{body}</div>
      {long && (
        <button className="nc-btn ghost" style={{ fontSize: 9, marginTop: 6, padding: '2px 8px' }} onClick={() => setOpen(o => !o)}>
          {open ? 'show less' : 'show full'}
        </button>
      )}
    </div>
  );
};

const RAGDocs = () => {
  const [enabled, setEnabled] = React.useState(true);
  const [sources, setSources] = React.useState([]);
  const [active, setActive]   = React.useState(null);   // source_id
  const [pages, setPages]     = React.useState([]);
  const [total, setTotal]     = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [pgLoading, setPg]    = React.useState(false);
  const [error, setError]     = React.useState(null);
  const [search, setSearch]   = React.useState('');

  const loadSources = async () => {
    setLoading(true); setError(null);
    try {
      const r = await window.NC_API.get('/api/kb/sources');
      setEnabled(r.enabled !== false);
      setSources(r.sources || []);
      if (r.error) setError(r.error);
    } catch (e) { setError(String(e.message || e)); }
    setLoading(false);
  };

  const loadPages = async (sourceId) => {
    setActive(sourceId); setPages([]); setTotal(0); setPg(true);
    try {
      const r = await window.NC_API.get(`/api/kb/sources/${encodeURIComponent(sourceId)}/pages`);
      setPages(r.pages || []); setTotal(r.total || 0);
    } catch (e) { setError(String(e.message || e)); }
    setPg(false);
  };

  React.useEffect(() => { loadSources(); }, []);

  const list = sources.filter(s => !search ||
    (`${s.title || ''} ${s.source_id}`).toLowerCase().includes(search.toLowerCase()));
  const activeSrc = sources.find(s => s.source_id === active);
  const totalPages = sources.reduce((n, s) => n + (s.page_count || 0), 0);

  return (
    <div>
      <PageHeader title="RAG Docs" subtitle="// knowledge base · neuroclaw_kb · supabase pgvector" right={<>
        <input className="nc-input" placeholder="search sources…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 200 }}/>
        <button className="nc-btn" onClick={loadSources}><Icon name="refresh" size={12}/> Refresh</button>
      </>}/>

      {!enabled && (
        <div className="nc-panel glow" style={{ padding: 16, marginBottom: 12 }}>
          <div className="mono" style={{ fontSize: 12, color: 'var(--text-soft)' }}>
            Knowledge base is disabled. Set <span className="neonc">KB_ENABLED=true</span> and restart to enable RAG document browsing.
          </div>
        </div>
      )}

      {error && (
        <div className="nc-panel" style={{ padding: 12, marginBottom: 12, borderColor: 'var(--danger)' }}>
          <div className="mono" style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</div>
        </div>
      )}

      <div className="mono muted" style={{ fontSize: 10, marginBottom: 12 }}>
        {sources.length} source{sources.length === 1 ? '' : 's'} · {totalPages} page chunk{totalPages === 1 ? '' : 's'} indexed
      </div>

      <div className="stack" style={{ gap: 12, alignItems: 'flex-start' }}>
        {/* Sources list */}
        <div style={{ flex: '0 0 320px', maxWidth: 360, display: 'grid', gap: 8, alignContent: 'start' }}>
          {loading && <div className="mono muted" style={{ fontSize: 11 }}>loading sources…</div>}
          {!loading && enabled && list.length === 0 && (
            <div className="nc-panel" style={{ padding: 14 }}>
              <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.6 }}>
                No documents indexed yet.<br/>
                <span className="muted">Agents add docs with </span><span className="neonc">crawl_and_index</span>
                <span className="muted"> or </span><span className="neonc">index_content</span>.
              </div>
            </div>
          )}
          {list.map(s => (
            <div key={s.source_id} className="nc-panel glow tilt" onClick={() => loadPages(s.source_id)}
              style={{ padding: 12, cursor: 'pointer', position: 'relative',
                boxShadow: active === s.source_id ? '0 0 0 1px var(--accent), 0 0 18px color-mix(in srgb, var(--accent) 22%, transparent)' : undefined }}>
              <div className="mono" style={{ fontSize: 12, color: 'var(--text)', marginBottom: 4, wordBreak: 'break-word' }}>
                {s.title || s.source_id}
              </div>
              <div className="mono muted" style={{ fontSize: 9, marginBottom: 8, wordBreak: 'break-all' }}>{s.source_id}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span className="tag blue" style={{ fontSize: 9 }}>{s.page_count} page{s.page_count === 1 ? '' : 's'}</span>
                {s.code_count > 0 && <span className="tag violet" style={{ fontSize: 9 }}>{s.code_count} code</span>}
                {s.updated_at && <span className="tag muted" style={{ fontSize: 9 }}>{new Date(s.updated_at).toLocaleDateString()}</span>}
              </div>
              {s.summary && <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)', lineHeight: 1.5, marginTop: 8 }}>{s.summary}</div>}
            </div>
          ))}
        </div>

        {/* Pages of the selected source */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!active && enabled && (
            <div className="nc-panel" style={{ padding: 20, textAlign: 'center' }}>
              <div className="mono muted" style={{ fontSize: 11 }}>← select a source to view its indexed pages</div>
            </div>
          )}
          {active && (
            <>
              <div className="nc-panel glow" style={{ padding: 12, marginBottom: 12 }}>
                <div className="label-tiny neonc" style={{ marginBottom: 6 }}>SOURCE</div>
                <div className="mono" style={{ fontSize: 13, color: 'var(--text)', wordBreak: 'break-word' }}>{activeSrc?.title || active}</div>
                <div className="mono muted" style={{ fontSize: 10, marginTop: 4 }}>
                  {active} · {total} chunk{total === 1 ? '' : 's'}
                </div>
              </div>
              {pgLoading && <div className="mono muted" style={{ fontSize: 11, padding: 8 }}>loading pages…</div>}
              {!pgLoading && pages.length === 0 && (
                <div className="mono muted" style={{ fontSize: 11, padding: 8 }}>no pages for this source</div>
              )}
              {pages.map(p => <RAGChunk key={p.id} p={p} />)}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

window.RAGDocs = RAGDocs;
