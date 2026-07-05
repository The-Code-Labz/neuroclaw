/* Channels — Discord bot management */

const BotLogPanel = ({ botId, botName }) => {
  const [lines,   setLines]   = React.useState([]);
  const [paused,  setPaused]  = React.useState(false);
  const [bufLen,  setBufLen]  = React.useState(0);
  const [loading, setLoading] = React.useState(true);

  const pausedRef = React.useRef(false);
  const bufRef    = React.useRef([]);
  const bottomRef = React.useRef(null);

  const matchesBot = (line) =>
    line.src === 'discord-bot' &&
    line.msg.includes(botId);

  React.useEffect(() => {
    fetch(`/api/logs/tail?limit=50&src=discord-bot&contains=${encodeURIComponent(botId)}`, { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        if (Array.isArray(data)) setLines(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [botId]);

  React.useEffect(() => {
    let es;
    try {
      es = new EventSource('/api/logs/stream');
      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.type !== 'line' || !matchesBot(ev.line)) return;
          if (pausedRef.current) {
            bufRef.current.push(ev.line);
            setBufLen(bufRef.current.length);
          } else {
            setLines(prev => [...prev.slice(-299), ev.line]);
          }
        } catch { /* ignore */ }
      };
      es.onerror = () => {};
    } catch { /* SSE not supported */ }
    return () => { if (es) es.close(); };
  }, [botId]);

  React.useEffect(() => {
    if (!paused && bottomRef.current)
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [lines, paused]);

  const togglePause = () => {
    const next = !paused;
    pausedRef.current = next;
    setPaused(next);
    if (!next && bufRef.current.length > 0) {
      setLines(prev => [...prev, ...bufRef.current].slice(-300));
      bufRef.current = [];
      setBufLen(0);
    }
  };

  const clear = () => { setLines([]); bufRef.current = []; setBufLen(0); };

  const levelColor = (lvl) => ({ ERROR: 'var(--danger)', WARN: 'var(--amber)', DEBUG: 'var(--muted)' }[lvl] || 'var(--accent-2)');

  const cleanMsg = (msg) => {
    const j = msg.lastIndexOf(' {');
    const stripped = (j >= 0 && msg.endsWith('}')) ? msg.slice(0, j) : msg;
    return stripped.replace(/^discord-(?:bot|voice):\s*/, '');
  };

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <div className="nc-panel glow" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="mono neonc" style={{ fontSize: 10 }}>$ tail · {botName}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {paused
              ? <span className="tag amber" style={{ fontSize: 9 }}>PAUSED · {bufLen} buffered</span>
              : <span className="tag cyan" style={{ fontSize: 9 }}><span className="dot cyan pulse" style={{ marginRight: 4 }}/>LIVE</span>
            }
            <button className="nc-btn ghost" style={{ fontSize: 10, padding: '2px 8px' }} onClick={togglePause}>
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button className="nc-btn ghost" style={{ fontSize: 10, padding: '2px 8px' }} onClick={clear}>Clear</button>
          </div>
        </div>
        <div style={{ background: 'rgba(0,4,12,0.7)', padding: '8px 12px', maxHeight: 200, overflowY: 'auto' }}>
          {loading && <div className="mono muted" style={{ fontSize: 10 }}>// loading...</div>}
          {!loading && lines.length === 0 && (
            <div className="mono muted" style={{ fontSize: 10 }}>// no recent events for this bot</div>
          )}
          {lines.map((l, i) => (
            <div key={i} className="mono" style={{ display: 'grid', gridTemplateColumns: '160px 52px 1fr', gap: 8, padding: '2px 0', fontSize: 10, lineHeight: 1.5 }}>
              <span className="muted">{l.t}</span>
              <span style={{ color: levelColor(l.lvl), fontWeight: 700 }}>{l.lvl}</span>
              <span style={{ color: 'var(--text-soft)', wordBreak: 'break-word' }}>{cleanMsg(l.msg)}</span>
            </div>
          ))}
          <div ref={bottomRef}/>
          <div className="mono neonc" style={{ paddingTop: 4, fontSize: 10 }}>$ <span className="blink">▌</span></div>
        </div>
      </div>
    </div>
  );
};

const Channels = () => {
  const [bots, setBots]       = React.useState([]);
  const [agents, setAgents]   = React.useState([]);
  const [busy, setBusy]       = React.useState(false);
  const [err, setErr]         = React.useState(null);
  const [adding, setAdding]   = React.useState(false);
  const [newBot, setNewBot]   = React.useState({ name: '', token: '', default_agent: '', application_id: '' });
  const [expanded, setExpanded] = React.useState({});       // bot_id → bool
  const [logsOpen, setLogsOpen] = React.useState({});       // bot_id → bool
  const [skillsOpen, setSkillsOpen] = React.useState({});
  const [botSkills, setBotSkills] = React.useState({});
  const [skillsLoading, setSkillsLoading] = React.useState({});
  const [newRoute, setNewRoute] = React.useState({});       // bot_id → { channel_id, agent }
  const [guildLists, setGuildLists] = React.useState({});   // bot_id → guilds[] from /api/discord/bots/:id/guilds
  const [guildErr, setGuildErr]     = React.useState({});   // bot_id → error string
  const [restarting, setRestarting] = React.useState({});   // bot_id → bool

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

  const toggleVoiceChannel = async (bot) => {
    await fetch(`/api/discord/bots/${bot.id}`, {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice_channel_enabled: !bot.voice_channel_enabled }),
    });
    refresh();
  };

  const [newVoiceRoute, setNewVoiceRoute] = React.useState({});  // bot_id → { channel_id, agent }

  const deleteBot = async (bot) => {
    if (!confirm(`Delete Discord bot "${bot.name}"? This removes the bot config and all its channel routes. The bot disconnects within 30s.`)) return;
    await fetch(`/api/discord/bots/${bot.id}`, { method: 'DELETE', credentials: 'same-origin' });
    refresh();
  };

  const restartBot = async (bot) => {
    setRestarting(p => ({ ...p, [bot.id]: true }));
    try {
      const res = await fetch(`/api/discord/bots/${bot.id}/restart`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error('restart failed', body);
        setErr('Restart failed: ' + body);
      }
    } catch (e) {
      console.error('restart failed', e);
      setErr('Restart failed: ' + (e.message || 'unknown error'));
    } finally {
      setRestarting(p => ({ ...p, [bot.id]: false }));
      refresh();
    }
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

  const addVoiceRoute = async (botId) => {
    const draft = newVoiceRoute[botId] || {};
    if (!draft.channel_id?.trim() || !draft.agent?.trim()) return;
    const r = await fetch(`/api/discord/bots/${botId}/routes`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    });
    if (r.ok) {
      setNewVoiceRoute(prev => ({ ...prev, [botId]: { channel_id: '', agent: '' } }));
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

  const toggleRouteAutoReply = async (routeId, current) => {
    await fetch(`/api/discord/routes/${routeId}`, {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auto_reply: !current }),
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

  const toggleSkills = async (botId) => {
    const nowOpen = !skillsOpen[botId];
    setSkillsOpen(s => ({ ...s, [botId]: nowOpen }));
    if (nowOpen && !botSkills[botId]) {
      setSkillsLoading(s => ({ ...s, [botId]: true }));
      try {
        const registered = await window.NC_API.get(`/api/discord/bots/${botId}/skills`);
        setBotSkills(s => ({ ...s, [botId]: new Set(registered) }));
      } catch {}
      setSkillsLoading(s => ({ ...s, [botId]: false }));
    }
  };

  const toggleBotSkill = async (botId, skillName, isRegistered) => {
    const method = isRegistered ? 'DELETE' : 'PUT';
    try {
      await fetch(`/api/discord/bots/${botId}/skills/${encodeURIComponent(skillName)}`, { method, credentials: 'same-origin' });
      setBotSkills(s => {
        const next = new Set(s[botId] || []);
        if (isRegistered) next.delete(skillName); else next.add(skillName);
        return { ...s, [botId]: next };
      });
    } catch (e) { console.error(e); }
  };

  const statusColor = (s) => ({
    ready:      'var(--accent-2)',
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
            Create a bot at <a href="https://discord.com/developers/applications" target="_blank" rel="noopener" style={{ color: 'var(--accent-2)' }}>discord.com/developers/applications</a>, then click "Add bot" above.<br/>
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
              <button className="nc-btn ghost" onClick={() => toggleSkills(bot.id)}>
                {skillsOpen[bot.id] ? 'Slash skills ▲' : 'Slash skills ▼'}
              </button>
              <button className="nc-btn ghost" style={{ fontSize: 10, color: logsOpen[bot.id] ? 'var(--accent-2)' : undefined }} onClick={() => setLogsOpen(p => ({ ...p, [bot.id]: !p[bot.id] }))}>
                {logsOpen[bot.id] ? 'Logs ▲' : 'Logs ▼'}
              </button>
              <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => toggleEnabled(bot)}>
                {bot.enabled ? 'Disable' : 'Enable'}
              </button>
              <span style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 2px' }}/>
              <button
                className="nc-btn ghost"
                style={{ fontSize: 10, color: restarting[bot.id] ? 'var(--amber)' : undefined }}
                disabled={!!restarting[bot.id] || !bot.enabled}
                title={!bot.enabled ? 'Enable the bot before restarting' : undefined}
                onClick={() => restartBot(bot)}
              >
                {restarting[bot.id] ? '↺ …' : '↺ Restart'}
              </button>
              <span style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 2px' }}/>
              <button className="nc-btn ghost" style={{ fontSize: 10, color: bot.voice_enabled ? 'var(--accent-2)' : undefined }}
                      title="Voice: when on, replies attach a synthesized .mp3 for any agent that has TTS enabled. Inbound voice notes are always transcribed."
                      onClick={() => toggleVoice(bot)}>
                🔊 {bot.voice_enabled ? 'Voice on' : 'Voice off'}
              </button>
              <button className="nc-btn ghost" style={{ fontSize: 10, color: bot.voice_channel_enabled ? 'var(--accent-2)' : undefined }}
                      title="Voice channels: when on, this bot listens and responds in routed voice channels."
                      onClick={() => toggleVoiceChannel(bot)}>
                🎙️ {bot.voice_channel_enabled ? 'VC on' : 'VC off'}
              </button>
              <button className="nc-btn ghost" style={{ fontSize: 10, color: 'var(--danger)' }} onClick={() => deleteBot(bot)}>×</button>
            </div>
          </div>

          {logsOpen[bot.id] && (
            <BotLogPanel botId={bot.id} botName={bot.name} />
          )}

          {skillsOpen[bot.id] && (
              <div style={{ marginTop: 10, padding: '10px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: 4 }}>
                <div className="label-tiny" style={{ marginBottom: 8 }}>SLASH SKILLS — toggled skills appear in Discord's / autocomplete (restart bot to apply)</div>
                {skillsLoading[bot.id] && <span className="muted" style={{ fontSize: 12 }}>Loading…</span>}
                {!skillsLoading[bot.id] && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                    {(window.NC_DATA.SKILLS || []).length === 0 && (
                      <span className="muted" style={{ fontSize: 12 }}>No skills available. Add .claude/skills/ files first.</span>
                    )}
                    {(window.NC_DATA.SKILLS || []).map(s => {
                      const on = (botSkills[bot.id] || new Set()).has(s.name);
                      return (
                        <button key={s.name}
                          className={`nc-btn ${on ? '' : 'ghost'}`}
                          style={{ fontSize: 11, padding: '3px 8px' }}
                          title={s.description || s.name}
                          onClick={() => toggleBotSkill(bot.id, s.name, on)}>
                          {on ? '✓ ' : ''}/{s.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

          {expanded[bot.id] && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div className="label-tiny">AUTO-REPLY SERVERS <span className="muted" style={{ fontSize: 10 }}>(no @mention required)</span></div>
                <a href="#" onClick={e => { e.preventDefault(); loadGuilds(bot.id); }} style={{ color: 'var(--accent-2)', fontSize: 10 }}>↻ load servers</a>
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
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }} title="Bot replies to all messages in this channel without an @mention, regardless of guild auto-reply settings.">
                    <input type="checkbox" checked={!!r.auto_reply} onChange={() => toggleRouteAutoReply(r.id, !!r.auto_reply)} style={{ width: 'auto' }}/>
                    <span className="muted">auto-reply</span>
                  </label>
                  {!!r.auto_reply && !!r.require_mention && (
                    <span style={{ fontSize: 9, color: 'var(--warning, #f59e0b)' }} title="auto-reply overrides mention-only — bot will respond without @mention">⚠ conflict</span>
                  )}
                  <button className="nc-btn ghost" style={{ fontSize: 10, color: 'var(--danger)' }} onClick={() => deleteRoute(r.id)}>×</button>
                </div>
              ))}
              <div className="mono muted" style={{ fontSize: 10, marginBottom: 6 }}>// enable Developer Mode in Discord, then right-click any text channel → Copy Channel ID</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <input className="nc-input" style={{ flex: 1, fontSize: 11, width: 'auto' }} placeholder="text channel id" value={newRoute[bot.id]?.channel_id || ''} onChange={e => setNewRoute(p => ({ ...p, [bot.id]: { ...(p[bot.id] || {}), channel_id: e.target.value } }))}/>
                <select className="nc-select" style={{ fontSize: 11, width: 'auto', minWidth: 130 }} value={newRoute[bot.id]?.agent || ''} onChange={e => setNewRoute(p => ({ ...p, [bot.id]: { ...(p[bot.id] || {}), agent: e.target.value } }))}>
                  <option value="">(agent)</option>
                  {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <button className="nc-btn primary" style={{ fontSize: 11 }} onClick={() => addRoute(bot.id)}>+ Add</button>
              </div>

              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div className="label-tiny">VOICE CHANNEL ROUTES</div>
                  <span className={`tag ${bot.voice_channel_enabled ? 'cyan' : ''}`} style={{ fontSize: 9 }}>
                    {bot.voice_channel_enabled ? 'active' : 'disabled — toggle 🎙️ VC on above'}
                  </span>
                </div>
                <div className="mono muted" style={{ fontSize: 10, marginBottom: 6 }}>// right-click a voice channel in Discord → Copy Channel ID · bot must be in the server</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="nc-input" style={{ flex: 1, fontSize: 11, width: 'auto' }} placeholder="voice channel id" value={newVoiceRoute[bot.id]?.channel_id || ''} onChange={e => setNewVoiceRoute(p => ({ ...p, [bot.id]: { ...(p[bot.id] || {}), channel_id: e.target.value } }))}/>
                  <select className="nc-select" style={{ fontSize: 11, width: 'auto', minWidth: 130 }} value={newVoiceRoute[bot.id]?.agent || ''} onChange={e => setNewVoiceRoute(p => ({ ...p, [bot.id]: { ...(p[bot.id] || {}), agent: e.target.value } }))}>
                    <option value="">(agent)</option>
                    {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <button className="nc-btn primary" style={{ fontSize: 11 }} onClick={() => addVoiceRoute(bot.id)}>+ Add</button>
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

window.Channels = Channels;
