/* Media — the generated-video gallery (Studio › Media). Plays every video the
 * forge renders (HyperFrames / Remotion), stored in Cloudflare R2 and streamed
 * via short-lived presigned URLs. Renders auto-register on dispatch; agents can
 * also push a video with the register_media tool. The human views, copies the
 * URL, downloads, or deletes here. Backed by /api/media/* (kind=video). */

const mediaApi = (path, method, body) =>
  fetch(path, { method: method || 'GET', credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json().catch(() => ({ ok: r.ok })));

const fmtWhen = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const fmtSize = (bytes) => {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
};

const Media = () => {
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState(null);

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 4000); };

  const load = React.useCallback(async () => {
    const r = await mediaApi('/api/media?kind=video');
    setItems(Array.isArray(r.items) ? r.items : []);
    setLoading(false);
  }, []);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  const filtered = items;

  const onCopy = async (item) => {
    try {
      await navigator.clipboard.writeText(item.url);
      flash('Copied URL');
    } catch (e) {
      flash('Copy failed', false);
    }
  };

  const onDownload = (id) => {
    window.open(`/api/media/${id}/download`, '_blank');
  };

  const onDelete = async (id) => {
    if (!confirm('Delete this media? This removes it from storage and cannot be undone.')) return;
    const r = await mediaApi(`/api/media/${id}`, 'DELETE');
    if (r.ok) {
      setItems(prev => prev.filter(i => i.id !== id));
      flash('Deleted');
    } else {
      flash(r.error ? `Delete failed: ${r.error}` : 'Delete failed', false);
    }
  };

  const cardStyle = { border: '1px solid var(--line-soft)', borderRadius: 8, overflow: 'hidden', background: 'rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column' };
  const footerStyle = { padding: '10px 12px', borderTop: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 };

  return (
    <div>
      <PageHeader
        title="Media"
        subtitle="// rendered video gallery · HyperFrames / Remotion · stored in R2"
        right={<>
          <button className="nc-btn" onClick={load} style={{ fontSize: 11, padding: '4px 8px' }}><Icon name="refresh" size={12}/> Refresh</button>
        </>}
      />
      {msg && <div className="nc-panel" style={{ padding: '8px 12px', marginBottom: 12, borderColor: msg.ok ? 'var(--accent-2)' : 'var(--danger)' }}>
        <span className="mono" style={{ fontSize: 12, color: msg.ok ? 'var(--accent-2)' : 'var(--danger)' }}>{msg.text}</span>
      </div>}
      {loading ? <div className="mono muted" style={{ padding: 24 }}>loading media…</div> : (
        <div className="nc-panel glow tilt" style={{ padding: 12 }}>
          {filtered.length === 0 ? (
            <div className="mono muted" style={{ padding: 32, textAlign: 'center' }}>
              <div style={{ marginBottom: 8 }}>No videos yet.</div>
              <div className="muted" style={{ fontSize: 12 }}>Renders from the forge (HyperFrames / Remotion) auto-register here; agents can also push a video via the <span className="neonc">register_media</span> tool.</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 }}>
              {filtered.map(item => (
                <div key={item.id} style={cardStyle}>
                  <div style={{ background: 'rgba(0,0,0,0.25)', minHeight: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <video
                      src={item.url}
                      controls
                      preload="metadata"
                      style={{ width: '100%', maxHeight: 200, display: 'block' }}
                    />
                  </div>
                  <div style={footerStyle}>
                    <div className="mono" style={{ fontSize: 12, color: 'var(--text-soft)', lineHeight: 1.35, wordBreak: 'break-word' }}>
                      {item.title || (item.prompt ? item.prompt.slice(0, 90) + (item.prompt.length > 90 ? '…' : '') : 'Untitled')}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                      <span className="tag mono" style={{ fontSize: 10, textTransform: 'uppercase' }}>{item.kind}</span>
                      {item.source_tool && <span className="tag mono" style={{ fontSize: 10 }}>{item.source_tool}</span>}
                      {item.author && <span className="tag mono" style={{ fontSize: 10 }}>@{item.author}</span>}
                      <span className="mono muted" style={{ fontSize: 10, marginLeft: 'auto' }}>{fmtWhen(item.created_at)} {fmtSize(item.size)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 'auto' }}>
                      <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 6px', flex: 1 }} onClick={() => onCopy(item)}>📋 Copy</button>
                      <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 6px', flex: 1 }} onClick={() => onDownload(item.id)}>⬇ Download</button>
                      <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 6px', color: 'var(--danger)' }} onClick={() => onDelete(item.id)}>✕</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

window.Media = Media;
