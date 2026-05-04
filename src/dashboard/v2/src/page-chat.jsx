/* Chat page - command center (live-wired to /api/chat SSE) */

const Chat = () => {
  const { AGENTS, SESSIONS } = window.NC_DATA;
  const [activeSession, setActiveSession] = React.useState(SESSIONS[0]?.id || null);
  const [activeAgent,   setActiveAgent]   = React.useState(AGENTS[0]?.id  || null);
  const [draft, setDraft] = React.useState('');
  const [pendingImages, setPendingImages] = React.useState([]);   // [{name, dataUrl}]
  const fileInputRef = React.useRef(null);
  const [messages, setMessages] = React.useState([]);
  const [streaming, setStreaming] = React.useState(false);
  const [route, setRoute] = React.useState(null);
  const [tools, setTools] = React.useState([]);
  const [spawned, setSpawned] = React.useState([]);
  const [error, setError] = React.useState(null);
  const liveRef = React.useRef(null);
  const scrollRef = React.useRef(null);
  // Audio: mic-to-transcript and speaker playback. The MediaRecorder ref keeps
  // a handle to the in-flight recorder so the same button can stop it; chunks
  // accumulate until stop, then we POST the full Blob to /api/audio/transcribe.
  const [recording, setRecording] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);
  const [playingIdx, setPlayingIdx] = React.useState(null);  // index of message currently playing
  const recorderRef = React.useRef(null);
  const recordChunksRef = React.useRef([]);
  const audioRef = React.useRef(null);

  // ── Slash-command autocomplete (skills) ────────────────────────────────
  // Plain inline compute — recomputes on every render so a late-arriving
  // SKILLS list (live-data tick) updates the popup without keystrokes.
  const slashState = (() => {
    if (!draft.startsWith('/')) return { open: false, query: '', matches: [], firstWord: '' };
    const rest = draft.slice(1);
    const spaceIdx = rest.indexOf(' ');
    const firstWord = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    if (spaceIdx !== -1) return { open: false, query: firstWord, matches: [], firstWord };
    const all = window.NC_DATA.SKILLS || [];
    const q = firstWord.toLowerCase();
    const matches = all.filter(s => s.name.toLowerCase().startsWith(q)).slice(0, 8);
    return { open: matches.length > 0, query: firstWord, matches, firstWord };
  })();

  const acceptSlash = (name) => setDraft(`/${name} `);

  // Expand a `/skill-name [args]` message into the full prompt body so the
  // skill works for any provider (VoidAI / Claude CLI / Codex / OpenAI / …)
  // without requiring the agent to have it in its declared skills list.
  const expandSlashCommand = (text) => {
    if (!text.startsWith('/')) return text;
    const rest = text.slice(1);
    const spaceIdx = rest.indexOf(' ');
    const name = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();
    const skill = (window.NC_DATA.SKILLS || []).find(s => s.name === name);
    if (!skill || !skill.body) return text;   // unknown skill → leave as-is so user sees the literal
    const argsBlock = args ? `\n\n---\n\n${args}` : '';
    return `[Skill activated: /${skill.name}]\n${skill.body}${argsBlock}`;
  };

  // ── Voice input: MediaRecorder → /api/audio/transcribe → draft ──────────
  const startRecording = async () => {
    if (recording || transcribing) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('mic capture not supported in this browser');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Pick the most compatible mime; webm/opus is the default in Chromium.
      // Whisper handles both webm and ogg via the file extension hint we send.
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
                 : MediaRecorder.isTypeSupported('audio/webm')             ? 'audio/webm'
                 : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recordChunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordChunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(recordChunksRef.current, { type: rec.mimeType || 'audio/webm' });
        recordChunksRef.current = [];
        if (blob.size === 0) { setRecording(false); return; }
        setRecording(false);
        setTranscribing(true);
        try {
          const fd = new FormData();
          fd.append('file', blob, 'voice.webm');
          const r = await fetch('/api/audio/transcribe', { method: 'POST', credentials: 'same-origin', body: fd });
          if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 120)}`);
          const data = await r.json();
          const text = (data?.text || '').trim();
          if (text) setDraft(d => d ? `${d} ${text}` : text);
        } catch (err) {
          setError('transcribe: ' + err.message);
        } finally {
          setTranscribing(false);
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setError(null);
    } catch (err) {
      setError('mic: ' + err.message);
    }
  };
  const stopRecording = () => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  };
  const toggleRecording = () => recording ? stopRecording() : startRecording();

  // ── Speaker playback: POST /api/audio/speak → blob → <audio> ────────────
  const speakMessage = async (msg, idx) => {
    if (playingIdx === idx) {
      // Toggle off — stop current playback.
      audioRef.current?.pause();
      audioRef.current = null;
      setPlayingIdx(null);
      return;
    }
    audioRef.current?.pause();
    setPlayingIdx(idx);
    try {
      const agentId = (window.NC_DATA.AGENTS || []).find(a => a.name === msg.agent)?.id || activeAgent;
      const r = await fetch('/api/audio/speak', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: msg.body, agentId }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 120)}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); if (audioRef.current === audio) { audioRef.current = null; setPlayingIdx(null); } };
      audio.onerror  = () => { URL.revokeObjectURL(url); setPlayingIdx(null); setError('playback failed'); };
      await audio.play();
    } catch (err) {
      setPlayingIdx(null);
      setError('speak: ' + err.message);
    }
  };

  // Load session messages whenever the active session changes.
  React.useEffect(() => {
    if (!activeSession) { setMessages([]); return; }
    let cancelled = false;
    setError(null);
    window.NC_API.get('/api/sessions/' + activeSession + '/messages')
      .then(rows => {
        if (cancelled) return;
        const agentsById = Object.fromEntries((window.NC_DATA.AGENTS || []).map(a => [(a._raw?.id || a.id), a.name]));
        const mapped = (rows || []).map(r => {
          // Prefer the JOINed agent_name from the API; fall back to the live
          // AGENTS map; only fall back to the raw id when the agent has been
          // deleted. This stops "@<uuid>" from appearing on tab-switch reloads.
          const fallbackName = (r.agent_id && agentsById[r.agent_id]) || (r.agent_id ? r.agent_id.slice(0, 8) : 'agent');
          return {
            kind:  r.role === 'user' ? 'user' : r.role === 'assistant' ? 'agent' : 'event',
            who:   r.role === 'user' ? 'You' : (r.agent_name || fallbackName),
            agent: r.role === 'user' ? null : (r.agent_name || fallbackName),
            model: r.model || '',
            provider: '',
            mem:   0,
            t:     (r.created_at || '').slice(11, 19),
            body:  r.content || '',
            tone:  'cyan',
            text:  r.role === 'system' ? (r.content || '') : '',
          };
        });
        setMessages(mapped);
        setRoute(null); setTools([]); setSpawned([]);
      })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [activeSession]);

  // Auto-scroll to bottom on new messages.
  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, streaming]);

  // Convert a File to a data URL (base64 inline). VoidAI/OpenAI's vision
  // endpoint accepts data: URIs, so no temp upload service required.
  const fileToDataUrl = (f) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

  const onPickFiles = async (filesLike) => {
    const files = [...filesLike].filter(f => f.type.startsWith('image/'));
    if (files.length === 0) return;
    const items = await Promise.all(files.map(async (f) => ({
      name: f.name, dataUrl: await fileToDataUrl(f),
    })));
    setPendingImages(p => [...p, ...items]);
  };

  // Paste images directly into the input — works for screenshots and copied images.
  const onPaste = async (e) => {
    const items = [...(e.clipboardData?.items ?? [])].filter(i => i.type.startsWith('image/'));
    if (items.length === 0) return;
    e.preventDefault();
    const files = items.map(i => i.getAsFile()).filter(Boolean);
    onPickFiles(files);
  };

  // Send a message — POST to /api/chat, parse SSE manually with fetch+ReadableStream.
  const send = async () => {
    const text = draft.trim();
    if ((!text && pendingImages.length === 0) || streaming) return;
    const attachments = pendingImages.map(p => ({ url: p.dataUrl, name: p.name }));
    setDraft('');
    setPendingImages([]);
    setError(null);

    // Slash-command expansion: client-side prompt rewrite. The display bubble
    // keeps the user's literal `/foo bar` so the thread is readable, but the
    // payload sent to /api/chat carries the full skill body. Works regardless
    // of which provider the chosen agent ends up routing through.
    const sentText = text.startsWith('/') ? expandSlashCommand(text) : text;
    const slashSkill = (text.startsWith('/') && sentText !== text)
      ? text.slice(1).split(/\s+/)[0]
      : null;

    const userMsg = {
      kind: 'user', who: 'You',
      t: new Date().toTimeString().slice(0, 8),
      body: text || (attachments.length > 0 ? `[${attachments.length} image${attachments.length === 1 ? '' : 's'}]` : ''),
      attachments,
      slashSkill,
    };
    setMessages(m => [...m, userMsg]);
    setStreaming(true);

    // Reserve a "live" assistant bubble we'll append chunks to.
    const liveIdx = -1;  // placeholder
    let assistantBuffer = '';
    let assistantAgent = null;
    let assistantModel = '';
    setMessages(m => {
      const idx = m.length;
      liveRef.current = idx;
      return [...m, { kind: 'agent', agent: '...', model: '', provider: '', mem: 0, t: '...', body: '', streaming: true }];
    });

    const updateLive = () => {
      setMessages(m => m.map((msg, i) => i === liveRef.current ? {
        ...msg,
        agent: assistantAgent || msg.agent,
        model: assistantModel || msg.model,
        body:  assistantBuffer,
      } : msg));
    };
    const pushEvent = (tone, text) => {
      setMessages(m => [...m, { kind: 'event', tone, text }]);
    };

    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: sentText,
          sessionId: activeSession,
          agentId: activeAgent,
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
      });
      if (!r.body) throw new Error('no SSE stream');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        // SSE: each event is "data: {...}\n\n"
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line.slice(6)); } catch { continue; }
          if (evt.type === 'session') {
            if (!activeSession) setActiveSession(evt.sessionId);
          } else if (evt.type === 'agent') {
            assistantAgent = evt.name;
            updateLive();
          } else if (evt.type === 'route') {
            setRoute({ winner: evt.winner || evt.agentName, confidence: evt.confidence, reason: evt.reason });
            pushEvent('blue', `Routed to ${evt.winner || evt.agentName} · confidence ${(evt.confidence || 0).toFixed(2)}`);
          } else if (evt.type === 'chunk') {
            assistantBuffer += evt.content;
            updateLive();
          } else if (evt.type === 'spawn' || evt.type === 'spawn_started') {
            setSpawned(s => [...s, evt.agentName]);
            pushEvent('violet', `Temp agent spawned: ${evt.agentName}`);
          } else if (evt.type === 'spawn_chunk') {
            // Suppress per-token noise; could render in a side panel if needed.
          } else if (evt.type === 'spawn_done') {
            pushEvent('violet', `${evt.agentName} finished`);
          } else if (evt.type === 'spawn_eval') {
            pushEvent(evt.shouldSpawn ? 'violet' : 'amber', `Spawn ${evt.shouldSpawn ? 'approved' : 'denied'}: ${evt.task} — ${evt.reason}`);
          } else if (evt.type === 'plan') {
            pushEvent('cyan', `Decomposed into ${evt.steps?.length || 0} steps`);
          } else if (evt.type === 'step_start') {
            pushEvent('cyan', `Step ${evt.stepIndex + 1}: ${evt.agentName} · ${evt.task}`);
          } else if (evt.type === 'agent_message') {
            pushEvent('blue', `${evt.fromName} → ${evt.toName}: "${(evt.preview || '').slice(0, 80)}"`);
          } else if (evt.type === 'agent_task_assigned') {
            pushEvent('blue', `${evt.fromName} assigned T-${(evt.taskId || '').slice(0, 6)}: ${evt.title}`);
          } else if (evt.type === 'tool') {
            setTools(t => [...t, { name: evt.name, input: evt.input, ms: evt.ms, status: evt.status }]);
          } else if (evt.type === 'done') {
            // mark live message non-streaming
            setMessages(m => m.map((msg, i) => i === liveRef.current ? { ...msg, streaming: false } : msg));
          } else if (evt.type === 'error') {
            setError(evt.message);
            pushEvent('amber', 'Error: ' + evt.message);
          }
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setStreaming(false);
    }
  };

  const session = SESSIONS.find(s => s.id === activeSession) || (activeSession ? { id: activeSession, title: activeSession.slice(0, 8), msgs: messages.length, agents: [] } : null);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr 280px', gap: 12, height: 'calc(100vh - 56px - 32px - 32px)', minHeight: 580 }}>
      {/* Session list */}
      <div className="nc-panel glow" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="label-tiny neonc">SESSIONS</span>
          <button className="nc-btn ghost" onClick={() => setActiveSession(null)} style={{ padding: '4px 6px' }} title="New chat"><Icon name="plus" size={12}/></button>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {SESSIONS.map(s => (
            <div key={s.id} onClick={() => setActiveSession(s.id)} style={{
              padding: '10px 14px',
              borderLeft: `2px solid ${activeSession === s.id ? 'var(--neon)' : 'transparent'}`,
              background: activeSession === s.id ? 'rgba(0,183,255,0.08)' : 'transparent',
              borderBottom: '1px dashed rgba(0,183,255,0.06)',
              cursor: 'pointer',
            }}>
              <div className="mono" style={{ fontSize: 11, color: activeSession === s.id ? '#fff' : 'var(--text-soft)', display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                {s.active && <span className="dot cyan pulse"/>}
              </div>
              <div className="mono muted" style={{ fontSize: 10, marginTop: 2 }}>
                {s.last}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main thread */}
      <div className="nc-panel glow" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="mono" style={{ fontSize: 12, color: '#fff' }}>{session?.title || 'New chat'}</div>
            <div className="mono muted" style={{ fontSize: 10, marginTop: 2, display: 'flex', gap: 10 }}>
              <span>{messages.length} msgs</span>
              <span>·</span>
              <span style={{ color: streaming ? 'var(--amber)' : 'var(--neon-2)' }}>{streaming ? '● streaming' : '● live'}</span>
            </div>
          </div>
          <select className="nc-select" value={activeAgent || ''} onChange={e => setActiveAgent(e.target.value)} style={{ width: 160 }}>
            {AGENTS.map(a => <option key={a.id} value={a.id}>@{a.name}</option>)}
          </select>
        </div>

        <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
          {messages.length === 0 && (
            <div className="mono muted" style={{ textAlign: 'center', padding: '40px 20px', fontSize: 12 }}>
              {activeSession ? '// no messages yet — send one to start' : '// pick a session or send a message to start a new one'}
            </div>
          )}
          {messages.map((m, i) => {
            if (m.kind === 'event') {
              const toneCls = m.tone === 'blue' ? 'blue' : m.tone === 'violet' ? 'violet' : m.tone === 'amber' ? 'amber' : 'cyan';
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'center', margin: '14px 0' }}>
                  <div className={`tag ${toneCls}`} style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em' }}>
                    <span className="blink">▸</span> {m.text}
                  </div>
                </div>
              );
            }
            if (m.kind === 'user') {
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
                  <div style={{ maxWidth: '70%', padding: '10px 14px', background: 'linear-gradient(180deg, rgba(0,183,255,0.18), rgba(0,183,255,0.08))', border: '1px solid rgba(0,183,255,0.4)', borderRadius: '8px 8px 2px 8px' }}>
                    <div style={{ display: 'flex', gap: 8, fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--neon-2)', marginBottom: 4, alignItems: 'center' }}>
                      <span>@{m.who}</span><span className="muted">·</span><span className="muted">{m.t}</span>
                      {m.slashSkill && <span className="tag cyan" style={{ fontSize: 9, padding: '1px 5px' }}>/{m.slashSkill}</span>}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: '#fff', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{m.body}</div>
                  </div>
                </div>
              );
            }
            const isTemp = (m.agent || '').includes('-');
            return (
              <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                <div style={{ width: 32, height: 32, flex: 'none', borderRadius: 6, background: isTemp ? 'radial-gradient(circle, rgba(139,92,246,0.55), rgba(139,92,246,0.1))' : 'radial-gradient(circle, rgba(0,183,255,0.55), rgba(0,183,255,0.05))', border: `1px solid ${isTemp ? 'rgba(139,92,246,0.6)' : 'var(--line-hard)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700 }}>
                  {(m.agent || '?')[0].toUpperCase()}
                </div>
                <div style={{ maxWidth: '78%', padding: '10px 14px', background: 'linear-gradient(180deg, rgba(7,17,31,0.9), rgba(2,6,23,0.6))', border: '1px solid var(--line)', borderRadius: '8px 8px 8px 2px' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                    <span className="mono" style={{ color: isTemp ? 'var(--violet)' : 'var(--neon)', fontSize: 11 }}>@{m.agent}</span>
                    {m.model && <span className="tag muted" style={{ fontSize: 9, padding: '1px 5px' }}>{m.model}</span>}
                    <span className="mono muted" style={{ fontSize: 10, marginLeft: 'auto' }}>{m.t}</span>
                    {m.body && !m.streaming && (
                      <button className="nc-btn ghost" onClick={() => speakMessage(m, i)}
                              title={playingIdx === i ? 'Stop' : 'Speak this message'}
                              style={{ padding: '2px 6px', fontSize: 11 }}>
                        {playingIdx === i ? '■' : '🔊'}
                      </button>
                    )}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-soft)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                    {m.body}{m.streaming && <span className="blink neonc">▌</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Composer */}
        <div style={{ padding: 12, borderTop: '1px solid var(--line-soft)', background: 'rgba(0,8,20,0.6)' }}>
          {error && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 6 }}>// {error}</div>}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <span className="tag cyan">@{AGENTS.find(a => a.id === activeAgent)?.name || 'auto'}</span>
            <span className="tag muted">{streaming ? 'streaming' : 'idle'}</span>
            <span style={{ flex: 1 }}/>
          </div>
          {pendingImages.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {pendingImages.map((p, i) => (
                <div key={i} style={{ position: 'relative', display: 'inline-block' }}>
                  <img src={p.dataUrl} alt={p.name} style={{ height: 56, borderRadius: 4, border: '1px solid var(--line)' }}/>
                  <button onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))}
                          title={`Remove ${p.name}`}
                          style={{ position: 'absolute', top: -6, right: -6, background: 'var(--danger)', color: '#fff', border: 0, borderRadius: '50%', width: 18, height: 18, fontSize: 11, cursor: 'pointer' }}>×</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(2,6,23,0.85)', border: '1px solid var(--line)', borderRadius: 2, padding: '6px 10px' }}>
            <span className="neonc mono" style={{ fontSize: 14 }}>▸</span>
            <div style={{ flex: 1, position: 'relative' }}>
              {slashState.open && (
                <div className="nc-panel" style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, right: 0, padding: 4, maxHeight: 240, overflow: 'auto', boxShadow: '0 6px 20px rgba(0,0,0,0.5)', zIndex: 5 }}>
                  <div className="label-tiny" style={{ padding: '4px 8px', color: 'var(--neon)' }}>SKILLS · tab/enter to insert</div>
                  {slashState.matches.map((s, i) => (
                    <div key={s.name}
                         onMouseDown={e => { e.preventDefault(); acceptSlash(s.name); }}
                         className="mono"
                         style={{ padding: '6px 10px', fontSize: 11, cursor: 'pointer', borderRadius: 2, display: 'flex', justifyContent: 'space-between', gap: 12 }}
                         onMouseOver={e => e.currentTarget.style.background = 'rgba(0,183,255,0.10)'}
                         onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                      <span><span className="neonc">/{s.name}</span> {s.description && <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>— {s.description}</span>}</span>
                      <span className="muted" style={{ fontSize: 10 }}>{s.source}</span>
                    </div>
                  ))}
                </div>
              )}
              <input value={draft}
                     onChange={e => setDraft(e.target.value)}
                     onPaste={onPaste}
                     onKeyDown={e => {
                       // Accept top slash match on Tab (or Enter when popup open and exact-match isn't already typed).
                       if (slashState.open && (e.key === 'Tab' || (e.key === 'Enter' && slashState.matches[0]?.name !== slashState.firstWord))) {
                         e.preventDefault();
                         acceptSlash(slashState.matches[0].name);
                         return;
                       }
                       if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                     }}
                     placeholder={pendingImages.length > 0 ? `${pendingImages.length} image${pendingImages.length === 1 ? '' : 's'} attached — press Enter to send` : 'Send command — / for skills, @ for agents. Paste images for vision.'}
                     disabled={streaming}
                     style={{ width: '100%', background: 'transparent', border: 0, outline: 0, color: '#fff', fontFamily: 'var(--mono)', fontSize: 13, opacity: streaming ? 0.5 : 1 }}/>
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => onPickFiles(e.target.files)}/>
            <button className="nc-btn ghost" onClick={() => fileInputRef.current?.click()} disabled={streaming} title="Attach image" style={{ padding: '4px 8px', fontSize: 11 }}>📎</button>
            <button className="nc-btn ghost" onClick={toggleRecording} disabled={streaming || transcribing}
                    title={recording ? 'Stop recording' : transcribing ? 'Transcribing…' : 'Voice input'}
                    style={{ padding: '4px 8px', fontSize: 11, color: recording ? 'var(--danger)' : undefined }}>
              {recording ? '● REC' : transcribing ? '…' : '🎤'}
            </button>
            {streaming && <span className="blink neonc">▌</span>}
            <button className="nc-btn primary" onClick={send} disabled={streaming} style={{ marginLeft: 6, opacity: streaming ? 0.5 : 1 }}><Icon name="send" size={12}/> {streaming ? 'STREAMING' : 'SEND'}</button>
          </div>
        </div>
      </div>

      {/* Inspector */}
      <div className="nc-panel glow" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-soft)' }}>
          <div className="label-tiny neonc">INSPECTOR · ROUTE TRACE</div>
        </div>
        <div style={{ padding: 14, flex: 1, overflow: 'auto' }}>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.7 }}>
            <div style={{ color: 'var(--neon)' }}># last route</div>
            {route ? (
              <>
                <div>winner: <span className="neonc">{route.winner || '—'}</span></div>
                {typeof route.confidence === 'number' && <div>confidence: <span className="greenc">{route.confidence.toFixed(2)}</span></div>}
                {route.reason && <div>reason: <span className="amberc">{route.reason}</span></div>}
              </>
            ) : <div className="muted">— no route yet —</div>}
          </div>
          <hr className="nc-hr" style={{ margin: '14px 0' }}/>
          <div className="label-tiny" style={{ marginBottom: 8 }}>TOOL CALLS</div>
          {tools.length === 0 && <div className="mono muted" style={{ fontSize: 10 }}>// none in this turn</div>}
          {tools.map((t, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px dashed rgba(0,183,255,0.08)' }}>
              <div className="mono" style={{ fontSize: 11 }}>
                <div className="neonc">{t.name}</div>
                <div className="muted" style={{ fontSize: 10 }}>{(t.input || '').slice(0, 40)}</div>
              </div>
              <div className="mono" style={{ fontSize: 10, textAlign: 'right' }}>
                <div className={t.status === 'ok' ? 'greenc' : 'amberc'}>{t.status || 'ok'}</div>
                <div className="muted">{t.ms || 0}ms</div>
              </div>
            </div>
          ))}
          <hr className="nc-hr" style={{ margin: '14px 0' }}/>
          <div className="label-tiny" style={{ marginBottom: 8 }}>SPAWNED</div>
          {spawned.length === 0 && <div className="mono muted" style={{ fontSize: 10 }}>// none</div>}
          {spawned.map((s, i) => (
            <div key={i} className="mono violetc" style={{ fontSize: 11 }}>· {s}</div>
          ))}
        </div>
      </div>
    </div>
  );
};

window.Chat = Chat;
