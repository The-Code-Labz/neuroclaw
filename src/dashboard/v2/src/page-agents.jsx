/* Agents page (live-wired) */

const AgentCard = ({ a, onEdit, onDelete, onActivate, onHardDelete }) => {
  const accent = a.temp ? 'var(--violet)' : a.color === 'neon2' ? 'var(--neon-2)' : 'var(--neon)';
  const inactive = (a._raw?.status === 'inactive');
  return (
    <div className="nc-panel glow tilt" style={{ padding: 14, position: 'relative', overflow: 'hidden', borderColor: a.temp ? 'rgba(139,92,246,0.35)' : 'var(--line)', opacity: inactive ? 0.5 : 1 }}>
      {a.temp && <div className="stripe-bg" style={{ position: 'absolute', inset: 0, opacity: 0.2 }}/>}
      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
          <div style={{ width: 46, height: 46, flex: 'none', borderRadius: 10, background: `radial-gradient(circle at 35% 30%, rgba(255,255,255,0.4), transparent 30%), radial-gradient(circle, ${accent}, rgba(0,0,0,0))`, border: `1px solid ${accent}`, boxShadow: `0 0 14px ${accent}66`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 18, color: '#fff', textShadow: `0 0 6px ${accent}` }}>
            {a.name[0]}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--display)', fontSize: 16, fontWeight: 600 }}>{a.name}</span>
              {a.temp && <span className="tag violet" style={{ fontSize: 9 }}>TEMP{a.expires ? ' · ' + a.expires : ''}</span>}
              {inactive && <span className="tag muted" style={{ fontSize: 9 }}>INACTIVE</span>}
            </div>
            <div className="mono muted" style={{ fontSize: 11 }}>{a.role}</div>
          </div>
          {(() => {
            const hb = a.heartbeat_status;
            const dotColor = hb === 'fail' ? 'red' : hb === 'ok' ? 'green' : hb === 'skipped' ? 'cyan' : 'muted';
            const title = hb === 'ok'      ? `heartbeat OK · ${a.heartbeat_latency_ms ?? '?'}ms`
                        : hb === 'fail'    ? 'heartbeat FAIL'
                        : hb === 'skipped' ? 'heartbeat skipped (Claude CLI)'
                        :                    'no heartbeat yet';
            return <span title={title} className={`dot ${dotColor} ${hb === 'ok' || hb === 'skipped' ? 'pulse' : ''}`}/>;
          })()}
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.55, minHeight: 32 }}>{a.desc}</div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, margin: '12px 0 10px' }}>
          <div className="mono" style={{ fontSize: 10 }}>
            <span className="muted">PROVIDER</span><br/>
            <span className="neonc">{a.provider}</span>
          </div>
          <div className="mono" style={{ fontSize: 10 }}>
            <span className="muted">MODEL</span><br/>
            <span style={{ color: 'var(--text)' }}>{a.model}</span>
          </div>
          <div className="mono" style={{ fontSize: 10 }}>
            <span className="muted">SCOPE</span><br/>
            <span className="neon2">{a.scope}</span>
          </div>
          <div className="mono" style={{ fontSize: 10 }}>
            <span className="muted">DEPTH · TASKS</span><br/>
            <span style={{ color: 'var(--text)' }}>{a.spawnDepth} · {a.tasks}</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
          {a.caps.map((c, i) => <span key={i} className="tag" style={{ fontSize: 9, padding: '1px 6px' }}>{c}</span>)}
          {a.exec && <span className="tag amber" style={{ fontSize: 9, padding: '1px 6px' }}>exec</span>}
        </div>

        <div style={{ display: 'flex', gap: 6, paddingTop: 10, borderTop: '1px dashed rgba(0,183,255,0.1)' }}>
          <button className="nc-btn ghost" style={{ flex: 1, fontSize: 10, padding: '5px 6px' }} onClick={onEdit}>edit</button>
          {inactive
            ? <button className="nc-btn ghost" style={{ flex: 1, fontSize: 10, padding: '5px 6px' }} onClick={onActivate}>activate</button>
            : <button className="nc-btn ghost" style={{ flex: 1, fontSize: 10, padding: '5px 6px', color: 'var(--danger)' }} onClick={onDelete} disabled={a.name === 'Alfred'}>{a.name === 'Alfred' ? 'protected' : 'deactivate'}</button>}
          <button className="nc-btn ghost" title="Permanently delete (cannot be undone)" style={{ fontSize: 10, padding: '5px 8px', color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={onHardDelete} disabled={a.name === 'Alfred'}>×</button>
        </div>
      </div>
    </div>
  );
};

