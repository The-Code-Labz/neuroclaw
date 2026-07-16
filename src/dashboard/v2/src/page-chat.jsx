/* Chat page - command center (live-wired to /api/chat SSE) */

function agentFileIcon(mime = '') {
  if (mime === 'application/pdf') return '📕';
  if (mime.includes('spreadsheet') || mime.includes('excel')) return '📊';
  if (mime === 'application/zip') return '🗜️';
  if (
    mime.startsWith('text/') || mime === 'application/json' ||
    mime === 'application/yaml' || mime === 'application/xml'
  ) return '📄';
  return '📎';
}

function agentFileMimeLabel(mime = '') {
  const labels = {
    'application/pdf':   'PDF',
    'text/markdown':     'Markdown',
    'text/plain':        'Text',
    'text/csv':          'CSV',
    'application/json':  'JSON',
    'application/yaml':  'YAML',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':       'Excel',
    'application/zip':   'ZIP',
    'text/html':         'HTML',
  };
  return labels[mime] || (mime.split('/')[1] || 'File').toUpperCase();
}

function agentFileFormatBytes(bytes) {
  if (!bytes || bytes < 1024) return (bytes || 0) + ' B';
  if (bytes < 1024 * 1024)   return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Map raw /api/sessions/:id/messages rows into chat message objects.
function mapSessionRows(rows) {
  const agentsById = Object.fromEntries(
    (window.NC_DATA.AGENTS || []).map(a => [(a._raw?.id || a.id), a.name]));
  return (rows || []).map(r => {
    const fallbackName = (r.agent_id && agentsById[r.agent_id])
      || (r.agent_id ? r.agent_id.slice(0, 8) : 'agent');
    return {
      kind:  r.role === 'user' ? 'user' : r.role === 'assistant' ? 'agent' : 'event',
      who:   r.role === 'user' ? 'You' : (r.agent_name || fallbackName),
      agent: r.role === 'user' ? null : (r.agent_name || fallbackName),
      model: r.model || '',
      provider: '',
      mem:   0,
      t:     r.created_at
        ? new Date(r.created_at).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: true })
        : '',
      body:  r.content || '',
      tone:  'cyan',
      text:  r.role === 'system' ? (r.content || '') : '',
    };
  });
}

