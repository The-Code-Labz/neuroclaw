/* WebApp Studio (Studio sub-tab) — a "lovable/bolt"-style tab: describe a web
 * app and ANY registered agent builds a genuinely functional single-file modern
 * web app (React + Tailwind via CDN). A WebApp is a Canvas project tagged
 * brief.kind='webapp': the backend reuses the whole Canvas engine (generate →
 * store → iterate) with a web-app prompt and a per-call agent choice.
 *
 * The agent picker is the point: not every deployment has a "Jarvis", so the
 * user chooses whichever agent they have. Preview runs in a sandboxed iframe via
 * the relaxed-CSP /api/webapp/artifact/:id/file (CDN scripts + https fetch OK,
 * but NO same-origin — no cookies/storage/parent access).
 *
 * Backend: POST /api/webapp/generate (SSE) · GET /api/webapp/projects ·
 *          GET /api/agents · DELETE /api/canvas/projects/:id ·
 *          preview via /api/webapp/artifact/:id/file
 */

// ─── helper: stream POST with SSE response (mirror of page-gamestudio) ──────
async function streamWebappPOST(path, body, onEvent, signal) {
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

const WEBAPP_IDEAS = [
  'a kanban board with 3 columns and drag-drop cards',
  'a markdown note-taking app with live preview',
  'a pomodoro timer with session history and stats',
  'a personal budget tracker with categories and a chart',
  'a habit tracker with a weekly streak grid',
  'a recipe finder that fetches from a public food API',
];

// Default "Built by" = '' → the backend's reliable non-reasoning code model.
// Agents are opt-in OVERRIDES: many are on general-reasoning (MiniMax) or
// subscription-only (anthropic) models that don't build a full app well, so we
// don't auto-select one — the user deliberately picks a code-capable agent.

// ─── Preview overlay — sandboxed iframe over the relaxed-CSP /file route ────
// Uses /api/webapp/artifact/:id/file: serves the app with a CSP that permits
// CDN scripts (React/Tailwind) + https fetch, but the iframe sandbox has NO
// allow-same-origin, so the app still cannot touch our cookies/DOM/origin.
function PreviewOverlay({ app, onClose }) {
  const artifactId = app?.artifacts?.[app.artifacts.length - 1]?.id;  // latest iteration
  const token = window.NC_API?.token;
  const src = artifactId
    ? `/api/webapp/artifact/${artifactId}/file${token ? '?token=' + encodeURIComponent(token) : ''}`
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
        width: 'min(1180px, 97vw)', height: 'min(820px, 92vh)', display: 'flex', flexDirection: 'column',
        background: 'var(--panel, #0b1220)', border: '1px solid var(--line, #1e293b)', borderRadius: 12, overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--line,#1e293b)' }}>
          <b style={{ flex: 1, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            🖥 {app?.brief?.brief || 'web app'}
          </b>
          <button className="nc-btn" onClick={onClose}>✕ Close</button>
        </div>
        {src ? (
          <iframe
            title="webapp"
            src={src}
            sandbox="allow-scripts"
            style={{ flex: 1, width: '100%', border: 0, background: '#fff' }}
          />
        ) : (
          <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--muted,#94a3b8)' }}>No artifact to preview.</div>
        )}
      </div>
    </div>
  );
}

// ─── Deploy-to-GitHub modal button (shared shape with Game Studio) ─────────
// Pushes the artifact to a GitHub repo via /api/studio/deploy-github (broker
// PAT, no local git). Optionally enables GitHub Pages for an instant live URL.
function DeployButton({ artifactId, defaultName, disabled }) {
  const [open, setOpen]     = React.useState(false);
  const [name, setName]     = React.useState(defaultName || '');
  const [pages, setPages]   = React.useState(true);
  const [busy, setBusy]     = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [err, setErr]       = React.useState(null);
  React.useEffect(() => { if (open) setName(defaultName || ''); }, [open, defaultName]);
  const deploy = async () => {
    if (!name.trim() || busy || !artifactId) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await window.NC_API.post('/api/studio/deploy-github',
        { artifactId, repoName: name.trim(), private: !pages, pages }, 120000);
      if (r?.error) setErr(r.error); else setResult(r);
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };
  return (
    <>
      <button className="nc-btn" disabled={disabled} title="Deploy to GitHub"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}>⬆ GitHub</button>
      {open && (
        <div onClick={() => !busy && setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1100,
          background: 'rgba(2,6,23,.82)', display: 'grid', placeItems: 'center', padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} className="nc-card" style={{ width: 'min(440px,94vw)', padding: 18 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>⬆ Deploy to GitHub</div>
            {!result ? (
              <>
                <label style={{ fontSize: 12, color: 'var(--muted,#94a3b8)' }}>Repository name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app" disabled={busy}
                  style={{ width: '100%', margin: '6px 0 12px', padding: 8, borderRadius: 8,
                    background: 'var(--bg,#020617)', color: 'inherit', border: '1px solid var(--line,#1e293b)' }} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <input type="checkbox" checked={pages} onChange={(e) => setPages(e.target.checked)} disabled={busy} />
                  Enable GitHub Pages — instant live URL (makes the repo public)
                </label>
                {err && <div style={{ fontSize: 12, color: 'var(--err,#ef4444)', marginTop: 10 }}>⚠ {err}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
                  <button className="nc-btn" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
                  <button className="nc-btn nc-btn-primary" onClick={deploy} disabled={busy || !name.trim()}>
                    {busy ? 'Deploying…' : 'Deploy'}</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, color: 'var(--ok,#22c55e)', marginBottom: 10 }}>
                  ✓ {result.created === false ? 'Updated' : 'Deployed'} to GitHub
                </div>
                <div style={{ fontSize: 12, marginBottom: 6, wordBreak: 'break-all' }}>
                  Repo: <a href={result.repo_url} target="_blank" rel="noopener noreferrer">{result.repo_url}</a>
                </div>
                {result.pages_url && (
                  <div style={{ fontSize: 12, wordBreak: 'break-all' }}>
                    Live: <a href={result.pages_url} target="_blank" rel="noopener noreferrer">{result.pages_url}</a>
                    <span style={{ color: 'var(--muted,#94a3b8)' }}> (~1 min to build)</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                  <button className="nc-btn nc-btn-primary" onClick={() => setOpen(false)}>Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function WebAppStudio() {
  const [brief, setBrief]       = React.useState('');
  const [agents, setAgents]     = React.useState([]);
  // Persisted "Built by" choice → the remembered default for this tab.
  const [agentName, setAgent]   = React.useState(() => {
    try { return localStorage.getItem('nc_webapp_agent') || ''; } catch { return ''; }
  });
  React.useEffect(() => {
    try { localStorage.setItem('nc_webapp_agent', agentName); } catch { /* noop */ }
  }, [agentName]);
  const [busy, setBusy]         = React.useState(false);
  const [status, setStatus]     = React.useState('idle');   // idle | building | complete | error
  const [chars, setChars]       = React.useState(0);
  const [elapsed, setElapsed]   = React.useState(0);
  const [err, setErr]           = React.useState(null);
  const [apps, setApps]         = React.useState([]);
  const [previewing, setPrev]   = React.useState(null);
  const timerRef = React.useRef(null);

  const refresh = React.useCallback(async () => {
    try { setApps(await window.NC_API.get('/api/webapp/projects')); } catch { /* noop */ }
  }, []);

  // Load active agents for the builder dropdown. Default stays '' (reliable
  // model) — agents are opt-in overrides, not auto-selected.
  React.useEffect(() => {
    (async () => {
      try {
        const all = await window.NC_API.get('/api/agents');
        const active = (Array.isArray(all) ? all : []).filter(a => (a.status || 'active') === 'active');
        setAgents(active);
      } catch { /* noop */ }
    })();
    refresh();
  }, [refresh]);

  async function build() {
    const b = brief.trim();
    if (!b || busy) return;
    setBusy(true); setErr(null); setChars(0); setElapsed(0); setStatus('building');
    const t0 = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    let hadError = false;
    try {
      let acc = 0;
      await streamWebappPOST('/api/webapp/generate', { brief: b, agentName }, (evt) => {
        if (evt.type === 'chunk') { acc += (evt.payload?.text || '').length; setChars(acc); }
        else if (evt.type === 'error') { hadError = true; setErr(evt.payload?.message || 'build failed'); setStatus('error'); }
        else if (evt.type === 'project.complete') { setStatus('complete'); }
      });
      if (!hadError) { setStatus('complete'); setBrief(''); }
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
    if (!confirm('Delete this web app?')) return;
    try {
      await fetch(`/api/canvas/projects/${id}${window.NC_API?.token ? '?token=' + window.NC_API.token : ''}`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      await refresh();
    } catch { /* noop */ }
  }

  return (
    <div>
      <PageHeader title="WebApp Studio" subtitle="Describe a web app — any agent you pick builds a real, working single-file app you can preview live." />

      {/* Composer */}
      <div className="nc-card" style={{ padding: 16, marginBottom: 16 }}>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) build(); }}
          placeholder="e.g. a kanban board with drag-drop cards and 3 columns"
          rows={2}
          disabled={busy}
          style={{ width: '100%', resize: 'vertical', padding: 10, borderRadius: 8,
            background: 'var(--bg,#020617)', color: 'inherit', border: '1px solid var(--line,#1e293b)', fontSize: 14 }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' }}>
          {WEBAPP_IDEAS.map((g) => (
            <button key={g} className="nc-btn" disabled={busy} onClick={() => setBrief(g)}
              style={{ fontSize: 12, opacity: busy ? .5 : .85 }}>{g}</button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted,#94a3b8)' }}>
            Built by
            <select
              value={agentName}
              onChange={(e) => setAgent(e.target.value)}
              disabled={busy}
              title="Any registered agent can build — pick a strong code/HTML model"
              style={{ padding: '6px 8px', borderRadius: 8, background: 'var(--bg,#020617)', color: 'inherit',
                border: '1px solid var(--line,#1e293b)', fontSize: 13, maxWidth: 240 }}
            >
              <option value="">⚡ Default (fast &amp; reliable)</option>
              {agents.map((a) => (
                <option key={a.id || a.name} value={a.name}>
                  {a.name}{a.model ? ` · ${a.model}` : ''}
                </option>
              ))}
            </select>
          </label>
          <button className="nc-btn nc-btn-primary" onClick={build} disabled={busy || !brief.trim()}>
            {busy ? 'Building…' : '🖥 Build App'}
          </button>
          {status === 'building' && (
            <span style={{ fontSize: 12, color: 'var(--muted,#94a3b8)' }}>
              Building… {elapsed}s · {chars.toLocaleString()} chars · usually 30s–3 min
            </span>
          )}
          {status === 'complete' && !busy && (
            <span style={{ fontSize: 12, color: 'var(--ok,#22c55e)' }}>✓ Built — it's in the gallery below</span>
          )}
          {err && <span style={{ fontSize: 12, color: 'var(--err,#ef4444)' }}>⚠ {err}</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted,#94a3b8)', marginTop: 8 }}>
          Apps run in a sandboxed iframe — no cookies/storage, but they may call public HTTPS APIs. State is session-only.
        </div>
      </div>

      {/* Gallery */}
      {apps.length === 0 ? (
        <div className="nc-card" style={{ padding: 32, textAlign: 'center', color: 'var(--muted,#94a3b8)' }}>
          No web apps yet — describe one above and press <b>Build App</b>.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {apps.map((g) => {
            const ready = g.status === 'complete' && g.artifacts?.length > 0;
            return (
              <div key={g.id} className="nc-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 13, minHeight: 34, lineHeight: 1.35 }}>{g.brief?.brief || 'Untitled app'}</div>
                <div style={{ fontSize: 11, color: 'var(--muted,#94a3b8)' }}>
                  {ready ? 'ready' : (g.status || 'building')}
                  {g.brief?.agentName ? ` · ${g.brief.agentName}` : ''} · {new Date(g.createdAt).toLocaleString()}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="nc-btn nc-btn-primary" disabled={!ready} onClick={() => setPrev(g)} style={{ flex: 1 }}>
                    ▶ Preview
                  </button>
                  <DeployButton
                    artifactId={g.artifacts?.[g.artifacts.length - 1]?.id}
                    defaultName={(g.brief?.brief || 'webapp').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}
                    disabled={!ready} />
                  <button className="nc-btn" onClick={(e) => del(g.id, e)} title="Delete">🗑</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {previewing && <PreviewOverlay app={previewing} onClose={() => setPrev(null)} />}
    </div>
  );
}

window.WebAppStudio = WebAppStudio;
