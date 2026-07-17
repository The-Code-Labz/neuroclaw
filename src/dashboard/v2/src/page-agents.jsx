/* Agents page (live-wired) */

const AgentCard = ({ a, onEdit, onDelete, onActivate, onHardDelete }) => {
  const accent = a.temp ? 'var(--violet)' : a.color === 'neon2' ? 'var(--accent-2)' : 'var(--accent)';
  const inactive = (a._raw?.status === 'inactive');
  const capsShown = a.caps.slice(0, 3);
  const capsMore = a.caps.length - capsShown.length;
  return (
    <div className={`ag-card${a.temp ? ' is-temp' : ''}${inactive ? ' is-inactive' : ''}`}>
      <div className="ag-head">
        <div className="ag-avatar" style={{ '--ag-accent': accent }}>
          {a._raw?.avatar_url
            ? <img src={a._raw.avatar_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : a.name[0]}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="ag-name">{a.name}</span>
            {a.temp && <span className="tag violet" style={{ fontSize: 9 }}>TEMP{a.expires ? ' · ' + a.expires : ''}</span>}
            {inactive && <span className="tag muted" style={{ fontSize: 9 }}>INACTIVE</span>}
          </div>
          <div className="ag-role">{a.role}</div>
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

      <div className="ag-desc">{a.desc}</div>

      <div className="ag-meta">
        <span><b>{a.provider}</b></span><span className="sep">·</span>
        <span><b>{a.model || 'default'}</b></span><span className="sep">·</span>
        <span>scope <b>{a.scope}</b></span><span className="sep">·</span>
        <span>depth <b>{a.spawnDepth}</b></span><span className="sep">·</span>
        <span><b>{a.tasks}</b> tasks</span>
      </div>

      <div className="ag-caps">
        {capsShown.map((c, i) => <span key={i} className="tag" style={{ fontSize: 9, padding: '1px 6px' }}>{c}</span>)}
        {capsMore > 0 && <span className="tag muted" style={{ fontSize: 9, padding: '1px 6px' }}>+{capsMore}</span>}
        {a.exec && <span className="tag amber" style={{ fontSize: 9, padding: '1px 6px' }}>exec</span>}
        {a._raw?.chat_mode === 1 && <span className="tag cyan" style={{ fontSize: 9, padding: '1px 6px' }}>chat</span>}
      </div>

      <div className="ag-actions">
        <button className="nc-btn ghost grow" style={{ fontSize: 11 }} onClick={onEdit}><Icon name="edit" size={12}/> Edit</button>
        {inactive
          ? <button className="nc-btn ghost icon-only" title="Activate" onClick={onActivate}><Icon name="play" size={13}/></button>
          : <button className="nc-btn ghost icon-only" title={a.name === 'Alfred' ? 'protected' : 'Deactivate'} style={{ color: a.name === 'Alfred' ? undefined : 'var(--danger)' }} onClick={onDelete} disabled={a.name === 'Alfred'}><Icon name="pause" size={13}/></button>}
        <button className="nc-btn ghost icon-only" title="Permanently delete (cannot be undone)" style={{ color: 'var(--danger)' }} onClick={onHardDelete} disabled={a.name === 'Alfred'}><Icon name="trash" size={13}/></button>
      </div>
    </div>
  );
};

const AgentEditor = ({ open, agent, onClose, onSaved }) => {
  const [name,    setName]    = React.useState('');
  const [desc,    setDesc]    = React.useState('');
  const [role,    setRole]    = React.useState('specialist');
  const [provider,setProvider]= React.useState('voidai');
  const [model,   setModel]   = React.useState('');
  const [tier,    setTier]    = React.useState('pinned');
  const [exec,    setExec]    = React.useState(false);
  const [chatMode,setChatMode]= React.useState(false);
  const [prompt,  setPrompt]  = React.useState('');
  const [caps,    setCaps]    = React.useState('');
  // Two separate catalog slots — one per provider. The dropdown displays
  // whichever matches the currently selected provider. Both are fetched on
  // modal open so toggling between providers is instant (no re-fetch).
  const [voidaiModels,      setVoidaiModels]      = React.useState([]);
  const [anthropicModels,  setAnthropicModels]   = React.useState([]);
  const [codexModels,      setCodexModels]       = React.useState([]);
  const [antigravityModels,setAntigravityModels] = React.useState([
    { model_id: 'google/antigravity-gemini-3.1-pro',           tier: 'high', provider: 'antigravity', is_available: true },
    { model_id: 'google/antigravity-claude-opus-4-6-thinking', tier: 'high', provider: 'antigravity', is_available: true },
    { model_id: 'google/antigravity-claude-sonnet-4-6',        tier: 'mid',  provider: 'antigravity', is_available: true },
    { model_id: 'google/antigravity-gemini-3-flash',           tier: 'low',  provider: 'antigravity', is_available: true },
  ]);
  const [openrouterModels, setOpenrouterModels]  = React.useState([]);
  const [ollamaModels,     setOllamaModels]      = React.useState([]);
  const [veniceModels,     setVeniceModels]      = React.useState([]);
  const [abacusModels,     setAbacusModels]      = React.useState([]);
  const [omnirouteModels,  setOmnirouteModels]   = React.useState([]);
  const [hermesModels,     setHermesModels]      = React.useState([
    { model_id: 'grok-4.3',                    tier: 'high', provider: 'hermes', is_available: true },
    { model_id: 'grok-4.20-multi-agent-0309',  tier: 'high', provider: 'hermes', is_available: true },
    { model_id: 'grok-4.20-0309-reasoning',    tier: 'high', provider: 'hermes', is_available: true },
    { model_id: 'grok-4.20-0309-non-reasoning',tier: 'mid',  provider: 'hermes', is_available: true },
  ]);
  const [kimiApiModels,    setKimiApiModels]     = React.useState([
    { model_id: 'kimi-for-coding', tier: 'high', provider: 'kimi-api', is_available: true },
    { model_id: 'kimi-k2',        tier: 'high', provider: 'kimi-api', is_available: true },
    { model_id: 'kimi-k2-5',      tier: 'high', provider: 'kimi-api', is_available: true },
  ]);
  // Native Anthropic-endpoint gateways — their OWN models (pulled from each
  // vendor's /v1/models via the catalog), NOT VoidAI's. Seeded with the configured
  // defaults so the picker isn't empty before the first catalog fetch lands.
  const [kimiModels,       setKimiModels]        = React.useState([
    { model_id: 'kimi-for-coding', tier: 'high', provider: 'kimi', is_available: true },
  ]);
  const [minimaxModels,    setMinimaxModels]     = React.useState([
    { model_id: 'MiniMax-M3',   tier: 'high', provider: 'minimax', is_available: true },
    { model_id: 'MiniMax-M2.7', tier: 'high', provider: 'minimax', is_available: true },
  ]);
  const [interactiveModels, setInteractiveModels] = React.useState([
    { model_id: 'claude-sonnet-4-6', tier: 'high', provider: 'claude-interactive', is_available: true },
    { model_id: 'claude-opus-4-7',   tier: 'high', provider: 'claude-interactive', is_available: true },
  ]);
  const [opencodeModels,   setOpencodeModels]    = React.useState([]);
  const [litellmModels,    setLitellmModels]     = React.useState([]);
  // claude-gateway: only the LiteLLM models that actually work on the Anthropic
  // /v1/messages route (a much smaller set than chat-completions — probed server-side).
  const [gatewayModels,    setGatewayModels]     = React.useState([]);
  const [modelsErr,       setModelsErr]       = React.useState(null);
  const [modelsLoading,   setModelsLoading]   = React.useState(false);
  const [skills,    setSkillsCatalog] = React.useState([]);
  const [pickedSkills, setPickedSkills] = React.useState([]);
  const [visionMode, setVisionMode] = React.useState('auto');
  const [visionProvider, setVisionProvider] = React.useState('');
  const [extraCoreTools, setExtraCoreTools] = React.useState([]);
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
  const [voiceProvider, setVoiceProvider] = React.useState('default');
  const [geminiVoice,   setGeminiVoice]   = React.useState('Zephyr');
  const [voiceCatalog, setVoiceCatalog] = React.useState({ voidai: [], elevenlabs: [], kokoro: [], chatterbox: [], elevenlabsAvailable: false, kokoroAvailable: false, chatterboxAvailable: false });
  // MCP-backed agent fields
  const [mcpServers,   setMcpServers]   = React.useState([]);
  const [mcpServerId,  setMcpServerId]  = React.useState('');
  const [mcpToolName,  setMcpToolName]  = React.useState('');
  const [mcpInputField,setMcpInputField]= React.useState('');
  const [optimizeTerse, setOptimizeTerse] = React.useState(false);
  const [optimizeLeanCode, setOptimizeLeanCode] = React.useState(false);
  const [compressLite, setCompressLite] = React.useState(false);
  const [compressHeadroom, setCompressHeadroom] = React.useState(false);
  const [compressRtk, setCompressRtk] = React.useState(false);
  const [pendingAvatarUrl, setPendingAvatarUrl] = React.useState(null);
  const avatarFileRef = React.useRef(null);
  const [busy,    setBusy]    = React.useState(false);
  const [err,     setErr]     = React.useState(null);

  const fetchAllCatalogs = React.useCallback(async () => {
    setModelsLoading(true);
    setModelsErr(null);
    try {
      const [v, a, c, ag, ve, oCatalog, oLive, olLive, oc, kma, ll, gw, km, mm, ci, ab, omr] = await Promise.all([
        window.NC_API.get('/api/models?provider=voidai').catch(() => []),
        window.NC_API.get('/api/models?provider=anthropic').catch(() => []),
        window.NC_API.get('/api/models?provider=codex').catch(() => []),
        window.NC_API.get('/api/models?provider=antigravity').catch(() => []),
        window.NC_API.get('/api/models?provider=venice').catch(() => []),
        window.NC_API.get('/api/models?provider=openrouter').catch(() => []),
        // Also fetch live OpenRouter models directly from their API
        window.NC_API.get('/api/openrouter/models').catch(() => ({ models: [] })),
        window.NC_API.get('/api/ollama/models').catch(() => ({ ok: false, models: [] })),
        window.NC_API.get('/api/models?provider=opencode').catch(() => []),
        window.NC_API.get('/api/models?provider=kimi-api').catch(() => []),
        window.NC_API.get('/api/models?provider=litellm').catch(() => []),
        window.NC_API.get('/api/models?provider=claude-gateway').catch(() => []),
        window.NC_API.get('/api/models?provider=kimi').catch(() => []),
        window.NC_API.get('/api/models?provider=minimax').catch(() => []),
        window.NC_API.get('/api/models?provider=claude-interactive').catch(() => []),
        window.NC_API.get('/api/models?provider=abacus&includeUnavailable=0').catch(() => []),
        window.NC_API.get('/api/models?provider=omniroute').catch(() => []),
      ]);
      setVoidaiModels(Array.isArray(v) ? v : []);
      setAnthropicModels(Array.isArray(a) ? a : []);
      setCodexModels(Array.isArray(c) ? c : []);
      if (Array.isArray(ag) && ag.length > 0) setAntigravityModels(ag);
      setVeniceModels(Array.isArray(ve) ? ve : []);
      setAbacusModels(Array.isArray(ab) ? ab : []);
      setOmnirouteModels(Array.isArray(omr) ? omr : []);
      if (Array.isArray(oc) && oc.length > 0) setOpencodeModels(oc);
      if (Array.isArray(kma) && kma.length > 0) setKimiApiModels(kma);
      if (Array.isArray(ll)  && ll.length  > 0) setLitellmModels(ll);
      setGatewayModels(Array.isArray(gw) ? gw : []);
      if (Array.isArray(km) && km.length > 0) setKimiModels(km);
      if (Array.isArray(mm) && mm.length > 0) setMinimaxModels(mm);
      if (Array.isArray(ci) && ci.length > 0) setInteractiveModels(ci);

      // For OpenRouter: prefer live API models, fall back to catalog
      const liveModels = oLive?.models || [];
      if (liveModels.length > 0) {
        // Transform live models to match catalog format
        const transformed = liveModels.map(m => ({
          model_id: m.id,
          tier: m.tier === 'free' ? 'low' : m.tier, // map 'free' to 'low' for display grouping
          provider: 'openrouter',
          is_available: true,
          _isFree: m.tier === 'free',
          _pricing: m.pricing,
        }));
        setOpenrouterModels(transformed);
      } else {
        setOpenrouterModels(Array.isArray(oCatalog) ? oCatalog : []);
      }
      
      const olModels = (olLive?.models || []).map(m => ({
        model_id: m.id,
        tier: 'mid',
        provider: 'ollama',
        is_available: true,
      }));
      setOllamaModels(olModels);
      // kimi CLI uses OpenAI API but the kimi cloud models live in Ollama.
      // Populate the kimi provider picker with the subset of ollama models whose
      // name contains "kimi", so the user sees what's actually available locally.
      if ((!v || v.length === 0) && (!a || a.length === 0) && (!c || c.length === 0) && (!ag || ag.length === 0) && liveModels.length === 0 && (!oCatalog || oCatalog.length === 0) && olModels.length === 0) {
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
      setProvider(agent._raw?.provider || 'voidai');
      setModel(agent._raw?.model || '');
      setTier(agent._raw?.model_tier || 'pinned');
      setExec(!!agent._raw?.exec_enabled);
      setChatMode(!!agent._raw?.chat_mode);
      setPrompt(agent._raw?.system_prompt || '');
      try { setCaps((JSON.parse(agent._raw?.capabilities || '[]') || []).join(', ')); } catch { setCaps(''); }
      try { setPickedSkills(JSON.parse(agent._raw?.skills || '[]') || []); } catch { setPickedSkills([]); }
      setVisionMode(agent._raw?.vision_mode || 'auto');
      setVisionProvider(agent._raw?.vision_provider || '');
      try { setExtraCoreTools(JSON.parse(agent._raw?.extra_core_tools || '[]') || []); } catch { setExtraCoreTools([]); }
      setComposioEnabled(!!agent._raw?.composio_enabled);
      setComposioUserId(agent._raw?.composio_user_id || '');
      try {
        const tk = agent._raw?.composio_toolkits;
        setPickedToolkits(tk ? JSON.parse(tk) : null);
      } catch { setPickedToolkits(null); }
      setTtsEnabled(!!agent._raw?.tts_enabled);
      setTtsProvider(agent._raw?.tts_provider || 'voidai');
      setTtsVoice(agent._raw?.tts_voice || '');
      setVoiceProvider(agent._raw?.voice_provider || 'default');
      setGeminiVoice(agent._raw?.gemini_live_voice || 'Zephyr');
      setMcpServerId(agent._raw?.mcp_server_id || '');
      setMcpToolName(agent._raw?.mcp_tool_name || '');
      setMcpInputField(agent._raw?.mcp_input_field || '');
      setOptimizeTerse(!!agent._raw?.optimize_terse);
      setOptimizeLeanCode(!!agent._raw?.optimize_lean_code);
      setCompressLite(!!agent._raw?.compress_lite);
      setCompressHeadroom(!!agent._raw?.compress_headroom);
      setCompressRtk(!!agent._raw?.compress_rtk);
      setPendingAvatarUrl(agent._raw?.avatar_url || null);
    } else {
      setName(''); setDesc(''); setRole('specialist'); setProvider('voidai');
      setModel(''); setTier('pinned'); setExec(false); setChatMode(false); setPrompt(''); setCaps('');
      setPickedSkills([]);
      setVisionMode('auto');
      setVisionProvider('');
      setComposioEnabled(false); setComposioUserId(''); setPickedToolkits(null);
      setTtsEnabled(false); setTtsProvider('voidai'); setTtsVoice('');
      setVoiceProvider('default'); setGeminiVoice('Zephyr');
      setMcpServerId(''); setMcpToolName(''); setMcpInputField('');
      setOptimizeTerse(false); setOptimizeLeanCode(false);
      setCompressLite(false); setCompressHeadroom(false); setCompressRtk(false);
      setPendingAvatarUrl(null);
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
    // Voice catalog (VoidAI static + ElevenLabs + Kokoro from API when keyed).
    window.NC_API.get('/api/audio/voices').then(v => setVoiceCatalog(v || { voidai: [], elevenlabs: [], kokoro: [], chatterbox: [], elevenlabsAvailable: false, kokoroAvailable: false, chatterboxAvailable: false })).catch(()=>{});
    // MCP server catalog for MCP-backed agent creation.
    window.NC_API.get('/api/mcp/servers').then(r => setMcpServers(r?.servers || [])).catch(()=>{});
  }, [open, agent, fetchAllCatalogs]);

  const refreshCatalog = async () => {
    if (provider === 'ollama') {
      setModelsLoading(true);
      try {
        const res = await window.NC_API.get('/api/ollama/models');
        const olModels = (res?.models || []).map(m => ({
          model_id: m.id,
          tier: 'mid',
          provider: 'ollama',
          is_available: true,
        }));
        setOllamaModels(olModels);
      } catch (e) { console.warn('[AgentEditor] ollama refresh failed', e); }
      finally { setModelsLoading(false); }
      return;
    }
    const apiProvider = provider === 'anthropic'      ? 'anthropic'
                      : provider === 'claude-gateway' ? 'claude-gateway'
                      : provider === 'codex'       ? 'codex'
                      : provider === 'antigravity' ? 'antigravity'
                      : provider === 'openrouter'  ? 'openrouter'
                      : provider === 'venice'      ? 'venice'
                      : provider === 'abacus'      ? 'abacus'
                      : provider === 'omniroute'   ? 'omniroute'
                      : provider === 'kimi-api'    ? 'kimi-api'
                      : provider === 'kimi'        ? 'kimi'
                      : provider === 'minimax'     ? 'minimax'
                      : provider === 'claude-interactive' ? 'claude-interactive'
                      : provider === 'litellm'     ? 'litellm'
                      :                              'voidai';
    setModelsLoading(true);
    try {
      await fetch('/api/models/refresh?provider=' + apiProvider, { method: 'POST', credentials: 'same-origin' });
    } catch (e) { console.warn('[AgentEditor] refresh failed', e); }
    await fetchAllCatalogs();
  };

  // The catalog the dropdown should currently render — switches with `provider` state.
  const activeCatalog       = provider === 'anthropic'      ? anthropicModels
                            : provider === 'claude-gateway' ? gatewayModels
                            : provider === 'codex'       ? codexModels
                            : provider === 'antigravity' ? antigravityModels
                            : provider === 'openrouter'  ? openrouterModels
                            : provider === 'venice'      ? veniceModels
                            : provider === 'abacus'      ? abacusModels
                            : provider === 'omniroute'   ? omnirouteModels
                            : provider === 'ollama'      ? ollamaModels
                            : provider === 'hermes'      ? hermesModels
                            : provider === 'kimi-api'    ? kimiApiModels
                            : provider === 'kimi'        ? kimiModels
                            : provider === 'minimax'     ? minimaxModels
                            : provider === 'claude-interactive' ? interactiveModels
                            : provider === 'litellm'     ? litellmModels
                            :                              voidaiModels;
  const activeProviderLabel = provider === 'anthropic'      ? 'Anthropic'
                            : provider === 'claude-gateway' ? 'Claude Gateway (LiteLLM)'
                            : provider === 'codex'       ? 'Codex'
                            : provider === 'antigravity' ? 'Antigravity'
                            : provider === 'openrouter'  ? 'OpenRouter'
                            : provider === 'venice'      ? 'Venice'
                            : provider === 'abacus'      ? 'Abacus AI'
                            : provider === 'omniroute'   ? 'OmniRoute'
                            : provider === 'ollama'      ? 'Ollama'
                            : provider === 'hermes'      ? 'Hermes/Grok'
                            : provider === 'kimi-api'    ? 'Kimi Code API'
                            : provider === 'kimi'        ? 'Kimi (native)'
                            : provider === 'minimax'     ? 'MiniMax (native)'
                            : provider === 'claude-interactive' ? 'Claude (interactive)'
                            : provider === 'litellm'     ? 'LiteLLM'
                            :                              'VoidAI';

  if (!open) return null;
  const save = async () => {
    const body = {
      name: name.trim(),
      description: desc.trim(),
      role,
      provider,
      model: model.trim() || undefined,
      model_tier: tier,
      // Chat mode has no tools, so exec is meaningless there — never persist both.
      exec_enabled: chatMode ? false : exec,
      chat_mode: chatMode,
      system_prompt: prompt.trim(),
      capabilities: caps.split(',').map(c => c.trim()).filter(Boolean),
      skills: pickedSkills,
      vision_mode:       visionMode,
      vision_provider:   visionProvider || null,
      extra_core_tools:  extraCoreTools,
      composio_enabled:  composioEnabled,
      composio_user_id:  composioUserId.trim() || null,
      // null = "all toolkits"; empty array gets normalized to null server-side.
      composio_toolkits: pickedToolkits === null ? null : pickedToolkits,
      tts_enabled:  ttsEnabled,
      tts_provider: ttsProvider,
      tts_voice:    ttsVoice.trim() || null,
      voice_provider:       voiceProvider,
      gemini_live_voice:    geminiVoice,
      gemini_tools_enabled: 1,
      avatar_url:   pendingAvatarUrl !== undefined ? pendingAvatarUrl : undefined,
      optimize_terse: optimizeTerse,
      optimize_lean_code: optimizeLeanCode,
      compress_lite: compressLite,
      compress_headroom: compressHeadroom,
      compress_rtk: compressRtk,
      ...(provider === 'mcp' ? {
        mcp_server_id:   mcpServerId || null,
        mcp_tool_name:   mcpToolName || null,
        mcp_input_field: mcpInputField.trim() || null,
      } : {}),
    };
    if (!body.name) { setErr('name required'); return; }
    setBusy(true); setErr(null);
    try {
      if (agent) await window.NC_API.patch('/api/agents/' + agent._raw.id, body);
      else await window.NC_API.post('/api/agents', body);
      await window.NC_LIVE.refresh();
      onSaved && onSaved();
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="nc-panel glow" onClick={e => e.stopPropagation()} style={{ width: '90%', maxWidth: 640, maxHeight: '85vh', overflow: 'auto', padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div className="label-tiny neonc">{agent ? 'EDIT AGENT — ' + agent.name : 'NEW AGENT'}</div>
          <button className="nc-btn ghost" onClick={onClose}>✕</button>
        </div>
        {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>// {err}</div>}

        {/* Avatar section */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
          <div
            onClick={() => avatarFileRef.current && avatarFileRef.current.click()}
            style={{ width: 72, height: 72, flex: 'none', borderRadius: '50%', background: 'radial-gradient(circle at 35% 30%, rgba(255,255,255,0.3), transparent 30%), radial-gradient(circle, var(--accent), rgba(0,0,0,0))', border: '2px solid var(--accent)', boxShadow: '0 0 14px var(--accent)66', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', overflow: 'hidden', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 26, color: 'var(--icon-on-accent, #fff)', textShadow: '0 0 6px var(--accent)' }}
            title="Click to upload avatar"
          >
            {pendingAvatarUrl
              ? <img src={pendingAvatarUrl} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
              : (name[0] || '?')}
          </div>
          <input
            ref={avatarFileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files && e.target.files[0];
              if (!file) return;
              if (agent && agent._raw?.id) {
                // Upload immediately for existing agents
                try {
                  const fd = new FormData();
                  fd.append('image', file);
                  const r = await fetch('/api/agents/' + agent._raw.id + '/avatar', { method: 'POST', credentials: 'same-origin', body: fd });
                  const data = await r.json();
                  if (data.ok && data.avatar_url) setPendingAvatarUrl(data.avatar_url);
                  else setErr(data.error || 'Avatar upload failed');
                } catch (ex) { setErr(ex.message); }
              } else {
                // New agent: show local preview; actual upload will need to happen post-create
                const reader = new FileReader();
                reader.onload = (ev) => setPendingAvatarUrl(ev.target.result);
                reader.readAsDataURL(file);
              }
              e.target.value = '';
            }}
          />
          <div style={{ flex: 1 }}>
            <div className="field" style={{ marginBottom: 6 }}>
              <label style={{ fontSize: 10 }}>Or paste image URL</label>
              <input
                className="nc-input"
                value={pendingAvatarUrl && !pendingAvatarUrl.startsWith('data:') ? pendingAvatarUrl : ''}
                onChange={e => setPendingAvatarUrl(e.target.value || null)}
                placeholder="https://..."
              />
            </div>
            {pendingAvatarUrl && (
              <button className="nc-btn ghost" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => setPendingAvatarUrl(null)}>Clear avatar</button>
            )}
          </div>
        </div>

        <div className="grid-responsive-sm">
          <div className="field"><label>Name</label><input className="nc-input" value={name} onChange={e => setName(e.target.value)}/></div>
          <div className="field"><label>Role</label><select className="nc-select" value={role} onChange={e => setRole(e.target.value)}><option>specialist</option><option>orchestrator</option><option>agent</option><option>assistant</option></select></div>
        </div>
        <div className="field" style={{ marginTop: 10 }}><label>Description</label><input className="nc-input" value={desc} onChange={e => setDesc(e.target.value)}/></div>
        <div className="grid-responsive-sm" style={{ marginTop: 10 }}>
          <div className="field"><label>Provider</label><select className="nc-select" value={provider} onChange={e => setProvider(e.target.value)}><option value="voidai">VoidAI (OpenAI-compatible)</option><option value="anthropic">Anthropic / Claude CLI</option><option value="claude-gateway">Claude Gateway (any model via LiteLLM)</option><option value="kimi">Kimi (native Anthropic endpoint)</option><option value="minimax">MiniMax (native Anthropic endpoint)</option><option value="claude-interactive">Claude (interactive / tmux REPL)</option><option value="codex">Codex / ChatGPT CLI</option><option value="antigravity">Antigravity (Google)</option><option value="openrouter">OpenRouter</option><option value="ollama">Ollama (Local)</option><option value="abacus">Abacus AI (media models)</option><option value="omniroute">OmniRoute (200+ providers, self-hosted)</option><option value="hermes">Hermes / Grok (xAI OAuth)</option><option value="litellm">LiteLLM (Proxy)</option><option value="mcp">MCP-backed (Pydantic AI / external)</option></select></div>
          <div className="field"><label>Model strategy</label><select className="nc-select" value={tier} onChange={e => setTier(e.target.value)}><option value="pinned">Pinned</option><option value="auto">Auto-triage</option><option value="low">Low</option><option value="mid">Mid</option><option value="high">High</option></select></div>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Model {tier !== 'pinned' && <span className="muted" style={{ fontSize: 10 }}>(fallback only — tier picks)</span>}</span>
            <span className="muted" style={{ fontSize: 10 }}>
              {modelsLoading ? 'loading…' : `${activeProviderLabel}: ${activeCatalog.length} models`}
              {' · '}
              <a href="#" onClick={(e) => { e.preventDefault(); refreshCatalog(); }} style={{ color: 'var(--accent-2)' }}>↻ refresh</a>
            </span>
          </label>
          {(provider === 'openrouter' || provider === 'venice' || provider === 'kimi' || provider === 'minimax') ? (
            <>
              <input
                className="nc-input"
                placeholder={provider === 'venice'
                  ? 'e.g. zai-org-glm-5, kimi-k2-5, qwen3-vl-235b-a22b, venice-uncensored'
                  : provider === 'kimi'    ? 'e.g. kimi-k2.6 (leave blank for the configured default)'
                  : provider === 'minimax' ? 'e.g. MiniMax-M2.7 (leave blank for the configured default)'
                  : 'e.g. anthropic/claude-sonnet-4, openai/gpt-4o, openai/gpt-oss-120b:free'}
                value={model}
                onChange={e => setModel(e.target.value)}
                style={{ width: '100%', marginBottom: 6 }}
              />
              <select className="nc-select" value="" onChange={e => e.target.value && setModel(e.target.value)} style={{ width: '100%' }}>
                <option value="">— or pick from catalog ({activeCatalog.length} models) —</option>
                {/* Free models first (OpenRouter only — Venice catalog rows carry no _isFree) */}
                {(() => {
                  const freeModels = activeCatalog.filter(m => m._isFree);
                  if (!freeModels.length) return null;
                  return <optgroup key="free" label={`FREE · ${freeModels.length}`}>{freeModels.map(m => <option key={m.model_id} value={m.model_id}>{m.model_id}</option>)}</optgroup>;
                })()}
                {['high','mid','low'].map(t => {
                  const inTier = activeCatalog.filter(m => m.tier === t && !m._isFree);
                  if (!inTier.length) return null;
                  return <optgroup key={t} label={t.toUpperCase() + ' · ' + inTier.length}>{inTier.map(m => <option key={m.model_id} value={m.model_id}>{m.model_id}</option>)}</optgroup>;
                })}
              </select>
              <div className="mono" style={{ color: 'var(--muted)', fontSize: 10, marginTop: 4 }}>
                {provider === 'venice'
                  ? '// any Venice model id works — pick from the catalog above or see venice.ai/models'
                  : '// format: provider/model-name · free models end with :free (see openrouter.ai/models)'}
              </div>
            </>
          ) : (
            <select className="nc-select" value={model} onChange={e => setModel(e.target.value)} style={{ width: '100%' }}>
              <option value="">(default — {activeProviderLabel})</option>
              {['high','mid','low'].map(t => {
                const inTier = activeCatalog.filter(m => m.tier === t);
                if (!inTier.length) return null;
                return <optgroup key={t} label={t.toUpperCase() + ' · ' + inTier.length}>{inTier.map(m => <option key={m.model_id} value={m.model_id}>{m.model_id}</option>)}</optgroup>;
              })}
            </select>
          )}
          {modelsErr && <div className="mono" style={{ color: 'var(--danger)', fontSize: 10, marginTop: 4 }}>// {modelsErr}</div>}
          {activeCatalog.length === 0 && !modelsLoading && !modelsErr && (
            <div className="mono" style={{ color: 'var(--amber)', fontSize: 10, marginTop: 4 }}>// no models for {activeProviderLabel} — try Refresh</div>
          )}
        </div>
        {provider === 'mcp' && (
          <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 6 }}>
            <div className="field">
              <label>MCP Server</label>
              <select className="nc-select" value={mcpServerId} onChange={e => { setMcpServerId(e.target.value); setMcpToolName(''); }}>
                <option value="">-- select server --</option>
                {mcpServers.filter(s => s.enabled && s.status === 'ready').map(s => (
                  <option key={s.id} value={s.id}>{s.name} ({s.tools_count} tools)</option>
                ))}
                {mcpServers.filter(s => s.enabled && s.status === 'ready').length === 0 && (
                  <option value="" disabled>no ready servers — probe a server on the MCP page first</option>
                )}
              </select>
            </div>
            <div className="field" style={{ marginTop: 8 }}>
              <label>Tool</label>
              <select className="nc-select" value={mcpToolName} onChange={e => setMcpToolName(e.target.value)} disabled={!mcpServerId}>
                <option value="">-- select tool --</option>
                {(mcpServers.find(s => s.id === mcpServerId)?.tools || []).map(t => (
                  <option key={t.name} value={t.name}>{t.name}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginTop: 8 }}>
              <label>Input field name <span className="muted" style={{ fontSize: 10 }}>(JSON key for user message; defaults to "query")</span></label>
              <input className="nc-input" placeholder="query" value={mcpInputField} onChange={e => setMcpInputField(e.target.value)}/>
            </div>
          </div>
        )}
        <div className="field" style={{ marginTop: 10 }}><label>Capabilities (comma-sep)</label><input className="nc-input" value={caps} onChange={e => setCaps(e.target.value)} placeholder="research, summarize"/></div>
        <div className="field" style={{ marginTop: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: chatMode ? 0.45 : 1 }}>
            <input type="checkbox" checked={exec} disabled={chatMode} onChange={e => setExec(e.target.checked)} style={{ width: 'auto' }}/>
            <span>Exec enabled — bash_run / fs_read / fs_write{chatMode ? ' (disabled in chat mode)' : ''}</span>
          </label>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={chatMode} onChange={e => { const on = e.target.checked; setChatMode(on); if (on) setExec(false); }} style={{ width: 'auto' }}/>
            <span>Chat mode — plain completion (no tools / skills / MCP / decomposition)</span>
          </label>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Skills <span className="muted" style={{ fontSize: 10 }}>(bodies appended to system prompt)</span></span>
            {pickedSkills.length > 0 && (
              <a href="#" onClick={e => { e.preventDefault(); setPickedSkills([]); }} style={{ color: 'var(--accent-2)', fontSize: 10 }}>clear all</a>
            )}
          </label>
          {skills.length === 0
            ? <div className="mono muted" style={{ fontSize: 11, padding: 6 }}>// no SKILL.md files found in .claude/skills/ or ~/.claude/skills/</div>
            : <>
                <select className="nc-select" onChange={e => {
                  const val = e.target.value;
                  if (val && !pickedSkills.includes(val)) setPickedSkills(p => [...p, val]);
                  e.target.value = '';
                }} style={{ width: '100%' }}>
                  <option value="">-- add skill --</option>
                  {skills.filter(s => !pickedSkills.includes(s.name)).map(s => (
                    <option key={s.name} value={s.name} title={s.description + (s.tools?.length ? ' · Tools: ' + s.tools.join(', ') : '')}>
                      {s.name}{s.source ? '  ·  ' + s.source : ''}
                    </option>
                  ))}
                </select>
                {pickedSkills.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
                    {pickedSkills.map(name => {
                      const meta = skills.find(s => s.name === name);
                      return (
                        <span key={name} className="tag cyan"
                          title={meta ? (meta.description + (meta.tools?.length ? '\nTools: ' + meta.tools.join(', ') : '')) : name}
                          style={{ fontSize: 10, padding: '2px 8px', cursor: 'default' }}>
                          {name}
                          {meta?.source && <span className="muted" style={{ fontSize: 9, marginLeft: 4 }}>· {meta.source}</span>}
                          <span onClick={() => setPickedSkills(p => p.filter(x => x !== name))}
                            style={{ marginLeft: 6, cursor: 'pointer', color: 'var(--muted)', fontWeight: 700 }}>×</span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </>}
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
          <label>Vision provider <span className="muted" style={{ fontSize: 10 }}>(which backend describes images when preprocessing)</span></label>
          <select className="nc-select" value={visionProvider} onChange={e => setVisionProvider(e.target.value)}>
            <option value="">Default — inherit global VISION_PROVIDER</option>
            <option value="openrouter">Gemini (OpenRouter) — stronger multimodal</option>
            <option value="hermes">Grok (Hermes) — stylized / uncensored</option>
            <option value="voidai">VoidAI (gpt-4o) — legacy</option>
          </select>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>Extra upfront tools <span className="muted" style={{ fontSize: 10 }}>(image-gen tools shown to this agent directly, not hidden behind search_tools)</span></label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: 8, border: '1px solid var(--border)', borderRadius: 6 }}>
            {[
              ['generate_image',          'Grok Aurora (direct) — no cookies'],
              ['generate_image_venice',   'Venice — no cookies'],
              ['abacus_image',            'Abacus Flux — no cookies'],
              ['grok_image_edit',         'Grok image edit (X session)'],
              ['grok_image_compose',      'Grok image compose (X session)'],
              ['gpt_image_generate',      'GPT image (ChatGPT session)'],
              ['gpt_image_edit',          'GPT image edit (ChatGPT session)'],
              ['gemini_image_generate',   'Gemini image (Gemini session)'],
              ['gemini_image_edit',       'Gemini image edit (Gemini session)'],
              ['gemini_web_generate_image','Gemini web image (native)'],
            ].map(([tool, label]) => (
              <label key={tool} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={extraCoreTools.includes(tool)}
                  onChange={e => setExtraCoreTools(prev =>
                    e.target.checked ? [...new Set([...prev, tool])] : prev.filter(t => t !== tool))}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
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
                  <a href="#" onClick={e => { e.preventDefault(); setPickedToolkits(null); }} style={{ color: 'var(--accent-2)' }}>reset to all</a>
                </span>
              </label>
              {composioCatalog.length === 0
                ? <div className="mono muted" style={{ fontSize: 10, padding: '6px 0' }}>// catalog loading or empty — verify COMPOSIO_API_KEY</div>
                : <>
                    <select className="nc-select" onChange={e => {
                      const val = e.target.value;
                      if (val) {
                        setPickedToolkits(prev => {
                          const cur = prev ?? [];
                          return cur.includes(val) ? cur : [...cur, val];
                        });
                      }
                      e.target.value = '';
                    }} style={{ width: '100%' }}>
                      <option value="">-- add toolkit --</option>
                      {composioCatalog
                        .filter(t => !(pickedToolkits ?? []).includes(t.slug))
                        .map(t => (
                          <option key={t.slug} value={t.slug}>{t.name}  ·  {t.slug}</option>
                        ))
                      }
                    </select>
                    {pickedToolkits !== null && pickedToolkits.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
                        {pickedToolkits.map(slug => {
                          const meta = composioCatalog.find(t => t.slug === slug);
                          return (
                            <span key={slug} className="tag cyan" style={{ fontSize: 10, padding: '2px 8px', cursor: 'default' }}>
                              {meta?.name || slug}
                              <span className="muted" style={{ fontSize: 9, marginLeft: 4 }}>· {slug}</span>
                              <span onClick={() => setPickedToolkits(p => (p ?? []).filter(x => x !== slug))}
                                style={{ marginLeft: 6, cursor: 'pointer', color: 'var(--muted)', fontWeight: 700 }}>×</span>
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {(pickedToolkits === null || pickedToolkits.length === 0) && (
                      <div className="mono muted" style={{ fontSize: 10, marginTop: 4 }}>// all available toolkits active — add specific ones above to restrict</div>
                    )}
                  </>
              }
            </div>
            {composioUserId.trim() && (
              <div className="mono muted" style={{ fontSize: 10 }}>
                ↗ Connect this user_id's accounts at <a href="https://platform.composio.dev/developers" target="_blank" style={{ color: 'var(--accent-2)' }}>platform.composio.dev/developers</a> — agents need OAuth-connected accounts to actually call apps.
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
                <option value="kokoro" disabled={!voiceCatalog.kokoroAvailable}>
                  Kokoro {!voiceCatalog.kokoroAvailable && '(set KOKORO_API_KEY)'}
                </option>
                <option value="chatterbox" disabled={!voiceCatalog.chatterboxAvailable}>
                  Chatterbox {!voiceCatalog.chatterboxAvailable && '(set CHATTERBOX_ENABLED=true)'}
                </option>
              </select>
            </div>
            <div className="field">
              <label>Voice <span className="muted" style={{ fontSize: 10 }}>(blank = use env default)</span></label>
              <select className="nc-select" value={ttsVoice} onChange={e => setTtsVoice(e.target.value)}>
                <option value="">(default)</option>
                {(ttsProvider === 'elevenlabs' ? voiceCatalog.elevenlabs : ttsProvider === 'kokoro' ? voiceCatalog.kokoro : ttsProvider === 'chatterbox' ? voiceCatalog.chatterbox : voiceCatalog.voidai).map(v => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}
        {ttsEnabled && (
          <div style={{ marginTop: 10 }}>
            <div className="field">
              <label>Voice provider</label>
              <select className="nc-select" value={voiceProvider} onChange={e => setVoiceProvider(e.target.value)}>
                <option value="default">Default Pipeline (STT → Agent → TTS)</option>
                <option value="gemini_live">Gemini Live (low-latency, bypasses agent)</option>
              </select>
            </div>
            {voiceProvider === 'gemini_live' && (
              <div className="field" style={{ marginTop: 8 }}>
                <label>Gemini voice</label>
                <select className="nc-select" value={geminiVoice} onChange={e => setGeminiVoice(e.target.value)}>
                  {[
                    { id: 'Zephyr',     label: 'Zephyr — Bright' },
                    { id: 'Puck',       label: 'Puck — Upbeat' },
                    { id: 'Charon',     label: 'Charon — Informative' },
                    { id: 'Kore',       label: 'Kore — Firm' },
                    { id: 'Fenrir',     label: 'Fenrir — Excitable' },
                    { id: 'Aoede',      label: 'Aoede — Breezy' },
                    { id: 'Orbit',      label: 'Orbit — Authoritative' },
                    { id: 'Callirrhoe', label: 'Callirrhoe — Easy-going' },
                    { id: 'Umbriel',    label: 'Umbriel — Easy-going' },
                    { id: 'Algieba',    label: 'Algieba — Smooth' },
                  ].map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                </select>
                <p className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                  Gemini Live replaces STT/TTS — the agent's system prompt becomes Gemini's persona. Requires GEMINI_API_KEY.
                </p>
              </div>
            )}
          </div>
        )}
        <div className="field" style={{ marginTop: 10 }}>
          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Token optimization</span>
            <span className="muted" style={{ fontSize: 10 }}>directives + tool-output compression</span>
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 6 }}>
            {[
              ['optimize_terse', optimizeTerse, setOptimizeTerse, 'Terse directive — minimize prose'],
              ['optimize_lean_code', optimizeLeanCode, setOptimizeLeanCode, 'Lean code directive — YAGNI code volume'],
              ['compress_lite', compressLite, setCompressLite, 'Lite — normalize whitespace'],
              ['compress_headroom', compressHeadroom, setCompressHeadroom, 'Headroom — compact JSON'],
              ['compress_rtk', compressRtk, setCompressRtk, 'RTK — collapse noisy output'],
            ].map(([key, checked, setter, label]) => (
              <label key={String(key)} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={checked} onChange={e => setter(e.target.checked)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <div className="mono muted" style={{ fontSize: 9, marginTop: 6 }}>
            // Retrieval results (memory, KB, uploads, vision) are always exempt from compression.
          </div>
        </div>
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

      <div className="ag-toolbar flex-wrap-mobile">
        <span className="tag blue">ALL · {AGENTS.length}</span>
        <span className="tag hide-mobile">PERMANENT · {AGENTS.filter(a => !a.temp).length}</span>
        <span className="tag violet">TEMP · {AGENTS.filter(a => a.temp).length}</span>
        <span className="tag green">LIVE · {AGENTS.filter(a => a.status === 'live').length}</span>
        <span className="ag-toolbar-spacer"/>
        <input className="nc-input full-mobile" placeholder="filter agents..." value={filter} onChange={e => setFilter(e.target.value)} style={{ maxWidth: 240 }}/>
      </div>

      <div className="ag-grid" style={{ marginBottom: 16 }}>
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
