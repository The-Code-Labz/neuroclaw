/* Studio › Video — text/image → video generation workbench.
 *
 * Sibling of Generate (page-imagegen) but for video. Provider + model dropdowns
 * render from the server-side manifest so new video tools appear automatically.
 * Generated clips land in Studio › Media (the tools deliver there internally);
 * this tab shows the fresh render inline plus a session history pulled from the
 * media gallery.
 *
 * Backend contract:
 *   GET  /api/studio/video-providers → { ok, providers:[{id,label,models[],defaultModel,healthy,degraded,supportsImageInit,note}], defaultProvider }
 *   POST /api/studio/video-gen       → { ok, media:[{ id, url }], provider, model, prompt }
 *   GET  /api/media?kind=video       → { ok, items:[{ id, url, prompt, source_tool, created_at }] }
 */

const V_SIZES = [
  { id: 'landscape', label: 'Landscape', ratio: '16:9' },
  { id: 'portrait',  label: 'Portrait',  ratio: '9:16' },
  { id: 'square',    label: 'Square',    ratio: '1:1' },
];

const V_DURATIONS = ['', '4', '5', '6', '8', '10'];

const V_EXAMPLES = [
  'a slow cinematic dolly through a neon-drenched Tokyo alley in the rain',
  'aerial drone shot sweeping over misty mountain peaks at dawn',
  'a hummingbird hovering by a flower, ultra slow-motion macro',
  'timelapse of storm clouds rolling over a desert mesa',
];

function vGetSession() {
  let s = localStorage.getItem('nc_studio_session');
  if (!s) {
    s = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('nc_studio_session', s);
  }
  return s;
}

function vFormatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function vRatioCss(ratio) {
  const [w, h] = String(ratio || '16:9').split(':').map(Number);
  if (!w || !h || !isFinite(w) || !isFinite(h)) return '16 / 9';
  return `${w} / ${h}`;
}

function vModelLabel(id) {
  return String(id || '').replace(/[/_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function vStudioApi(path, method, body) {
  const tok = window.NC_API?.token || new URLSearchParams(location.search).get('token') || '';
  const sep = path.includes('?') ? '&' : '?';
  const qs = tok ? `${sep}token=${encodeURIComponent(tok)}` : '';
  return fetch(`/api/${path}${qs}`, {
    method: method || 'GET',
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
    return { ok: r.ok && data.ok !== false, status: r.status, data };
  });
}

const V_SOURCE_LABEL = { fal_video: 'fal.ai', kie_video: 'KIE AI', higgsfield_video: 'Higgsfield' };

const VideoCard = ({ item, ratio, onDownload, staggerIndex, isNew }) => {
  const animations = [
    isNew ? 'pulseGlow 0.5s ease-out' : '',
    staggerIndex >= 0 ? `fadeIn 0.35s ease-out ${Math.min(staggerIndex, 7) * 0.06}s backwards` : '',
  ].filter(Boolean).join(', ');
  const provider = V_SOURCE_LABEL[item.source_tool] || item.source_tool || item.provider || 'video';
  return (
    <div className="nc-panel glow tilt" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8, position: 'relative', overflow: 'hidden', animation: animations || undefined }}>
      <div style={{ aspectRatio: vRatioCss(ratio), background: 'rgba(0,4,12,0.6)', borderRadius: 3, overflow: 'hidden', border: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <video
          src={item.url}
          controls
          preload="metadata"
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
        />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)', lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {item.prompt || '(no prompt)'}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center' }}>
          <span className="tag mono" style={{ fontSize: 9, textTransform: 'uppercase' }}>{provider}</span>
          {item.model_id && <span className="tag muted mono" style={{ fontSize: 9 }}>{vModelLabel(item.model_id)}</span>}
          <button
            className="nc-btn"
            title="Download video"
            aria-label="Download video"
            onClick={() => onDownload(item)}
            style={{ fontSize: 11, lineHeight: 1, padding: '3px 7px', marginLeft: 'auto' }}
          >⤓</button>
          <span className="mono muted" style={{ fontSize: 9 }}>{vFormatDate(item.created_at)}</span>
        </div>
      </div>
    </div>
  );
};

