/* Backlot (Studio sub-tab) — OpenMontage glass wall.
 *
 * A *window* into the OpenMontage pipeline, not the pipeline itself. It reads
 * the project JSON checkpoints the render-node pipeline writes (pulled over SSH
 * on poll — open-decision #4 resolved: pull-on-poll, no sync-back) and shows
 * storyboard → render → preview → approve.
 *
 * Backend contract:
 *   GET  /api/openmontage/projects            → { ok, node, projects:[{id,project,stages,has_render,mtime}] }
 *   GET  /api/openmontage/projects/:id         → { ok, id, project, checkpoints, decisions, events, renders }
 *   POST /api/openmontage/projects/:id/gate    → { stage, action:'approve'|'reject', reason? } → { ok }
 *   GET  /api/openmontage/projects/:id/render  → base64 MP4 (small clips only) or { ok:false }
 */

const MVP_STAGES = ['research', 'proposal', 'script', 'scene_plan', 'assets', 'edit', 'compose', 'publish'];

const STAGE_COLOR = {
  completed:      { bg: 'color-mix(in srgb, var(--accent-2) 16%, transparent)', fg: 'var(--accent-2)', label: 'done' },
  awaiting_human: { bg: 'rgba(255,193,7,0.18)',  fg: '#ffc107', label: 'gate' },
  in_progress:    { bg: 'color-mix(in srgb, var(--accent) 16%, transparent)',  fg: 'var(--accent)', label: 'running' },
  rejected:       { bg: 'rgba(255,64,96,0.16)',  fg: 'var(--danger)', label: 'rejected' },
  pending:        { bg: 'rgba(255,255,255,0.05)', fg: '#8892a0', label: '—' },
};

