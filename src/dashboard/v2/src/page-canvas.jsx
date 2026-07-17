/* Canvas — Asia's design studio workspace.
 *
 * Implements the workspace surface from docs/specs/design-tab-ASAGI-brief.md.
 * The chat surface (Phase 3 of the brief) will eventually reuse the same
 * /api/canvas/* endpoints — keep this file thin and route-driven.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ Brief / Discovery / Direction picker + Live plan card            │
 *   ├──────────────────────┬───────────────────────────────────────────┤
 *   │ Sandboxed iframe     │ Critique radar · Export bar · Iterate    │
 *   │ artifact preview     │ chat (Asia)                               │
 *   └──────────────────────┴───────────────────────────────────────────┘
 */

const TONES = ['Cinematic', 'Minimal', 'Playful', 'Authoritative', 'Editorial', 'Experimental'];
const AUDIENCES = ['Investors', 'Engineers', 'Designers', 'Executives', 'End users', 'General public'];
const SURFACES = [
  { id: 'deck',        label: 'Pitch deck' },
  { id: 'web',         label: 'Web page' },
  { id: 'mobile',      label: 'Mobile screen' },
  { id: 'poster',      label: 'Poster' },
  { id: 'motion',      label: 'Motion piece' },
  { id: 'infographic', label: 'Infographic' },
];
const SCALES = [
  { id: 'single',     label: 'Single' },
  { id: 'multi-page', label: 'Multi-page' },
  { id: 'prototype',  label: 'Prototype' },
];

// ─── helper: stream POST with SSE response ───────────────────────────────
async function streamCanvasPOST(path, body, onEvent, signal) {
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

// ─── srcdoc CSP helper ───────────────────────────────────────────────────
// Mirror of src/skills/canvas/srcdoc.ts. The v2 dashboard has no bundler, so
// this browser file cannot import the server module — the duplication is
// intentional. Keep the two copies in sync.
const CANVAS_CSP = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src data: https:",
  "script-src 'unsafe-inline'",
  "connect-src 'none'",
  // NOTE: frame-ancestors is ignored when this CSP is delivered via <meta>
  // (header-only directive). Kept here so CANVAS_CSP stays byte-identical to
  // the /file route's HTTP-header CSP. iframe sandbox is the real frame guard.
  "frame-ancestors 'self'",
].join('; ');

function withCspMeta(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}">`;
  const s = html || '';
  if (/<head[^>]*>/i.test(s)) return s.replace(/<head[^>]*>/i, (m) => m + meta);
  if (/<html[^>]*>/i.test(s)) return s.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
  return `<head>${meta}</head>${s}`;
}

// ─── Activity-log mapping ────────────────────────────────────────────────
// The // ACTIVITY strip is event-level (one line per SSE event); the
// neuroclaw.log lines from engine.ts are phase-level. The two timelines
// differ on purpose — do not "reconcile" them.
function activityLineFor(evt) {
  const p = evt.payload || {};
  switch (evt.type) {
    case 'project.start':       return { kind: 'info', text: 'project started' };
    case 'discovery.form.show': return { kind: 'step', text: 'discovery' };
    case 'direction.form.show': return { kind: 'step', text: 'direction options loaded' };
    case 'todo.update': {
      const list = Array.isArray(p) ? p : [];
      const done = list.filter((t) => t.status === 'completed').length;
      return { kind: 'step', text: `plan · ${done}/${list.length} steps done` };
    }
    case 'tool.call':
      if (p.ok !== undefined) {
        return p.ok
          ? { kind: 'ok',    text: `✓ ${p.name} · ${p.ms != null ? p.ms : 0}ms${p.chars ? ' · ' + p.chars.toLocaleString() + ' chars' : ''}` }
          : { kind: 'error', text: `✗ ${p.name} failed` };
      }
      return { kind: 'step', text: `▶ ${p.name}${p.args && p.args.model ? ' · model=' + p.args.model : ''}` };
    case 'artifact.emit':    return { kind: 'ok',    text: 'artifact emitted' };
    case 'critique.result':  return { kind: 'ok',    text: 'critique scored' };
    case 'project.complete': return { kind: 'ok',    text: 'complete' };
    case 'error':            return { kind: 'error', text: '✗ ' + (p.message || 'unknown error') };
    // 'chunk' (streaming tokens) is intentionally skipped here — it would flood
    // the log with one line per token. Chunks instead drive the live StreamMeter
    // (char + elapsed counter). pushActivity drops null lines.
    default: return null;
  }
}

