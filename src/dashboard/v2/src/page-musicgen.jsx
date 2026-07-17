/* Studio › Music — text → music/audio generation workbench.
 *
 * Sibling of Video (page-videogen) but for audio. Provider + model dropdowns
 * render from the server-side manifest so new music tools appear automatically.
 * Generated tracks land in Studio › Media (the tools deliver there internally);
 * this tab shows the fresh render inline (audio player) plus a session history
 * pulled from the media gallery.
 *
 * Backend contract:
 *   GET  /api/studio/audio-providers → { ok, providers:[{id,label,models[],defaultModel,healthy,degraded,supportsLyrics,note}], defaultProvider }
 *   POST /api/studio/audio-gen       → { ok, media:[{ id, url }], provider, model, prompt }
 *   GET  /api/media?kind=audio       → { ok, items:[{ id, url, prompt, source_tool, created_at }] }
 */

const M_DURATIONS = ['', '15', '30', '60', '90', '120'];

const M_EXAMPLES = [
  'lofi hip-hop beat, mellow piano, rainy night, 80 bpm',
  'epic orchestral cinematic trailer, soaring strings and brass',
  'upbeat synthwave, retro 80s arpeggios, driving bassline',
  'acoustic folk guitar, warm and intimate, fingerpicked',
];

function mGetSession() {
  let s = localStorage.getItem('nc_studio_session');
  if (!s) {
    s = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('nc_studio_session', s);
  }
  return s;
}

function mFormatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function mModelLabel(id) {
  return String(id || '').replace(/[/_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function mStudioApi(path, method, body) {
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

const M_SOURCE_LABEL = { fal_audio: 'fal.ai', kie_audio: 'KIE AI' };

const TrackCard = ({ item, onDownload, staggerIndex, isNew }) => {
  const animations = [
    isNew ? 'pulseGlow 0.5s ease-out' : '',
    staggerIndex >= 0 ? `fadeIn 0.35s ease-out ${Math.min(staggerIndex, 7) * 0.06}s backwards` : '',
  ].filter(Boolean).join(', ');
  const provider = M_SOURCE_LABEL[item.source_tool] || item.source_tool || item.provider || 'audio';
  return (
    <div className="st-card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, position: 'relative', overflow: 'hidden', animation: animations || undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 40, height: 40, borderRadius: 6, flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--accent) 10%, rgba(0,4,12,0.6))', border: '1px solid var(--line-soft)' }}>
          <Icon name="music" size={20} className="neonc" style={{ opacity: 0.8 }}/>
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {item.prompt || '(no prompt)'}
          </div>
        </div>
      </div>
      <audio src={item.url} controls preload="metadata" style={{ width: '100%', height: 34 }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <span className="tag mono" style={{ fontSize: 9, textTransform: 'uppercase' }}>{provider}</span>
        {item.model_id && <span className="tag muted mono" style={{ fontSize: 9 }}>{mModelLabel(item.model_id)}</span>}
        <button
          className="nc-btn"
          title="Download track"
          aria-label="Download track"
          onClick={() => onDownload(item)}
          style={{ fontSize: 11, lineHeight: 1, padding: '3px 7px', marginLeft: 'auto' }}
        >⤓</button>
        <span className="mono muted" style={{ fontSize: 9 }}>{mFormatDate(item.created_at)}</span>
      </div>
    </div>
  );
};

const TrackSkeleton = ({ elapsed }) => (
  <div className="st-card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div style={{
      height: 80, borderRadius: 6, position: 'relative', overflow: 'hidden',
      background: 'rgba(0,4,12,0.5)',
      backgroundImage: 'linear-gradient(90deg, color-mix(in srgb, var(--accent) 4%, transparent) 25%, color-mix(in srgb, var(--accent) 14%, transparent) 50%, color-mix(in srgb, var(--accent) 4%, transparent) 75%)',
      backgroundSize: '200% 100%', animation: 'shimmer 1.4s infinite',
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6,
    }}>
      <Icon name="music" size={30} className="neonc" style={{ opacity: 0.6 }}/>
      <div className="mono muted" style={{ fontSize: 10 }}>composing… {elapsed}s</div>
      <div className="mono muted" style={{ fontSize: 9, opacity: 0.7 }}>music takes ~15-120s</div>
    </div>
  </div>
);

const MusicGen = () => {
  const [providers, setProviders] = React.useState([]);
  const [provider, setProvider] = React.useState('fal_audio');
  const [models, setModels] = React.useState([]);
  const [model, setModel] = React.useState('');

  const [prompt, setPrompt] = React.useState('');
  const [duration, setDuration] = React.useState('');
  const [lyrics, setLyrics] = React.useState('');
  const [advanced, setAdvanced] = React.useState(false);

  const [status, setStatus] = React.useState('idle'); // idle | loading | success | error
  const [error, setError] = React.useState('');
  const [elapsed, setElapsed] = React.useState(0);

  const [results, setResults] = React.useState([]);
  const [historyIds, setHistoryIds] = React.useState(new Set());

  const sessionId = React.useMemo(() => mGetSession(), []);
  const currentProvider = providers.find(p => p.id === provider);

  // Load the audio provider manifest once.
  React.useEffect(() => {
    (async () => {
      try {
        const r = await mStudioApi('studio/audio-providers', 'GET');
        if (!r.ok || !r.data.providers?.length) return;
        setProviders(r.data.providers);
        const def = r.data.defaultProvider || r.data.providers[0].id;
        setProvider(prev => r.data.providers.some(p => p.id === prev) ? prev : def);
      } catch (err) {
        console.error('studio/audio-providers failed', err);
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

  // Session history from the media gallery (audio only).
  const loadHistory = React.useCallback(async () => {
    try {
      const r = await mStudioApi('media?kind=audio', 'GET');
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

  const supportsLyrics = !!currentProvider?.supportsLyrics;
  const isDegraded = currentProvider?.degraded;

  const onGenerate = React.useCallback(async () => {
    const clean = prompt.trim();
    if (!clean || status === 'loading') return;
    if (isDegraded) { setStatus('error'); setError(currentProvider?.note || 'This provider is unavailable.'); return; }
    setStatus('loading');
    setError('');

    const body = {
      provider, model, prompt: clean, sessionId,
      ...(duration ? { duration } : {}),
      ...(supportsLyrics && lyrics.trim() ? { lyrics: lyrics.trim() } : {}),
    };

    const r = await mStudioApi('studio/audio-gen', 'POST', body);

    if (r.ok && Array.isArray(r.data.media) && r.data.media.length) {
      const tracks = r.data.media.map((m, i) => ({
        id: m.id, url: m.url, prompt: clean,
        source_tool: provider, model_id: model || provider,
        provider, created_at: new Date().toISOString(),
        _fresh: `${Date.now()}-${i}`,
      }));
      setResults(prev => [...tracks, ...prev]);
      setStatus('success');
      setTimeout(() => setStatus(s => s === 'success' ? 'idle' : s), 800);
    } else {
      setStatus('error');
      setError(r.data?.error || 'Music generation failed');
    }
  }, [prompt, provider, model, duration, lyrics, supportsLyrics, sessionId, status, isDegraded, currentProvider]);

  const canGenerate = prompt.trim().length > 0 && status !== 'loading' && !isDegraded;

  const download = React.useCallback((item) => {
    const a = document.createElement('a');
    a.href = item.id ? `/api/media/${item.id}/download` : item.url;
    a.download = `music-${item.id || Date.now()}.mp3`;
    document.body.appendChild(a); a.click(); a.remove();
  }, []);

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

      <PageHeader title="Music" subtitle="// text → music/audio · registered providers" />

      {/* Composer */}
      <div className="st-panel" style={{ padding: 14, marginBottom: 14 }}>
        <textarea
          className="nc-textarea"
          placeholder="Describe the music — genre, mood, instruments, tempo…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={textareaRows}
          disabled={status === 'loading'}
          style={{ resize: 'vertical', minHeight: 72 }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <select className="nc-input mono" value={provider} onChange={(e) => setProvider(e.target.value)} disabled={status === 'loading'} style={{ fontSize: 11, padding: '6px 8px', minWidth: 150, flex: '1 1 auto' }} aria-label="Music provider">
            {providers.map(p => (
              <option key={p.id} value={p.id}>{p.degraded ? `${p.label} (unavailable)` : p.label}</option>
            ))}
          </select>

          <select className="nc-input mono" value={model} onChange={(e) => setModel(e.target.value)} disabled={status === 'loading' || models.length === 0} style={{ fontSize: 11, padding: '6px 8px', minWidth: 160, flex: '2 1 auto' }} aria-label="Music model">
            {models.map(m => <option key={m} value={m}>{mModelLabel(m)}</option>)}
          </select>

          <button className="nc-btn ghost" onClick={() => setAdvanced(a => !a)} disabled={status === 'loading'} style={{ fontSize: 10 }} aria-label="Toggle advanced options">
            {advanced ? '▾ Advanced' : '▸ Advanced'}
          </button>

          <button className={`nc-btn primary ${canGenerate ? '' : 'disabled'}`} onClick={onGenerate} disabled={!canGenerate} style={{ marginLeft: 'auto', fontSize: 11 }} aria-label="Generate music">
            {status === 'loading' ? `Composing… ${elapsed}s` : 'Generate'}
          </button>
        </div>

        {currentProvider && (
          <div className="mono muted" style={{ fontSize: 10, marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className={`dot ${currentProvider.degraded ? 'boundary' : 'blue'}`} style={{ width: 6, height: 6 }}/>
            <span style={currentProvider.degraded ? { color: 'var(--boundary)' } : undefined}>{currentProvider.note}</span>
          </div>
        )}

        {advanced && (
          <div style={{ marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="mono muted" style={{ fontSize: 10 }}>duration</span>
              <select className="nc-input mono" value={duration} onChange={(e) => setDuration(e.target.value)} disabled={status === 'loading'} style={{ fontSize: 11, padding: '6px 8px', minWidth: 90 }} aria-label="Duration">
                {M_DURATIONS.map(d => <option key={d || 'auto'} value={d}>{d ? `${d}s` : 'auto'}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 260px' }}>
              <span className="mono muted" style={{ fontSize: 10 }}>lyrics {supportsLyrics ? '(optional · song models)' : '(not supported)'}</span>
              <textarea
                className="nc-textarea mono"
                placeholder={supportsLyrics ? 'optional lyrics for song-generating models…' : 'this provider generates instrumental only'}
                value={lyrics}
                onChange={(e) => setLyrics(e.target.value)}
                disabled={status === 'loading' || !supportsLyrics}
                rows={3}
                style={{ fontSize: 11, padding: '6px 8px', resize: 'vertical', minHeight: 48 }}
                aria-label="Lyrics"
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
        <div className="st-panel" style={{ padding: 40, textAlign: 'center' }}>
          <Icon name="music" size={48} className="neonc" style={{ opacity: 0.6 }}/>
          <div className="mono muted" style={{ marginTop: 14, fontSize: 12 }}>// no tracks yet</div>
          <div className="mono muted" style={{ marginTop: 4, fontSize: 10 }}>pick a provider, describe a vibe, and hit Generate · tracks land in Studio › Media</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 18 }}>
            {M_EXAMPLES.map(ex => (
              <button key={ex} className="tag blue" onClick={() => setPrompt(ex)} style={{ cursor: 'pointer', fontSize: 9 }}>{ex}</button>
            ))}
          </div>
        </div>
      )}

      {/* Current run */}
      {showGrid && (
        <div className="st-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', alignContent: 'start' }}>
          {status === 'loading' && <TrackSkeleton elapsed={elapsed} />}
          {currentRun.map((it, idx) => (
            <TrackCard key={it._fresh || it.id} item={it} onDownload={download} isNew={status === 'success' && idx === 0} staggerIndex={idx} />
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
          <div className="st-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', alignContent: 'start', opacity: 0.9 }}>
            {history.map((it, idx) => (
              <TrackCard key={it.id || idx} item={it} onDownload={download} isNew={false} staggerIndex={-1} />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

window.MusicGen = MusicGen;
