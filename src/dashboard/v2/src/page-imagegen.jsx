/* Studio › Generate — image generation workbench.
 *
 * New sub-tab upstream of Gallery. Lets the operator generate images through
 * the full set of registered image-generation providers. The provider+model
 * dropdowns are rendered from the server-side manifest so future image tools
 * appear automatically.
 *
 * Backend contract:
 *   GET  /api/studio/image-providers → { ok, providers:[{id,label,tier,mode,models[],requiresSession,healthy,degraded,note}], defaultProvider }
 *   GET  /api/studio/quota?sessionId=... → { ok, quota: { used, limit, resetAt, usedUsd, limitUsd, orgUsedUsd, orgLimitUsd, warning } }
 *   POST /api/studio/gen → { ok, images:[{ url, mime }], quota }
 *                     429 → { ok:false, rateLimited:true, error, reason, retryAfterMs, quota }
 */

const SIZES = [
  { id: 'square',    label: 'Square',    ratio: '1:1' },
  { id: 'portrait',  label: 'Portrait',  ratio: '9:16' },
  { id: 'landscape', label: 'Landscape', ratio: '16:9' },
];

const ALLOWED_COUNTS = [1, 2, 4];

const EXAMPLES = [
  'a neon cyberpunk alley at night, rain on wet asphalt',
  'a calm Japanese tea room in watercolor',
  'a retro-futuristic dashboard interface, cyan glow',
  'a bioluminescent deep-sea creature, macro photography',
];

