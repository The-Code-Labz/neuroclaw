/* Artifacts — read-only browse of the agent workspace sandbox
 * (workspaces/<session>/<agent>/). Shows what an agent actually built even when
 * a mid-task error swallowed the chat reply. List workspaces → files → preview. */
const Artifacts = () => {
  const [entries, setEntries]   = React.useState(null); // null = loading
  const [sel, setSel]           = React.useState(null); // { session, agent }
  const [files, setFiles]       = React.useState(null);
  const [preview, setPreview]   = React.useState(null); // { file, data }
  const [err, setErr]           = React.useState('');

  const loadEntries = React.useCallback(async () => {
    setErr('');
    try {
      const r = await fetch('/api/workspace-artifacts', { credentials: 'same-origin' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'failed to load');
      setEntries(j.items);
    } catch (e) { setErr(e.message); setEntries([]); }
  }, []);

  React.useEffect(() => { loadEntries(); }, [loadEntries]);

  const openWorkspace = async (e) => {
    setSel(e); setFiles(null); setPreview(null);
    try {
      const r = await fetch(`/api/workspace-artifacts/${encodeURIComponent(e.session)}/${encodeURIComponent(e.agent)}/files`, { credentials: 'same-origin' });
      const j = await r.json();
      setFiles(j.ok ? j.files : []);
    } catch { setFiles([]); }
  };

  const rawUrl = (f) =>
    `/api/workspace-artifacts/${encodeURIComponent(sel.session)}/${encodeURIComponent(sel.agent)}/raw?path=${encodeURIComponent(f.relPath)}`;

  const openFile = async (f) => {
    setPreview({ file: f, data: null });
    if (f.kind === 'text') {
      try {
        const r = await fetch(`/api/workspace-artifacts/${encodeURIComponent(sel.session)}/${encodeURIComponent(sel.agent)}/file?path=${encodeURIComponent(f.relPath)}`, { credentials: 'same-origin' });
        const j = await r.json();
        setPreview({ file: f, data: j.ok ? j : { content: `Error: ${j.error}`, truncated: false } });
      } catch (e) { setPreview({ file: f, data: { content: `Error: ${e.message}`, truncated: false } }); }
    }
  };

  const fmtBytes = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b/1024).toFixed(1)} KB` : `${(b/1048576).toFixed(1)} MB`;
  const ago = (ms) => {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    if (m < 1440) return `${Math.round(m/60)}h ago`;
    return `${Math.round(m/1440)}d ago`;
  };
  const kindIcon = (k) => ({ text: '📄', image: '🖼', video: '🎬', audio: '🎵', pdf: '📕', binary: '⬢' }[k] || '⬢');

  const prettySession = (s) => s === '_shared' ? '_shared' : s === '_persistent' ? '_persistent' : s.length > 14 ? s.slice(0, 8) + '…' + s.slice(-4) : s;

  return (
    <div>
      <PageHeader title="Artifacts" subtitle="// what agents built — scoped workspace sandbox" right={
        <button className="nc-btn" onClick={loadEntries}><Icon name="refresh" size={12}/> Refresh</button>
      }/>

      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 12 }}>
        {/* Workspace list */}
        <Section title="WORKSPACES">
          {entries === null && <div className="mono muted" style={{ fontSize: 11 }}>Loading…</div>}
          {entries?.length === 0 && <div className="mono muted" style={{ fontSize: 11 }}>No agent output yet.</div>}
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            {entries?.map((e) => {
              const active = sel && sel.session === e.session && sel.agent === e.agent;
              return (
                <div key={`${e.session}/${e.agent}`} onClick={() => openWorkspace(e)}
                     className={active ? 'ob-row ob-active-row' : 'ob-row'}
                     style={{ marginBottom: 2 }}>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--text)' }}>{e.agent}</div>
                  <div className="mono muted" style={{ fontSize: 9 }}>
                    {prettySession(e.session)} · {e.fileCount} file{e.fileCount === 1 ? '' : 's'} · {ago(e.mtime)}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>

        {/* Files + preview */}
        <Section title={sel ? `FILES · ${sel.agent}` : 'FILES'}>
          {!sel && <div className="mono muted" style={{ fontSize: 11 }}>Select a workspace to browse its files.</div>}
          {sel && files === null && <div className="mono muted" style={{ fontSize: 11 }}>Loading files…</div>}
          {sel && files?.length === 0 && <div className="mono muted" style={{ fontSize: 11 }}>Empty.</div>}

          {sel && files && files.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: preview ? '1fr 1.4fr' : '1fr', gap: 12 }}>
              <div style={{ maxHeight: 500, overflowY: 'auto' }}>
                {files.map((f) => {
                  const active = preview && preview.file.relPath === f.relPath;
                  return (
                    <div key={f.relPath} onClick={() => openFile(f)}
                         className={active ? 'ob-row ob-active-row' : 'ob-row'}
                         style={{ display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid var(--line-soft)' }}>
                      <span style={{ fontSize: 12 }}>{kindIcon(f.kind)}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="mono" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.relPath}</div>
                        <div className="mono muted" style={{ fontSize: 9 }}>{fmtBytes(f.bytes)} · {ago(f.mtime)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {preview && (
                <div style={{ minWidth: 0 }}>
                  <div className="mono muted" style={{ fontSize: 9, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview.file.relPath}</span>
                    <a className="nc-btn" href={rawUrl(preview.file)} target="_blank" rel="noreferrer" style={{ fontSize: 9, padding: '2px 6px', textDecoration: 'none', flexShrink: 0 }}>Open ↗</a>
                  </div>
                  {preview.file.kind === 'image' && (
                    <img src={rawUrl(preview.file)} alt={preview.file.name}
                         className="ob-preview-box" style={{ maxWidth: '100%' }}/>
                  )}
                  {preview.file.kind === 'video' && (
                    <video src={rawUrl(preview.file)} controls style={{ maxWidth: '100%', borderRadius: 2 }}/>
                  )}
                  {preview.file.kind === 'audio' && (
                    <audio src={rawUrl(preview.file)} controls style={{ width: '100%' }}/>
                  )}
                  {preview.file.kind === 'pdf' && (
                    <iframe src={rawUrl(preview.file)} title={preview.file.name} style={{ width: '100%', height: 480, border: '1px solid var(--line-soft)', borderRadius: 2 }}/>
                  )}
                  {preview.file.kind === 'text' && (
                    preview.data === null
                      ? <div className="mono muted" style={{ fontSize: 11 }}>Loading…</div>
                      : <>
                          {preview.data.truncated && <div className="mono" style={{ fontSize: 9, color: 'var(--amber)', marginBottom: 4 }}>⚠ truncated to 1 MB</div>}
                          <pre className="mono ob-preview-box" style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 480, overflowY: 'auto', margin: 0, padding: 8 }}>{preview.data.content}</pre>
                        </>
                  )}
                  {preview.file.kind === 'binary' && (
                    <div className="mono muted" style={{ fontSize: 11 }}>Binary file · {fmtBytes(preview.file.bytes)} — use Open ↗ to download.</div>
                  )}
                </div>
              )}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
};

Object.assign(window, { Artifacts });