const VideoSkeleton = ({ ratio, elapsed }) => (
  <div className="nc-panel glow" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div style={{
      aspectRatio: vRatioCss(ratio), borderRadius: 3, position: 'relative', overflow: 'hidden',
      background: 'rgba(0,4,12,0.5)',
      backgroundImage: 'linear-gradient(90deg, color-mix(in srgb, var(--accent) 4%, transparent) 25%, color-mix(in srgb, var(--accent) 14%, transparent) 50%, color-mix(in srgb, var(--accent) 4%, transparent) 75%)',
      backgroundSize: '200% 100%', animation: 'shimmer 1.4s infinite',
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6,
    }}>
      <Icon name="video" size={34} className="neonc" style={{ opacity: 0.6 }}/>
      <div className="mono muted" style={{ fontSize: 10 }}>rendering… {elapsed}s</div>
      <div className="mono muted" style={{ fontSize: 9, opacity: 0.7 }}>video takes ~1-4 min</div>
    </div>
  </div>
);

const VideoGen = () => {
  const [providers, setProviders] = React.useState([]);
  const [provider, setProvider] = React.useState('fal_video');
  const [models, setModels] = React.useState([]);
  const [model, setModel] = React.useState('');

  const [prompt, setPrompt] = React.useState('');
  const [size, setSize] = React.useState('landscape');
  const [duration, setDuration] = React.useState('');
  const [initImage, setInitImage] = React.useState('');
  const [advanced, setAdvanced] = React.useState(false);

  const [status, setStatus] = React.useState('idle'); // idle | loading | success | error
  const [error, setError] = React.useState('');
  const [elapsed, setElapsed] = React.useState(0);

  const [results, setResults] = React.useState([]);
  const [historyIds, setHistoryIds] = React.useState(new Set());

  const sessionId = React.useMemo(() => vGetSession(), []);
  const selectedRatio = V_SIZES.find(s => s.id === size)?.ratio || '16:9';
  const currentProvider = providers.find(p => p.id === provider);

  // Load the video provider manifest once.
  React.useEffect(() => {
    (async () => {
      try {
        const r = await vStudioApi('studio/video-providers', 'GET');
        if (!r.ok || !r.data.providers?.length) return;
        setProviders(r.data.providers);
        const def = r.data.defaultProvider || r.data.providers[0].id;
        setProvider(prev => r.data.providers.some(p => p.id === prev) ? prev : def);
      } catch (err) {
        console.error('studio/video-providers failed', err);
      }
    })();
  }, []);

  // Keep model valid when provider changes.
  React.useEffect(() => {
    const p = providers.find(x => x.id === provider);
    const list = p?.models || [];
    setModels(list);
    setModel(prev => (list.includes(prev) ? prev : (p?.defaultModel && list.includes(p.defaultModel) ? p.defaultModel : list[0] || '')));
  }, [provider, providers]);

  // Session history from the media gallery (video only).
  const loadHistory = React.useCallback(async () => {
    try {
      const r = await vStudioApi('media?kind=video', 'GET');
      if (!r.ok || !Array.isArray(r.data.items)) return;
      setResults(prev => {
        const existing = new Set(prev.map(it => it.id).filter(Boolean));
        const fresh = r.data.items.filter(it => !existing.has(it.id));
        return [...prev, ...fresh];
      });
      setHistoryIds(prev => {
        const next = new Set(prev);
        r.data.items.forEach(it => { if (it.id) next.add(it.id); });
        return next;
      });
    } catch { /* history is a convenience */ }
  }, []);

  React.useEffect(() => { loadHistory(); }, [loadHistory]);

  // Elapsed timer while rendering.
  React.useEffect(() => {
    if (status !== 'loading') return;
    setElapsed(0);
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  const supportsInit = !!currentProvider?.supportsImageInit;
  const isDegraded = currentProvider?.degraded;

  const onGenerate = React.useCallback(async () => {
    const clean = prompt.trim();
    if (!clean || status === 'loading') return;
    if (isDegraded) { setStatus('error'); setError(currentProvider?.note || 'This provider is unavailable.'); return; }
    setStatus('loading');
    setError('');

    const body = {
      provider, model, prompt: clean,
      aspect_ratio: selectedRatio, sessionId,
      ...(duration ? { duration } : {}),
      ...(supportsInit && initImage.trim() ? { input_image: initImage.trim() } : {}),
    };

    const r = await vStudioApi('studio/video-gen', 'POST', body);

    if (r.ok && Array.isArray(r.data.media) && r.data.media.length) {
      const clips = r.data.media.map((m, i) => ({
        id: m.id, url: m.url, prompt: clean,
        source_tool: provider, model_id: model || provider,
        provider, created_at: new Date().toISOString(),
        _fresh: `${Date.now()}-${i}`,
      }));
      setResults(prev => [...clips, ...prev]);
      // Newly-created clips are also history rows — mark them so the "current run"
      // split stays clean on the next history refresh.
      setStatus('success');
      setTimeout(() => setStatus(s => s === 'success' ? 'idle' : s), 800);
    } else {
      setStatus('error');
      setError(r.data?.error || 'Video generation failed');
    }
  }, [prompt, provider, model, selectedRatio, duration, initImage, supportsInit, sessionId, status, isDegraded, currentProvider]);

  const canGenerate = prompt.trim().length > 0 && status !== 'loading' && !isDegraded;

  const download = React.useCallback((item) => {
    const a = document.createElement('a');
    a.href = item.id ? `/api/media/${item.id}/download` : item.url;
    a.download = `video-${item.id || Date.now()}.mp4`;
    document.body.appendChild(a); a.click(); a.remove();
  }, []);

  // Fresh clips from this run (have _fresh) vs. gallery history.
  const currentRun = results.filter(it => it._fresh);
  const history = results.filter(it => !it._fresh && historyIds.has(it.id));
  const showGrid = currentRun.length > 0 || status === 'loading';

  const textareaRows = React.useMemo(() => Math.min(8, Math.max(3, prompt.split('\n').length)), [prompt]);

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <style>{`
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes pulseGlow { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 25%, transparent); } 70% { box-shadow: 0 0 0 10px color-mix(in srgb, var(--accent) 0%, transparent); } 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <PageHeader title="Video" subtitle="// text/image → video · registered providers" />

      {/* Composer */}
      <div className="nc-panel glow" style={{ padding: 14, marginBottom: 14 }}>
        <textarea
          className="nc-textarea"
          placeholder="Describe the shot — motion, camera, mood…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={textareaRows}
          disabled={status === 'loading'}
          style={{ resize: 'vertical', minHeight: 72 }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <select className="nc-input mono" value={provider} onChange={(e) => setProvider(e.target.value)} disabled={status === 'loading'} style={{ fontSize: 11, padding: '6px 8px', minWidth: 150, flex: '1 1 auto' }} aria-label="Video provider">
            {providers.map(p => (
              <option key={p.id} value={p.id}>{p.degraded ? `${p.label} (unavailable)` : p.label}</option>
            ))}
          </select>

          <select className="nc-input mono" value={model} onChange={(e) => setModel(e.target.value)} disabled={status === 'loading' || models.length === 0} style={{ fontSize: 11, padding: '6px 8px', minWidth: 160, flex: '2 1 auto' }} aria-label="Video model">
            {models.map(m => <option key={m} value={m}>{vModelLabel(m)}</option>)}
          </select>

          <select className="nc-input mono" value={size} onChange={(e) => setSize(e.target.value)} disabled={status === 'loading'} style={{ fontSize: 11, padding: '6px 8px', minWidth: 120 }} aria-label="Aspect ratio">
            {V_SIZES.map(s => <option key={s.id} value={s.id}>{s.label} · {s.ratio}</option>)}
          </select>

          <button className="nc-btn ghost" onClick={() => setAdvanced(a => !a)} disabled={status === 'loading'} style={{ fontSize: 10 }} aria-label="Toggle advanced options">
            {advanced ? '▾ Advanced' : '▸ Advanced'}
          </button>

          <button className={`nc-btn primary ${canGenerate ? '' : 'disabled'}`} onClick={onGenerate} disabled={!canGenerate} style={{ marginLeft: 'auto', fontSize: 11 }} aria-label="Generate video">
            {status === 'loading' ? `Rendering… ${elapsed}s` : 'Generate'}
          </button>
        </div>

        {currentProvider && (
          <div className="mono muted" style={{ fontSize: 10, marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className={`dot ${currentProvider.degraded ? 'boundary' : 'blue'}`} style={{ width: 6, height: 6 }}/>
            <span style={currentProvider.degraded ? { color: 'var(--boundary)' } : undefined}>{currentProvider.note}</span>
          </div>
        )}

        {advanced && (
          <div style={{ marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="mono muted" style={{ fontSize: 10 }}>duration</span>
              <select className="nc-input mono" value={duration} onChange={(e) => setDuration(e.target.value)} disabled={status === 'loading'} style={{ fontSize: 11, padding: '6px 8px', minWidth: 90 }} aria-label="Duration">
                {V_DURATIONS.map(d => <option key={d || 'auto'} value={d}>{d ? `${d}s` : 'auto'}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 240px' }}>
              <span className="mono muted" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>image→video</span>
              <input
                className="nc-input mono"
                placeholder={supportsInit ? 'source image URL (first frame → motion)…' : 'not supported by this provider'}
                value={initImage}
                onChange={(e) => setInitImage(e.target.value)}
                disabled={status === 'loading' || !supportsInit}
                style={{ fontSize: 11, padding: '6px 8px', flex: 1, minWidth: 120 }}
                aria-label="Image-to-video source URL"
              />
            </div>
          </div>
        )}
      </div>

      {status === 'error' && (
        <div className="nc-panel" style={{ padding: 12, marginBottom: 14, borderLeft: '3px solid var(--danger)' }} role="status" aria-live="polite">
          <div className="mono" style={{ fontSize: 12, color: 'var(--danger)' }}>! {error || 'Generation failed'}</div>
          <div style={{ marginTop: 8 }}>
            <button className="nc-btn" onClick={onGenerate} style={{ fontSize: 11 }}>Retry</button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!showGrid && history.length === 0 && (
        <div className="nc-panel glow" style={{ padding: 40, textAlign: 'center' }}>
          <Icon name="video" size={48} className="neonc" style={{ opacity: 0.6 }}/>
          <div className="mono muted" style={{ marginTop: 14, fontSize: 12 }}>// no videos yet</div>
          <div className="mono muted" style={{ marginTop: 4, fontSize: 10 }}>pick a provider, describe a shot, and hit Generate · clips land in Studio › Media</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 18 }}>
            {V_EXAMPLES.map(ex => (
              <button key={ex} className="tag blue" onClick={() => setPrompt(ex)} style={{ cursor: 'pointer', fontSize: 9 }}>{ex}</button>
            ))}
          </div>
        </div>
      )}

      {/* Current run */}
      {showGrid && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, alignContent: 'start' }}>
          {status === 'loading' && <VideoSkeleton ratio={selectedRatio} elapsed={elapsed} />}
          {currentRun.map((it, idx) => (
            <VideoCard key={it._fresh || it.id} item={it} ratio={selectedRatio} onDownload={download} isNew={status === 'success' && idx === 0} staggerIndex={idx} />
          ))}
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <>
          <div className="label-tiny" style={{ margin: '18px 0 10px', color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, height: 1, background: 'var(--line-soft)' }}/>
            From the gallery
            <span style={{ flex: 1, height: 1, background: 'var(--line-soft)' }}/>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, alignContent: 'start', opacity: 0.9 }}>
            {history.map((it, idx) => (
              <VideoCard key={it.id || idx} item={it} ratio={it.aspect_ratio || '16:9'} onDownload={download} isNew={false} staggerIndex={-1} />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

window.VideoGen = VideoGen;
