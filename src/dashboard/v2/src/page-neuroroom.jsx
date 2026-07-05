/* Neuro Room — shared group voice + chat with all agents */

// livekit-client is bundled into THIS chunk (not the entry bundle) so the heavy
// voice dep only loads when the Neuro Room page is opened (Dashboard v3 §3.4).
// Code below still reads the global `LivekitClient` (guarded), so we expose it.
import * as LivekitClient from 'livekit-client';
window.LivekitClient = LivekitClient;

const NeuroRoom = () => {
  const [liveAgents,      setLiveAgents]      = React.useState([]);
  const [targetAgentIds,  setTargetAgentIds]  = React.useState(['all']);
  const [messages,        setMessages]        = React.useState([]);
  const [draft,           setDraft]           = React.useState('');
  const [streaming,       setStreaming]        = React.useState(false);
  const [voiceMode,       setVoiceMode]        = React.useState('ptt');
  const [isRecording,     setIsRecording]     = React.useState(false);
  const [transcribing,    setTranscribing]    = React.useState(false);
  const [agentSpeaking,   setAgentSpeaking]   = React.useState(null);
  const [roomSessionId,   setRoomSessionId]   = React.useState(null);
  const [livekitEnabled,  setLivekitEnabled]  = React.useState(false);
  const [livekitConnected,setLivekitConnected]= React.useState(false);
  const [error,           setError]           = React.useState(null);

  const scrollRef       = React.useRef(null);
  const recorderRef     = React.useRef(null);
  const recordChunksRef = React.useRef([]);
  const roomRef         = React.useRef(null);
  const audioRef        = React.useRef(null);
  const vadTimerRef     = React.useRef(null);
  const analyserRef     = React.useRef(null);
  const isRecordingRef  = React.useRef(false);
  const audioUrlRef     = React.useRef(null);

  // ── Init ──────────────────────────────────────────────────────────────────
  React.useEffect(() => {
    fetchStatus();
    return () => {
      roomRef.current?.disconnect?.();
      if (vadTimerRef.current) clearInterval(vadTimerRef.current);
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
        recorderRef.current.stream?.getTracks().forEach(t => t.stop());
      }
      analyserRef.current?.context?.close();
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      if (audioUrlRef.current) { URL.revokeObjectURL(audioUrlRef.current); audioUrlRef.current = null; }
    };
  }, []);

  // Refresh agent list whenever NC_DATA updates
  React.useEffect(() => {
    const handler = () => {
      const all = window.NC_DATA?.AGENTS || [];
      setLiveAgents(all.filter(a => a.status === 'live' || a.status === 'busy'));
    };
    handler();
    window.addEventListener('nc-data-tick', handler);
    return () => window.removeEventListener('nc-data-tick', handler);
  }, []);

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // ── PTT space key ─────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (voiceMode !== 'ptt') return;
    const down = (e) => {
      if (e.code !== 'Space' || e.target !== document.body || isRecordingRef.current) return;
      e.preventDefault();
      startRecording();
    };
    const up = (e) => {
      if (e.code !== 'Space' || !isRecordingRef.current) return;
      e.preventDefault();
      stopRecording();
    };
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    return () => { document.removeEventListener('keydown', down); document.removeEventListener('keyup', up); };
  }, [voiceMode]);

  // ── Fetch room status ─────────────────────────────────────────────────────
  const fetchStatus = async () => {
    try {
      const r = await fetch('/api/room/status', { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      setRoomSessionId(data.sessionId);
      setLivekitEnabled(!!data.livekitEnabled);
      if (data.livekitEnabled) connectLiveKit(data.livekitUrl);
    } catch { /* backend might not be ready */ }
  };

  // ── LiveKit connection ────────────────────────────────────────────────────
  const connectLiveKit = async (livekitUrl) => {
    if (typeof LivekitClient === 'undefined') return;
    try {
      const sessionId = Math.random().toString(36).slice(2, 8);
      const tr = await fetch(`/api/room/token?identity=dashboard-user-${sessionId}`, { credentials: 'same-origin' });
      if (!tr.ok) return;
      const { token, url } = await tr.json();
      const { Room, RoomEvent, ConnectionState } = LivekitClient;
      const room = new Room();
      roomRef.current = room;
      room.on(RoomEvent.ConnectionStateChanged, (s) =>
        setLivekitConnected(s === ConnectionState.Connected),
      );
      await room.connect(url || livekitUrl, token);
    } catch (err) {
      console.warn('NeuroRoom: LiveKit connect failed', err.message);
    }
  };

  // ── Recording ─────────────────────────────────────────────────────────────
  const startRecording = async () => {
    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec      = new MediaRecorder(stream);
      recorderRef.current    = rec;
      recordChunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data); };
      rec.start();
      setIsRecording(true);
      isRecordingRef.current = true;
      setError(null);

      // VAD: watch mic level; auto-stop after 800 ms of silence
      if (voiceMode === 'vad') {
        const ctx      = new AudioContext();
        const source   = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        analyserRef.current = analyser;
        const buf = new Uint8Array(analyser.frequencyBinCount);
        let silenceMs = 0;
        vadTimerRef.current = setInterval(() => {
          analyser.getByteFrequencyData(buf);
          const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
          if (avg < 10) {
            silenceMs += 100;
            if (silenceMs >= 800) { clearInterval(vadTimerRef.current); stopRecording(); }
          } else {
            silenceMs = 0;
          }
        }, 100);
      }
    } catch (err) {
      setError('mic: ' + err.message);
    }
  };

  const stopRecording = () => {
    if (vadTimerRef.current) { clearInterval(vadTimerRef.current); vadTimerRef.current = null; }
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') return;
    rec.onstop = async () => {
      const blob = new Blob(recordChunksRef.current, { type: 'audio/webm' });
      rec.stream.getTracks().forEach(t => t.stop());
      if (blob.size < 500) return;
      setTranscribing(true);
      try {
        const fd = new FormData();
        fd.append('file', blob, 'voice.webm');
        const r = await fetch('/api/audio/transcribe', { method: 'POST', credentials: 'same-origin', body: fd });
        if (r.ok) {
          const { text } = await r.json();
          if (text?.trim()) await sendMessage(text.trim(), true);
        }
      } catch (err) { setError('transcribe: ' + err.message); }
      finally { setTranscribing(false); }
    };
    rec.stop();
    setIsRecording(false);
    isRecordingRef.current = false;
  };

  // ── Send message ─────────────────────────────────────────────────────────
  const sendMessage = async (text, isVoice = false) => {
    const msg = text.trim();
    if (!msg) return;
    if (streaming) { setError('busy — please wait for the current response'); return; }

    const userMsgId = `u-${Date.now()}`;
    setMessages(prev => [...prev, {
      id: userMsgId, role: 'user', content: msg,
      timestamp: new Date().toISOString(), isVoice,
      targetAgentIds: [...targetAgentIds],
    }]);
    setDraft('');
    setStreaming(true);
    setError(null);

    try {
      const r = await fetch('/api/room/chat', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: msg, targetAgentIds, roomSessionId }),
      });
      if (!r.ok || !r.body) { setError(`room/chat: ${r.status}`); setStreaming(false); return; }

      const reader  = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      // Track { id, content } per agentId so we can pass content directly to TTS
      // without reading state (setState is async — reading via callback is unreliable).
      const agentMsgIds = {}; // { [agentId]: { id: string, content: string } }

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n\n')) !== -1) {
          const ev = buf.slice(0, nl); buf = buf.slice(nl + 2);
          const dl = ev.split('\n').find(l => l.startsWith('data: '));
          if (!dl) continue;
          const raw = dl.slice(6);
          if (raw === '[DONE]') break outer;
          try {
            const e = JSON.parse(raw);
            if (e.type === 'agent_start') {
              const mid = `a-${e.agentId}-${Date.now()}`;
              agentMsgIds[e.agentId] = { id: mid, content: '' };
              setMessages(prev => [...prev, {
                id: mid, role: 'agent', agentId: e.agentId, agentName: e.agentName,
                content: '', mentionedBy: e.mentionedBy || null,
                streaming: true, timestamp: new Date().toISOString(),
              }]);
            } else if (e.type === 'chunk') {
              const entry = agentMsgIds[e.agentId];
              if (entry) {
                entry.content += e.content;
                setMessages(prev => prev.map(m => m.id === entry.id ? { ...m, content: m.content + e.content } : m));
              }
            } else if (e.type === 'agent_done') {
              const entry = agentMsgIds[e.agentId];
              if (entry) {
                setMessages(prev => prev.map(m => m.id === entry.id ? { ...m, streaming: false } : m));
                playSpeakForAgent(e.agentId, entry.content);
              }
            } else if (e.type === 'error') {
              const entry = agentMsgIds[e.agentId];
              if (entry) setMessages(prev => prev.map(m => m.id === entry.id ? { ...m, streaming: false, error: e.error } : m));
            } else if (e.type === 'room_done') {
              break outer;
            }
          } catch { /* skip malformed event */ }
        }
      }
    } catch (err) {
      setError('send: ' + err.message);
    } finally {
      setStreaming(false);
    }
  };

  // TTS playback — content is passed directly from the SSE loop (not read from state)
  const playSpeakForAgent = async (agentId, content) => {
    try {
      if (!content) return;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
      setAgentSpeaking(agentId);
      const r = await fetch('/api/audio/speak', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: content, agentId }),
      });
      if (!r.ok) { setAgentSpeaking(null); return; }
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); audioUrlRef.current = null; setAgentSpeaking(null); };
      audio.onerror = () => { URL.revokeObjectURL(url); audioUrlRef.current = null; setAgentSpeaking(null); };
      await audio.play();
    } catch { setAgentSpeaking(null); }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const agentColor = (agentId) => {
    const a = liveAgents.find(x => x.id === agentId);
    if (!a) return 'var(--muted)';
    const map = { orchestrator: '#00ff88', specialist: '#4da8ff', assistant: '#a855f7', agent: '#ff9966' };
    return map[a.role] || 'var(--muted)';
  };

  const agentAvatar = (agentId) => liveAgents.find(x => x.id === agentId)?._raw?.avatar_url || null;

  const isSelected = (id) => id === 'all'
    ? targetAgentIds.includes('all')
    : targetAgentIds.includes(id) && !targetAgentIds.includes('all');

  const selectAgent = (id) => setTargetAgentIds(id === 'all' ? ['all'] : [id]);

  const targetLabel = () => {
    if (targetAgentIds.includes('all')) return 'All Agents';
    const a = liveAgents.find(x => x.id === targetAgentIds[0]);
    return a?.name || targetAgentIds[0] || 'Unknown';
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', height:'100%', flexDirection:'column', background:'var(--bg)', overflow:'hidden' }}>
      <div style={{ flex:1, display:'flex', minHeight:0 }}>

        {/* LEFT: Agent panel */}
        <div style={{ width:164, flexShrink:0, background:'rgba(6,14,28,0.9)', borderRight:'1px solid var(--line)', display:'flex', flexDirection:'column' }}>
          <div style={{ padding:'12px 14px 10px', borderBottom:'1px solid var(--line-soft)' }}>
            <div className="label-tiny" style={{ color:'var(--accent)', letterSpacing:'2px' }}>NEURO ROOM</div>
            <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:5 }}>
              {livekitConnected
                ? <><span className="dot green" style={{width:6,height:6}}/><span style={{color:'var(--green)',fontSize:9}}>LIVE</span></>
                : livekitEnabled
                  ? <><span className="dot amber" style={{width:6,height:6}}/><span style={{color:'var(--amber)',fontSize:9}}>CONNECTING</span></>
                  : <><span className="dot muted" style={{width:6,height:6}}/><span style={{color:'var(--muted)',fontSize:9}}>TEXT ONLY</span></>
              }
            </div>
          </div>

          <div style={{ flex:1, overflowY:'auto', padding:'8px' }}>
            <div className="label-tiny" style={{ padding:'4px', marginBottom:6 }}>AGENTS</div>

            {/* All */}
            <div onClick={() => selectAgent('all')} style={{
              background: isSelected('all') ? 'rgba(0,183,255,0.1)' : 'transparent',
              border: `1px solid ${isSelected('all') ? 'rgba(0,183,255,0.4)' : 'var(--line-soft)'}`,
              borderRadius:6, padding:'8px 10px', marginBottom:4, cursor:'pointer',
              display:'flex', alignItems:'center', gap:8,
            }}>
              <div style={{ width:24, height:24, background:'rgba(0,183,255,0.15)', border:'1px solid rgba(0,183,255,0.3)', borderRadius:6, display:'flex', alignItems:'center', justifyContent:'center', fontSize:13 }}>⬡</div>
              <div>
                <div style={{ color: isSelected('all') ? 'var(--accent)' : 'var(--fg)', fontSize:11, fontWeight:600 }}>All Agents</div>
                <div style={{ color:'var(--muted)', fontSize:9 }}>broadcast</div>
              </div>
            </div>

            {liveAgents.map(agent => {
              const color   = agentColor(agent.id);
              const speaking = agentSpeaking === agent.id;
              const avatarUrl = agent._raw?.avatar_url || null;
              return (
                <div key={agent.id} onClick={() => selectAgent(agent.id)} style={{
                  background: isSelected(agent.id) ? `${color}15` : 'transparent',
                  border: `1px solid ${isSelected(agent.id) ? `${color}44` : 'var(--line-soft)'}`,
                  borderRadius:6, padding:'8px 10px', marginBottom:4, cursor:'pointer',
                  display:'flex', alignItems:'center', gap:8,
                }}>
                  <div style={{ width:24, height:24, background:`${color}15`, border:`1px solid ${color}33`, borderRadius:6, display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, overflow:'hidden', flexShrink:0 }}>
                    {avatarUrl
                      ? <img src={avatarUrl} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                      : agent.name?.[0]?.toUpperCase() || '?'}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ color: isSelected(agent.id) ? color : 'var(--fg)', fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{agent.name}</div>
                    {speaking
                      ? <div style={{ display:'flex', gap:2, alignItems:'flex-end', height:10, marginTop:2 }}>
                          {[4,9,6,10,5].map((h,i) => <div key={i} style={{ width:2, height:h, background:color, borderRadius:1 }}/>)}
                        </div>
                      : <div style={{ color:'var(--muted)', fontSize:9 }}>{agent.role}</div>
                    }
                  </div>
                  <div style={{ width:5, height:5, background:['live','busy'].includes(agent.status) ? '#00ff88' : '#444', borderRadius:'50%', flexShrink:0 }}/>
                </div>
              );
            })}
          </div>

          <div style={{ padding:'8px 14px', borderTop:'1px solid var(--line-soft)' }}>
            <div className="label-tiny" style={{ marginBottom:4 }}>SESSION</div>
            <div className="mono" style={{ fontSize:9, color:'var(--muted)' }}>{messages.length} messages</div>
            <div className="mono" style={{ fontSize:9, color:'var(--muted)' }}>{liveAgents.length} agents</div>
          </div>
        </div>

        {/* CENTER: Transcript */}
        <div ref={scrollRef} style={{ flex:1, overflowY:'auto', padding:'16px 20px', display:'flex', flexDirection:'column', gap:10 }}>
          {messages.length === 0 && (
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:12 }}>
              <div style={{ fontSize:32, filter:'drop-shadow(0 0 10px rgba(0,183,255,0.5))' }}>⬡</div>
              <div style={{ color:'var(--accent)', fontFamily:'var(--display)', letterSpacing:'0.2em', fontSize:13 }}>NEURO ROOM</div>
              <div style={{ color:'var(--muted)', fontSize:12, textAlign:'center', maxWidth:280, lineHeight:1.6 }}>Select an agent or broadcast to All. Type or hold Space to speak.</div>
              {!livekitEnabled && (
                <div style={{ background:'rgba(255,170,0,0.08)', border:'1px solid rgba(255,170,0,0.3)', borderRadius:6, padding:'8px 14px', fontSize:11, color:'#ffaa00', textAlign:'center' }}>
                  Add LIVEKIT_* vars to .env to enable voice
                </div>
              )}
            </div>
          )}

          {messages.map(msg => {
            if (msg.role === 'user') return (
              <div key={msg.id} style={{ display:'flex', justifyContent:'flex-end' }}>
                <div style={{ maxWidth:'72%' }}>
                  <div style={{ background:'rgba(0,183,255,0.08)', border:'1px solid rgba(0,183,255,0.2)', borderRadius:'8px 2px 8px 8px', padding:'8px 12px' }}>
                    {msg.isVoice && <span style={{ fontSize:10, color:'var(--accent)', marginRight:6 }}>🎤</span>}
                    <span style={{ color:'var(--fg)', fontSize:13 }}>{msg.content}</span>
                  </div>
                  <div style={{ color:'var(--muted)', fontSize:9, textAlign:'right', marginTop:3 }}>
                    You → {msg.targetAgentIds?.includes('all') ? 'All' : liveAgents.find(a => a.id === msg.targetAgentIds?.[0])?.name || msg.targetAgentIds?.[0]}
                  </div>
                </div>
              </div>
            );

            const color = agentColor(msg.agentId);
            const msgAvatar = agentAvatar(msg.agentId);
            return (
              <div key={msg.id} style={{ display:'flex', gap:8 }}>
                <div style={{ width:22, height:22, background:`${color}15`, border:`1px solid ${color}33`, borderRadius:5, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, flexShrink:0, marginTop:2, color, overflow:'hidden' }}>
                  {msgAvatar
                    ? <img src={msgAvatar} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                    : msg.agentName?.[0]?.toUpperCase() || '?'}
                </div>
                <div style={{ maxWidth:'80%' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:3 }}>
                    <span style={{ color, fontSize:9 }}>{msg.agentName}</span>
                    {msg.mentionedBy && (
                      <span style={{ background:'rgba(168,85,247,0.12)', border:'1px solid rgba(168,85,247,0.3)', borderRadius:3, padding:'1px 5px', fontSize:8, color:'#a855f7' }}>
                        ↳ @{msg.mentionedBy}
                      </span>
                    )}
                  </div>
                  <div style={{ background:'rgba(8,18,32,0.8)', border:'1px solid var(--line-soft)', borderRadius:'2px 8px 8px 8px', padding:'8px 12px' }}>
                    <span style={{ color: msg.error ? 'var(--red)' : 'var(--fg)', fontSize:13, whiteSpace:'pre-wrap' }}>
                      {msg.error ? `⚠ ${msg.error}` : msg.content}
                    </span>
                    {msg.streaming && (
                      <span style={{ display:'inline-flex', gap:3, marginLeft:6, verticalAlign:'middle' }}>
                        {[1,2,3].map(i => <span key={i} style={{ width:4, height:4, background:color, borderRadius:'50%', opacity: 0.3 + i*0.2 }}/>)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* BOTTOM: Voice + text bar */}
      <div style={{ borderTop:'1px solid var(--line)', padding:'10px 16px', background:'rgba(5,13,26,0.97)', flexShrink:0 }}>
        {error && <div style={{ color:'var(--red)', fontSize:10, marginBottom:6 }}>⚠ {error}</div>}
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <button
            onClick={isRecording ? stopRecording : startRecording}
            style={{
              width:36, height:36, borderRadius:'50%', cursor:'pointer', border:'none',
              background: isRecording ? 'rgba(255,60,60,0.2)' : 'rgba(0,183,255,0.12)',
              outline: `1px solid ${isRecording ? 'rgba(255,60,60,0.5)' : 'rgba(0,183,255,0.35)'}`,
              color: isRecording ? '#ff4444' : 'var(--accent)',
              fontSize:15, flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center',
            }}>
            {transcribing ? '⏳' : isRecording ? '⏹' : '🎤'}
          </button>

          <div style={{ background:'var(--panel)', border:'1px solid var(--line)', borderRadius:20, display:'flex', overflow:'hidden', flexShrink:0 }}>
            {['ptt','vad'].map(m => (
              <button key={m} onClick={() => setVoiceMode(m)} style={{
                padding:'4px 10px', fontSize:9, cursor:'pointer', border:'none',
                background: voiceMode === m ? 'rgba(168,85,247,0.25)' : 'transparent',
                color: voiceMode === m ? '#d8a8ff' : 'var(--muted)',
                fontFamily:'var(--mono)', letterSpacing:'1px',
              }}>{m.toUpperCase()}</button>
            ))}
          </div>

          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(draft); } }}
            placeholder={`Type to ${targetLabel()}…`}
            disabled={streaming}
            style={{ flex:1, background:'var(--panel)', border:'1px solid var(--line)', borderRadius:6, padding:'7px 12px', color:'var(--fg)', fontFamily:'var(--mono)', fontSize:12, outline:'none' }}
          />

          <button
            onClick={() => sendMessage(draft)}
            disabled={!draft.trim() || streaming}
            style={{
              width:32, height:32, borderRadius:6, cursor: draft.trim() ? 'pointer' : 'default',
              border:`1px solid ${draft.trim() ? 'rgba(0,183,255,0.4)' : 'var(--line)'}`,
              background: draft.trim() ? 'rgba(0,183,255,0.15)' : 'rgba(0,183,255,0.04)',
              color: draft.trim() ? 'var(--accent)' : 'var(--muted)',
              fontSize:14, flexShrink:0,
            }}>↑</button>
        </div>

        <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:6 }}>
          <span style={{ color:'var(--muted)', fontSize:9 }}>Speaking to:</span>
          <span style={{ background:'rgba(0,183,255,0.08)', border:'1px solid rgba(0,183,255,0.25)', borderRadius:10, padding:'2px 8px', fontSize:9, color:'var(--accent)' }}>{targetLabel()}</span>
          <span style={{ color:'var(--muted)', fontSize:9, marginLeft:'auto' }}>
            {voiceMode === 'ptt' ? 'click mic or hold Space' : 'click mic or VAD'} · Enter = send
          </span>
        </div>
      </div>
    </div>
  );
};

window.NeuroRoom = NeuroRoom;
