/* Studio › Editor — prompt-based image editing workbench.
 *
 * Sits between Generate and Gallery. Takes a source image (handed off from the
 * Generate tab, uploaded, or pasted as a URL) and edits it through any registered
 * edit-capable provider (VoidAI / Abacus / KIE / fal direct-API, plus Grok
 * edit/compose via web session). Provider + model dropdowns render from the
 * server-side manifest so new edit tools appear automatically.
 *
 * Backend contract:
 *   GET  /api/studio/edit-providers → { ok, providers:[{id,label,models[],requiresSession,
 *          healthy,degraded,note,supportsMask,supportsSafety,supportsCompose,resolutions[],safetyLevels[]}], defaultProvider }
 *   POST /api/studio/edit → { ok, images:[{ url, mime }], quota }
 *                      429 → { ok:false, rateLimited:true, error, quota }
 */

function editorSession() {
  let s = localStorage.getItem('nc_studio_session');
  if (!s) {
    s = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('nc_studio_session', s);
  }
  return s;
}

function editorApi(path, method, body) {
  const tok = window.NC_API?.token || new URLSearchParams(location.search).get('token') || '';
  const sep = path.includes('?') ? '&' : '?';
  const qs = tok ? `${sep}token=${encodeURIComponent(tok)}` : '';
  return fetch(`/api/studio/${path}${qs}`, {
    method: method || 'GET',
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
    return { ok: r.ok && data.ok !== false, status: r.status, data };
  });
}

