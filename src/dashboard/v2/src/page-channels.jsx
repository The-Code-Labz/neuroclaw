/* Channels — Discord bot management */

const Channels = () => {
  const [bots, setBots]       = React.useState([]);
  const [agents, setAgents]   = React.useState([]);
  const [busy, setBusy]       = React.useState(false);
  const [err, setErr]         = React.useState(null);
  const [adding, setAdding]   = React.useState(false);
  const [newBot, setNewBot]   = React.useState({ name: '', token: '', default_agent: '', application_id: '' });
  const [expanded, setExpanded] = React.useState({});       // bot_id → bool
  const [newRoute, setNewRoute] = React.useState({});       // bot_id → { channel_id, agent }
  const [guildLists, setGuildLists] = React.useState({});   // bot_id → guilds[] from /api/discord/bots/:id/guilds
  const [guildErr, setGuildErr]     = React.useState({});   // bot_id → error string

  const refresh = React.useCallback(async () => {
    setErr(null);
    try {
      const r = await window.NC_API.get('/api/discord/bots');
      setBots(Array.isArray(r?.bots) ? r.bots : []);
    } catch (e) { setErr(e.message); }
  }, []);

  React.useEffect(() => {
    refresh();
    window.NC_API.get('/api/agents').then(rows => setAgents(Array.isArray(rows) ? rows : [])).catch(() => {});
    const id = setInterval(refresh, 5000);                  // live status updates
    return () => clearInterval(id);
  }, [refresh]);

  const submitNewBot = async () => {
    if (!newBot.name.trim() || !newBot.token.trim()) { setErr('name and token required'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/discord/bots', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(newBot),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setNewBot({ name: '', token: '', default_agent: '', application_id: '' });
      setAdding(false);
      await refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const toggleEnabled = async (bot) => {
    await fetch(`/api/discord/bots/${bot.id}`, {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !bot.enabled }),
    });
    refresh();
  };

  const toggleVoice = async (bot) => {
    await fetch(`/api/discord/bots/${bot.id}`, {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice_enabled: !bot.voice_enabled }),
    });
    refresh();
  };

  const deleteBot = async (bot) => {
    if (!confirm(`Delete Discord bot "${bot.name}"? This removes the bot config and all its channel routes. The bot disconnects within 30s.`)) return;
    await fetch(`/api/discord/bots/${bot.id}`, { method: 'DELETE', credentials: 'same-origin' });
    refresh();
  };

  const addRoute = async (botId) => {
    const draft = newRoute[botId] || {};
    if (!draft.channel_id?.trim() || !draft.agent?.trim()) return;
    const r = await fetch(`/api/discord/bots/${botId}/routes`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    });
    if (r.ok) {
      setNewRoute(prev => ({ ...prev, [botId]: { channel_id: '', agent: '' } }));
      refresh();
    }
  };

  const deleteRoute = async (routeId) => {
    await fetch(`/api/discord/routes/${routeId}`, { method: 'DELETE', credentials: 'same-origin' });
    refresh();
  };

  const toggleRouteRequireMention = async (routeId, current) => {
    await fetch(`/api/discord/routes/${routeId}`, {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ require_mention: !current }),
    });
    refresh();
  };

  const loadGuilds = React.useCallback(async (botId) => {
    setGuildErr(prev => ({ ...prev, [botId]: null }));
    try {
      const r = await window.NC_API.get(`/api/discord/bots/${botId}/guilds`);
      if (r?.ok) setGuildLists(prev => ({ ...prev, [botId]: r.guilds || [] }));
      else       setGuildErr(prev => ({ ...prev, [botId]: r?.error || 'failed to fetch guilds' }));
    } catch (e) {
      setGuildErr(prev => ({ ...prev, [botId]: e.message }));
    }
  }, []);

  const toggleAutoReplyGuild = async (bot, guildId) => {
    const current = new Set((guildLists[bot.id] || []).filter(g => g.auto_reply).map(g => g.id));
    if (current.has(guildId)) current.delete(guildId); else current.add(guildId);
    await fetch(`/api/discord/bots/${bot.id}`, {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auto_reply_guilds: [...current] }),
    });
    await loadGuilds(bot.id);
    refresh();
  };

  const statusColor = (s) => ({
    ready:      'var(--neon-2)',
    connecting: 'var(--amber)',
    error:      'var(--danger)',
    idle:       'var(--muted)',
    disabled:   'var(--muted)',
  }[s] || 'var(--muted)');

  const agentName = (id) => agents.find(a => a.id === id)?.name || id;

  return (
    <div className="page page-channels">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div className="label-tiny neonc">DISCORD BOTS</div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            Multi-bot Discord integration. Each bot is its own gateway connection with its own identity. Channel routes map Discord channel ids → NeuroClaw agents.
          </div>
        </div>
        <button className="nc-btn primary" onClick={() => setAdding(true)}>+ Add bot</button>
      </div>

      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>// {err}</div>}

      {adding && (
        <div className="nc-panel glow" style={{ padding: 16, marginBottom: 14 }}>
          <div className="label-tiny neonc" style={{ marginBottom: 10 }}>NEW DISCORD BOT</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="field"><label>Name</label><input className="nc-input" value={newBot.name} onChange={e => setNewBot({ ...newBot, name: e.target.value })} placeholder="e.g. Coder Bot"/></div>
            <div className="field"><label>Default agent</label><select className="nc-select" value={newBot.default_agent} onChange={e => setNewBot({ ...newBot, default_agent: e.target.value })}><option value="">(none)</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label>Bot token <span className="muted" style={{ fontSize: 10 }}>(from Developer Portal → Bot → Reset Token)</span></label>
            <input className="nc-input" type="password" value={newBot.token} onChange={e => setNewBot({ ...newBot, token: e.target.value })} placeholder="MTk4..."/>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label>Application ID <span className="muted" style={{ fontSize: 10 }}>(optional — skips a startup REST call)</span></label>
            <input className="nc-input" value={newBot.application_id} onChange={e => setNewBot({ ...newBot, application_id: e.target.value })} placeholder=""/>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button className="nc-btn ghost" onClick={() => { setAdding(false); setErr(null); }}>Cancel</button>
            <button className="nc-btn primary" onClick={submitNewBot} disabled={busy}>{busy ? 'Adding…' : 'Add bot'}</button>
          </div>
        </div>
      )}

      {bots.length === 0 && !adding && (
        <div className="nc-panel" style={{ padding: 24, textAlign: 'center' }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>// no Discord bots configured</div>
          <div className="muted" style={{ fontSize: 10 }}>
            Create a bot at <a href="https://discord.com/developers/applications" target="_blank" rel="noopener" style={{ color: 'var(--neon-2)' }}>discord.com/developers/applications</a>, then click "Add bot" above.<br/>
            Or just ask Alfred — agents can register bots directly via the <code>discord_register_bot</code> tool.
          </div>
        </div>
      )}

      {bots.map(bot => (
        <div key={bot.id} className="nc-panel" style={{ marginBottom: 10, padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(bot.status), display: 'inline-block' }}/>
                <strong>{bot.name}</strong>
                {bot.bot_user_tag && <span className="muted" style={{ fontSize: 10 }}>· {bot.bot_user_tag}</span>}
                <span className="tag" style={{ fontSize: 9 }}>{bot.status}</span>
                {!bot.enabled && <span className="tag" style={{ fontSize: 9, background: 'var(--muted)' }}>disabled</span>}
              </div>
              <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                token <code>{bot.token}</code> · default <code>{agentName(bot.default_agent_id) || '(none)'}</code> · {(bot.routes?.length ?? 0)} channel routes
                {bot.status_detail && <span style={{ color: 'var(--danger)' }}> · {bot.status_detail}</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => setExpanded(p => ({ ...p, [bot.id]: !p[bot.id] }))}>
                {expanded[bot.id] ? 'Hide routes' : 'Routes'}
              </button>
              <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => toggleEnabled(bot)}>
                {bot.enabled ? 'Disable' : 'Enable'}
              </button>
              <button className="nc-btn ghost" style={{ fontSize: 10, color: bot.voice_enabled ? 'var(--neon-2)' : undefined }}
                      title="Voice: when on, replies attach a synthesized .mp3 for any agent that has TTS enabled. Inbound voice notes are always transcribed."
                      onClick={() => toggleVoice(bot)}>
                🔊 {bot.voice_enabled ? 'Voice on' : 'Voice off'}
              </button>
              <button className="nc-btn ghost" style={{ fontSize: 10, color: 'var(--danger)' }} onClick={() => deleteBot(bot)}>×</button>
            </div>
          </div>

          {expanded[bot.id] && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div className="label-tiny">AUTO-REPLY SERVERS <span className="muted" style={{ fontSize: 10 }}>(no @mention required)</span></div>
                <a href="#" onClick={e => { e.preventDefault(); loadGuilds(bot.id); }} style={{ color: 'var(--neon-2)', fontSize: 10 }}>↻ load servers</a>
              </div>
              {guildErr[bot.id] && <div className="mono" style={{ color: 'var(--amber)', fontSize: 10, marginBottom: 8 }}>// {guildErr[bot.id]}</div>}
              {!guildLists[bot.id] && !guildErr[bot.id] && bot.status === 'ready' && (
                <div className="mono muted" style={{ fontSize: 10, marginBottom: 8 }}>// click "load servers" to see which servers this bot is in</div>
              )}
              {bot.status !== 'ready' && (
                <div className="mono muted" style={{ fontSize: 10, marginBottom: 8 }}>// bot must be connected (status: ready) to enumerate servers</div>
              )}
              {guildLists[bot.id] && guildLists[bot.id].length === 0 && (
                <div className="mono muted" style={{ fontSize: 10, marginBottom: 8 }}>// bot is not in any servers yet — invite it via the Developer Portal OAuth2 URL Generator</div>
              )}
              {guildLists[bot.id] && guildLists[bot.id].length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {guildLists[bot.id].map(g => (
                    <span key={g.id} onClick={() => toggleAutoReplyGuild(bot, g.id)}
                          className={`tag ${g.auto_reply ? 'cyan' : ''}`}
                          title={`${g.name} (${g.member_count ?? '?'} members)\nclick to ${g.auto_reply ? 'disable' : 'enable'} auto-reply`}
                          style={{ cursor: 'pointer', fontSize: 10, padding: '3px 8px' }}>
                      {g.auto_reply ? '✓ ' : ''}{g.name}<span className="muted" style={{ fontSize: 9, marginLeft: 4 }}>· {g.member_count ?? '?'}</span>
                    </span>
                  ))}
                </div>
              )}

              <div className="label-tiny" style={{ marginBottom: 8 }}>CHANNEL ROUTES</div>
              {(bot.routes ?? []).length === 0 && <div className="muted mono" style={{ fontSize: 10, marginBottom: 8 }}>// no routes — mentions fall back to default agent</div>}
              {(bot.routes ?? []).map(r => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <code style={{ fontSize: 10, flex: 1 }}>channel <strong>{r.channel_id}</strong> → agent <strong>{agentName(r.agent_id)}</strong></code>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }} title="When checked, this channel ignores guild auto-reply and requires an @mention. Use it when multiple bots share a server.">
                    <input type="checkbox" checked={!!r.require_mention} onChange={() => toggleRouteRequireMention(r.id, !!r.require_mention)} style={{ width: 'auto' }}/>
                    <span className="muted">mention-only</span>
                  </label>
                  <button className="nc-btn ghost" style={{ fontSize: 10, color: 'var(--danger)' }} onClick={() => deleteRoute(r.id)}>×</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <input className="nc-input" style={{ flex: 1, fontSize: 11 }} placeholder="channel id (right-click channel → Copy ID)" value={newRoute[bot.id]?.channel_id || ''} onChange={e => setNewRoute(p => ({ ...p, [bot.id]: { ...(p[bot.id] || {}), channel_id: e.target.value } }))}/>
                <select className="nc-select" style={{ fontSize: 11 }} value={newRoute[bot.id]?.agent || ''} onChange={e => setNewRoute(p => ({ ...p, [bot.id]: { ...(p[bot.id] || {}), agent: e.target.value } }))}>
                  <option value="">(agent)</option>
                  {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <button className="nc-btn primary" style={{ fontSize: 11 }} onClick={() => addRoute(bot.id)}>+ Add</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

window.Channels = Channels;