// ─── Brief / Discovery / Direction (left panel) ──────────────────────────
const BriefPanel = ({ form, setForm, onSubmit, busy, agents, agentName, setAgent }) => (
  <div className="st-panel" style={{ padding: 14 }}>
    <div className="label-tiny" style={{ color: 'var(--accent)' }}>// BRIEF</div>
    <textarea
      value={form.brief}
      onChange={e => setForm(f => ({ ...f, brief: e.target.value }))}
      placeholder='e.g. "design a magazine-style pitch deck for our seed round"'
      rows={4}
      style={{
        width: '100%', marginTop: 8, background: 'color-mix(in srgb, var(--text) 4%, transparent)',
        color: 'var(--text)', border: '1px solid var(--line)',
        padding: 10, fontFamily: 'var(--mono)', fontSize: 12, resize: 'vertical',
        borderRadius: 3,
      }}
    />

    <div className="label-tiny" style={{ marginTop: 12 }}>SURFACE</div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {SURFACES.map(s => (
        <button key={s.id}
          className={`nc-btn ${form.surface === s.id ? '' : 'ghost'}`}
          style={{ fontSize: 10, padding: '4px 8px' }}
          onClick={() => setForm(f => ({ ...f, surface: s.id }))}>{s.label}</button>
      ))}
    </div>

    <div className="label-tiny" style={{ marginTop: 10 }}>AUDIENCE</div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {AUDIENCES.map(a => (
        <button key={a}
          className={`nc-btn ${form.audience === a ? '' : 'ghost'}`}
          style={{ fontSize: 10, padding: '4px 8px' }}
          onClick={() => setForm(f => ({ ...f, audience: a }))}>{a}</button>
      ))}
    </div>

    <div className="label-tiny" style={{ marginTop: 10 }}>TONE</div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {TONES.map(t => (
        <button key={t}
          className={`nc-btn ${form.tone === t ? '' : 'ghost'}`}
          style={{ fontSize: 10, padding: '4px 8px' }}
          onClick={() => setForm(f => ({ ...f, tone: t }))}>{t}</button>
      ))}
    </div>

    <div className="label-tiny" style={{ marginTop: 10 }}>SCALE</div>
    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
      {SCALES.map(s => (
        <button key={s.id}
          className={`nc-btn ${form.scale === s.id ? '' : 'ghost'}`}
          style={{ fontSize: 10, padding: '4px 8px' }}
          onClick={() => setForm(f => ({ ...f, scale: s.id }))}>{s.label}</button>
      ))}
    </div>

    <div className="label-tiny" style={{ marginTop: 10 }}>BUILT BY</div>
    <select
      value={agentName}
      onChange={e => setAgent(e.target.value)}
      disabled={busy}
      title="Any registered agent can build — pick a strong code/HTML model, or leave on the reliable default. Your choice is remembered as the default."
      style={{
        width: '100%', marginTop: 6, background: 'rgba(2,6,23,0.6)',
        color: 'var(--text)', border: '1px solid var(--line)',
        padding: '6px 8px', fontFamily: 'var(--mono)', fontSize: 11, borderRadius: 3,
      }}
    >
      <option value="">⚡ Default (fast &amp; reliable)</option>
      {(agents || []).map(a => (
        <option key={a.id || a.name} value={a.name}>{a.name}{a.model ? ` · ${a.model}` : ''}</option>
      ))}
    </select>

    <button onClick={onSubmit}
      disabled={busy || !form.brief?.trim()}
      style={{
        marginTop: 14, width: '100%', padding: '10px',
        background: busy ? 'color-mix(in srgb, var(--accent) 20%, transparent)' : 'var(--accent)',
        color: '#000', border: 0, borderRadius: 3,
        fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12,
        letterSpacing: '0.08em', cursor: busy ? 'wait' : 'pointer',
      }}>
      {busy ? '◐ GENERATING…' : '▶ GENERATE'}
    </button>
  </div>
);

const DirectionPicker = ({ directions, active, onPick }) => (
  <div className="nc-panel" style={{ padding: 12, marginTop: 12 }}>
    <div className="label-tiny" style={{ color: 'var(--accent-2)' }}>// DIRECTION</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
      {directions.map(d => (
        <button key={d.id}
          onClick={() => onPick(d.id)}
          style={{
            textAlign: 'left',
            padding: '8px 10px',
            background: active === d.id ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'color-mix(in srgb, var(--text) 4%, transparent)',
            border: '1px solid ' + (active === d.id ? 'var(--accent)' : 'var(--line)'),
            borderRadius: 3, cursor: 'pointer', color: 'var(--text)',
          }}>
          <div className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>{d.name}</div>
          <div className="mono muted" style={{ fontSize: 10, marginTop: 2 }}>{d.philosophy}</div>
        </button>
      ))}
    </div>
  </div>
);