function editModelLabel(id) {
  return String(id || '').replace(/^(fal-ai|google|bytedance|gpt|qwen|ideogram|flux2)\//, '').replace(/[-_/]/g, ' ');
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

const ImageEditor = () => {
  const [providers, setProviders] = React.useState([]);
  const [provider, setProvider] = React.useState('voidai_gpt_image');
  const [models, setModels] = React.useState([]);
  const [model, setModel] = React.useState('');

  const [sourceUrl, setSourceUrl] = React.useState('');   // https URL or data URL
  const [sourceName, setSourceName] = React.useState('');
  const [urlInput, setUrlInput] = React.useState('');
  const [prompt, setPrompt] = React.useState('');

  const [resolution, setResolution] = React.useState('');
  const [safety, setSafety] = React.useState('');
  const [maskUrl, setMaskUrl] = React.useState('');       // gpt-image inpaint (data URL)
  const [secondUrl, setSecondUrl] = React.useState('');   // grok compose (data URL / URL)

  const [status, setStatus] = React.useState('idle');     // idle | loading | success | error | rate-limited
  const [error, setError] = React.useState('');
  const [results, setResults] = React.useState([]);

  const sessionId = React.useMemo(() => editorSession(), []);
  const fileRef = React.useRef(null);
  const maskRef = React.useRef(null);
  const secondRef = React.useRef(null);

  // Load the edit-provider manifest once.
  React.useEffect(() => {
    (async () => {
      try {
        const data = await window.NC_API.get('/api/studio/edit-providers');
        if (!data?.providers?.length) return;
        setProviders(data.providers);
        const def = data.defaultProvider || data.providers[0].id;
        setProvider(prev => data.providers.some(p => p.id === prev) ? prev : def);
      } catch (err) {
        console.error('studio/edit-providers failed', err);
      }
    })();
  }, []);

  // Keep model/resolution/safety valid as provider changes.
  const currentProvider = providers.find(p => p.id === provider);
  React.useEffect(() => {
    const p = providers.find(x => x.id === provider);
    const list = p?.models || [];
    setModels(list);
    setModel(prev => (list.includes(prev) ? prev : list[0] || ''));
    const res = p?.resolutions || [];
    setResolution(prev => (res.includes(prev) ? prev : (res[0] || '')));
    const safe = p?.safetyLevels || [];
    setSafety(prev => (safe.includes(prev) ? prev : (safe.length ? '4' : '')));
  }, [provider, providers]);

  // Receive a handed-off image from the Generate tab.
  React.useEffect(() => {
    const apply = (detail) => {
      const url = detail?.imageUrl || window.__ncStudioEditorImage?.url;
      if (url) {
        setSourceUrl(url);
        setSourceName('from Generate');
        if (detail?.prompt && !prompt) setPrompt('');
      }
    };
    if (window.__ncStudioEditorImage?.url) apply(window.__ncStudioEditorImage);
    const handler = (e) => apply(e.detail);
    window.addEventListener('nc-studio-send-to-editor', handler);
    return () => window.removeEventListener('nc-studio-send-to-editor', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolutions = currentProvider?.resolutions || [];
  const safetyLevels = currentProvider?.safetyLevels || [];
  const supportsMask = !!currentProvider?.supportsMask;
  const supportsCompose = !!currentProvider?.supportsCompose;
  const supportsSafety = !!currentProvider?.supportsSafety;
  const supportsResolution = resolutions.length > 0;
  const isDegraded = !!currentProvider?.degraded;

  const onPickSource = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const dataUrl = await fileToDataUrl(f);
      setSourceUrl(dataUrl);
      setSourceName(f.name);
    } catch { setError('Could not read that file.'); }
  };
  const onPickMask = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { setMaskUrl(await fileToDataUrl(f)); } catch { /* ignore */ }
  };
  const onPickSecond = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { setSecondUrl(await fileToDataUrl(f)); } catch { /* ignore */ }
  };

  const applyUrl = () => {
    const u = urlInput.trim();
    if (!u) return;
    setSourceUrl(u);
    setSourceName('from URL');
    setUrlInput('');
  };

  const canEdit = sourceUrl && prompt.trim().length > 0 && status !== 'loading' && !isDegraded
    && (!supportsCompose || secondUrl);

  const onEdit = React.useCallback(async () => {
    if (!canEdit) return;
    setStatus('loading');
    setError('');
    const body = {
      provider,
      model,
      prompt: prompt.trim(),
      input_image: sourceUrl,
      sessionId,
    };
    if (supportsResolution && resolution) body.resolution = resolution;
    if (supportsSafety && safety) body.safety_tolerance = safety;
    if (supportsMask && maskUrl) body.mask = maskUrl;
    if (supportsCompose && secondUrl) body.second_image = secondUrl;

    const r = await editorApi('edit', 'POST', body);
    if (r.ok && Array.isArray(r.data.images) && r.data.images.length) {
      const imgs = r.data.images.map((it, i) => ({
        ...it,
        provider, model: model || provider, prompt: prompt.trim(),
        _id: `${Date.now()}-${i}`,
      }));
      setResults(prev => [...imgs, ...prev]);
      setStatus('success');
      setTimeout(() => setStatus(s => s === 'success' ? 'idle' : s), 650);
    } else {
      const isRate = r.status === 429 || r.status === 503 || r.data?.rateLimited;
      setStatus(isRate ? 'rate-limited' : 'error');
      setError(r.data?.error || 'Edit failed');
    }
  }, [canEdit, provider, model, prompt, sourceUrl, resolution, safety, maskUrl, secondUrl, supportsResolution, supportsSafety, supportsMask, supportsCompose, sessionId]);

  const useAsSource = (url) => { if (url) { setSourceUrl(url); setSourceName('edited result'); } };

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader title="Editor" subtitle="// edit images · provider edit APIs" />

      <div className="st-panel" style={{ padding: 14, marginBottom: 14 }}>
        {/* Source row */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{
            width: 150, height: 150, flex: '0 0 auto', borderRadius: 4, overflow: 'hidden',
            border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)', background: 'color-mix(in srgb, var(--text) 4%, transparent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {sourceUrl
              ? <img src={sourceUrl} alt="source" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              : <Icon name="image" size={36} className="neonc" style={{ opacity: 0.5 }} />}
          </div>
          <div style={{ flex: '1 1 240px', minWidth: 220 }}>
            <div className="mono muted" style={{ fontSize: 10, marginBottom: 6 }}>
              source image {sourceName ? `· ${sourceName}` : '· none selected'}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => fileRef.current?.click()}>Upload</button>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPickSource} />
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="nc-input mono" placeholder="…or paste an image URL"
                value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') applyUrl(); }}
                style={{ fontSize: 11, flex: '1 1 auto', minWidth: 120 }}
              />
              <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={applyUrl} disabled={!urlInput.trim()}>Use</button>
            </div>
          </div>
        </div>

        {/* Prompt */}
        <textarea
          className="nc-textarea" placeholder="Describe the edit — what should change…"
          value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
          disabled={status === 'loading'}
          style={{ resize: 'vertical', minHeight: 60, marginTop: 12 }}
        />

        {/* Controls */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <select
            className="nc-input mono" value={provider} onChange={(e) => setProvider(e.target.value)}
            disabled={status === 'loading'} aria-label="Edit provider"
            style={{ fontSize: 11, padding: '6px 8px', minWidth: 160, flex: '1 1 auto' }}
          >
            {providers.map(p => (
              <option key={p.id} value={p.id}>{p.degraded ? `${p.label} (needs session)` : p.label}</option>
            ))}
          </select>

          <select
            className="nc-input mono" value={model} onChange={(e) => setModel(e.target.value)}
            disabled={status === 'loading' || models.length === 0} aria-label="Edit model"
            style={{ fontSize: 11, padding: '6px 8px', minWidth: 160, flex: '2 1 auto' }}
          >
            {models.map(m => <option key={m} value={m}>{editModelLabel(m)}</option>)}
          </select>

          {supportsResolution && (
            <select
              className="nc-input mono" value={resolution} onChange={(e) => setResolution(e.target.value)}
              disabled={status === 'loading'} aria-label="Resolution" title="Output resolution"
              style={{ fontSize: 11, padding: '6px 8px', minWidth: 90 }}
            >
              {resolutions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          )}

          {supportsSafety && (
            <select
              className="nc-input mono" value={safety} onChange={(e) => setSafety(e.target.value)}
              disabled={status === 'loading'} aria-label="Safety tolerance"
              title="Content-filter strictness — 1 strict, 6 permissive (Nano-Banana / Pro-FLUX)"
              style={{ fontSize: 11, padding: '6px 8px', minWidth: 110 }}
            >
              {safetyLevels.map(s => (
                <option key={s} value={s}>safety {s}{s === '1' ? ' (strict)' : s === '6' ? ' (perm.)' : ''}</option>
              ))}
            </select>
          )}

          <button
            className={`nc-btn primary ${canEdit ? '' : 'disabled'}`}
            onClick={onEdit} disabled={!canEdit}
            style={{ marginLeft: 'auto', fontSize: 11 }}
          >
            {status === 'loading' ? 'Editing…' : 'Edit'}
          </button>
        </div>

        {/* Optional extras */}
        {(supportsMask || supportsCompose) && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
            {supportsMask && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="mono muted" style={{ fontSize: 10 }}>mask {maskUrl ? '✓' : '(optional inpaint)'}</span>
                <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => maskRef.current?.click()}>Upload mask</button>
                {maskUrl && <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => setMaskUrl('')}>clear</button>}
                <input ref={maskRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPickMask} />
              </div>
            )}
            {supportsCompose && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="mono muted" style={{ fontSize: 10 }}>2nd image {secondUrl ? '✓' : '(required to blend)'}</span>
                <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => secondRef.current?.click()}>Upload</button>
                {secondUrl && <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => setSecondUrl('')}>clear</button>}
                <input ref={secondRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPickSecond} />
              </div>
            )}
          </div>
        )}

        {currentProvider?.note && (
          <div className="mono muted" style={{ fontSize: 10, marginTop: 8 }}>// {currentProvider.note}</div>
        )}
      </div>

      {/* Status */}
      {status === 'error' && (
        <div className="nc-panel" style={{ padding: 10, marginBottom: 12, borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)' }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--danger)' }}>⚠ {error}</span>
        </div>
      )}
      {status === 'rate-limited' && (
        <div className="nc-panel" style={{ padding: 10, marginBottom: 12, borderColor: 'color-mix(in srgb, var(--boundary) 40%, transparent)' }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--boundary)' }}>rate limited — {error}</span>
        </div>
      )}

      {/* Empty state */}
      {results.length === 0 && status !== 'loading' && (
        <div className="st-panel" style={{ padding: 40, textAlign: 'center' }}>
          <Icon name="edit" size={44} className="neonc" style={{ opacity: 0.6 }} />
          <div className="mono muted" style={{ marginTop: 14, fontSize: 12 }}>// no edits yet</div>
          <div className="mono muted" style={{ marginTop: 4, fontSize: 10 }}>pick a source image, describe the change, and hit Edit</div>
        </div>
      )}

      {/* Results */}
      {(results.length > 0 || status === 'loading') && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
          {status === 'loading' && (
            <div className="nc-panel" style={{ aspectRatio: '1 / 1', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="mono muted" style={{ fontSize: 11 }}>editing…</span>
            </div>
          )}
          {results.map((it, idx) => (
            <div key={it._id || idx} className="nc-panel" style={{ padding: 8, borderRadius: 4 }}>
              <img src={it.url} alt={it.prompt} style={{ width: '100%', borderRadius: 3, display: 'block' }} />
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => useAsSource(it.url)}>Use as source</button>
                <a className="nc-btn ghost" style={{ fontSize: 10 }} href={it.url} target="_blank" rel="noreferrer" download>Download</a>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <span className="tag mono" style={{ fontSize: 9, textTransform: 'uppercase' }}>{it.provider}</span>
                <span className="tag muted mono" style={{ fontSize: 9 }}>{editModelLabel(it.model)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

window.ImageEditor = ImageEditor;