function fmtWhen(ts) {
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function projectTitle(p) {
  const m = p?.project || {};
  return m.title || m.topic || m.name || p?.id || 'untitled';
}

// ── project list (left rail) ────────────────────────────────────────────────
const ProjectRow = ({ p, active, onClick }) => {
  const stages = p.stages || {};
  const gate = Object.entries(stages).find(([, s]) => s === 'awaiting_human');
  return (
    <button
      className={'nc-listrow' + (active ? ' active' : '')}
      onClick={onClick}
      style={{
        display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px',
        border: '1px solid ' + (active ? 'var(--accent)' : 'rgba(255,255,255,0.07)'),
        borderRadius: 8, marginBottom: 8, cursor: 'pointer',
        background: active ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'rgba(255,255,255,0.02)',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {projectTitle(p)}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {gate && <span className="tag" style={{ fontSize: 9, background: STAGE_COLOR.awaiting_human.bg, color: STAGE_COLOR.awaiting_human.fg }}>● {gate[0]} gate</span>}
        {p.has_render && <span className="tag mono" style={{ fontSize: 9 }}>▶ MP4</span>}
        <span className="tag muted mono" style={{ fontSize: 9, marginLeft: 'auto' }}>{fmtWhen(p.mtime)}</span>
      </div>
    </button>
  );
};

// ── stage rail ──────────────────────────────────────────────────────────────
const StageRail = ({ checkpoints }) => (
  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
    {MVP_STAGES.map(st => {
      const cp = checkpoints?.[st];
      const status = cp?.status || 'pending';
      const c = STAGE_COLOR[status] || STAGE_COLOR.pending;
      return (
        <div key={st} title={st + ' · ' + status}
          style={{
            flex: '1 1 90px', minWidth: 80, padding: '8px 6px', borderRadius: 6, textAlign: 'center',
            background: c.bg, border: '1px solid ' + c.fg + '33',
            animation: status === 'awaiting_human' ? 'ncpulse 1.6s ease-in-out infinite' : 'none',
          }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: c.fg, textTransform: 'capitalize' }}>{st.replace('_', ' ')}</div>
          <div style={{ fontSize: 8, color: c.fg, opacity: 0.8, marginTop: 2 }}>{c.label}</div>
        </div>
      );
    })}
  </div>
);

// Providers with an OpenMontage Python shim on the render node. The image
// manifest lists many more (abacus/grok/venice…) but the montage pipeline can
// only route to providers that have a tools/graphics/*.py shim — offering the
// others would set an override the selector can't honor (silent fallback).
const MONTAGE_IMAGE_PROVIDERS = ['voidai_image', 'kie_image', 'fal_image'];

// ── media override panel (image provider/model + Kokoro voice) ───────────────
const OverridePanel = ({ id, overrides, onSaved }) => {
  const [providers, setProviders] = React.useState([]);
  const [voices, setVoices] = React.useState([]);
  const [imageProvider, setImageProvider] = React.useState(overrides?.image_provider || '');
  const [imageModel, setImageModel] = React.useState(overrides?.image_model || '');
  const [ttsVoice, setTtsVoice] = React.useState(overrides?.tts_voice || '');
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState('');

  React.useEffect(() => {
    (async () => {
      try {
        const r = await window.NC_API.get('/api/studio/image-providers');
        const list = (r?.providers || []).filter(p => MONTAGE_IMAGE_PROVIDERS.includes(p.id));
        setProviders(list);
      } catch { /* leave empty */ }
      try {
        const v = await window.NC_API.get('/api/audio/voices?provider=kokoro');
        setVoices(Array.isArray(v?.voices) ? v.voices : []);
      } catch { /* leave empty */ }
    })();
  }, []);

  const modelsForProvider = React.useMemo(() => {
    const p = providers.find(x => x.id === imageProvider);
    return p?.models || [];
  }, [providers, imageProvider]);

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      // Empty string → null: clears the override (revert to pipeline default).
      const body = {
        image_provider: imageProvider || null,
        image_model:    imageModel || null,
        tts_voice:      ttsVoice || null,
      };
      const r = await window.NC_API.post('/api/openmontage/projects/' + encodeURIComponent(id) + '/overrides', body);
      if (r?.ok) { setMsg('saved'); onSaved && onSaved(); }
      else setMsg(r?.error || 'save failed');
    } catch (e) { setMsg(String(e?.message || e)); }
    finally { setSaving(false); }
  };

  const sel = { padding: '6px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.12)', color: 'inherit', fontSize: 12, minWidth: 150 };
  const lbl = { fontSize: 10, color: '#8892a0', marginBottom: 4, display: 'block' };

  return (
    <div className="nc-panel" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Media overrides</div>
      <div className="muted" style={{ fontSize: 10.5, marginBottom: 10 }}>
        Pin the image provider/model and narration voice for this project. Leave blank to use the pipeline default.
        Applied when the asset stage next runs.
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label style={lbl}>Image provider</label>
          <select style={sel} value={imageProvider}
            onChange={e => { setImageProvider(e.target.value); setImageModel(''); }}>
            <option value="">(pipeline default)</option>
            {providers.map(p => (
              <option key={p.id} value={p.id}>{p.label}{p.degraded ? ' ⚠' : ''}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={lbl}>Image model</label>
          <select style={sel} value={imageModel} disabled={!imageProvider}
            onChange={e => setImageModel(e.target.value)}>
            <option value="">(provider default)</option>
            {modelsForProvider.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>Narration voice (Kokoro)</label>
          <select style={sel} value={ttsVoice} onChange={e => setTtsVoice(e.target.value)}>
            <option value="">(default · af_heart)</option>
            {voices.map(v => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
          </select>
        </div>
        <button className="nc-btn primary" disabled={saving} onClick={save} style={{ height: 32 }}>
          {saving ? 'Saving…' : 'Save overrides'}
        </button>
        {msg && <span className="muted" style={{ fontSize: 11, color: msg === 'saved' ? '#00f5d4' : '#ff4060' }}>{msg}</span>}
      </div>
    </div>
  );
};

// ── detail pane ─────────────────────────────────────────────────────────────
const ProjectDetail = ({ id }) => {
  const [detail, setDetail] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [videoUrl, setVideoUrl] = React.useState('');

  const load = React.useCallback(async () => {
    try {
      const d = await window.NC_API.get('/api/openmontage/projects/' + encodeURIComponent(id));
      if (!d?.ok) { setErr(d?.error || 'failed to load project'); setDetail(null); }
      else { setDetail(d); setErr(''); }
    } catch (e) { setErr(String(e?.message || e)); }
    finally { setLoading(false); }
  }, [id]);

  React.useEffect(() => { setLoading(true); setVideoUrl(''); load(); }, [load]);
  React.useEffect(() => {
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [load]);

  const onGate = async (stage, action) => {
    setBusy(true);
    try {
      const r = await window.NC_API.post('/api/openmontage/projects/' + encodeURIComponent(id) + '/gate', { stage, action });
      if (!r?.ok) setErr(r?.error || 'gate action failed');
      await load();
    } catch (e) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const loadVideo = async () => {
    setBusy(true);
    try {
      const r = await window.NC_API.get('/api/openmontage/projects/' + encodeURIComponent(id) + '/render');
      if (r?.ok && r.base64) {
        const bin = atob(r.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        setVideoUrl(URL.createObjectURL(new Blob([bytes], { type: r.mime || 'video/mp4' })));
      } else { setErr(r?.error || 'render unavailable'); }
    } catch (e) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="muted" style={{ padding: 24 }}>Loading project…</div>;
  if (err && !detail) return <div className="nc-panel" style={{ padding: 16, color: '#ff4060' }}>⚠ {err}</div>;
  if (!detail) return null;

  const { project = {}, checkpoints = {}, decisions, events = [], renders = [] } = detail;
  const gateStage = Object.entries(checkpoints).find(([, cp]) => cp?.status === 'awaiting_human');
  const hasRender = renders.some(r => /\.mp4$/i.test(r));

  return (
    <div>
      {err && <div className="nc-panel" style={{ padding: 10, marginBottom: 10, color: '#ff4060', fontSize: 12 }}>⚠ {err}</div>}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{projectTitle(detail)}</h2>
        <span className="tag mono muted" style={{ fontSize: 10 }}>{project.pipeline_type || 'mvp'}</span>
        <span className="tag mono muted" style={{ fontSize: 10 }}>{id}</span>
      </div>

      <StageRail checkpoints={checkpoints} />

      {/* Media overrides — image provider/model + Kokoro voice */}
      <OverridePanel id={id} overrides={project.overrides} onSaved={load} />

      {/* Human-approval gate */}
      {gateStage && (
        <div className="nc-panel glow" style={{ padding: 14, marginBottom: 14, borderColor: STAGE_COLOR.awaiting_human.fg }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: STAGE_COLOR.awaiting_human.fg, marginBottom: 6 }}>
            ● {gateStage[0]} — awaiting your approval
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
            The pipeline is parked at this gate. Approve to let it proceed; reject to send it back for rework.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="nc-btn primary" disabled={busy} onClick={() => onGate(gateStage[0], 'approve')}>✓ Approve</button>
            <button className="nc-btn" disabled={busy} onClick={() => onGate(gateStage[0], 'reject')}>✗ Reject</button>
          </div>
        </div>
      )}

      {/* Render preview */}
      {hasRender && (
        <div className="nc-panel" style={{ padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Render</div>
          {videoUrl
            ? <video src={videoUrl} controls style={{ width: '100%', maxHeight: 360, borderRadius: 8, background: '#000' }} />
            : <button className="nc-btn" disabled={busy} onClick={loadVideo}>▶ Load preview ({renders.filter(r => /\.mp4$/i.test(r)).join(', ')})</button>}
        </div>
      )}

      {/* Decision / cost audit */}
      {decisions?.decisions?.length > 0 && (
        <div className="nc-panel" style={{ padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Decision log</div>
          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
            <tbody>
              {decisions.decisions.map((d, i) => (
                <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <td className="mono" style={{ padding: '5px 6px', color: 'var(--accent)', whiteSpace: 'nowrap' }}>{d.stage || d.decision_point || '—'}</td>
                  <td style={{ padding: '5px 6px' }}>{d.chosen || d.selected || d.decision || ''}</td>
                  <td className="muted" style={{ padding: '5px 6px' }}>{d.rationale || d.reason || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Live events ticker */}
      {events.length > 0 && (
        <div className="nc-panel" style={{ padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Events</div>
          <div style={{ maxHeight: 220, overflowY: 'auto', fontFamily: 'monospace', fontSize: 10.5, lineHeight: 1.7 }}>
            {events.slice().reverse().map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: 8 }}>
                <span style={{ color: 'var(--accent2)' }}>{e.event || e.type || '·'}</span>
                {e.stage && <span className="muted">[{e.stage}]</span>}
                <span style={{ opacity: 0.85 }}>{e.msg || e.message || ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ── root ────────────────────────────────────────────────────────────────────
const Backlot = () => {
  const [projects, setProjects] = React.useState([]);
  const [node, setNode] = React.useState({ ok: true, detail: '' });
  const [selected, setSelected] = React.useState('');
  const [loaded, setLoaded] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const d = await window.NC_API.get('/api/openmontage/projects');
      setNode({ ok: !!d?.ok, detail: d?.error || d?.node || '' });
      const list = Array.isArray(d?.projects) ? d.projects : [];
      list.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      setProjects(list);
      setSelected(prev => (prev && list.some(p => p.id === prev)) ? prev : (list[0]?.id || ''));
    } catch (e) {
      setNode({ ok: false, detail: String(e?.message || e) });
    } finally { setLoaded(true); }
  }, []);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div style={{ padding: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Backlot</h1>
        <span className="muted" style={{ fontSize: 12 }}>OpenMontage pipeline · render node</span>
        {!node.ok && <span className="tag" style={{ fontSize: 10, background: 'rgba(255,64,96,0.16)', color: '#ff4060', marginLeft: 'auto' }}>⚠ node unreachable</span>}
      </div>

      {loaded && projects.length === 0 && node.ok && (
        <div className="nc-panel" style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>No montage projects yet</div>
          <div className="muted" style={{ fontSize: 12 }}>Projects appear here once Sachi drives a pipeline run on the render node.</div>
        </div>
      )}

      {!node.ok && (
        <div className="nc-panel" style={{ padding: 16, color: '#ff4060', fontSize: 12 }}>
          ⚠ Cannot reach the render node. {node.detail}
        </div>
      )}

      {projects.length > 0 && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div style={{ width: 260, flexShrink: 0 }}>
            {projects.map(p => (
              <ProjectRow key={p.id} p={p} active={p.id === selected} onClick={() => setSelected(p.id)} />
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {selected && <ProjectDetail id={selected} />}
          </div>
        </div>
      )}
    </div>
  );
};

window.Backlot = Backlot;