function getStudioSession() {
  let s = localStorage.getItem('nc_studio_session');
  if (!s) {
    s = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('nc_studio_session', s);
  }
  return s;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatCountdown(ms) {
  if (ms <= 0) return 'soon';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ratioToCss(ratio) {
  const [w, h] = String(ratio || '1:1').split(':').map(Number);
  if (!w || !h || !isFinite(w) || !isFinite(h)) return '1 / 1';
  return `${w} / ${h}`;
}

function ratioToDimensions(ratio) {
  const [w, h] = String(ratio || '1:1').split(':').map(Number);
  if (!w || !h || !isFinite(w) || !isFinite(h)) return [1024, 1024];
  const area = 1024 * 1024;
  const scale = Math.sqrt(area / (w * h));
  return [Math.round(w * scale), Math.round(h * scale)];
}

function downloadImage(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name || `generated-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function studioApi(path, method, body) {
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

function modelLabel(id) {
  return String(id || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function normalizeHistoryItem(it) {
  const provider = it.source_tool || it.source || 'unknown';
  return {
    ...it,
    _id: it.id,
    provider,
    model: it.model_id || provider,
    prompt: it.prompt || '',
  };
}

const QuotaBadge = ({ quota, now }) => {
  if (!quota) return null;
  const resetMs = quota.resetAt ? new Date(quota.resetAt).getTime() - now : 0;
  const label = resetMs > 0
    ? `${quota.used}/${quota.limit} today · resets in ${formatCountdown(resetMs)}`
    : `${quota.used}/${quota.limit} today`;
  const pct = quota.limit > 0 ? quota.used / quota.limit : 0;
  const nearLimit = pct >= 0.8 || quota.warning || quota.used >= quota.limit;
  return (
    <span className={`tag ${nearLimit ? 'boundary' : 'blue'}`} title={`Daily image budget · ${quota.limit} generations per day`}>
      {label}
    </span>
  );
};

const StatusStrip = ({ status, error, resetAt, now, onRetry, reason }) => {
  if (status !== 'error' && status !== 'rate-limited') return null;
  const boundary = status === 'rate-limited';
  const resetMs = resetAt ? new Date(resetAt).getTime() - now : 0;
  const isConcurrency = reason === 'user_concurrent_limit';
  const headline = isConcurrency
    ? 'Too many generations running at once'
    : boundary
      ? "You've reached today's generation limit"
      : `! ${error || 'Generation failed'}`;
  return (
    <div
      className="nc-panel"
      style={{
        padding: 12,
        marginBottom: 14,
        borderLeft: `3px solid var(${boundary ? '--boundary' : '--danger'})`,
        background: boundary ? 'rgba(224,169,73,0.06)' : undefined,
      }}
      role="status"
      aria-live="polite"
    >
      <div className="mono" style={{ fontSize: 12, color: `var(${boundary ? '--boundary' : '--danger'})` }}>
        {headline}
      </div>
      {boundary && isConcurrency && (
        <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
          Wait for an in-flight image to finish, then retry.
        </div>
      )}
      {boundary && !isConcurrency && resetMs > 0 && (
        <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
          Resets in {formatCountdown(resetMs)} · the cap keeps shared usage sustainable.
        </div>
      )}
      {(!boundary || isConcurrency) && (
        <div style={{ marginTop: 8 }}>
          <button className="nc-btn" onClick={onRetry} style={{ fontSize: 11 }}>Retry</button>
        </div>
      )}
    </div>
  );
};

const SkeletonCard = ({ ratio }) => (
  <div className="st-card" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div style={{
      aspectRatio: ratioToCss(ratio), background: 'rgba(0,4,12,0.5)', borderRadius: 3,
      backgroundImage: 'linear-gradient(90deg, color-mix(in srgb, var(--accent) 4%, transparent) 25%, color-mix(in srgb, var(--accent) 12%, transparent) 50%, color-mix(in srgb, var(--accent) 4%, transparent) 75%)',
      backgroundSize: '200% 100%',
      animation: 'shimmer 1.4s infinite',
    }}/>
    <div style={{ height: 28, background: 'color-mix(in srgb, var(--accent) 6%, transparent)', borderRadius: 2 }}/>
    <div style={{ height: 14, background: 'color-mix(in srgb, var(--accent) 4%, transparent)', borderRadius: 2, width: '60%' }}/>
  </div>
);

const ImageError = () => (
  <div style={{
    width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--muted)', fontSize: 10, textAlign: 'center', padding: 12,
  }}>
    <span className="mono">// image unavailable</span>
  </div>
);

const ResultCard = ({ item, onDiscard, isNew, onSendToEditor, staggerIndex, ratio }) => {
  const [discarding, setDiscarding] = React.useState(false);
  const [imgError, setImgError] = React.useState(false);
  const doDiscard = (e) => {
    e.stopPropagation();
    setDiscarding(true);
    onDiscard();
  };
  const animations = [
    isNew ? 'pulseGlow 0.45s ease-out' : '',
    staggerIndex >= 0 ? `fadeIn 0.35s ease-out ${Math.min(staggerIndex, 7) * 0.06}s backwards` : '',
  ].filter(Boolean).join(', ');
  return (
    <div
      className="st-card"
      style={{
        padding: 8, display: 'flex', flexDirection: 'column', gap: 8,
        position: 'relative', overflow: 'hidden',
        animation: animations || undefined,
      }}
    >
      <div style={{
        position: 'absolute', top: 12, right: 12, zIndex: 3,
        display: 'flex', gap: 6,
      }}>
        <button
          className="nc-btn"
          title="Download image"
          aria-label="Download image"
          onClick={(e) => { e.stopPropagation(); downloadImage(item.url, `generated-${Date.now()}.png`); }}
          style={{ fontSize: 13, lineHeight: 1, padding: '4px 7px', background: 'rgba(0,4,12,0.7)', backdropFilter: 'blur(2px)' }}
        >⤓</button>
        <button
          className="nc-btn"
          title="Send to Editor"
          aria-label="Send to Editor"
          onClick={(e) => { e.stopPropagation(); onSendToEditor(item); }}
          style={{ fontSize: 13, lineHeight: 1, padding: '4px 7px', background: 'rgba(0,4,12,0.7)', backdropFilter: 'blur(2px)' }}
        >✎</button>
        <button
          className="nc-btn"
          title="Remove from this list"
          aria-label="Remove from this list"
          onClick={doDiscard}
          disabled={discarding}
          style={{ fontSize: 13, lineHeight: 1, padding: '4px 7px', background: 'rgba(0,4,12,0.7)', backdropFilter: 'blur(2px)', color: 'var(--danger)' }}
        >✕</button>
      </div>
      <div style={{
        aspectRatio: ratioToCss(ratio), background: 'rgba(0,4,12,0.5)', borderRadius: 3,
        display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        border: '1px solid var(--line-soft)',
      }}>
        {imgError ? <ImageError /> : (
          <img
            src={item.url}
            alt={item.prompt}
            loading="lazy"
            onError={() => setImgError(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)', lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {item.prompt || '(no prompt)'}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center' }}>
          <span className="tag mono" style={{ fontSize: 9, textTransform: 'uppercase' }}>{item.provider}</span>
          <span className="tag muted mono" style={{ fontSize: 9 }}>{item.model}</span>
          <span className="mono muted" style={{ fontSize: 9, marginLeft: 'auto' }}>{formatDate(item.created_at)}</span>
        </div>
      </div>
    </div>
  );
};

const ProviderHint = ({ providers, provider }) => {
  const p = providers.find(x => x.id === provider);
  if (!p) return null;
  return (
    <div className="mono muted" style={{ fontSize: 10, marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
      {p.degraded || !p.healthy ? (
        <span className="dot boundary" style={{ width: 6, height: 6 }}/>
      ) : (
        <span className="dot blue" style={{ width: 6, height: 6 }}/>
      )}
      <span style={p.degraded || !p.healthy ? { color: 'var(--boundary)' } : undefined}>
        {p.degraded || !p.healthy ? p.note : p.note}
      </span>
    </div>
  );
};

const SectionLabel = ({ children }) => (
  <div className="label-tiny" style={{ margin: '18px 0 10px', color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
    <span style={{ flex: 1, height: 1, background: 'var(--line-soft)' }}/>
    {children}
    <span style={{ flex: 1, height: 1, background: 'var(--line-soft)' }}/>
  </div>
);

const ImageGen = () => {
  const [providers, setProviders] = React.useState([]);
  const [provider, setProvider] = React.useState('abacus_image');
  const [models, setModels] = React.useState([]);
  const [model, setModel] = React.useState('');
  const [manifestLoaded, setManifestLoaded] = React.useState(false);

  const [prompt, setPrompt] = React.useState('');
  const [size, setSize] = React.useState('square');
  const [count, setCount] = React.useState(1);
  const [negative, setNegative] = React.useState('');
  const [resolution, setResolution] = React.useState('');
  const [safety, setSafety] = React.useState('');
  const [advanced, setAdvanced] = React.useState(false);

  const [status, setStatus] = React.useState('idle'); // idle | loading | success | error | rate-limited
  const [error, setError] = React.useState('');
  const [resetAt, setResetAt] = React.useState(null);
  const [rateLimitReason, setRateLimitReason] = React.useState(null);
  const [loadingCount, setLoadingCount] = React.useState(1);

  const [results, setResults] = React.useState([]);
  const [historyIds, setHistoryIds] = React.useState(new Set());
  const [quota, setQuota] = React.useState(null);
  const [now, setNow] = React.useState(Date.now());

  const sessionId = React.useMemo(() => getStudioSession(), []);
  const selectedRatio = SIZES.find(s => s.id === size)?.ratio || '1:1';

  // Live countdown for reset time.
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Load the server-side provider manifest once on mount.
  React.useEffect(() => {
    const load = async () => {
      try {
        const data = await window.NC_API.get('/api/studio/image-providers');
        if (!data?.providers?.length) return;
        setProviders(data.providers);
        const defaultId = data.defaultProvider || data.providers[0].id;
        setProvider(prev => data.providers.some(p => p.id === prev) ? prev : defaultId);
        setManifestLoaded(true);
      } catch (err) {
        // Static fallback: keep the original Abacus default.
        console.error('studio/image-providers failed', err);
      }
    };
    load();
  }, []);

  // Keep the selected model valid when the provider (or manifest) changes.
  React.useEffect(() => {
    const p = providers.find(x => x.id === provider);
    const list = p?.models || [];
    setModels(list);
    setModel(prev => (list.includes(prev) ? prev : list[0] || ''));
  }, [provider, providers]);

  const loadQuota = React.useCallback(async () => {
    try {
      const r = await studioApi(`quota?sessionId=${encodeURIComponent(sessionId)}`, 'GET');
      if (r.ok && r.data.quota) setQuota(r.data.quota);
    } catch { /* silent — badge hides if unavailable */ }
  }, [sessionId]);

  const loadHistory = React.useCallback(async () => {
    try {
      const r = await studioApi(`gen/history?sessionId=${encodeURIComponent(sessionId)}&limit=48`, 'GET');
      if (!r.ok || !Array.isArray(r.data.images)) return;
      const history = r.data.images.map(normalizeHistoryItem);
      setResults(prev => {
        const existingIds = new Set(prev.map(it => it._id || it.id).filter(Boolean));
        const fresh = history.filter(it => !existingIds.has(it._id));
        return [...fresh, ...prev];
      });
      setHistoryIds(prev => {
        const next = new Set(prev);
        history.forEach(it => { if (it._id) next.add(it._id); });
        return next;
      });
    } catch { /* non-fatal: history is a convenience, not a requirement */ }
  }, [sessionId]);

  React.useEffect(() => { loadQuota(); loadHistory(); }, [loadQuota, loadHistory]);
  React.useEffect(() => {
    const t = setInterval(loadQuota, 30000);
    return () => clearInterval(t);
  }, [loadQuota]);

  const currentProvider = providers.find(p => p.id === provider);
  const resolutions = currentProvider?.resolutions || [];
  const safetyLevels = currentProvider?.safetyLevels || [];
  const supportsCount = currentProvider?.supportsCount ?? (provider === 'abacus_image');
  const supportsNegative = currentProvider?.supportsNegative ?? (provider === 'generate_image_venice');
  const supportsResolution = resolutions.length > 0;
  const supportsSafety = currentProvider?.supportsSafety ?? false;

  // Keep resolution/safety valid for the selected provider.
  React.useEffect(() => {
    setResolution(prev => (resolutions.includes(prev) ? prev : (resolutions[0] || '')));
    setSafety(prev => (safetyLevels.includes(prev) ? prev : (safetyLevels.length ? '4' : '')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, providers]);

  const onGenerate = React.useCallback(async () => {
    const clean = prompt.trim();
    if (!clean || status === 'loading') return;
    if (currentProvider?.degraded) {
      setStatus('error');
      setError(currentProvider.note || 'This provider is temporarily unavailable.');
      return;
    }
    setStatus('loading');
    setError('');
    setResetAt(null);
    setRateLimitReason(null);
    setLoadingCount(supportsCount ? count : 1);

    const sizeRatio = selectedRatio;
    const body = {
      provider,
      model,
      prompt: clean,
      aspect_ratio: sizeRatio,
      num_images: supportsCount ? count : 1,
      sessionId,
    };

    if (provider === 'generate_image') {
      body.quality = model?.includes('quality') ? 'hd' : 'standard';
    }
    if (provider === 'generate_image_venice') {
      const [width, height] = ratioToDimensions(sizeRatio);
      body.width = width;
      body.height = height;
      body.negative = negative.trim();
    }
    if (provider === 'voidai_gpt_image') {
      const sizeMap = { '1:1': '1024x1024', '9:16': '1024x1536', '16:9': '1536x1024', '3:4': '1024x1536', '4:3': '1536x1024' };
      body.size = sizeMap[sizeRatio] || '1024x1024';
    }
    if (provider === 'gpt_image_generate') {
      const styleMap = { 'dall-e-3': 'auto', vivid: 'vivid', natural: 'natural' };
      body.style = styleMap[model] || 'auto';
    }
    if (supportsResolution && resolution) body.resolution = resolution;
    if (supportsSafety && safety) body.safety_tolerance = safety;

    const r = await studioApi('gen', 'POST', body);

    if (r.ok && Array.isArray(r.data.images)) {
      const imgs = r.data.images.map((it, i) => ({
        ...it,
        provider,
        model: model || provider,
        prompt: clean,
        created_at: new Date().toISOString(),
        _id: `${Date.now()}-${i}`,
      }));
      setResults(prev => [...imgs, ...prev]);
      setStatus('success');
      if (r.data.quota) setQuota(r.data.quota);
      setTimeout(() => setStatus(s => s === 'success' ? 'idle' : s), 650);
    } else {
      const isRate = r.status === 429 || r.status === 503 || r.data?.rateLimited || /limit reached/i.test(r.data?.error || '');
      setStatus(isRate ? 'rate-limited' : 'error');
      setError(r.data?.error || 'Generation failed');
      setResetAt(r.data?.resetAt || (r.data?.retryAfterMs ? Date.now() + r.data.retryAfterMs : null));
      if (r.data?.reason) setRateLimitReason(r.data.reason);
      if (r.data?.quota) setQuota(r.data.quota);
    }
  }, [prompt, provider, model, size, count, negative, resolution, safety, supportsResolution, supportsSafety, status, sessionId, selectedRatio, currentProvider, supportsCount]);

  const isDegraded = currentProvider?.degraded;
  const canGenerate = prompt.trim().length > 0 && status !== 'loading' && status !== 'rate-limited' && !isDegraded;

  const textareaRows = React.useMemo(() => {
    const lines = prompt.split('\n').length;
    return Math.min(8, Math.max(3, lines));
  }, [prompt]);

  const sendToEditor = React.useCallback((item) => {
    const { url, prompt: imgPrompt, provider: imgProvider } = item || {};
    if (!url) return;
    try {
      window.__ncStudioEditorImage = { url, prompt: imgPrompt, provider: imgProvider, createdAt: Date.now() };
      window.dispatchEvent(new CustomEvent('nc-studio-send-to-editor', { detail: { imageUrl: url, prompt: imgPrompt, provider: imgProvider } }));
      location.hash = 'studio/editor';
    } catch {
      // Non-fatal: the image stays in the gallery regardless.
    }
  }, []);

  const currentRun = results.filter(it => !historyIds.has(it._id));
  const history = results.filter(it => historyIds.has(it._id));
  const showGrid = currentRun.length > 0 || status === 'loading';

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes pulseGlow {
          0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 25%, transparent); }
          70% { box-shadow: 0 0 0 10px color-mix(in srgb, var(--accent) 0%, transparent); }
          100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <PageHeader
        title="Generate"
        subtitle="// image generation · registered providers"
        right={<QuotaBadge quota={quota} now={now} />}
      />

      {/* Composer */}
      <div className="st-panel" style={{ padding: 14, marginBottom: 14 }}>
        <textarea
          className="nc-textarea"
          placeholder="Describe the image you're imagining…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={textareaRows}
          disabled={status === 'loading'}
          style={{ resize: 'vertical', minHeight: 72 }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <select
            className="nc-input mono"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            disabled={status === 'loading'}
            style={{ fontSize: 11, padding: '6px 8px', minWidth: 160, flex: '1 1 auto' }}
            aria-label="Image provider"
          >
            {providers.filter(p => (p.mode || 'generate') === 'generate').map(p => (
              <option key={p.id} value={p.id}>
                {p.degraded ? `${p.label} (degraded)` : p.label}
              </option>
            ))}
          </select>

          <select
            className="nc-input mono"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={status === 'loading' || models.length === 0}
            style={{ fontSize: 11, padding: '6px 8px', minWidth: 160, flex: '2 1 auto' }}
            aria-label="Image model"
          >
            {models.map(m => (
              <option key={m} value={m}>{modelLabel(m)}</option>
            ))}
          </select>

          <select
            className="nc-input mono"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            disabled={status === 'loading'}
            style={{ fontSize: 11, padding: '6px 8px', minWidth: 110 }}
            aria-label="Aspect ratio"
          >
            {SIZES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>

          {supportsResolution && (
            <select
              className="nc-input mono"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              disabled={status === 'loading'}
              style={{ fontSize: 11, padding: '6px 8px', minWidth: 90 }}
              aria-label="Resolution"
              title="Output resolution"
            >
              {resolutions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              className="nc-btn ghost"
              onClick={() => setCount(c => {
                const i = ALLOWED_COUNTS.indexOf(c);
                return ALLOWED_COUNTS[Math.max(0, i - 1)];
              })}
              disabled={status === 'loading' || count <= ALLOWED_COUNTS[0] || !supportsCount}
              style={{ padding: '6px 9px' }}
              aria-label="Decrease count"
            >−</button>
            <span className="mono" style={{ minWidth: 20, textAlign: 'center', fontSize: 12 }}>{count}</span>
            <button
              className="nc-btn ghost"
              onClick={() => setCount(c => {
                const i = ALLOWED_COUNTS.indexOf(c);
                return ALLOWED_COUNTS[Math.min(ALLOWED_COUNTS.length - 1, i + 1)];
              })}
              disabled={status === 'loading' || count >= ALLOWED_COUNTS[ALLOWED_COUNTS.length - 1] || !supportsCount}
              style={{ padding: '6px 9px' }}
              aria-label="Increase count"
            >+</button>
          </div>

          <button
            className="nc-btn ghost"
            onClick={() => setAdvanced(a => !a)}
            disabled={status === 'loading'}
            style={{ fontSize: 10 }}
            aria-label="Toggle advanced options"
          >
            {advanced ? '▾ Advanced' : '▸ Advanced'}
          </button>

          <button
            className={`nc-btn primary ${canGenerate ? '' : 'disabled'}`}
            onClick={onGenerate}
            disabled={!canGenerate}
            style={{ marginLeft: 'auto', fontSize: 11 }}
            aria-label="Generate images"
          >
            {status === 'loading' ? 'Generating…' : 'Generate'}
          </button>
        </div>

        <ProviderHint providers={providers} provider={provider} />

        {advanced && (
          <div style={{ marginTop: 10 }}>
            <textarea
              className="nc-textarea mono"
              placeholder={supportsNegative ? 'Negative prompt — things to avoid (optional)…' : 'Negative prompt is only supported by Venice.'}
              value={negative}
              onChange={(e) => setNegative(e.target.value)}
              rows={2}
              disabled={status === 'loading' || !supportsNegative}
              style={{ fontSize: 11, resize: 'vertical', minHeight: 44 }}
            />
            {supportsSafety && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span className="mono muted" style={{ fontSize: 10 }}>fal safety tolerance</span>
                <select
                  className="nc-input mono"
                  value={safety}
                  onChange={(e) => setSafety(e.target.value)}
                  disabled={status === 'loading'}
                  style={{ fontSize: 11, padding: '6px 8px', minWidth: 90 }}
                  aria-label="Safety tolerance"
                  title="Content-filter strictness — 1 strictest, 6 most permissive. Honored by Nano-Banana + Pro-FLUX."
                >
                  {safetyLevels.map(s => (
                    <option key={s} value={s}>{s}{s === '1' ? ' (strict)' : s === '6' ? ' (permissive)' : ''}</option>
                  ))}
                </select>
                <span className="mono muted" style={{ fontSize: 9 }}>1 strict → 6 permissive · Nano-Banana / Pro-FLUX only</span>
              </div>
            )}
          </div>
        )}
      </div>

      <StatusStrip status={status} error={error} resetAt={resetAt} now={now} onRetry={onGenerate} reason={rateLimitReason} />

      {/* Empty state */}
      {!showGrid && history.length === 0 && (
        <div className="st-panel" style={{ padding: 40, textAlign: 'center' }}>
          <Icon name="image" size={48} className="neonc" style={{ opacity: 0.6 }}/>
          <div className="mono muted" style={{ marginTop: 14, fontSize: 12 }}>// nothing generated yet</div>
          <div className="mono muted" style={{ marginTop: 4, fontSize: 10 }}>pick a provider, write a prompt, and hit Generate</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 18 }}>
            {EXAMPLES.map(ex => (
              <button
                key={ex}
                className="tag blue"
                onClick={() => setPrompt(ex)}
                style={{ cursor: 'pointer', fontSize: 9 }}
              >{ex}</button>
            ))}
          </div>
        </div>
      )}

      {/* Current run */}
      {showGrid && (
        <div className="st-grid" style={{ alignContent: 'start' }}>
          {status === 'loading' && Array.from({ length: loadingCount }).map((_, i) => <SkeletonCard key={`sk-${i}`} ratio={selectedRatio} />)}
          {currentRun.map((it, idx) => (
            <ResultCard
              key={it._id || idx}
              item={it}
              ratio={selectedRatio}
              onDiscard={() => setResults(prev => prev.filter(p => p._id !== it._id))}
              onSendToEditor={sendToEditor}
              isNew={status === 'success' && idx < loadingCount}
              staggerIndex={idx}
            />
          ))}
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <>
          <SectionLabel>Earlier in this session</SectionLabel>
          <div className="st-grid" style={{ alignContent: 'start', opacity: 0.85 }}>
            {history.map((it, idx) => (
              <ResultCard
                key={it._id || idx}
                item={it}
                ratio={it.aspect_ratio || '1:1'}
                onDiscard={() => {
                  setResults(prev => prev.filter(p => p._id !== it._id));
                  setHistoryIds(prev => {
                    const next = new Set(prev);
                    next.delete(it._id);
                    return next;
                  });
                }}
                onSendToEditor={sendToEditor}
                isNew={false}
                staggerIndex={-1}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

window.ImageGen = ImageGen;
