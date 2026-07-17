/* Game Studio (Studio sub-tab) — commission real, playable browser games from
 * a sentence. A game is a Canvas project tagged brief.kind='game': the backend
 * reuses the whole Canvas engine (generate → store → CSP-sandboxed /view) with
 * a game-tuned prompt. This tab is deliberately thin — describe → build → play.
 *
 * Backend: POST /api/game/generate (SSE) · GET /api/game/projects ·
 *          DELETE /api/canvas/projects/:id · play via /api/canvas/artifact/:id/view
 */

// ─── helper: stream POST with SSE response (mirror of page-canvas) ─────────
async function streamGamePOST(path, body, onEvent, signal) {
  const url = (window.NC_API?.token ? `${path}${path.includes('?') ? '&' : '?'}token=${window.NC_API.token}` : path);
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${t || r.statusText}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      try { onEvent(JSON.parse(data)); } catch { /* skip malformed */ }
    }
  }
}

const GAME_IDEAS = [
  'a neon brick-breaker with power-ups',
  'a fast 2-button endless runner with a high score',
  'a minimalist snake with a rainbow trail',
  'an asteroids clone with screen wrap and particles',
  'a flappy-style one-tap bird with pipes',
  'a grid-based 2048 puzzle',
];

// ─── Play overlay — sandboxed iframe over the /file route ──────────────────
// NOTE: use /file, NOT /view. The /view route is the standalone new-tab
// wrapper and sets `frame-ancestors 'none'` — it REFUSES to be embedded in an
// iframe. The /file route serves the raw artifact with `frame-ancestors 'self'`
// (same-origin embeddable) + the sandbox-matching CSP, which is exactly what a
// same-origin play overlay needs.
function PlayOverlay({ game, onClose }) {
  const artifactId = game?.artifacts?.[0]?.id;
  const token = window.NC_API?.token;
  const src = artifactId
    ? `/api/canvas/artifact/${artifactId}/file${token ? '?token=' + encodeURIComponent(token) : ''}`
    : null;
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(2,6,23,.86)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 'min(960px, 96vw)', height: 'min(720px, 88vh)', display: 'flex', flexDirection: 'column',
        background: 'var(--panel, #0b1220)', border: '1px solid var(--line, #1e293b)', borderRadius: 12, overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--line,#1e293b)' }}>
          <b style={{ flex: 1, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            🎮 {game?.brief?.brief || 'game'}
          </b>
          <button className="nc-btn" onClick={onClose}>✕ Close</button>
        </div>
        {src ? (
          <iframe
            title="game"
            src={src}
            sandbox="allow-scripts"
            allow="autoplay; gamepad"
            style={{ flex: 1, width: '100%', border: 0, background: '#000' }}
          />
        ) : (
          <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--muted,#94a3b8)' }}>No artifact to play.</div>
        )}
      </div>
    </div>
  );
}

function GameStudio() {
  const [brief, setBrief]     = React.useState('');
  const [busy, setBusy]       = React.useState(false);
  const [status, setStatus]   = React.useState('idle');   // idle | building | complete | error
  const [chars, setChars]     = React.useState(0);
  const [elapsed, setElapsed] = React.useState(0);
  const [err, setErr]         = React.useState(null);
  const [games, setGames]     = React.useState([]);
  const [playing, setPlaying] = React.useState(null);
  const timerRef = React.useRef(null);

  const refresh = React.useCallback(async () => {
    try { setGames(await window.NC_API.get('/api/game/projects')); } catch { /* noop */ }
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  async function build() {
    const b = brief.trim();
    if (!b || busy) return;
    setBusy(true); setErr(null); setChars(0); setElapsed(0); setStatus('building');
    const t0 = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    try {
      let acc = 0;
      await streamGamePOST('/api/game/generate', { brief: b }, (evt) => {
        if (evt.type === 'chunk') { acc += (evt.payload?.text || '').length; setChars(acc); }
        else if (evt.type === 'error') { setErr(evt.payload?.message || 'build failed'); setStatus('error'); }
        else if (evt.type === 'project.complete') { setStatus('complete'); }
      });
      if (status !== 'error') { setStatus('complete'); setBrief(''); }
      await refresh();
    } catch (e) {
      setErr(String(e.message || e)); setStatus('error');
    } finally {
      clearInterval(timerRef.current);
      setBusy(false);
    }
  }

  async function del(id, e) {
    e?.stopPropagation();
    if (!confirm('Delete this game?')) return;
    try {
      await fetch(`/api/canvas/projects/${id}${window.NC_API?.token ? '?token=' + window.NC_API.token : ''}`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      await refresh();
    } catch { /* noop */ }
  }

  return (
    <div>
      <PageHeader title="Game Studio" subtitle="Describe a game in a sentence — it builds a real, playable browser game." />

      {/* Composer */}
      <div className="nc-card" style={{ padding: 16, marginBottom: 16 }}>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) build(); }}
          placeholder="e.g. a fast 2-button endless runner with a high score"
          rows={2}
          disabled={busy}
          style={{ width: '100%', resize: 'vertical', padding: 10, borderRadius: 8,
            background: 'var(--bg,#020617)', color: 'inherit', border: '1px solid var(--line,#1e293b)', fontSize: 14 }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' }}>
          {GAME_IDEAS.map((g) => (
            <button key={g} className="nc-btn" disabled={busy} onClick={() => setBrief(g)}
              style={{ fontSize: 12, opacity: busy ? .5 : .85 }}>{g}</button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="nc-btn nc-btn-primary" onClick={build} disabled={busy || !brief.trim()}>
            {busy ? 'Building…' : '🎮 Build Game'}
          </button>
          {status === 'building' && (
            <span style={{ fontSize: 12, color: 'var(--muted,#94a3b8)' }}>
              Building… {elapsed}s · {chars.toLocaleString()} chars · usually 30s–2 min
            </span>
          )}
          {status === 'complete' && !busy && (
            <span style={{ fontSize: 12, color: 'var(--ok,#22c55e)' }}>✓ Built — it's in the gallery below</span>
          )}
          {err && <span style={{ fontSize: 12, color: 'var(--err,#ef4444)' }}>⚠ {err}</span>}
        </div>
      </div>

      {/* Gallery */}
      {games.length === 0 ? (
        <div className="nc-card" style={{ padding: 32, textAlign: 'center', color: 'var(--muted,#94a3b8)' }}>
          No games yet — describe one above and press <b>Build Game</b>.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
          {games.map((g) => {
            const playable = g.status === 'complete' && g.artifacts?.length > 0;
            return (
              <div key={g.id} className="nc-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 13, minHeight: 34, lineHeight: 1.35 }}>{g.brief?.brief || 'Untitled game'}</div>
                <div style={{ fontSize: 11, color: 'var(--muted,#94a3b8)' }}>
                  {playable ? 'ready' : (g.status || 'building')} · {new Date(g.createdAt).toLocaleString()}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="nc-btn nc-btn-primary" disabled={!playable} onClick={() => setPlaying(g)} style={{ flex: 1 }}>
                    ▶ Play
                  </button>
                  <button className="nc-btn" onClick={(e) => del(g.id, e)} title="Delete">🗑</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {playing && <PlayOverlay game={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}

window.GameStudio = GameStudio;