const AgentEditor = ({ open, agent, onClose, onSaved }) => {
  const [name,    setName]    = React.useState('');
  const [desc,    setDesc]    = React.useState('');
  const [role,    setRole]    = React.useState('specialist');
  const [provider,setProvider]= React.useState('openai');
  const [model,   setModel]   = React.useState('');
  const [tier,    setTier]    = React.useState('pinned');
  const [exec,    setExec]    = React.useState(false);
  const [prompt,  setPrompt]  = React.useState('');
  const [caps,    setCaps]    = React.useState('');
  // Two separate catalog slots — one per provider. The dropdown displays
  // whichever matches the currently selected provider. Both are fetched on
  // modal open so toggling between providers is instant (no re-fetch).
  const [voidaiModels,    setVoidaiModels]    = React.useState([]);
  const [anthropicModels, setAnthropicModels] = React.useState([]);
  const [codexModels,     setCodexModels]     = React.useState([]);
  const [modelsErr,       setModelsErr]       = React.useState(null);
  const [modelsLoading,   setModelsLoading]   = React.useState(false);
  const [skills,    setSkillsCatalog] = React.useState([]);
  const [pickedSkills, setPickedSkills] = React.useState([]);
  const [visionMode, setVisionMode] = React.useState('auto');
  const [composioEnabled, setComposioEnabled] = React.useState(false);
  const [composioUserId,  setComposioUserId]  = React.useState('');
  // null = "all toolkits" (Composio default). Empty array also means "all" on save.
  const [pickedToolkits,  setPickedToolkits]  = React.useState(null);
  const [composioCatalog, setComposioCatalog] = React.useState([]);
  const [composioStatus,  setComposioStatus]  = React.useState({ enabled: false });
  // Voice / TTS settings — surfaced on dashboard chat (speaker button) and Discord.
  const [ttsEnabled,  setTtsEnabled]  = React.useState(false);
  const [ttsProvider, setTtsProvider] = React.useState('voidai');
  const [ttsVoice,    setTtsVoice]    = React.useState('');
  const [voiceCatalog, setVoiceCatalog] = React.useState({ voidai: [], elevenlabs: [], elevenlabsAvailable: false });
  const [busy,    setBusy]    = React.useState(false);
  const [err,     setErr]     = React.useState(null);

  const fetchAllCatalogs = React.useCallback(async () => {
    setModelsLoading(true);
    setModelsErr(null);
    try {
      const [v, a, c] = await Promise.all([
        window.NC_API.get('/api/models?provider=voidai').catch(() => []),
        window.NC_API.get('/api/models?provider=anthropic').catch(() => []),
        window.NC_API.get('/api/models?provider=codex').catch(() => []),
      ]);
      setVoidaiModels(Array.isArray(v) ? v : []);
      setAnthropicModels(Array.isArray(a) ? a : []);
      setCodexModels(Array.isArray(c) ? c : []);
      if ((!v || v.length === 0) && (!a || a.length === 0) && (!c || c.length === 0)) {
        setModelsErr('all catalogs empty — try Refresh');
      }
    } catch (e) {
      console.warn('[AgentEditor] /api/models failed:', e);
      setModelsErr(e.message || 'fetch failed');
    } finally {
      setModelsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;
    if (agent) {
      setName(agent.name || ''); setDesc(agent._raw?.description || '');
      setRole(agent._raw?.role || 'specialist');
      setProvider(agent._raw?.provider || 'openai');
      setModel(agent._raw?.model || '');
      setTier(agent._raw?.model_tier || 'pinned');
      setExec(!!agent._raw?.exec_enabled);
      setPrompt(agent._raw?.system_prompt || '');
      try { setCaps((JSON.parse(agent._raw?.capabilities || '[]') || []).join(', ')); } catch { setCaps(''); }
      try { setPickedSkills(JSON.parse(agent._raw?.skills || '[]') || []); } catch { setPickedSkills([]); }
      setVisionMode(agent._raw?.vision_mode || 'auto');
      setComposioEnabled(!!agent._raw?.composio_enabled);
      setComposioUserId(agent._raw?.composio_user_id || '');
      try {
        const tk = agent._raw?.composio_toolkits;
        setPickedToolkits(tk ? JSON.parse(tk) : null);
      } catch { setPickedToolkits(null); }
      setTtsEnabled(!!agent._raw?.tts_enabled);
      setTtsProvider(agent._raw?.tts_provider || 'voidai');
      setTtsVoice(agent._raw?.tts_voice || '');
    } else {
      setName(''); setDesc(''); setRole('specialist'); setProvider('openai');
      setModel(''); setTier('pinned'); setExec(false); setPrompt(''); setCaps('');
      setPickedSkills([]);
      setVisionMode('auto');
      setComposioEnabled(false); setComposioUserId(''); setPickedToolkits(null);
      setTtsEnabled(false); setTtsProvider('voidai'); setTtsVoice('');
    }
    setErr(null);
    fetchAllCatalogs();
    window.NC_API.get('/api/skills').then(rows => setSkillsCatalog(rows || [])).catch(()=>{});
    // Fetch Composio status + toolkit catalog (both no-ops when API key isn't set).
    window.NC_API.get('/api/composio/status').then(s => setComposioStatus(s || {})).catch(()=>{});
    window.NC_API.get('/api/composio/toolkits').then(r => {
      if (r?.ok && Array.isArray(r.toolkits)) setComposioCatalog(r.toolkits);
    }).catch(()=>{});
    // Voice catalog (VoidAI static + ElevenLabs from /v1/voices when keyed).
    window.NC_API.get('/api/audio/voices').then(v => setVoiceCatalog(v || { voidai: [], elevenlabs: [], elevenlabsAvailable: false })).catch(()=>{});
  }, [open, agent, fetchAllCatalogs]);

  const refreshCatalog = async () => {
    const apiProvider = provider === 'anthropic' ? 'anthropic'
                      : provider === 'codex'     ? 'codex'
                      :                            'voidai';
    setModelsLoading(true);
    try {
      await fetch('/api/models/refresh?provider=' + apiProvider, { method: 'POST', credentials: 'same-origin' });
    } catch (e) { console.warn('[AgentEditor] refresh failed', e); }
    await fetchAllCatalogs();
  };

  // The catalog the dropdown should currently render — switches with `provider` state.
  const activeCatalog       = provider === 'anthropic' ? anthropicModels
                            : provider === 'codex'     ? codexModels
                            :                            voidaiModels;
  const activeProviderLabel = provider === 'anthropic' ? 'Anthropic'
                            : provider === 'codex'     ? 'Codex'
                            :                            'VoidAI';

  if (!open) return null;
  const save = async () => {
    const body = {
      name: name.trim(),
      description: desc.trim(),
      role,
      provider,
      model: model.trim() || undefined,
      model_tier: tier,
      exec_enabled: exec,
      system_prompt: prompt.trim(),
      capabilities: caps.split(',').map(c => c.trim()).filter(Boolean),
      skills: pickedSkills,
      vision_mode:       visionMode,
      composio_enabled:  composioEnabled,
      composio_user_id:  composioUserId.trim() || null,
      // null = "all toolkits"; empty array gets normalized to null server-side.
      composio_toolkits: pickedToolkits === null ? null : pickedToolkits,
      tts_enabled:  ttsEnabled,
      tts_provider: ttsProvider,
      tts_voice:    ttsVoice.trim() || null,
    };
    if (!body.name) { setErr('name required'); return; }
    setBusy(true); setErr(null);
    try {
      if (agent) await window.NC_API.post('/api/agents/' + agent._raw.id, body).then(() => true).catch(async () => {
        // PATCH not available via NC_API.post; use raw fetch
        const r = await fetch('/api/agents/' + agent._raw.id, {
          method: 'PATCH', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`${r.status}`);
      });
      else await window.NC_API.post('/api/agents', body);
      await window.NC_LIVE.refresh();
      onSaved && onSaved();
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="nc-panel glow" onClick={e => e.stopPropagation()} style={{ width: 640, maxHeight: '85vh', overflow: 'auto', padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div className="label-tiny neonc">{agent ? 'EDIT AGENT — ' + agent.name : 'NEW AGENT'}</div>
          <button className="nc-btn ghost" onClick={onClose}>✕</button>
        </div>
        {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>// {err}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="field"><label>Name</label><input className="nc-input" value={name} onChange={e => setName(e.target.value)}/></div>
          <div className="field"><label>Role</label><select className="nc-select" value={role} onChange={e => setRole(e.target.value)}><option>specialist</option><option>orchestrator</option><option>agent</option><option>assistant</option></select></div>
        </div>
        <div className="field" style={{ marginTop: 10 }}><label>Description</label><input className="nc-input" value={desc} onChange={e => setDesc(e.target.value)}/></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <div className="field"><label>Provider</label><select className="nc-select" value={provider} onChange={e => setProvider(e.target.value)}><option value="openai">OpenAI / VoidAI</option><option value="anthropic">Anthropic / Claude CLI</option><option value="codex">Codex / ChatGPT CLI</option></select></div>
          <div className="field"><label>Model strategy</label><select className="nc-select" value={tier} onChange={e => setTier(e.target.value)}><option value="pinned">Pinned</option><option value="auto">Auto-triage</option><option value="low">Low</option><option value="mid">Mid</option><option value="high">High</option></select></div>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Model {tier !== 'pinned' && <span className="muted" style={{ fontSize: 10 }}>(fallback only — tier picks)</span>}</span>
            <span className="muted" style={{ fontSize: 10 }}>
              {modelsLoading ? 'loading…' : `${activeProviderLabel}: ${activeCatalog.length} models`}
              {' · '}
              <a href="#" onClick={(e) => { e.preventDefault(); refreshCatalog(); }} style={{ color: 'var(--neon-2)' }}>↻ refresh</a>
            </span>
          </label>
          <select className="nc-select" value={model} onChange={e => setModel(e.target.value)} style={{ width: '100%' }}>
            <option value="">(default — {activeProviderLabel})</option>
            {['high','mid','low'].map(t => {
              const inTier = activeCatalog.filter(m => m.tier === t);
              if (!inTier.length) return null;
              return <optgroup key={t} label={t.toUpperCase() + ' · ' + inTier.length}>{inTier.map(m => <option key={m.model_id} value={m.model_id}>{m.model_id}</option>)}</optgroup>;
            })}
          </select>
          {modelsErr && <div className="mono" style={{ color: 'var(--danger)', fontSize: 10, marginTop: 4 }}>// {modelsErr}</div>}
          {activeCatalog.length === 0 && !modelsLoading && !modelsErr && (
            <div className="mono" style={{ color: 'var(--amber)', fontSize: 10, marginTop: 4 }}>// no models for {activeProviderLabel} — try Refresh</div>
          )}
        </div>
        <div className="field" style={{ marginTop: 10 }}><label>Capabilities (comma-sep)</label><input className="nc-input" value={caps} onChange={e => setCaps(e.target.value)} placeholder="research, summarize"/></div>
        <div className="field" style={{ marginTop: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={exec} onChange={e => setExec(e.target.checked)} style={{ width: 'auto' }}/>
            <span>Exec enabled — bash_run / fs_read / fs_write</span>
          </label>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>Skills <span className="muted" style={{ fontSize: 10 }}>(toggle to attach; bodies appended to system prompt)</span></label>
          {skills.length === 0
            ? <div className="mono muted" style={{ fontSize: 11, padding: 6 }}>// no SKILL.md files found in .claude/skills/ or ~/.claude/skills/</div>
            : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {skills.map(s => {
                  const on = pickedSkills.includes(s.name);
                  return (
                    <span key={s.name} onClick={() => setPickedSkills(p => on ? p.filter(x => x !== s.name) : [...p, s.name])}
                      className={`tag ${on ? 'cyan' : ''}`}
                      title={s.description + (s.tools.length ? '\nTools: ' + s.tools.join(', ') : '')}
                      style={{ cursor: 'pointer', fontSize: 10, padding: '3px 8px' }}>
                      {on ? '✓ ' : ''}{s.name}<span className="muted" style={{ fontSize: 9, marginLeft: 4 }}>· {s.source}</span>
                    </span>
                  );
                })}
              </div>}
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>Vision mode <span className="muted" style={{ fontSize: 10 }}>(how this agent handles image attachments)</span></label>
          <select className="nc-select" value={visionMode} onChange={e => setVisionMode(e.target.value)}>
            <option value="auto">Auto — native if model supports vision, else describe via VISION_MODEL</option>
            <option value="native">Native — pass images directly to this agent's LLM</option>
            <option value="preprocess">Preprocess — always describe via VISION_MODEL, then send text</option>
          </select>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={composioEnabled} onChange={e => setComposioEnabled(e.target.checked)} style={{ width: 'auto' }} disabled={!composioStatus.enabled}/>
            <span>Composio — 1000+ external app toolkits via hosted MCP {!composioStatus.enabled && <span className="muted" style={{ fontSize: 10 }}>(set COMPOSIO_API_KEY in .env)</span>}</span>
          </label>
        </div>
        {composioEnabled && composioStatus.enabled && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10, marginTop: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 6 }}>
            <div className="field">
              <label>Composio user_id <span className="muted" style={{ fontSize: 10 }}>(per-agent identity; create via Composio dashboard or use any stable string)</span></label>
              <input className="nc-input" value={composioUserId} onChange={e => setComposioUserId(e.target.value)} placeholder="e.g. user_alice or alfred-prod"/>
            </div>
            <div className="field">
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Toolkits <span className="muted" style={{ fontSize: 10 }}>({pickedToolkits === null || pickedToolkits.length === 0 ? 'all available' : pickedToolkits.length + ' selected'})</span></span>
                <span className="muted" style={{ fontSize: 10 }}>
                  {composioCatalog.length} in catalog
                  {' · '}
                  <a href="#" onClick={e => { e.preventDefault(); setPickedToolkits(null); }} style={{ color: 'var(--neon-2)' }}>reset to all</a>
                </span>
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 160, overflow: 'auto', padding: 4, background: 'var(--surface-2)', borderRadius: 4 }}>
                {composioCatalog.length === 0
                  ? <div className="mono muted" style={{ fontSize: 10, padding: 4 }}>// catalog loading or empty — verify COMPOSIO_API_KEY</div>
                  : composioCatalog.map(t => {
                      const on = pickedToolkits !== null && pickedToolkits.includes(t.slug);
                      return (
                        <span key={t.slug} onClick={() => {
                          setPickedToolkits(prev => {
                            const cur = prev ?? [];
                            return cur.includes(t.slug) ? cur.filter(x => x !== t.slug) : [...cur, t.slug];
                          });
                        }} className={`tag ${on ? 'cyan' : ''}`} style={{ cursor: 'pointer', fontSize: 10, padding: '3px 8px' }}>
                          {on ? '✓ ' : ''}{t.name}<span className="muted" style={{ fontSize: 9, marginLeft: 4 }}>· {t.slug}</span>
                        </span>
                      );
                    })
                }
              </div>
            </div>
            {composioUserId.trim() && (
              <div className="mono muted" style={{ fontSize: 10 }}>
                ↗ Connect this user_id's accounts at <a href="https://platform.composio.dev/developers" target="_blank" style={{ color: 'var(--neon-2)' }}>platform.composio.dev/developers</a> — agents need OAuth-connected accounts to actually call apps.
              </div>
            )}
          </div>
        )}
        <div className="field" style={{ marginTop: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={ttsEnabled} onChange={e => setTtsEnabled(e.target.checked)} style={{ width: 'auto' }}/>
            <span>Voice (TTS) — speaker button on dashboard messages, audio attached to Discord replies (when bot has voice enabled)</span>
          </label>
        </div>
        {ttsEnabled && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 6 }}>
            <div className="field">
              <label>TTS provider</label>
              <select className="nc-select" value={ttsProvider} onChange={e => { setTtsProvider(e.target.value); setTtsVoice(''); }}>
                <option value="voidai">VoidAI (OpenAI-compatible)</option>
                <option value="elevenlabs" disabled={!voiceCatalog.elevenlabsAvailable}>
                  ElevenLabs {!voiceCatalog.elevenlabsAvailable && '(set ELEVENLABS_API_KEY)'}
                </option>
              </select>
            </div>
            <div className="field">
              <label>Voice <span className="muted" style={{ fontSize: 10 }}>(blank = use env default)</span></label>
              <select className="nc-select" value={ttsVoice} onChange={e => setTtsVoice(e.target.value)}>
                <option value="">(default)</option>
                {(ttsProvider === 'elevenlabs' ? voiceCatalog.elevenlabs : voiceCatalog.voidai).map(v => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}
        <div className="field" style={{ marginTop: 10 }}><label>System prompt</label><textarea className="nc-input" rows={6} value={prompt} onChange={e => setPrompt(e.target.value)}/></div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="nc-btn ghost" onClick={onClose}>Cancel</button>
          <button className="nc-btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
};

const Agents = () => {
  const { AGENTS } = window.NC_DATA;
  const [filter, setFilter] = React.useState('');
  const [editor, setEditor] = React.useState({ open: false, agent: null });

  const filtered = (AGENTS || []).filter(a => !filter || (a.name + ' ' + a.role + ' ' + a.desc).toLowerCase().includes(filter.toLowerCase()));

  const onDelete = async (a) => {
    if (!confirm(`Deactivate ${a.name}? (Soft-delete; row preserved.)`)) return;
    try { await fetch('/api/agents/' + a._raw.id, { method: 'DELETE', credentials: 'same-origin' }); await window.NC_LIVE.refresh(); }
    catch (e) { alert('Failed: ' + e.message); }
  };

  const onHardDelete = async (a) => {
    if (a.name === 'Alfred') { alert('Alfred is protected.'); return; }
    if (!confirm(`PERMANENTLY delete ${a.name}? This removes the agent row entirely. References on tasks/messages/comms will be nulled but kept. Cannot be undone.`)) return;
    if (!confirm(`Type the agent name to confirm: ${a.name}\n\nClick OK to proceed.`)) return;
    try {
      const r = await fetch('/api/agents/' + a._raw.id + '/hard', { method: 'DELETE', credentials: 'same-origin' });
      const data = await r.json();
      if (!r.ok) { alert('Failed: ' + (data.error || r.status)); return; }
      await window.NC_LIVE.refresh();
    } catch (e) { alert('Failed: ' + e.message); }
  };
  const onActivate = async (a) => {
    try { await window.NC_API.post('/api/agents/' + a._raw.id + '/activate'); await window.NC_LIVE.refresh(); }
    catch (e) { alert('Failed: ' + e.message); }
  };

  return (
    <div>
      <PageHeader title="Agents" subtitle="// roster · loadouts · spawn graph" right={<>
        <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>
        <button className="nc-btn primary" onClick={() => setEditor({ open: true, agent: null })}><Icon name="plus" size={12}/> New Agent</button>
      </>}/>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <span className="tag blue">ALL · {AGENTS.length}</span>
        <span className="tag">PERMANENT · {AGENTS.filter(a => !a.temp).length}</span>
        <span className="tag violet">TEMP · {AGENTS.filter(a => a.temp).length}</span>
        <span className="tag green">LIVE · {AGENTS.filter(a => a.status === 'live').length}</span>
        <span style={{ flex: 1 }}/>
        <input className="nc-input" placeholder="filter agents..." value={filter} onChange={e => setFilter(e.target.value)} style={{ maxWidth: 240 }}/>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 12, marginBottom: 16 }}>
        {filtered.map(a => (
          <AgentCard key={a._raw?.id || a.id} a={a}
            onEdit={() => setEditor({ open: true, agent: a })}
            onDelete={() => onDelete(a)}
            onActivate={() => onActivate(a)}
            onHardDelete={() => onHardDelete(a)}
          />
        ))}
        {filtered.length === 0 && <div className="mono muted" style={{ padding: 20 }}>// no agents match filter</div>}
      </div>

      <AgentEditor open={editor.open} agent={editor.agent} onClose={() => setEditor({ open: false, agent: null })}/>
    </div>
  );
};

window.Agents = Agents;