const Chat = () => {
  const { AGENTS, SESSIONS } = window.NC_DATA;
  // Don't auto-select SESSIONS[0] on mount — early renders can see stale/seed
  // data before live-data.jsx populates real UUIDs, which caused a cold-load
  // GET /api/sessions/<bad-id>/messages → 404. Let the user pick, or let the
  // first /api/chat send synthesize a new session id.
  // Exception: an explicit cross-page "open session" jump (nc-goto sets
  // NC_PENDING_SESSION to a real DB id) — honor it once and clear the flag.
  const [activeSession, setActiveSession] = React.useState(() => {
    const pending = window.NC_PENDING_SESSION;
    if (pending) { window.NC_PENDING_SESSION = null; return pending; }
    return null;
  });
  // Default to A.S.A.G.I; fall back to Alfred, then first agent.
  const [activeAgent, setActiveAgent] = React.useState(() => {
    const agents = window.NC_DATA.AGENTS || [];
    return (agents.find(a => a.name === 'A.S.A.G.I') || agents.find(a => a.name === 'Alfred') || agents[0])?.id || null;
  });
  // When a new session is created mid-stream (session SSE event), we must NOT
  // let the useEffect re-fetch messages — that would overwrite the live streaming
  // bubbles. Store the new session ID here; the effect checks and skips once.
  const skipSessionReloadRef = React.useRef(null);
  const [draft, setDraft] = React.useState('');
  const [pendingImages, setPendingImages] = React.useState([]);   // [{name, dataUrl}]
  const [pendingDocs, setPendingDocs] = React.useState([]);        // [{name, text|null}]
  const fileInputRef = React.useRef(null);
  const [messages, setMessages] = React.useState([]);
  const [builtinCmds, setBuiltinCmds] = React.useState([]);
  const [streaming, setStreaming] = React.useState(false);
  const [route, setRoute] = React.useState(null);
  const [tools, setTools] = React.useState([]);
  const [spawned, setSpawned] = React.useState([]);
  const [error, setError] = React.useState(null);
  // This session's chat-mode override: null = inherit the agent default,
  // true = force plain (no tools/skills/MCP), false = force full agent mode.
  // Loaded from the session row on switch; an explicit true/false is what the
  // pill always sends, so toggling OFF actually clears a plain session.
  const [chatModeOverride, setChatModeOverride] = React.useState(null);
  const liveRef = React.useRef(null);
  const abortRef = React.useRef(null);
  // Set by the ⏏ BG button just before aborting the fetch: distinguishes a
  // deliberate "continue in background" detach from a hard ■ STOP, so the
  // AbortError handler re-attaches via resume instead of freezing the bubble.
  const detachRequestedRef = React.useRef(false);
  const scrollRef = React.useRef(null);
  // Sticky-bottom behaviour: follow the stream while the user is parked at the
  // bottom, but bail out the moment they scroll up to read history so we don't
  // yank them back mid-read. Re-engages once they scroll back near the bottom.
  const stickToBottomRef = React.useRef(true);
  // Audio: mic-to-transcript and speaker playback. The MediaRecorder ref keeps
  // a handle to the in-flight recorder so the same button can stop it; chunks
  // accumulate until stop, then we POST the full Blob to /api/audio/transcribe.
  const [recording, setRecording] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);
  const [playingIdx, setPlayingIdx] = React.useState(null);  // index of message currently playing
  const recorderRef = React.useRef(null);
  const recordChunksRef = React.useRef([]);
  const audioRef = React.useRef(null);
  const textareaRef = React.useRef(null);

  // ── Slash-command autocomplete (skills) ────────────────────────────────
  // Plain inline compute — recomputes on every render so a late-arriving
  // SKILLS list (live-data tick) updates the popup without keystrokes.
  const slashState = (() => {
    if (!draft.startsWith('/')) return { open: false, query: '', cmdMatches: [], skillMatches: [], firstWord: '' };
    const rest = draft.slice(1);
    const spaceIdx = rest.indexOf(' ');
    const firstWord = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    if (spaceIdx !== -1) return { open: false, query: firstWord, cmdMatches: [], skillMatches: [], firstWord };
    const q = firstWord.toLowerCase();
    const cmdMatches = builtinCmds.filter(c => c.name.toLowerCase().startsWith(q));
    const skillMatches = (window.NC_DATA.SKILLS || []).filter(s => s.name.toLowerCase().startsWith(q)).slice(0, 8);
    return { open: cmdMatches.length > 0 || skillMatches.length > 0, query: firstWord, cmdMatches, skillMatches, firstWord };
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

  // Poll a background run and update the live bubble at bubbleIdx.
  // Returns a cleanup function. Manages its own cancelled flag and pollTimer.
  const startBackgroundPoll = (run, bubbleIdx, sessionId) => {
    let cancelled = false;
    let pollTimer = null;
    let delay = 3000;

    const poll = async () => {
      if (cancelled) return;
      let data;
      try {
        data = await window.NC_API.get('/api/runs/' + run.id);
      } catch {
        pollTimer = setTimeout(poll, 5000);
        return;
      }
      if (cancelled) return;
      const r = data && data.run;
      if (!r) return;
      if (['running', 'detached', 'paused'].includes(r.status)) {
        // Rebuild activityLog from hive_mind events
        const events = data.events || [];
        const pending = {};
        const newLog = [];
        for (const e of events) {
          let toolName = null;
          try { if (e.metadata) toolName = JSON.parse(e.metadata).tool; } catch {}
          if (e.action === 'tool_start' && toolName) {
            newLog.push({ label: toolName, done: false });
            (pending[toolName] = pending[toolName] || []).push(newLog.length - 1);
          } else if (e.action === 'tool_end' && toolName && pending[toolName]?.length) {
            newLog[pending[toolName].shift()].done = true;
          }
        }
        setMessages(m => m.map((msg, i) => i === bubbleIdx ? {
          ...msg,
          body: r.partial_output || msg.body,
          activity: r.current_activity || msg.activity,
          ...(newLog.length > 0 ? { activityLog: newLog } : {}),
        } : msg));
        delay = Math.min(delay + 1000, 10000);
        pollTimer = setTimeout(poll, delay);
      } else {
        // Terminal — reload canonical history.
        window.NC_API.get('/api/sessions/' + sessionId + '/messages')
          .then(rows2 => { if (!cancelled) setMessages(mapSessionRows(rows2)); })
          .catch(() => {});
      }
    };

    pollTimer = setTimeout(poll, delay);
    return () => { cancelled = true; if (pollTimer) clearTimeout(pollTimer); };
  };

  // Re-attach to a live run via the SSE resume endpoint. The server mirrors
  // chunks + terminal events onto its agent bus, so this streams tokens in
  // real time — startBackgroundPoll is kept as the fallback when resume
  // 404s or the stream dies before a terminal event. Returns a cleanup fn.
  const attachViaResume = (run, bubbleIdx, sessionId) => {
    const ctrl = new AbortController();
    let cancelled = false;
    let innerCleanup = null;
    let sawTerminal = false;

    const setBubble = (patch) => setMessages(m => m.map((msg, i) => i === bubbleIdx ? { ...msg, ...patch } : msg));
    const finishWithCanonical = () => {
      window.NC_API.get('/api/sessions/' + sessionId + '/messages')
        .then(rows2 => { if (!cancelled) setMessages(mapSessionRows(rows2)); })
        .catch(() => setBubble({ streaming: false, activity: null }));
    };

    (async () => {
      try {
        const rr = await fetch('/api/chat/resume/' + sessionId, { credentials: 'same-origin', signal: ctrl.signal });
        if (rr.status === 404 || !rr.ok || !rr.body) throw new Error('not resumable');
        const reader = rr.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let body = '';
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
            let evt;
            try { evt = JSON.parse(line.slice(6)); } catch { continue; }
            if (evt.type === 'replay') {
              body = evt.content; setBubble({ body });
            } else if (evt.type === 'chunk') {
              body += evt.content; setBubble({ body });
            } else if (evt.type === 'heartbeat') {
              const sec = Math.round((evt.elapsedMs || 0) / 1000);
              setBubble({ activity: `working… turn ${evt.turn || 0} · ${evt.currentActivity || 'thinking'} · ${sec}s` });
            } else if (evt.type === 'done' || evt.type === 'paused' || evt.type === 'error') {
              sawTerminal = true;
              finishWithCanonical();
            }
          }
        }
        if (!sawTerminal && !cancelled) throw new Error('resume stream ended early');
      } catch {
        if (!cancelled && !sawTerminal) {
          innerCleanup = startBackgroundPoll(run, bubbleIdx, sessionId);
        }
      }
    })();

    return () => {
      cancelled = true;
      try { ctrl.abort(); } catch { /* already closed */ }
      if (innerCleanup) innerCleanup();
    };
  };

  // Load built-in slash commands once on mount.
  React.useEffect(() => {
    window.NC_API.get('/api/commands').then(setBuiltinCmds).catch(() => {});
  }, []);

  // Load session messages whenever the active session changes; if the session
  // has a still-running (detached) generation, re-attach by polling the run.
  React.useEffect(() => {
    if (!activeSession) { setMessages([]); setChatModeOverride(null); return; }
    if (skipSessionReloadRef.current === activeSession) {
      skipSessionReloadRef.current = null;
      return;
    }
    let cancelled = false;
    setError(null);

    // Reflect the session's stored chat-mode so the 💬 pill shows the real state.
    window.NC_API.get('/api/sessions/' + activeSession)
      .then(s => { if (!cancelled) setChatModeOverride(s && s.chat_mode != null ? s.chat_mode === 1 : null); })
      .catch(() => {});

    window.NC_API.get('/api/sessions/' + activeSession + '/messages')
      .then(rows => {
        if (cancelled) return;
        setMessages(mapSessionRows(rows));
        setRoute(null); setTools([]); setSpawned([]);
        const lastAssistantRow = [...(rows || [])].reverse().find(r => r.role === 'assistant');
        if (lastAssistantRow?.agent_id) setActiveAgent(lastAssistantRow.agent_id);
        // Is there a background run still going for this session?
        return window.NC_API.get('/api/runs?session=' + activeSession + '&limit=1');
      })
      .then(runs => {
        if (cancelled || !runs) return;
        const run = (runs || [])[0];
        if (!run || !['running', 'detached', 'paused'].includes(run.status)) return;

        // Re-attach: append a live "still working" bubble and poll the run.
        let bubbleIdx = -1;
        setMessages(m => {
          bubbleIdx = m.length;
          return [...m, {
            kind: 'agent', agent: run.agent_name || 'agent', model: '', provider: '', mem: 0,
            t: new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: true }),
            body: run.partial_output || '', streaming: true,
            activity: run.current_activity || 'working in the background',
            activityLog: [{ label: 'reconnecting to background run…', done: false }],
          }];
        });

        const pollCleanup = attachViaResume(run, bubbleIdx, activeSession);
        return pollCleanup;
      })
      .then(pollCleanup => {
        if (cancelled && pollCleanup) pollCleanup();
      })
      .catch(err => { if (!cancelled) setError(err.message); });

    return () => { cancelled = true; };
  }, [activeSession]);

  // Auto-scroll to bottom while the user is sticky at the bottom. Keyed on
  // `messages` (not just length) so streamed token updates — which mutate the
  // live bubble's body in-place without growing the array — also re-pin. Prior
  // version only fired on length/streaming changes, so a long streaming reply
  // would grow past the viewport and the view appeared to "stop" scrolling.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // Track whether the user is parked at the bottom. We tolerate a small slack
  // (40px) so a tiny scroll wiggle from the browser doesn't disable follow.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distanceFromBottom < 40;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-resize textarea as draft content grows.
  React.useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  }, [draft]);

  // Convert a File to a data URL (base64 inline). VoidAI/OpenAI's vision
  // endpoint accepts data: URIs, so no temp upload service required.
  const fileToDataUrl = (f) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

  const MAX_TEXT_SIZE = 100 * 1024;
  // Plain-text formats — inlined into the message body as fenced blocks. Note:
  // .html is intentionally NOT in this list anymore; HTML now flows through
  // the document attachment path so MCP parsers like docuflow can structure
  // it, instead of being shoved into the prompt verbatim.
  const TEXT_EXTS_CHAT = ['.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml', '.py', '.js', '.ts', '.css', '.sh', '.sql'];
  // Binary / structured documents — sent to the backend as base64 and held in
  // the per-session attachment registry. Agents retrieve them via the
  // `get_attachment` tool and forward to docuflow (or any other parser MCP).
  const DOC_EXTS_CHAT = ['.pdf', '.docx', '.epub', '.html', '.htm', '.xhtml'];
  // Hard cap on attachment size (decoded). Mirrors backend MAX_BYTES_PER_SES
  // so the user gets immediate feedback instead of a server-side rejection.
  const MAX_DOC_BYTES = 50 * 1024 * 1024;

  const fileToText = (f) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      let t = r.result;
      if (t.length > MAX_TEXT_SIZE) t = t.slice(0, MAX_TEXT_SIZE) + '\n[truncated — file exceeds 100 KB]';
      resolve(t);
    };
    r.onerror = () => reject(r.error);
    r.readAsText(f);
  });

  // Read a File as raw base64 (no data: prefix). Used for the document
  // attachment path so the backend can register bytes verbatim.
  const fileToBase64 = (f) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result || '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

  const isTextFile  = (f) => TEXT_EXTS_CHAT.some(ext => f.name.toLowerCase().endsWith(ext));
  const isBinaryDoc = (f) => DOC_EXTS_CHAT.some(ext => f.name.toLowerCase().endsWith(ext));

  const onPickFiles = async (filesLike) => {
    for (const f of [...filesLike]) {
      if (f.type.startsWith('image/')) {
        const dataUrl = await fileToDataUrl(f);
        setPendingImages(p => [...p, { name: f.name, dataUrl }]);
      } else if (isBinaryDoc(f)) {
        // Order matters: check binary-doc before text. We want .html to flow
        // through the parser path, not be inlined as raw markup.
        if (f.size > MAX_DOC_BYTES) {
          setMessages(m => [...m, { kind: 'event', tone: 'err', text: `// ${f.name} exceeds ${Math.round(MAX_DOC_BYTES / 1024 / 1024)} MB limit` }]);
          continue;
        }
        try {
          const base64 = await fileToBase64(f);
          setPendingDocs(p => [...p, { name: f.name, base64, mime: f.type || null, size: f.size, kind: 'binary' }]);
        } catch (err) {
          setMessages(m => [...m, { kind: 'event', tone: 'err', text: `// failed to read ${f.name}: ${err.message || err}` }]);
        }
      } else if (isTextFile(f)) {
        // Small text files inline into the prompt as a fenced block. Files over
        // the inline cap would be silently truncated (lossy) — instead route
        // them through the attachment registry like binary docs, so the agent
        // reads the whole thing via get_attachment. text/plain is an accepted
        // attachment mime, so nothing is lost.
        if (f.size > MAX_TEXT_SIZE) {
          if (f.size > MAX_DOC_BYTES) {
            setMessages(m => [...m, { kind: 'event', tone: 'err', text: `// ${f.name} exceeds ${Math.round(MAX_DOC_BYTES / 1024 / 1024)} MB limit` }]);
            continue;
          }
          try {
            const base64 = await fileToBase64(f);
            setPendingDocs(p => [...p, { name: f.name, base64, mime: f.type || 'text/plain', size: f.size, kind: 'binary' }]);
            setMessages(m => [...m, { kind: 'event', tone: 'warn', text: `// ${f.name} (${Math.round(f.size / 1024)} KB) too large to inline — attached as a file; the agent will read it via get_attachment` }]);
          } catch (err) {
            setMessages(m => [...m, { kind: 'event', tone: 'err', text: `// failed to read ${f.name}: ${err.message || err}` }]);
          }
        } else {
          const text = await fileToText(f);
          setPendingDocs(p => [...p, { name: f.name, text, kind: 'text' }]);
        }
      } else {
        // Any other type (audio, video, zip, …): send as a generic binary upload.
        // The server persists every documents[] entry into the session uploads
        // store; non-document MIME types skip docuflow parsing but stay openable
        // by the agent via get_upload.
        if (f.size > MAX_DOC_BYTES) {
          setMessages(m => [...m, { kind: 'event', tone: 'err', text: `// ${f.name} exceeds ${Math.round(MAX_DOC_BYTES / 1024 / 1024)} MB limit` }]);
          continue;
        }
        try {
          const base64 = await fileToBase64(f);
          setPendingDocs(p => [...p, { name: f.name, base64, mime: f.type || null, size: f.size, kind: 'binary' }]);
        } catch (err) {
          setMessages(m => [...m, { kind: 'event', tone: 'err', text: `// failed to read ${f.name}: ${err.message || err}` }]);
        }
      }
    }
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

    if (text === '/stop') {
      if (activeSession) {
        fetch('/api/chat/stop', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: activeSession }),
        }).catch(() => {});
        abortRef.current?.abort();
      }
      setDraft('');
      return;
    }

    if (text.startsWith('/agent')) {
      const name = text.slice(6).trim();
      if (!name) {
        setMessages(m => [...m, { kind: 'event', tone: 'warn', text: '// usage: /agent [name]' }]);
        setDraft('');
        return;
      }
      const found = (window.NC_DATA.AGENTS || []).find(a => a.name.toLowerCase() === name.toLowerCase());
      if (!found) {
        setMessages(m => [...m, { kind: 'event', tone: 'err', text: `// no agent named '${name}'` }]);
        setDraft('');
        return;
      }
      setActiveAgent(found.id);
      setMessages(m => [...m, { kind: 'event', tone: 'ok', text: `// switched to ${found.name}` }]);
      setDraft('');
      return;
    }

    if ((!text && pendingImages.length === 0 && pendingDocs.length === 0) || streaming) return;
    const attachments = pendingImages.map(p => ({ url: p.dataUrl, name: p.name }));

    // Split pending docs:
    //   text-mode  → inline as fenced blocks in the message (cheap, fits well
    //                in the prompt for source files / notes).
    //   binary-mode → send as base64 in the `documents[]` field; backend
    //                registers them in the per-session attachment registry
    //                and tells the agent how to retrieve them via the
    //                `get_attachment` tool. The bytes never enter the user
    //                message — they reach MCP parsers (docuflow, etc.) on
    //                demand.
    let docPrefix = '';
    const documents = [];
    for (const d of pendingDocs) {
      if (d.kind === 'text' && d.text != null) {
        docPrefix += `[file: ${d.name}]\n\`\`\`\n${d.text}\n\`\`\`\n\n`;
      } else if (d.kind === 'binary' && d.base64) {
        documents.push({ name: d.name, data: d.base64, mime_type: d.mime || undefined });
      }
    }

    setDraft('');
    setPendingImages([]);
    setPendingDocs([]);
    setError(null);

    const fullText = docPrefix + (text || '');
    const sentText = fullText.startsWith('/') ? expandSlashCommand(fullText) : fullText;
    const slashSkill = (text.startsWith('/') && sentText !== text)
      ? text.slice(1).split(/\s+/)[0]
      : null;

    const userMsg = {
      kind: 'user', who: 'You',
      t: new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: true }),
      body: text || (attachments.length > 0
        ? `[${attachments.length} image${attachments.length === 1 ? '' : 's'}]`
        : documents.length > 0
          ? `[${documents.length} document${documents.length === 1 ? '' : 's'} attached]`
          : pendingDocs.length > 0
            ? '[file attached]'
            : ''),
      attachments,
      docs: pendingDocs.map(d => d.name),
      slashSkill,
    };
    setMessages(m => [...m, userMsg]);
    setStreaming(true);
    detachRequestedRef.current = false;  // fresh turn — clear any stale ⏏ BG intent

    // Reserve a "live" assistant bubble we'll append chunks to.
    const liveIdx = -1;  // placeholder
    let assistantBuffer = '';
    let assistantAgent = null;
    let assistantModel = '';
    setMessages(m => {
      const idx = m.length;
      liveRef.current = idx;
      return [...m, { kind: 'agent', agent: '...', model: '', provider: '', mem: 0, t: '...', body: '', streaming: true, activityLog: [{ label: 'connecting', done: false }] }];
    });

    const updateLive = () => {
      setMessages(m => m.map((msg, i) => i === liveRef.current ? {
        ...msg,
        agent: assistantAgent || msg.agent,
        model: assistantModel || msg.model,
        body:  assistantBuffer,
      } : msg));
    };
    const pushLog = (label, asDone = false) => {
      setMessages(m => m.map((msg, i) => i === liveRef.current ? {
        ...msg,
        activityLog: [
          ...(msg.activityLog || []).map(e => ({ ...e, done: true })),
          { label, done: asDone },
        ],
      } : msg));
    };
    const pushEvent = (tone, text) => {
      setMessages(m => [...m, { kind: 'event', tone, text }]);
    };

    // v3.2: per-stream state captured so resume() can pick up where we left off.
    let currentSessionId = activeSession;
    let currentRunId = null;
    let terminal = false;        // set by done/error/paused — suppresses auto-resume
    let activityLine = null;      // last 'thinking' / 'tool: …' label for status line

    // SSE event dispatch — shared between the initial POST and any resume GET.
    // Returns 'done' when a terminal event was seen, 'gone' when the stream
    // closed without a terminal event (candidate for resume).
    const handleEvent = (evt) => {
      if (evt.type === 'session') {
        currentSessionId = evt.sessionId;
        if (!activeSession) {
          // Tell the useEffect to skip the DB reload — streaming bubbles
          // are already in state and must not be overwritten mid-stream.
          skipSessionReloadRef.current = evt.sessionId;
          setActiveSession(evt.sessionId);
        }
      } else if (evt.type === 'run') {
        // v3.2: route emits the runId up-front so resume can target the
        // exact row even if a later turn starts.
        currentRunId = evt.runId;
      } else if (evt.type === 'agent') {
        assistantAgent = evt.name;
        updateLive();
        pushLog('processing');
      } else if (evt.type === 'route') {
        setRoute({ winner: evt.winner || evt.agentName, confidence: evt.confidence, reason: evt.reason });
        pushEvent('blue', `Routed to ${evt.winner || evt.agentName} · confidence ${(evt.confidence || 0).toFixed(2)}`);
        pushLog('routed → @' + (evt.winner || evt.agentName), true);
      } else if (evt.type === 'chunk') {
        assistantBuffer += evt.content;
        updateLive();
      } else if (evt.type === 'replay') {
        // v3.2: resume payload — full partial_output from the DB. REPLACE the
        // buffer (not append) — the primary stream may have already populated
        // assistantBuffer before the connection dropped, and replay contains
        // everything from the beginning, so appending would double the content.
        assistantBuffer = evt.content;
        updateLive();
        pushLog('reconnected', true);
      } else if (evt.type === 'heartbeat') {
        // v3.2: structured status line replaces the silent ':' keepalive.
        const sec = Math.round((evt.elapsedMs || 0) / 1000);
        activityLine = `working… turn ${evt.turn || 0} · ${evt.currentActivity || 'thinking'} · ${sec}s`;
        setMessages(m => m.map((msg, i) => i === liveRef.current ? { ...msg, activity: activityLine } : msg));
      } else if (evt.type === 'tool_start') {
        pushLog('tool · ' + evt.tool);
      } else if (evt.type === 'tool_done') {
        pushLog('tool · ' + evt.tool, true);
      } else if (evt.type === 'spawn' || evt.type === 'spawn_started') {
        setSpawned(s => [...s, evt.agentName]);
        pushEvent('violet', `Temp agent spawned: ${evt.agentName}`);
      } else if (evt.type === 'spawn_chunk') {
        // Suppress per-token noise.
      } else if (evt.type === 'spawn_done') {
        pushEvent('violet', `${evt.agentName} finished`);
      } else if (evt.type === 'spawn_eval') {
        pushEvent(evt.shouldSpawn ? 'violet' : 'amber', `Spawn ${evt.shouldSpawn ? 'approved' : 'denied'}: ${evt.task} — ${evt.reason}`);
      } else if (evt.type === 'plan') {
        pushEvent('cyan', `Decomposed into ${evt.steps?.length || 0} steps`);
        pushLog('planned · ' + (evt.steps?.length || 0) + ' steps', true);
      } else if (evt.type === 'step_start') {
        pushEvent('cyan', `Step ${evt.stepIndex + 1}: ${evt.agentName} · ${evt.task}`);
        pushLog('step ' + (evt.stepIndex + 1) + ' · @' + evt.agentName);
      } else if (evt.type === 'agent_message') {
        pushEvent('blue', `${evt.fromName} → ${evt.toName}: "${(evt.preview || '').slice(0, 80)}"`);
      } else if (evt.type === 'agent_task_assigned') {
        pushEvent('blue', `${evt.fromName} assigned T-${(evt.taskId || '').slice(0, 6)}: ${evt.title}`);
      } else if (evt.type === 'agent_image') {
        // Agent sent an inline image via send_image_to_user. Append it to the
        // live bubble so it renders immediately; the markdown tag the LLM will
        // emit afterwards is the persistence path on reload.
        const img = { url: evt.url, alt: evt.alt || '', caption: evt.caption || '' };
        setMessages(m => m.map((msg, i) => i === liveRef.current
          ? { ...msg, agentImages: [...(msg.agentImages || []), img] }
          : msg));
        pushLog('image · ' + (evt.alt || 'sent'), true);
      } else if (evt.type === 'agent_file') {
        const file = {
          url:      evt.url,
          filename: evt.filename || 'file',
          mime:     evt.mime     || 'application/octet-stream',
          size:     evt.size     || 0,
          caption:  evt.caption  || '',
        };
        setMessages(m => m.map((msg, i) => i === liveRef.current
          ? { ...msg, agentFiles: [...(msg.agentFiles || []), file] }
          : msg));
        pushLog('file · ' + (evt.filename || 'sent'), true);
      } else if (evt.type === 'tool') {
        setTools(t => [...t, { name: evt.name, input: evt.input, ms: evt.ms, status: evt.status }]);
        pushLog('tool · ' + evt.name, true);
      } else if (evt.type === 'done') {
        terminal = true;
        setMessages(m => m.map((msg, i) => i === liveRef.current ? { ...msg, streaming: false, activity: null } : msg));
      } else if (evt.type === 'paused') {
        terminal = true;
        pushEvent('amber', `Paused at soft cap — send another message to continue.`);
        setMessages(m => m.map((msg, i) => i === liveRef.current ? { ...msg, streaming: false, activity: null } : msg));
      } else if (evt.type === 'error') {
        terminal = true;
        setError(evt.message);
        pushEvent('amber', 'Error: ' + evt.message);
        setMessages(m => m.map((msg, i) => i === liveRef.current ? { ...msg, streaming: false, activity: null } : msg));
      }
    };

    // Drain an SSE response body. Resolves when the stream naturally ends.
    const consumeSSE = async (body) => {
      const reader = body.getReader();
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
          let evt;
          try { evt = JSON.parse(line.slice(6)); } catch { continue; }
          handleEvent(evt);
        }
      }
    };

    // v3.2: try to re-attach to an in-flight run after the primary stream drops.
    // Returns true iff a resumable run was found AND we consumed its stream.
    const attemptResume = async () => {
      if (!currentSessionId) return false;
      try {
        const ctrl2 = new AbortController();
        abortRef.current = ctrl2;
        const rr = await fetch(`/api/chat/resume/${currentSessionId}`, {
          credentials: 'same-origin',
          signal: ctrl2.signal,
        });
        if (rr.status === 404) return false;
        if (!rr.body) return false;
        await consumeSSE(rr.body);
        return true;
      } catch {
        return false;
      }
    };

    try {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const r = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          message: sentText,
          sessionId: activeSession,
          agentId: activeAgent,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(documents.length > 0 ? { documents } : {}),
          ...(chatModeOverride !== null ? { chatMode: chatModeOverride } : {}),
        }),
      });
      if (!r.body) throw new Error('no SSE stream');
      await consumeSSE(r.body);

      // v3.2: stream ended without a terminal event — try to resume.
      if (!terminal && currentSessionId) {
        const resumed = await attemptResume();
        if (!resumed) {
          // Truly gone with no resumable state — check for a background run to attach.
          (async () => {
            let rescuedRun = null;
            try {
              const runs = await window.NC_API.get('/api/runs?session=' + currentSessionId + '&limit=1');
              const candidate = (runs || [])[0];
              if (candidate && ['running', 'detached', 'paused'].includes(candidate.status)) {
                rescuedRun = candidate;
              }
            } catch {}
            if (rescuedRun) {
              const bubbleIdx = liveRef.current;
              setMessages(m => m.map((msg, i) => i === bubbleIdx ? {
                ...msg,
                streaming: true,
                activity: rescuedRun.current_activity || 'working in the background',
                activityLog: [{ label: 'reconnecting to background run…', done: false }],
              } : msg));
              startBackgroundPoll(rescuedRun, bubbleIdx, currentSessionId);
            } else {
              setMessages(m => m.map((msg, i) => i === liveRef.current ? { ...msg, streaming: false, activity: null } : msg));
            }
          })();
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        if (detachRequestedRef.current && currentSessionId && !terminal) {
          // Deliberate backgrounding (⏏ BG): the run keeps going server-side
          // (detach-on-disconnect). Keep the bubble streaming via the resume
          // SSE while the composer is freed for other work.
          detachRequestedRef.current = false;
          pushLog('backgrounded — run continues', true);
          setMessages(m => m.map((msg, i) => i === liveRef.current ? { ...msg, activity: 'continuing in background…' } : msg));
          attachViaResume({ id: currentRunId }, liveRef.current, currentSessionId);
        } else {
          // User-initiated stop; do nothing further.
          setMessages(m => m.map((msg, i) => i === liveRef.current ? { ...msg, streaming: false, activity: null } : msg));
        }
      } else if (!terminal) {
        // v3.2: connection error — try resume before surfacing as failure.
        const resumed = await attemptResume();
        if (!resumed) {
          setError(err.message);
          // Check for a background run to attach to before giving up.
          (async () => {
            let rescuedRun = null;
            try {
              const runs = await window.NC_API.get('/api/runs?session=' + currentSessionId + '&limit=1');
              const candidate = (runs || [])[0];
              if (candidate && ['running', 'detached', 'paused'].includes(candidate.status)) {
                rescuedRun = candidate;
              }
            } catch {}
            if (rescuedRun) {
              const bubbleIdx = liveRef.current;
              setMessages(m => m.map((msg, i) => i === bubbleIdx ? {
                ...msg,
                streaming: true,
                activity: rescuedRun.current_activity || 'working in the background',
                activityLog: [{ label: 'reconnecting to background run…', done: false }],
              } : msg));
              startBackgroundPoll(rescuedRun, bubbleIdx, currentSessionId);
            } else {
              setMessages(m => m.map((msg, i) => i === liveRef.current ? { ...msg, streaming: false, activity: null } : msg));
            }
          })();
        }
      } else {
        setMessages(m => m.map((msg, i) => i === liveRef.current ? { ...msg, streaming: false, activity: null } : msg));
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  };

  const session = SESSIONS.find(s => s.id === activeSession) || (activeSession ? { id: activeSession, title: activeSession.slice(0, 8), msgs: messages.length, agents: [] } : null);
  // Effective chat mode for this conversation = session override (if set) else
  // the active agent's chat_mode default. Drives the 💬 pill's on/off state.
  const activeAgentRaw  = (window.NC_DATA.AGENTS || []).find(a => (a._raw?.id || a.id) === activeAgent);
  const agentDefaultPlain = !!(activeAgentRaw?._raw?.chat_mode);
  const effectivePlain  = chatModeOverride !== null ? chatModeOverride : agentDefaultPlain;
  const [mobSessionsOpen, setMobSessionsOpen] = React.useState(false);

  React.useEffect(() => {
    window.NC_STATUS_CONTEXT = {
      source:    'chat',
      mode:      effectivePlain ? 'chat' : 'agent',
      agentId:   activeAgent,
      agentName: activeAgentRaw?.name,
      agentRole: activeAgentRaw?.role,
      model:     activeAgentRaw?.model,
      sessionId: activeSession,
    };
    window.dispatchEvent(new CustomEvent('nc-status-context'));
    return () => {
      if (window.NC_STATUS_CONTEXT?.source === 'chat') {
        window.NC_STATUS_CONTEXT = null;
        window.dispatchEvent(new CustomEvent('nc-status-context'));
      }
    };
  }, [activeAgent, activeAgentRaw?.name, activeAgentRaw?.role, activeAgentRaw?.model, activeSession, effectivePlain]);

  // Session-rail management (absorbed from the old standalone Sessions page).
  const [sessFilter, setSessFilter] = React.useState('');
  const onRenameSession = async (e, s) => {
    e.stopPropagation();
    const next = prompt('Rename session', s.title);
    if (!next || next === s.title) return;
    try {
      await fetch('/api/sessions/' + s.id, { method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: next }) });
      await window.NC_LIVE.refresh();
    } catch (err) { alert('Failed: ' + err.message); }
  };
  const onDeleteSession = async (e, s) => {
    e.stopPropagation();
    if (!confirm(`Delete session "${s.title}" and all its messages?`)) return;
    try {
      await fetch('/api/sessions/' + s.id, { method: 'DELETE', credentials: 'same-origin' });
      if (activeSession === s.id) setActiveSession(null);
      await window.NC_LIVE.refresh();
    } catch (err) { alert('Failed: ' + err.message); }
  };
  const patchSession = async (id, body) => {
    await fetch('/api/sessions/' + id, {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await window.NC_LIVE.refresh();
  };
  const onTogglePin = async (e, s) => {
    e.stopPropagation();
    try { await patchSession(s.id, { pinned: !s.pinned }); } catch (err) { alert('Failed: ' + err.message); }
  };
  const onToggleArchive = async (e, s) => {
    e.stopPropagation();
    try { await patchSession(s.id, { status: s.status === 'archived' ? 'active' : 'archived' }); }
    catch (err) { alert('Failed: ' + err.message); }
  };
  const [showArchived, setShowArchived] = React.useState(false);
  const railSessions = (SESSIONS || [])
    .filter(s => showArchived ? true : s.status !== 'archived')
    .filter(s => !sessFilter || (s.title || '').toLowerCase().includes(sessFilter.toLowerCase()) || s.id.includes(sessFilter))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)); // pinned float to top

  return (
    <div className="chat-layout" style={{ height: 'var(--chat-h)', minHeight: 'var(--chat-min-h)' }}>
      {/* Session list (mobile sessions toggle lives in the thread header below) */}
      <div className={`nc-panel glow chat-sessions ${mobSessionsOpen ? 'mob-open' : ''}`} style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="label-tiny neonc">SESSIONS</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="nc-btn ghost show-mobile" onClick={() => setMobSessionsOpen(false)} style={{ padding: '4px 6px' }}><Icon name="close" size={12}/></button>
            <button className="nc-btn ghost" onClick={() => {
              const agents = window.NC_DATA.AGENTS || [];
              const alfredId = (agents.find(a => a.name === 'A.S.A.G.I') || agents.find(a => a.name === 'Alfred') || agents[0])?.id || null;
              setActiveAgent(alfredId);
              setActiveSession(null);
            }} style={{ padding: '4px 6px' }} title="New chat"><Icon name="plus" size={12}/></button>
          </div>
        </div>
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input className="nc-input" placeholder="filter sessions…" value={sessFilter}
                 onChange={e => setSessFilter(e.target.value)} style={{ width: '100%', fontSize: 11 }}/>
          <label className="mono muted" style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)}/> show archived
          </label>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {railSessions.map(s => (
            <div key={s.id} onClick={() => setActiveSession(s.id)} className="chat-sess-row" style={{
              padding: '10px 14px',
              borderLeft: `2px solid ${activeSession === s.id ? 'var(--accent)' : 'transparent'}`,
              background: activeSession === s.id ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
              borderBottom: '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)',
              cursor: 'pointer',
            }}>
              <div className="mono" style={{ fontSize: 11, color: activeSession === s.id ? 'var(--text)' : 'var(--text-soft)', display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                {s.active && <span className="dot cyan pulse"/>}
              </div>
              <div className="mono muted" style={{ fontSize: 10, marginTop: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                <span style={{ display: 'flex', gap: 6 }}>
                  <span>{s.last}</span>
                  {s.msgs != null && <span className="neonc">{s.msgs} msgs</span>}
                </span>
                <span className="chat-sess-actions" style={{ display: 'flex', gap: 4 }}>
                  <button className="nc-btn ghost" style={{ fontSize: 9, padding: '2px 5px', color: s.pinned ? 'var(--accent)' : undefined }} onClick={e => onTogglePin(e, s)} title={s.pinned ? 'Unpin' : 'Pin'}>{s.pinned ? 'pinned' : 'pin'}</button>
                  <button className="nc-btn ghost" style={{ fontSize: 9, padding: '2px 5px' }} onClick={e => onToggleArchive(e, s)} title={s.status === 'archived' ? 'Unarchive' : 'Archive'}>{s.status === 'archived' ? 'unarch' : 'arch'}</button>
                  <button className="nc-btn ghost" style={{ fontSize: 9, padding: '2px 5px' }} onClick={e => onRenameSession(e, s)} title="Rename">ren</button>
                  <button className="nc-btn ghost" style={{ fontSize: 9, padding: '2px 5px', color: 'var(--danger)' }} onClick={e => onDeleteSession(e, s)} title="Delete">del</button>
                </span>
              </div>
            </div>
          ))}
          {railSessions.length === 0 && (
            <div className="mono muted" style={{ padding: 20, textAlign: 'center', fontSize: 10 }}>
              {sessFilter ? '// no match' : '// no sessions yet'}
            </div>
          )}
        </div>
      </div>

      {/* Main thread */}
      <div className="nc-panel glow" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Mobile-only: open the sessions rail as a slide-over */}
          <button className="nc-btn ghost show-mobile" onClick={() => setMobSessionsOpen(true)}
                  title="Sessions" style={{ padding: '6px 9px', flex: '0 0 auto' }}>
            <Icon name="sessions" size={15}/>
          </button>
          <div className="chat-thread-title" style={{ flex: 1, minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session?.title || 'New chat'}</div>
            <div className="mono muted" style={{ fontSize: 10, marginTop: 2, display: 'flex', gap: 10 }}>
              <span>{messages.length} msgs</span>
              <span>·</span>
              <span style={{ color: streaming ? 'var(--amber)' : 'var(--accent-2)' }}>{streaming ? '● streaming' : '● live'}</span>
            </div>
          </div>
          <select className="nc-select chat-agent-select" value={activeAgent || ''} onChange={e => setActiveAgent(e.target.value)} style={{ width: 160 }}>
            {AGENTS.map(a => <option key={a.id} value={a.id}>@{a.name}</option>)}
          </select>
          <button
            className="nc-btn ghost"
            style={{ padding: '5px 11px', fontSize: 11, whiteSpace: 'nowrap' }}
            title="Open Chat Mode in new tab"
            onClick={() => {
              const t = window.NC_API?.token || new URLSearchParams(location.search).get('token') || '';
              window.open('/chat-mode' + (t ? '?token=' + t : ''), '_blank');
            }}
          >
            ⚡ Chat Mode
          </button>
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
                  <div style={{ maxWidth: '70%', padding: '10px 14px', background: 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 18%, transparent), color-mix(in srgb, var(--accent) 8%, transparent))', border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)', borderRadius: '8px 8px 2px 8px' }}>
                    <div style={{ display: 'flex', gap: 8, fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--accent-2)', marginBottom: 4, alignItems: 'center' }}>
                      <span>@{m.who}</span><span className="muted">·</span><span className="muted">{m.t}</span>
                      {m.slashSkill && <span className="tag cyan" style={{ fontSize: 9, padding: '1px 5px' }}>/{m.slashSkill}</span>}
                    </div>
                    {((m.attachments?.length || 0) + (m.docs?.length || 0)) > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                        {(m.attachments || []).map((a, ai) => (
                          <img key={ai} src={a.url} alt={a.name} style={{ height: 48, borderRadius: 4, border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)' }} />
                        ))}
                        {(m.docs || []).map((d, di) => (
                          <span key={di} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(255,255,255,0.06)', border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)', borderRadius: 4, padding: '2px 6px', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent-2)' }}>
                            📄 {d}
                          </span>
                        ))}
                      </div>
                    )}
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{m.body}</div>
                  </div>
                </div>
              );
            }
            const isTemp = (m.agent || '').includes('-');
            const agentRecord = (window.NC_DATA.AGENTS || []).find(a => a.name === m.agent);
            const agentAvatarUrl = agentRecord?._raw?.avatar_url || null;
            return (
              <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                <div style={{ width: 32, height: 32, flex: 'none', borderRadius: 6, background: isTemp ? 'radial-gradient(circle, rgba(139,92,246,0.55), rgba(139,92,246,0.1))' : 'radial-gradient(circle, color-mix(in srgb, var(--accent) 55%, transparent), color-mix(in srgb, var(--accent) 5%, transparent))', border: `1px solid ${isTemp ? 'rgba(139,92,246,0.6)' : 'var(--line-hard)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, overflow: 'hidden' }}>
                  {agentAvatarUrl
                    ? <img src={agentAvatarUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : (m.agent || '?')[0].toUpperCase()}
                </div>
                <div style={{ maxWidth: '78%', padding: '10px 14px', background: 'linear-gradient(180deg, rgba(7,17,31,0.9), rgba(2,6,23,0.6))', border: '1px solid var(--line)', borderRadius: '8px 8px 8px 2px' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                    <span className="mono" style={{ color: isTemp ? 'var(--violet)' : 'var(--accent)', fontSize: 11 }}>@{m.agent}</span>
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
                  {m.body === '' && m.streaming && (m.activityLog?.length ?? 0) > 0 && (
                    <div style={{ borderLeft: '2px solid color-mix(in srgb, var(--accent) 20%, transparent)', paddingLeft: 8, marginBottom: 4 }}>
                      {m.activityLog.map((entry, ei) => (
                        <div key={ei} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', fontFamily: 'var(--mono)', fontSize: 10, color: entry.done ? 'rgba(255,255,255,0.25)' : 'var(--accent)' }}>
                          <span style={{ width: 14, textAlign: 'center', display: 'inline-block', animation: entry.done ? 'none' : 'spin 0.8s linear infinite' }}>
                            {entry.done ? '✓' : '◌'}
                          </span>
                          <span>{entry.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {(m.agentImages?.length || 0) > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                      {m.agentImages.map((img, ii) => (
                        <div key={ii} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <a href={img.url} target="_blank" rel="noreferrer">
                            <img
                              src={img.url}
                              alt={img.alt || 'image'}
                              style={{ maxWidth: '100%', maxHeight: 480, borderRadius: 6, border: '1px solid var(--line)', display: 'block' }}
                            />
                          </a>
                          {img.caption && (
                            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-soft)', opacity: 0.75 }}>{img.caption}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div
                    className="nc-md"
                    style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-soft)', lineHeight: 1.6, wordBreak: 'break-word' }}
                    ref={el => {
                      if (!el) return;
                      if (m.body && window.marked) {
                        el.innerHTML = window.marked.parse(m.body) +
                          (m.streaming ? '<span class="blink neonc">▌</span>' : '');
                      } else {
                        el.textContent = m.body || '';
                        if (m.streaming) {
                          const cur = document.createElement('span');
                          cur.className = 'blink neonc';
                          cur.textContent = '▌';
                          el.appendChild(cur);
                        }
                      }
                    }}
                  />
                  {m.streaming && (m.activity || '').trim() && !(m.body === '' && (m.activityLog?.length ?? 0) > 0) && (
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 10,
                      color: 'var(--accent)', opacity: 0.7,
                      marginTop: 4, display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      <span style={{ display: 'inline-block', animation: 'spin 0.8s linear infinite' }}>◌</span>
                      <span>{m.activity}</span>
                    </div>
                  )}
                  {(m.agentFiles || []).map((f, i) => (
                    <div key={i} style={{ display: 'flex', flexDirection: 'column', marginTop: '6px', maxWidth: '340px' }}>
                      {f.caption && (
                        <div style={{ fontSize: '12px', color: 'var(--text-soft)', marginBottom: '4px' }}>
                          {f.caption}
                        </div>
                      )}
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: '10px',
                        padding: '10px 13px',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: '8px',
                      }}>
                        <span style={{ fontSize: '22px', flexShrink: 0 }}>{agentFileIcon(f.mime)}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            color: 'var(--text)', fontSize: '12px', fontWeight: 600,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          }}>
                            {f.filename}
                          </div>
                          <div style={{ color: 'var(--muted)', fontSize: '10px', marginTop: '2px' }}>
                            {agentFileMimeLabel(f.mime)} · {agentFileFormatBytes(f.size)}
                          </div>
                        </div>
                        <a
                          href={f.url}
                          download={f.filename}
                          style={{
                            background: '#7c6af7', color: '#fff', borderRadius: '4px',
                            padding: '5px 10px', fontSize: '12px', fontWeight: 700,
                            textDecoration: 'none', flexShrink: 0,
                          }}
                        >↓</a>
                      </div>
                    </div>
                  ))}
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
          {(pendingImages.length > 0 || pendingDocs.length > 0) && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {pendingImages.map((p, i) => (
                <div key={i} style={{ position: 'relative', display: 'inline-block' }}>
                  <img src={p.dataUrl} alt={p.name} style={{ height: 56, borderRadius: 4, border: '1px solid var(--line)' }}/>
                  <button onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))}
                          title={`Remove ${p.name}`}
                          style={{ position: 'absolute', top: -6, right: -6, background: 'var(--danger)', color: '#fff', border: 0, borderRadius: '50%', width: 18, height: 18, fontSize: 11, cursor: 'pointer' }}>×</button>
                </div>
              ))}
              {pendingDocs.map((d, i) => (
                <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(255,255,255,0.06)', border: '1px solid var(--line)', borderRadius: 4, padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-soft)' }}>
                  📄 {d.name}
                  <button onClick={() => setPendingDocs(prev => prev.filter((_, j) => j !== i))}
                          title={`Remove ${d.name}`}
                          style={{ background: 'none', border: 'none', color: 'var(--text-soft)', cursor: 'pointer', fontSize: 13, padding: '0 2px', marginLeft: 2 }}>×</button>
                </div>
              ))}
            </div>
          )}
          <div className="chat-composer-row" style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(2,6,23,0.85)', border: '1px solid var(--line)', borderRadius: 2, padding: '6px 10px' }}>
            <span className="neonc mono chat-prompt-caret" style={{ fontSize: 14 }}>▸</span>
            <div className="chat-composer-input" style={{ flex: 1, position: 'relative' }}>
              {slashState.open && (
                <div className="nc-panel" style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, right: 0, padding: 4, maxHeight: 280, overflow: 'auto', boxShadow: '0 6px 20px rgba(0,0,0,0.5)', zIndex: 5 }}>
                  {slashState.cmdMatches.length > 0 && (
                    <>
                      <div className="label-tiny" style={{ padding: '4px 8px', color: 'var(--accent)' }}>COMMANDS · tab/enter to insert</div>
                      {slashState.cmdMatches.map(c => (
                        <div key={c.name}
                             onMouseDown={e => { e.preventDefault(); acceptSlash(c.name); }}
                             className="mono"
                             style={{ padding: '6px 10px', fontSize: 11, cursor: 'pointer', borderRadius: 2, display: 'flex', justifyContent: 'space-between', gap: 12 }}
                             onMouseOver={e => e.currentTarget.style.background = 'color-mix(in srgb, var(--accent) 10%, transparent)'}
                             onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                          <span><span style={{ color: 'var(--accent, #7c7cff)' }}>/{c.name}</span>{c.description && <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>— {c.description}</span>}</span>
                          <span className="muted" style={{ fontSize: 10 }}>built-in</span>
                        </div>
                      ))}
                    </>
                  )}
                  {slashState.skillMatches.length > 0 && (
                    <>
                      <div className="label-tiny" style={{ padding: '4px 8px', color: 'var(--accent)', borderTop: slashState.cmdMatches.length > 0 ? '1px solid var(--line)' : 'none', marginTop: slashState.cmdMatches.length > 0 ? 4 : 0 }}>SKILLS · tab/enter to insert</div>
                      {slashState.skillMatches.map(s => (
                        <div key={s.name}
                             onMouseDown={e => { e.preventDefault(); acceptSlash(s.name); }}
                             className="mono"
                             style={{ padding: '6px 10px', fontSize: 11, cursor: 'pointer', borderRadius: 2, display: 'flex', justifyContent: 'space-between', gap: 12 }}
                             onMouseOver={e => e.currentTarget.style.background = 'color-mix(in srgb, var(--accent) 10%, transparent)'}
                             onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                          <span><span className="neonc">/{s.name}</span>{s.description && <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>— {s.description}</span>}</span>
                          <span className="muted" style={{ fontSize: 10 }}>{s.source}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onPaste={onPaste}
                onKeyDown={e => {
                  if (slashState.open && (e.key === 'Tab' || (e.key === 'Enter' && [...slashState.cmdMatches, ...slashState.skillMatches][0]?.name !== slashState.firstWord))) {
                    e.preventDefault();
                    acceptSlash([...slashState.cmdMatches, ...slashState.skillMatches][0].name);
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                }}
                placeholder={
                  pendingImages.length > 0
                    ? `${pendingImages.length} image${pendingImages.length === 1 ? '' : 's'} attached — add a message or press Enter to send`
                    : pendingDocs.length > 0
                    ? (() => {
                        const bin = pendingDocs.filter(d => d.kind === 'binary').length;
                        const txt = pendingDocs.length - bin;
                        if (bin > 0 && txt === 0) return `${bin} document${bin === 1 ? '' : 's'} queued for docuflow — add a question or press Enter to send`;
                        if (txt > 0 && bin === 0) return `${txt} text file${txt === 1 ? '' : 's'} ready to inline — add a message or press Enter to send`;
                        return `${bin + txt} file${bin + txt === 1 ? '' : 's'} attached — add a message or press Enter to send`;
                      })()
                    : 'Send command — / for commands & skills, @ for agents. Paste images for vision. Shift+Enter for newline.'
                }
                disabled={streaming}
                rows={1}
                style={{
                  width: '100%', background: 'transparent', border: 0, outline: 0,
                  color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 13,
                  opacity: streaming ? 0.5 : 1, resize: 'none', lineHeight: 1.5,
                  minHeight: 36, maxHeight: 140, overflowY: 'auto',
                }}
              />
            </div>
            <input ref={fileInputRef} type="file" accept="image/*,audio/*,video/*,.txt,.md,.csv,.json,.yaml,.yml,.xml,.py,.js,.ts,.css,.sh,.sql,.pdf,.docx,.epub,.html,.htm,.xhtml,*/*" multiple style={{ display: 'none' }} onChange={e => { onPickFiles(e.target.files); e.target.value = ''; }}/>
            <button className="nc-btn ghost" onClick={() => fileInputRef.current?.click()} disabled={streaming} title="Attach image" style={{ padding: '4px 8px', fontSize: 11 }}>📎</button>
            <button className="nc-btn ghost" onClick={() => setChatModeOverride(effectivePlain ? false : true)} disabled={streaming}
                    title={effectivePlain
                      ? 'Chat mode ON for this conversation — plain completion (no tools/skills/MCP). Click to switch to full agent mode.'
                      : 'Full agent mode. Click to switch this conversation to plain chat mode.'}
                    style={{ padding: '4px 8px', fontSize: 11, color: effectivePlain ? 'var(--accent)' : undefined, borderColor: effectivePlain ? 'var(--accent)' : undefined }}>
              💬 {effectivePlain ? 'CHAT' : 'chat'}
            </button>
            <button className="nc-btn ghost" onClick={toggleRecording} disabled={streaming || transcribing}
                    title={recording ? 'Stop recording' : transcribing ? 'Transcribing…' : 'Voice input'}
                    style={{ padding: '4px 8px', fontSize: 11, color: recording ? 'var(--danger)' : undefined }}>
              {recording ? '● REC' : transcribing ? '…' : '🎤'}
            </button>
            {streaming && <span className="blink neonc">▌</span>}
            {streaming && (
              <button className="nc-btn ghost" title="Continue in background — the run keeps going server-side and output keeps streaming into the bubble while you do other things"
                onClick={() => {
                  detachRequestedRef.current = true;
                  abortRef.current?.abort();
                }} style={{ marginLeft: 6 }}>
                ⏏ BG
              </button>
            )}
            {streaming && (
              <button className="nc-btn ghost" onClick={() => {
                abortRef.current?.abort();
                if (activeSession) {
                  fetch('/api/chat/stop', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ sessionId: activeSession }),
                  }).catch(() => {});
                }
              }} style={{ marginLeft: 6, color: 'var(--danger)', borderColor: 'var(--danger)' }}>
                ■ STOP
              </button>
            )}
            <button className="nc-btn primary" onClick={send} disabled={streaming} style={{ marginLeft: 6, opacity: streaming ? 0.5 : 1 }}><Icon name="send" size={12}/> {streaming ? 'STREAMING' : 'SEND'}</button>
          </div>
        </div>
      </div>

      {/* Inspector */}
      <div className="nc-panel glow chat-inspector" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-soft)' }}>
          <div className="label-tiny neonc">INSPECTOR · ROUTE TRACE</div>
        </div>
        <div style={{ padding: 14, flex: 1, overflow: 'auto' }}>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.7 }}>
            <div style={{ color: 'var(--accent)' }}># last route</div>
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
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px dashed color-mix(in srgb, var(--accent) 8%, transparent)' }}>
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