const LivePlanCard = ({ todos, status, errors }) => (
  <div className="nc-panel" style={{ padding: 12, marginTop: 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div className="label-tiny" style={{ color: 'var(--violet)' }}>// LIVE PLAN</div>
      <span className={`tag ${status === 'complete' ? 'green' : status === 'error' ? 'red' : 'cyan'}`} style={{ fontSize: 9 }}>
        {status || 'idle'}
      </span>
    </div>
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {todos.length === 0 && <div className="mono muted" style={{ fontSize: 11 }}>// awaiting brief…</div>}
      {todos.map(t => (
        <div key={t.id} className="mono" style={{ display: 'flex', gap: 8, fontSize: 11, alignItems: 'center' }}>
          <span style={{
            display: 'inline-block', width: 12, height: 12, borderRadius: 2,
            border: '1px solid var(--line)',
            background:
              t.status === 'completed'   ? 'var(--accent-2)' :
              t.status === 'in_progress' ? 'var(--amber)'  : 'transparent',
          }} />
          <span style={{ color: t.status === 'completed' ? 'var(--muted)' : 'var(--text)', textDecoration: t.status === 'completed' ? 'line-through' : 'none' }}>
            {t.text}
          </span>
        </div>
      ))}
    </div>
    {errors.length > 0 && (
      <div style={{ marginTop: 10, padding: 8, background: 'rgba(251,59,95,0.08)', border: '1px solid var(--danger)', borderRadius: 3 }}>
        {errors.map((e, i) => <div key={i} className="mono" style={{ fontSize: 10, color: 'var(--danger)' }}>! {e}</div>)}
      </div>
    )}
  </div>
);

// ─── Artifact preview (center, sandboxed iframe) ─────────────────────────
const ArtifactPreview = ({ artifact, expanded, onExpand }) => {
  if (!artifact) {
    return (
      <div className="nc-panel" style={{
        flex: 1, minHeight: 720, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'repeating-linear-gradient(45deg, color-mix(in srgb, var(--accent) 4%, transparent), color-mix(in srgb, var(--accent) 4%, transparent) 10px, transparent 10px, transparent 20px)',
        border: '1px dashed var(--line)',
      }}>
        <div className="mono muted" style={{ textAlign: 'center', fontSize: 12 }}>
          <Icon name="canvas" size={42} className="neonc" />
          <div style={{ marginTop: 12 }}>// no artifact yet</div>
          <div style={{ marginTop: 4, fontSize: 10 }}>submit a brief to begin</div>
        </div>
      </div>
    );
  }

  // While the expand overlay is open, render a static placeholder so only the
  // overlay's iframe executes (no duplicate timers/animations).
  if (expanded) {
    return (
      <div className="nc-panel" style={{
        flex: 1, minHeight: 720, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: '1px dashed var(--line)',
      }}>
        <div className="mono muted" style={{ fontSize: 12 }}>⤢ viewing in overlay</div>
      </div>
    );
  }

  const openNewTab = () => {
    const t = window.NC_API?.token;
    const url = `/api/canvas/artifact/${artifact.id}/view${t ? '?token=' + encodeURIComponent(t) : ''}`;
    window.open(url, '_blank', 'noopener');
  };

  const toolbar = (
    <div style={{ position: 'absolute', top: 6, right: 6, zIndex: 2, display: 'flex', gap: 4 }}>
      <button className="nc-btn ghost" title="Expand" onClick={onExpand}
        style={{ fontSize: 12, padding: '2px 7px' }}>⤢</button>
      <button className="nc-btn ghost" title="Open in new tab" onClick={openNewTab}
        style={{ fontSize: 12, padding: '2px 7px' }}>⧉</button>
    </div>
  );

  // SECURITY: §7 of the brief — sandbox includes allow-scripts but NEVER
  // allow-same-origin. The artifact renders via srcdoc (no tokened URL); the
  // §7 CSP travels inside the document via withCspMeta().
  if (artifact.type !== 'html') {
    return (
      <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
        {toolbar}
        <div className="nc-panel" style={{
          flex: 1, minHeight: 720, display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '1px solid var(--line)',
        }}>
          <div className="mono muted" style={{ fontSize: 12 }}>// preview unavailable for this artifact type</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
      {toolbar}
      <iframe
        key={artifact.id}
        title={artifact.title || 'artifact'}
        srcDoc={withCspMeta(artifact.content)}
        sandbox="allow-scripts"
        style={{ width: '100%', flex: 1, border: '1px solid var(--line)', background: '#fff', borderRadius: 3, minHeight: 720 }}
      />
    </div>
  );
};

// ─── Expand overlay (full-viewport artifact view) ────────────────────────
const ExpandedOverlay = ({ artifact, onClose }) => {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,4,12,0.92)', display: 'flex', flexDirection: 'column', padding: 16,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span className="label-tiny" style={{ color: 'var(--accent)' }}>// PREVIEW · {artifact.title || 'artifact'}</span>
        <button className="nc-btn" onClick={onClose} style={{ fontSize: 11 }}>✕ close</button>
      </div>
      {artifact.type === 'html' ? (
        <iframe
          key={artifact.id}
          title={artifact.title || 'artifact'}
          srcDoc={withCspMeta(artifact.content)}
          sandbox="allow-scripts"
          style={{ flex: 1, width: '100%', border: '1px solid var(--line)', background: '#fff', borderRadius: 3 }}
        />
      ) : (
        <div className="nc-panel" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="mono muted" style={{ fontSize: 12 }}>// preview unavailable for this artifact type</div>
        </div>
      )}
    </div>
  );
};

// ─── Critique radar ──────────────────────────────────────────────────────
const CritiqueRadar = ({ critique }) => {
  if (!critique) return <div className="mono muted" style={{ fontSize: 11 }}>// critique pending…</div>;
  const dims = ['clarity', 'hierarchy', 'craft', 'brandFit', 'emotion'];
  const labels = { clarity: 'Clarity', hierarchy: 'Hierarchy', craft: 'Craft', brandFit: 'Brand Fit', emotion: 'Emotion' };
  const cx = 90, cy = 90, R = 70;
  const pt = (i, v) => {
    const a = (Math.PI * 2 / dims.length) * i - Math.PI / 2;
    const r = R * (v / 10);
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  const poly = dims.map((d, i) => pt(i, critique.scores[d] || 0).join(',')).join(' ');
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <svg width={180} height={180} style={{ flexShrink: 0 }}>
        {[2, 4, 6, 8, 10].map(g => (
          <polygon key={g}
            points={dims.map((_, i) => pt(i, g).join(',')).join(' ')}
            fill="none" stroke="color-mix(in srgb, var(--accent) 12%, transparent)" strokeWidth="1"
          />
        ))}
        {dims.map((d, i) => {
          const [x, y] = pt(i, 10);
          return <line key={d} x1={cx} y1={cy} x2={x} y2={y} stroke="color-mix(in srgb, var(--accent) 18%, transparent)" strokeWidth="1" />;
        })}
        <polygon points={poly} fill="color-mix(in srgb, var(--accent-2) 18%, transparent)" stroke="var(--accent-2)" strokeWidth="1.5" />
        {dims.map((d, i) => {
          const [x, y] = pt(i, 11);
          return <text key={d} x={x} y={y} fontSize="9" fill="var(--text-soft)" fontFamily="var(--mono)" textAnchor="middle">{labels[d]}</text>;
        })}
      </svg>
      <div style={{ flex: 1 }}>
        <div className="label-tiny" style={{ color: 'var(--accent-2)' }}>// NOTES</div>
        <ul className="mono" style={{ fontSize: 10, color: 'var(--text-soft)', marginTop: 6, paddingLeft: 16, lineHeight: 1.5 }}>
          {(critique.notes || []).map((n, i) => <li key={i} style={{ marginBottom: 4 }}>{n}</li>)}
        </ul>
      </div>
    </div>
  );
};

// ─── Iterate chat (right panel) ──────────────────────────────────────────
const IterateChat = ({ artifact, onIterate, busy, messages }) => {
  const [input, setInput] = React.useState('');
  if (!artifact) return <div className="mono muted" style={{ fontSize: 11, padding: 12 }}>// generate an artifact first to iterate</div>;
  const send = () => {
    const t = input.trim();
    if (!t || busy) return;
    onIterate(t);
    setInput('');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="label-tiny" style={{ color: 'var(--accent)' }}>// ASIA · ITERATE</div>
      <div style={{ maxHeight: 120, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {messages.map((m, i) => (
          <div key={i} className="mono" style={{
            fontSize: 10, padding: '4px 8px', borderRadius: 3,
            background: m.role === 'user' ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'rgba(139,92,246,0.08)',
            color: m.role === 'user' ? 'var(--text)' : 'var(--text-soft)',
            borderLeft: `2px solid ${m.role === 'user' ? 'var(--accent)' : 'var(--violet)'}`,
          }}>
            <span style={{ color: 'var(--muted)' }}>{m.role}:</span> {m.text}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); }}
          placeholder='e.g. "make the hero darker"'
          disabled={busy}
          style={{
            flex: 1, padding: '6px 8px', background: 'color-mix(in srgb, var(--text) 4%, transparent)',
            color: 'var(--text)', border: '1px solid var(--line)',
            fontFamily: 'var(--mono)', fontSize: 11, borderRadius: 3,
          }}
        />
        <button className="nc-btn" onClick={send} disabled={busy || !input.trim()} style={{ fontSize: 10, padding: '6px 10px' }}>
          {busy ? '◐' : '↵'}
        </button>
      </div>
    </div>
  );
};

// ─── Export bar ──────────────────────────────────────────────────────────
const ExportBar = ({ artifact, onMultiCritique, multiBusy }) => {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr]   = React.useState(null);
  const doExport = async (format) => {
    if (!artifact) return;
    setBusy(true); setErr(null);
    try {
      const r = await window.NC_API.post('/api/canvas/export', { artifactId: artifact.id, format });
      if (r.url) {
        const tokenedUrl = window.NC_API?.token ? `${r.url}${r.url.includes('?') ? '&' : '?'}token=${window.NC_API.token}` : r.url;
        window.open(tokenedUrl, '_blank', 'noopener');
      }
    } catch (e) {
      setErr(e.message || String(e));
    }
    setBusy(false);
  };
  return (
    <div>
      <div className="label-tiny" style={{ color: 'var(--violet)' }}>// EXPORT</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="nc-btn ghost" onClick={() => doExport('html')} disabled={!artifact || busy} style={{ fontSize: 10, padding: '4px 8px' }}>HTML</button>
        <button className="nc-btn ghost" disabled title="Install the opt-in huashu-design skill to enable PDF export" style={{ fontSize: 10, padding: '4px 8px', opacity: 0.4, cursor: 'not-allowed' }}>PDF</button>
        <button className="nc-btn ghost" disabled title="Install the opt-in huashu-design skill to enable PPTX export" style={{ fontSize: 10, padding: '4px 8px', opacity: 0.4, cursor: 'not-allowed' }}>PPTX</button>
        <button className="nc-btn ghost" onClick={() => doExport('zip')}  disabled={!artifact || busy} style={{ fontSize: 10, padding: '4px 8px' }}>ZIP</button>
        <button className="nc-btn" onClick={onMultiCritique} disabled={!artifact || multiBusy} style={{ fontSize: 10, padding: '4px 8px', marginLeft: 'auto' }}>
          {multiBusy ? '◐ multi-critique…' : '+ multi-agent critique'}
        </button>
      </div>
      {err && <div className="mono" style={{ fontSize: 10, color: 'var(--danger)', marginTop: 6 }}>! {err}</div>}
    </div>
  );
};

// ─── Project history (rightmost rail) ────────────────────────────────────
const ProjectHistory = ({ projects, activeId, onPick, onDelete }) => (
  <div>
    <div className="label-tiny" style={{ color: 'var(--muted)' }}>// HISTORY</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
      {projects.length === 0 && <div className="mono muted" style={{ fontSize: 10 }}>// no past projects</div>}
      {projects.slice(0, 12).map(p => (
        <div key={p.id} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: activeId === p.id ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
          border: '1px solid ' + (activeId === p.id ? 'var(--line-hard)' : 'var(--line-soft)'),
          borderRadius: 3, padding: '4px 6px',
        }}>
          <button onClick={() => onPick(p.id)} style={{ flex: 1, background: 'transparent', border: 0, textAlign: 'left', cursor: 'pointer', color: 'var(--text)' }}>
            <div className="mono" style={{ fontSize: 10 }}>{(p.brief?.brief || 'untitled').slice(0, 36)}</div>
            <div className="mono muted" style={{ fontSize: 9 }}>{p.artifacts.length} artifact · {p.status}</div>
          </button>
          <button onClick={() => onDelete(p.id)} className="nc-btn ghost" style={{ fontSize: 9, padding: '2px 4px' }} title="delete">×</button>
        </div>
      ))}
    </div>
  </div>
);

// ─── License footer ──────────────────────────────────────────────────────
const CanvasFooter = () => (
  <div className="mono muted" style={{ fontSize: 9, padding: '8px 0', textAlign: 'right', borderTop: '1px dashed var(--line-soft)', marginTop: 12 }}>
    Powered by NeuroClaw canvas skill · open-design (Apache-2.0, optional) · huashu-design (Personal-Use, opt-in)
  </div>
);

// ─── Activity log (collapsible strip) ────────────────────────────────────
const ActivityLog = ({ entries, open, onToggle }) => {
  const bottomRef = React.useRef(null);
  React.useEffect(() => {
    if (open && bottomRef.current) bottomRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [entries, open]);
  const colorOf = (k) => k === 'error' ? 'var(--danger)' : k === 'ok' ? 'var(--accent-2)' : 'var(--text-soft)';
  return (
    <div className="nc-panel" style={{ marginTop: 12, padding: 0, overflow: 'hidden' }}>
      <div onClick={onToggle} style={{
        cursor: 'pointer', padding: '8px 12px', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center',
        borderBottom: open ? '1px solid var(--line-soft)' : 'none',
      }}>
        <span className="label-tiny" style={{ color: 'var(--accent)' }}>// ACTIVITY · {entries.length} events</span>
        <span className="mono muted" style={{ fontSize: 11 }}>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div style={{ background: 'color-mix(in srgb, var(--text) 3%, transparent)', padding: '8px 12px', maxHeight: 220, overflow: 'auto' }}>
          {entries.length === 0 && (
            <div className="mono muted" style={{ fontSize: 11 }}>// no activity yet</div>
          )}
          {entries.map((e, i) => (
            <div key={i} className="mono" style={{
              display: 'grid', gridTemplateColumns: '70px 1fr', gap: 10,
              fontSize: 11, lineHeight: 1.5, padding: '2px 0',
            }}>
              <span className="muted">{e.t}</span>
              <span style={{ color: colorOf(e.kind), wordBreak: 'break-word' }}>{e.text}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
};

// ─── Live stream meter ───────────────────────────────────────────────────
// Shows a live char + elapsed readout while an LLM call is in flight, so the
// long generation is never a silent "◐ GENERATING…" gap. Fed by `chunk` SSE
// events (char count via a ref, no per-token re-render) and a 500ms ticker.
const StreamMeter = ({ stream, chars }) => {
  if (!stream) return null;
  const elapsed = ((Date.now() - stream.startMs) / 1000).toFixed(1);
  return (
    <div className="nc-panel glow" style={{
      padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10,
      border: '1px solid var(--accent)', background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
    }}>
      <span className="mono nc-spin" style={{ color: 'var(--accent)', fontSize: 13 }}>◐</span>
      <span className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>{stream.name}</span>
      {chars > 0 && <span className="mono muted" style={{ fontSize: 11 }}>· {chars.toLocaleString()} chars</span>}
      <span className="mono muted" style={{ fontSize: 11, marginLeft: 'auto' }}>{elapsed}s</span>
    </div>
  );
};

// ─── Main page ───────────────────────────────────────────────────────────
const Canvas = () => {
  const [form, setForm] = React.useState({ brief: '', surface: 'web', audience: 'Investors', tone: 'Cinematic', scale: 'single' });
  const [directions, setDirections] = React.useState([]);
  const [activeDirection, setActiveDirection] = React.useState(null);
  // "Built by" agent picker. The choice is persisted in localStorage → it acts
  // as the remembered default for this tab. '' = the reliable default model.
  const [agents, setAgents] = React.useState([]);
  const [agentName, setAgent] = React.useState(() => {
    try { return localStorage.getItem('nc_canvas_agent') || ''; } catch { return ''; }
  });
  React.useEffect(() => {
    try { localStorage.setItem('nc_canvas_agent', agentName); } catch { /* noop */ }
  }, [agentName]);
  const [project, setProject] = React.useState(null);   // current full project
  const [artifact, setArtifact] = React.useState(null); // latest emitted artifact
  const [todos, setTodos] = React.useState([]);
  const [status, setStatus] = React.useState('idle');   // idle | discovery | direction | building | critique | complete | error
  const [errors, setErrors] = React.useState([]);
  const [critique, setCritique] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [iterBusy, setIterBusy] = React.useState(false);
  const [multiBusy, setMultiBusy] = React.useState(false);
  const [chatLog, setChatLog] = React.useState([]);
  const [projects, setProjects] = React.useState([]);
  const [expanded, setExpanded] = React.useState(false);
  const closeExpanded = React.useCallback(() => setExpanded(false), []);
  const [activity, setActivity] = React.useState([]);
  const [activityOpen, setActivityOpen] = React.useState(false);
  // Live stream meter — { name, startMs } while an LLM call is in flight, else
  // null. Char count is held in a ref (incremented per `chunk` with no
  // re-render) and surfaced by a 500ms ticker so the readout stays smooth
  // without thousands of setState calls.
  const [stream, setStream] = React.useState(null);
  const streamCharsRef = React.useRef(0);
  const [, forceTick] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => {
    if (!stream) return;
    const id = setInterval(forceTick, 500);
    return () => clearInterval(id);
  }, [stream]);
  const pushActivity = React.useCallback((evt) => {
    const line = activityLineFor(evt);
    if (!line) return;
    const t = new Date().toLocaleTimeString('en-US', { hour12: false });
    setActivity((a) => [...a, { t, kind: line.kind, text: line.text }]);
  }, []);
  const abortRef = React.useRef(null);

  const loadProjects = React.useCallback(async () => {
    try { setProjects(await window.NC_API.get('/api/canvas/projects')); }
    catch { /* noop */ }
  }, []);

  React.useEffect(() => {
    (async () => {
      try { setDirections(await window.NC_API.get('/api/canvas/directions')); } catch { /* noop */ }
      try {
        const all = await window.NC_API.get('/api/agents');
        setAgents((Array.isArray(all) ? all : []).filter(a => (a.status || 'active') === 'active'));
      } catch { /* noop */ }
      loadProjects();
    })();
  }, [loadProjects]);

  const onSubmit = React.useCallback(async () => {
    if (busy || !form.brief.trim()) return;
    setBusy(true);
    setErrors([]);
    setTodos([]);
    setCritique(null);
    setArtifact(null);
    // GENERATE starts a fresh project every time; iterate refines the current
    // one. Without this, every generate piled into the first project (with its
    // stale brief as the history label).
    setProject(null);
    setExpanded(false);
    setStatus('discovery');
    setActivity([]);
    setActivityOpen(true);
    setStream(null);
    streamCharsRef.current = 0;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamCanvasPOST('/api/canvas/generate', {
        brief:     form.brief,
        surface:   form.surface,
        audience:  form.audience,
        tone:      form.tone,
        scale:     form.scale,
        direction: activeDirection || undefined,
        agentName: agentName || undefined,   // '' → backend reliable default
        // Intentionally omit projectId — a fresh GENERATE is a new project.
      }, (evt) => {
        pushActivity(evt);
        switch (evt.type) {
          case 'project.start':
            setProject(p => p || { id: evt.payload.projectId, artifacts: [], brief: { brief: form.brief }, status: 'building' });
            break;
          case 'discovery.form.show':
            setStatus('discovery');
            break;
          case 'direction.form.show':
            setStatus('direction');
            break;
          case 'todo.update':
            setTodos(evt.payload);
            break;
          case 'tool.call':
            setStatus('building');
            if (evt.payload?.ok === undefined) {
              // start marker — begin the live meter for this call
              streamCharsRef.current = 0;
              setStream({ name: evt.payload?.name || 'llm', startMs: Date.now() });
            } else {
              // end marker — stop the meter
              setStream(null);
            }
            break;
          case 'chunk':
            // token delta — accumulate chars in the ref (no re-render); the
            // 500ms ticker repaints the meter.
            streamCharsRef.current += (evt.payload?.text?.length || 0);
            break;
          case 'artifact.emit':
            setArtifact(evt.payload);
            setStatus('critique');
            setStream(null);
            break;
          case 'critique.result':
            setCritique(evt.payload);
            break;
          case 'project.complete':
            setStatus('complete');
            setStream(null);
            loadProjects();
            break;
          case 'error':
            setErrors(e => [...e, evt.payload?.message || 'unknown error']);
            setStatus('error');
            setStream(null);
            break;
        }
      }, ctrl.signal);
    } catch (err) {
      if (err.name !== 'AbortError') {
        setErrors(e => [...e, err.message]);
        setStatus('error');
      }
    }
    setBusy(false);
  }, [busy, form, activeDirection, agentName, project, loadProjects, pushActivity]);

  const onIterate = React.useCallback(async (instruction) => {
    if (!artifact || iterBusy) return;
    setIterBusy(true);
    setChatLog(l => [...l, { role: 'user', text: instruction }]);
    setActivityOpen(true);
    setStream(null);
    streamCharsRef.current = 0;
    const ctrl = new AbortController();
    try {
      await streamCanvasPOST('/api/canvas/iterate', { artifactId: artifact.id, instruction }, (evt) => {
        pushActivity(evt);
        if (evt.type === 'tool.call') {
          if (evt.payload?.ok === undefined) {
            streamCharsRef.current = 0;
            setStream({ name: evt.payload?.name || 'llm', startMs: Date.now() });
          } else {
            setStream(null);
          }
        } else if (evt.type === 'chunk') {
          streamCharsRef.current += (evt.payload?.text?.length || 0);
        } else if (evt.type === 'artifact.emit') {
          setArtifact(evt.payload);
          setCritique(null);
          setStream(null);
          setChatLog(l => [...l, { role: 'asia', text: 'Updated artifact.' }]);
        } else if (evt.type === 'error') {
          setStream(null);
          setChatLog(l => [...l, { role: 'asia', text: 'error: ' + (evt.payload?.message || 'unknown') }]);
        }
      }, ctrl.signal);
    } catch (e) {
      setChatLog(l => [...l, { role: 'asia', text: 'error: ' + e.message }]);
    }
    setStream(null);
    setIterBusy(false);
    loadProjects();
  }, [artifact, iterBusy, loadProjects, pushActivity]);

  const onMultiCritique = React.useCallback(async () => {
    if (!artifact || multiBusy) return;
    setMultiBusy(true);
    try {
      // Multi-agent critique fans out to 3 LLM calls — well past the 10s
      // default fetch timeout, which otherwise aborted it every time.
      const r = await window.NC_API.post('/api/canvas/critique', { artifactId: artifact.id, multiAgent: true }, 180000);
      setCritique(r);
    } catch (e) {
      setErrors(es => [...es, e.message]);
    }
    setMultiBusy(false);
  }, [artifact, multiBusy]);

  const onPickProject = React.useCallback(async (id) => {
    try {
      const p = await window.NC_API.get('/api/canvas/projects/' + id);
      setProject(p);
      const last = p.artifacts && p.artifacts[p.artifacts.length - 1];
      setArtifact(last || null);
      setCritique(last?.critique || null);
      setTodos([]);
      setExpanded(false);
      setStatus(p.status);
      setErrors([]);
    } catch (e) {
      setErrors(es => [...es, e.message]);
    }
  }, []);

  const onDeleteProject = React.useCallback(async (id) => {
    if (!window.confirm('Delete this canvas project?')) return;
    try {
      await fetch(`/api/canvas/projects/${id}${window.NC_API?.token ? '?token=' + window.NC_API.token : ''}`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      if (project?.id === id) {
        setProject(null); setArtifact(null); setCritique(null); setTodos([]); setExpanded(false);
      }
      loadProjects();
    } catch { /* noop */ }
  }, [project, loadProjects]);

  React.useEffect(() => {
    const onSend = (e) => {
      const { imageUrl, prompt: imgPrompt, provider: imgProvider } = e.detail || {};
      if (!imageUrl) return;
      setChatLog(l => [...l, {
        role: 'asia',
        text: `Reference image received from Generate · ${imgProvider || 'studio'}${imgPrompt ? ' · "' + imgPrompt.slice(0, 60) + (imgPrompt.length > 60 ? '…"' : '"') : ''}`,
      }]);
      // Also surface the image in the brief as a visual anchor.
      setForm(f => ({ ...f, brief: (f.brief ? f.brief + '\n\n' : '') + `[Reference image] ${imageUrl}` }));
    };
    window.addEventListener('nc-studio-send-to-editor', onSend);
    // If the user sent an image while Canvas was not mounted, pick it up now.
    const pending = window.__ncStudioEditorImage;
    if (pending?.url) {
      onSend({ detail: pending });
      window.__ncStudioEditorImage = null;
    }
    return () => window.removeEventListener('nc-studio-send-to-editor', onSend);
  }, []);

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <PageHeader
        title="Canvas"
        subtitle="// Asia · design studio · brief → artifact in minutes"
        right={
          <div style={{ display: 'flex', gap: 6 }}>
            <span className="tag cyan" style={{ fontSize: 10 }}>POWERED BY ASIA</span>
            <span className={`tag ${status === 'complete' ? 'green' : status === 'error' ? 'red' : 'muted'}`} style={{ fontSize: 10 }}>
              {status}
            </span>
          </div>
        }
      />

      <div className="canvas-grid" style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(280px, 320px) 1fr minmax(260px, 320px)',
        gap: 14,
        alignItems: 'start',
      }}>
        {/* LEFT: brief + direction + plan */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <BriefPanel form={form} setForm={setForm} onSubmit={onSubmit} busy={busy}
            agents={agents} agentName={agentName} setAgent={setAgent} />
          <DirectionPicker directions={directions} active={activeDirection} onPick={setActiveDirection} />
          <LivePlanCard todos={todos} status={status} errors={errors} />
        </div>

        {/* CENTER: artifact preview */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 540, gap: 12 }}>
          <StreamMeter stream={stream} chars={streamCharsRef.current} />
          <ArtifactPreview artifact={artifact} expanded={expanded} onExpand={() => setExpanded(true)} />
          <div className="nc-panel" style={{ padding: 12 }}>
            <CritiqueRadar critique={critique} />
          </div>
          <div className="nc-panel" style={{ padding: 12 }}>
            <ExportBar artifact={artifact} onMultiCritique={onMultiCritique} multiBusy={multiBusy} />
          </div>
        </div>

        {/* RIGHT: history + iterate chat */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="nc-panel" style={{ padding: 12 }}>
            <ProjectHistory projects={projects} activeId={project?.id} onPick={onPickProject} onDelete={onDeleteProject} />
          </div>
          <div className="st-panel" style={{ padding: 12 }}>
            <IterateChat artifact={artifact} onIterate={onIterate} busy={iterBusy} messages={chatLog} />
          </div>
        </div>
      </div>

      <ActivityLog entries={activity} open={activityOpen} onToggle={() => setActivityOpen((o) => !o)} />

      <CanvasFooter />

      {expanded && artifact && <ExpandedOverlay artifact={artifact} onClose={closeExpanded} />}

      <style>{`
        @media (max-width: 1100px) {
          .canvas-grid { grid-template-columns: 1fr !important; }
        }
        @keyframes nc-spin-kf { to { transform: rotate(360deg); } }
        .nc-spin { display: inline-block; animation: nc-spin-kf 1s linear infinite; }
      `}</style>
    </div>
  );
};

window.Canvas = Canvas;
