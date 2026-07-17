/* Gallery — agent-generated image archive.
 *
 * Reads from /api/gallery (SQLite metadata + fresh Supabase signed URLs).
 * Renders a responsive grid, supports lightbox view, and paginates via
 * limit/offset. Bytes live in the private 'agent-images' bucket; the backend
 * mints signed URLs so the service key never reaches the browser.
 */

const PAGE_SIZE = 48;

function formatBytes(n) {
  if (!n || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Force a real file download. Hits the backend /download endpoint (same-origin,
// Content-Disposition: attachment) rather than the cross-origin signed URL —
// the HTML download attr is ignored cross-origin, so a signed-URL link would
// just open the image in a tab instead of saving it.
function downloadImage(item) {
  if (!item?.id) return;
  const tok = window.NC_API?.token;
  const tq  = tok ? `?token=${encodeURIComponent(tok)}` : '';
  const a = document.createElement('a');
  a.href = `/api/gallery/${item.id}/download${tq}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function makeQuery({ limit, offset, agent, session }) {
  const q = new URLSearchParams();
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  if (agent) q.set('agent', agent);
  if (session) q.set('session', session);
  return `/api/gallery?${q.toString()}`;
}

const Lightbox = ({ item, onClose, onPrev, onNext, hasPrev, hasNext }) => {
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && hasPrev) onPrev();
      if (e.key === 'ArrowRight' && hasNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext, hasPrev, hasNext]);

  if (!item) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,4,12,0.94)', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--line-soft)' }}>
        <span className="label-tiny" style={{ color: 'var(--accent)' }}>// IMAGE · {item.id.slice(0, 8)}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="nc-btn" onClick={() => downloadImage(item)} style={{ fontSize: 11 }}>⤓ download</button>
          <button className="nc-btn" onClick={onClose} style={{ fontSize: 11 }}>✕ close</button>
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden', padding: 16 }}>
        {item.url ? (
          <img
            src={item.url}
            alt={item.alt || item.prompt}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 3, boxShadow: '0 0 30px color-mix(in srgb, var(--accent) 15%, transparent)' }}
          />
        ) : (
          <div className="mono muted" style={{ fontSize: 12 }}>// signed URL unavailable</div>
        )}
        {hasPrev && (
          <button onClick={onPrev} className="nc-btn ghost" style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', fontSize: 18, padding: '8px 12px' }}>‹</button>
        )}
        {hasNext && (
          <button onClick={onNext} className="nc-btn ghost" style={{ position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', fontSize: 18, padding: '8px 12px' }}>›</button>
        )}
      </div>
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--line-soft)', display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <div>
          <div className="label-tiny" style={{ fontSize: 9 }}>PROMPT</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4, lineHeight: 1.5 }}>{item.prompt}</div>
        </div>
        <div>
          <div className="label-tiny" style={{ fontSize: 9 }}>AGENT</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--accent-2)', marginTop: 4 }}>@{item.agent_name || '—'}</div>
        </div>
        <div>
          <div className="label-tiny" style={{ fontSize: 9 }}>SOURCE</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4 }}>{item.source_tool}</div>
        </div>
        <div>
          <div className="label-tiny" style={{ fontSize: 9 }}>MODEL</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4 }}>{item.model || '—'}</div>
        </div>
        <div>
          <div className="label-tiny" style={{ fontSize: 9 }}>META</div>
          <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>{formatBytes(item.bytes)} · {formatDate(item.created_at)}</div>
        </div>
        {item.session_id && (
          <div>
            <div className="label-tiny" style={{ fontSize: 9 }}>SESSION</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4 }}>{item.session_id.slice(0, 8)}</div>
          </div>
        )}
      </div>
    </div>
  );
};

const Gallery = () => {
  const [items, setItems] = React.useState([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [offset, setOffset] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(true);
  const [filterAgent, setFilterAgent] = React.useState('');
  const [filterSession, setFilterSession] = React.useState('');
  const [lightboxIndex, setLightboxIndex] = React.useState(null);
  const loaderRef = React.useRef(null);

  // ── Upload (single image or a whole folder) ──────────────────────────────
  const [uploading, setUploading] = React.useState(false);
  const [uploadNote, setUploadNote] = React.useState('');
  const [uploadStat, setUploadStat] = React.useState({ done: 0, total: 0, failed: 0 });
  const fileInputRef = React.useRef(null);
  const folderInputRef = React.useRef(null);

  // webkitdirectory is a non-standard attribute React won't reliably emit —
  // set it on the DOM node directly so the folder picker actually recurses.
  React.useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute('webkitdirectory', '');
      folderInputRef.current.setAttribute('directory', '');
    }
  }, []);

  const load = React.useCallback(async (reset = false) => {
    if (loading) return;
    const nextOffset = reset ? 0 : offset;
    if (!reset && !hasMore) return;

    setLoading(true);
    setError(null);
    try {
      const data = await window.NC_API.get(makeQuery({
        limit: PAGE_SIZE,
        offset: nextOffset,
        agent: filterAgent,
        session: filterSession,
      }));
      const fetched = data?.items || [];
      setTotal(data?.total || 0);
      if (reset) {
        setItems(fetched);
        setOffset(PAGE_SIZE);
      } else {
        setItems(prev => [...prev, ...fetched]);
        setOffset(prev => prev + PAGE_SIZE);
      }
      setHasMore(fetched.length === PAGE_SIZE);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [loading, offset, hasMore, filterAgent, filterSession]);

  // Upload a FileList (from the image picker or a folder picker). Images are
  // filtered client-side, then POSTed to /api/gallery/upload in small batches
  // so a big folder doesn't create one giant request body. Refreshes on done.
  const doUpload = React.useCallback(async (fileList) => {
    // Accept by MIME when the browser provides it, else fall back to the file
    // extension — folder (webkitdirectory) uploads and some OS/browser combos
    // leave file.type empty even for obvious images.
    const IMAGE_EXT = /\.(png|jpe?g|jfif|gif|webp|bmp|svg|avif|heic|heif|tiff?|ico)$/i;
    const isImageFile = (f) => (f.type && f.type.startsWith('image/')) || IMAGE_EXT.test(f.name || '');
    const all = Array.from(fileList || []).filter(isImageFile);
    if (all.length === 0) { setError('No image files in the selection'); return; }

    setUploading(true);
    setError(null);
    setUploadStat({ done: 0, total: all.length, failed: 0 });

    const BATCH = 6;
    const tok = window.NC_API?.token;
    const tq  = tok ? `?token=${tok}` : '';
    let done = 0, failed = 0;
    try {
      for (let i = 0; i < all.length; i += BATCH) {
        const chunk = all.slice(i, i + BATCH);
        const form = new FormData();
        chunk.forEach(f => form.append('file', f));
        if (uploadNote.trim()) form.append('note', uploadNote.trim());
        const res = await fetch(`/api/gallery/upload${tq}`, { method: 'POST', body: form, credentials: 'same-origin' });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) { failed += chunk.length; }
        else { done += (json.uploaded || 0); failed += (json.failed || 0); }
        setUploadStat({ done: done + failed, total: all.length, failed });
      }
      if (failed > 0) setError(`${failed} of ${all.length} file(s) failed to upload`);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setUploading(false);
      load(true); // pull the freshly-archived images into the grid
    }
  }, [uploadNote, load]);

  const onPick = (e) => {
    // Materialize a real array BEFORE clearing the input — `e.target.files` is a
    // live FileList, and resetting `value` empties it, which would drop every
    // file on the floor (the "No image files in the selection" bug).
    const f = Array.from(e.target.files || []);
    e.target.value = '';
    doUpload(f);
  };

  // Initial load + refetch when filters change
  React.useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterAgent, filterSession]);

  // Infinite scroll
  React.useEffect(() => {
    if (!loaderRef.current) return;
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting && hasMore && !loading) load(false); },
      { threshold: 0.1 }
    );
    observer.observe(loaderRef.current);
    return () => observer.disconnect();
  }, [hasMore, loading, load]);

  // Agent filter options derived from loaded items (plus the active filter if not present)
  const agents = React.useMemo(() => {
    const map = new Map();
    items.forEach(it => { if (it.agent_id) map.set(it.agent_id, it.agent_name || it.agent_id.slice(0, 8)); });
    if (filterAgent && !map.has(filterAgent)) map.set(filterAgent, filterAgent.slice(0, 8));
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [items, filterAgent]);

  const lightboxItem = lightboxIndex != null ? items[lightboxIndex] : null;

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader
        title="Gallery"
        subtitle={`// agent-generated images · ${total.toLocaleString()} archived`}
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {agents.length > 0 && (
              <select
                className="nc-input mono"
                value={filterAgent}
                onChange={e => setFilterAgent(e.target.value)}
                style={{ fontSize: 11, padding: '6px 8px', minWidth: 140 }}
              >
                <option value="">all agents</option>
                {agents.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            )}
            <input
              className="nc-input mono"
              placeholder="session id…"
              value={filterSession}
              onChange={e => setFilterSession(e.target.value.trim())}
              style={{ fontSize: 11, padding: '6px 8px', width: 140 }}
            />
            <button className="nc-btn" onClick={() => load(true)} disabled={loading} style={{ fontSize: 11 }}>
              <Icon name="refresh" size={12}/> Refresh
            </button>
          </div>
        }
      />

      {/* Upload bar — single image or a whole folder */}
      <div className="nc-panel" style={{ padding: 10, marginBottom: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="label-tiny" style={{ color: 'var(--accent)' }}>UPLOAD</span>
        <input
          className="nc-input mono"
          placeholder="note / description for these images (optional)…"
          value={uploadNote}
          onChange={e => setUploadNote(e.target.value)}
          disabled={uploading}
          style={{ fontSize: 11, padding: '6px 8px', flex: 1, minWidth: 180 }}
        />
        <button className="nc-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading} style={{ fontSize: 11 }}>
          <Icon name="image" size={12}/> Image(s)
        </button>
        <button className="nc-btn" onClick={() => folderInputRef.current?.click()} disabled={uploading} style={{ fontSize: 11 }}>
          ▤ Folder
        </button>
        {uploading && (
          <span className="mono" style={{ fontSize: 11, color: 'var(--accent-2)' }}>
            uploading {uploadStat.done}/{uploadStat.total}{uploadStat.failed > 0 ? ` · ${uploadStat.failed} failed` : ''}…
          </span>
        )}
        <input ref={fileInputRef}   type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onPick} />
        <input ref={folderInputRef} type="file" multiple                style={{ display: 'none' }} onChange={onPick} />
      </div>

      {error && (
        <div className="nc-panel" style={{ padding: 12, marginBottom: 14, borderColor: 'var(--danger)' }}>
          <div className="mono" style={{ fontSize: 11, color: 'var(--danger)' }}>! {error}</div>
        </div>
      )}

      {items.length === 0 && !loading && (
        <div className="st-panel" style={{ padding: 40, textAlign: 'center' }}>
          <Icon name="image" size={48} className="neonc" style={{ opacity: 0.6 }}/>
          <div className="mono muted" style={{ marginTop: 14, fontSize: 12 }}>// no archived images yet</div>
          <div className="mono muted" style={{ marginTop: 4, fontSize: 10 }}>agent-generated images land here automatically — or upload your own above</div>
        </div>
      )}

      {items.length > 0 && (
        <div className="st-grid" style={{ alignContent: 'start' }}>
          {items.map((it, idx) => (
            <div
              key={it.id}
              className="st-card"
              onClick={() => setLightboxIndex(idx)}
              style={{
                padding: 8, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8,
                position: 'relative', overflow: 'hidden',
              }}
            >
              <button
                className="nc-btn"
                title="download"
                onClick={(e) => { e.stopPropagation(); downloadImage(it); }}
                style={{
                  position: 'absolute', top: 12, right: 12, zIndex: 3,
                  fontSize: 13, lineHeight: 1, padding: '4px 7px',
                  background: 'rgba(0,4,12,0.7)', backdropFilter: 'blur(2px)',
                }}
              >⤓</button>
              <div style={{
                aspectRatio: '1 / 1', background: 'rgba(0,4,12,0.5)', borderRadius: 3,
                display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                border: '1px solid var(--line-soft)',
              }}>
                {it.url ? (
                  <img
                    src={it.url}
                    alt={it.alt || it.prompt}
                    loading="lazy"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <div className="mono muted" style={{ fontSize: 10, textAlign: 'center', padding: 8 }}>// url unavailable</div>
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)', lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {it.prompt || '(no prompt)'}
                </div>
                <div className="mono muted" style={{ fontSize: 9, marginTop: 6, display: 'flex', justifyContent: 'space-between' }}>
                  <span>@{it.agent_name || '—'}</span>
                  <span>{formatBytes(it.bytes)}</span>
                </div>
                <div className="mono muted" style={{ fontSize: 9, marginTop: 2, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                  <span style={{ color: 'var(--accent-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.model || '—'}</span>
                  <span style={{ flexShrink: 0 }}>{formatDate(it.created_at)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div ref={loaderRef} style={{ padding: 24, textAlign: 'center' }}>
        {loading && <div className="mono muted" style={{ fontSize: 11 }}>loading…</div>}
        {!loading && hasMore && items.length > 0 && <div className="mono muted" style={{ fontSize: 10 }}>scroll for more</div>}
        {!loading && !hasMore && items.length > 0 && <div className="mono muted" style={{ fontSize: 10 }}>— {items.length} of {total} images loaded —</div>}
      </div>

      {lightboxItem && (
        <Lightbox
          item={lightboxItem}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => setLightboxIndex(i => Math.max(0, i - 1))}
          onNext={() => setLightboxIndex(i => Math.min(items.length - 1, i + 1))}
          hasPrev={lightboxIndex > 0}
          hasNext={lightboxIndex < items.length - 1}
        />
      )}
    </div>
  );
};

window.Gallery = Gallery;
