# Chat Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone `/chat-mode` page — a full-screen PWA chat UI with Claude warm-dark colors, sidebar sessions, markdown rendering, file uploads, voice input, and TTS — openable from the dashboard Chat tab.

**Architecture:** New `src/dashboard/chat-mode.html` is a self-contained React (CDN) app with inline CSS and no build step. Three server routes added to `server.ts` handle serving the page, the PWA manifest, and the updated service worker shell. One button added to `page-chat.jsx` opens the new tab.

**Tech Stack:** React 18 (CDN/Babel), marked.js v9 (CDN), Hono (existing), MediaRecorder API, SSE streaming (existing `/api/chat` endpoint)

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Modify | `src/dashboard/server.ts` | Add `/chat-mode` route + auth, `/chat-mode-manifest.json`, update `/sw.js` SHELL |
| Create | `src/dashboard/chat-mode.html` | Full standalone Chat Mode React app |
| Modify | `src/dashboard/v2/src/page-chat.jsx` | Add "⚡ Chat Mode" button to topbar |

---

## Task 1: Server Routes

**Files:**
- Modify: `src/dashboard/server.ts:215-222` (sw.js), `src/dashboard/server.ts:222` (insert after sw.js)

- [ ] **Step 1: Update `/sw.js` to cache `/chat-mode`**

In `server.ts`, find the `/sw.js` route (line ~215) and change the SHELL array:

```typescript
// BEFORE:
return c.body(`const CACHE='neuroclaw-v1';const SHELL=['/manifest.json','/icon.svg','/favicon.svg'];

// AFTER:
return c.body(`const CACHE='neuroclaw-v1';const SHELL=['/manifest.json','/chat-mode-manifest.json','/icon.svg','/favicon.svg','/chat-mode'];
```

Full updated line (replace the entire `return c.body(...)` string):
```typescript
  return c.body(`const CACHE='neuroclaw-v1';const SHELL=['/manifest.json','/chat-mode-manifest.json','/icon.svg','/favicon.svg','/chat-mode'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(Promise.all([clients.claim(),caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))]));});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.pathname.startsWith('/api/')||u.origin!==location.origin||u.pathname.endsWith('.jsx'))return;e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).catch(()=>new Response('',{status:503}))));});`);
```

- [ ] **Step 2: Add `/chat-mode-manifest.json` route**

Insert after the closing `});` of the `/sw.js` route (after line ~222), before the `/dashboard` auth middleware:

```typescript
app.get('/chat-mode-manifest.json', (c) => {
  return c.json({
    name: 'NeuroClaw Chat',
    short_name: 'NC Chat',
    description: 'Talk to your AI agents',
    start_url: '/chat-mode',
    scope: '/chat-mode',
    display: 'standalone',
    background_color: '#1a1814',
    theme_color: '#d97b5e',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  });
});
```

- [ ] **Step 3: Add `/chat-mode` auth middleware and route handler**

Insert directly after the `/chat-mode-manifest.json` route you just added:

```typescript
// Token guard for /chat-mode — same pattern as /dashboard
app.use('/chat-mode', async (c, next) => {
  const cookie = c.req.header('cookie') ?? '';
  const cookieToken = /(?:^|;\s*)dashboard-token=([^;]+)/.exec(cookie)?.[1];
  const token = c.req.query('token') ?? cookieToken ?? '';
  if (token !== config.dashboard.token) {
    return c.text('Unauthorized — open Chat Mode from the NeuroClaw dashboard', 401);
  }
  await next();
});

app.get('/chat-mode', (c) => {
  try {
    const html = fs.readFileSync(
      path.resolve(process.cwd(), 'src/dashboard/chat-mode.html'),
      'utf-8'
    );
    c.header('Set-Cookie', `dashboard-token=${config.dashboard.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    return c.html(html);
  } catch (err) {
    return c.text(`Chat Mode not found: ${(err as Error).message}`, 500);
  }
});
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors. If you see errors about `config`, `fs`, or `path` — those are already imported at the top of `server.ts`, no new imports needed.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.ts
git commit -m "feat(chat-mode): add /chat-mode route, manifest, and sw cache entry"
```

---

## Task 2: Create `chat-mode.html`

**Files:**
- Create: `src/dashboard/chat-mode.html`

This is the complete file. Create it in one step — it is self-contained HTML with inline CSS and a Babel JSX script block.

- [ ] **Step 1: Create the file**

Create `src/dashboard/chat-mode.html` with the following complete content:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="theme-color" content="#d97b5e"/>
<meta name="mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
<meta name="apple-mobile-web-app-title" content="NC Chat"/>
<link rel="manifest" href="/chat-mode-manifest.json"/>
<link rel="apple-touch-icon" href="/icon.svg"/>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
<title>NeuroClaw Chat</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
<script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@9/marked.min.js"></script>
<style>
:root {
  --bg-dark: #1a1814; --bg-main: #201e1b; --bg-topbar: #1c1a17; --bg-input: #161412;
  --text: #f0ece4; --text-soft: #c8c4bc; --text-muted: #9a9490; --text-dim: #6b6560;
  --accent: #d97b5e; --accent-2: #c9a56a;
  --border: rgba(255,240,210,0.07); --border-soft: rgba(255,240,210,0.05);
  --border-input: rgba(255,240,210,0.12); --border-focus: rgba(217,123,94,0.40);
  --user-bg: rgba(217,123,94,0.15); --user-border: rgba(217,123,94,0.30);
  --agent-bg: rgba(255,240,210,0.04); --agent-border: rgba(255,240,210,0.08);
  --mono: 'JetBrains Mono', ui-monospace, monospace;
  --display: 'Space Grotesk', system-ui, sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg-dark);color:var(--text);font-family:var(--display)}
#root{height:100%}
.cm-shell{display:flex;height:100vh;overflow:hidden}
/* Sidebar */
.cm-sidebar{width:240px;flex-shrink:0;display:flex;flex-direction:column;background:var(--bg-dark);border-right:1px solid var(--border)}
.cm-sb-hdr{padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.cm-logo{display:flex;align-items:center;gap:8px;color:var(--text);font-weight:700;font-size:13px;letter-spacing:.08em}
.cm-logo-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px rgba(217,123,94,.6)}
.cm-new-btn{display:flex;align-items:center;gap:5px;background:rgba(217,123,94,.12);border:1px solid rgba(217,123,94,.3);border-radius:6px;padding:5px 10px;color:var(--accent);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--display)}
.cm-new-btn:hover{background:rgba(217,123,94,.2)}
.cm-sec-lbl{padding:10px 16px 5px;font-size:10px;font-weight:600;letter-spacing:.12em;color:var(--text-dim);text-transform:uppercase;flex-shrink:0}
.cm-sessions{flex:1;overflow-y:auto}
.cm-sitem{padding:9px 16px;border-left:2px solid transparent;color:var(--text-muted);font-size:12px;display:flex;flex-direction:column;gap:2px;cursor:pointer}
.cm-sitem:hover{background:rgba(255,240,210,.04)}
.cm-sitem.active{border-left-color:var(--accent);background:rgba(217,123,94,.08);color:var(--text)}
.cm-sitem-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-sitem-meta{font-size:10px;color:var(--text-dim)}
.cm-sitem.active .cm-sitem-meta{color:var(--text-muted)}
.cm-sb-foot{padding:12px 16px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-shrink:0}
.cm-av{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent-2));display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;flex-shrink:0}
/* Main */
.cm-main{flex:1;display:flex;flex-direction:column;background:var(--bg-main);overflow:hidden;min-width:0}
.cm-topbar{padding:12px 20px;border-bottom:1px solid var(--border-soft);display:flex;align-items:center;gap:10px;background:var(--bg-topbar);flex-shrink:0}
.cm-chat-title{color:var(--text);font-size:14px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-agent-pill{display:flex;align-items:center;gap:6px;background:rgba(217,123,94,.1);border:1px solid rgba(217,123,94,.25);border-radius:20px;padding:4px 12px 4px 8px;white-space:nowrap}
.cm-agent-pill select{background:transparent;border:none;color:var(--accent);font-size:12px;font-weight:600;cursor:pointer;outline:none;font-family:var(--display)}
.cm-pdot{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 5px rgba(217,123,94,.7);flex-shrink:0}
/* Thread */
.cm-thread{flex:1;padding:20px 24px;overflow-y:auto;display:flex;flex-direction:column;gap:16px}
.cm-empty{text-align:center;padding:60px 20px;color:var(--text-dim);font-size:13px;font-family:var(--mono)}
/* User bubble */
.cm-umsg{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.cm-ububble{background:var(--user-bg);border:1px solid var(--user-border);border-radius:16px 16px 4px 16px;padding:10px 16px;color:var(--text);font-size:13px;line-height:1.55;max-width:65%;white-space:pre-wrap;word-break:break-word}
.cm-msg-meta{color:var(--text-dim);font-size:10px;font-family:var(--mono)}
.cm-attach-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px}
.cm-attach-img{height:60px;border-radius:6px;border:1px solid var(--border-input)}
.cm-attach-doc{display:inline-flex;align-items:center;gap:4px;background:rgba(255,240,210,.06);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-family:var(--mono);font-size:10px;color:var(--text-muted)}
/* Agent bubble */
.cm-amsg{display:flex;gap:10px;max-width:80%}
.cm-aav{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#2c2a26,#3a3630);border:1px solid rgba(217,123,94,.25);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:var(--accent);flex-shrink:0;overflow:hidden}
.cm-aav img{width:100%;height:100%;object-fit:cover}
.cm-abody{display:flex;flex-direction:column;gap:4px;min-width:0}
.cm-ahdr{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cm-albl{color:var(--accent);font-size:12px;font-weight:600}
.cm-mtag{background:rgba(255,240,210,.06);border:1px solid rgba(255,240,210,.1);border-radius:4px;padding:1px 6px;color:var(--text-dim);font-size:10px;font-family:var(--mono)}
.cm-speak-btn{margin-left:auto;background:none;border:none;color:var(--text-dim);font-size:13px;cursor:pointer;padding:1px 4px;border-radius:4px}
.cm-speak-btn:hover{color:var(--text-muted);background:rgba(255,240,210,.06)}
.cm-abubble{background:var(--agent-bg);border:1px solid var(--agent-border);border-radius:4px 16px 16px 16px;padding:10px 16px;color:var(--text-soft);font-size:13px;line-height:1.65;word-break:break-word;min-width:120px}
/* Activity log */
.cm-activity{border-left:2px solid rgba(217,123,94,.2);padding-left:10px;margin-bottom:6px;display:flex;flex-direction:column;gap:3px}
.cm-act-row{display:flex;align-items:center;gap:6px;font-size:10px;font-family:var(--mono);color:var(--text-dim)}
.cm-act-row.live{color:var(--accent)}
.cm-spin{display:inline-block;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
/* Markdown */
.cm-md h1,.cm-md h2,.cm-md h3{color:var(--text);margin:10px 0 4px}
.cm-md h1{font-size:15px}.cm-md h2{font-size:14px}.cm-md h3{font-size:13px}
.cm-md p{margin:4px 0}.cm-md ul,.cm-md ol{padding-left:18px;margin:4px 0}.cm-md li{margin:2px 0}
.cm-md code{background:rgba(201,165,106,.1);border:1px solid rgba(201,165,106,.2);border-radius:3px;padding:1px 5px;font-family:var(--mono);font-size:11px;color:var(--accent-2)}
.cm-md pre{position:relative;background:rgba(0,0,0,.35);border:1px solid rgba(255,240,210,.1);border-radius:6px;padding:10px 12px;margin:8px 0;overflow-x:auto}
.cm-md pre code{background:none;border:none;padding:0;color:var(--text-soft);font-size:12px}
.cm-md strong{color:var(--accent);font-weight:600}.cm-md em{font-style:italic;color:var(--text-muted)}
.cm-md table{border-collapse:collapse;width:100%;margin:8px 0;font-size:12px}
.cm-md th,.cm-md td{border:1px solid var(--border);padding:6px 10px;text-align:left}
.cm-md th{background:rgba(217,123,94,.1);color:var(--accent)}
.cm-md blockquote{border-left:3px solid var(--accent);padding-left:10px;color:var(--text-muted);margin:6px 0;font-style:italic}
.cm-md a{color:var(--accent-2);text-decoration:underline}
.copy-btn{position:absolute;top:6px;right:8px;background:rgba(255,240,210,.08);border:1px solid rgba(255,240,210,.15);border-radius:4px;color:var(--text-dim);font-size:10px;padding:2px 7px;cursor:pointer;font-family:var(--display)}
.copy-btn:hover{background:rgba(255,240,210,.14);color:var(--text-muted)}
/* Cursor */
.cm-cursor{display:inline-block;width:8px;height:14px;background:var(--accent);opacity:.8;vertical-align:text-bottom;animation:blink 1s step-end infinite}
@keyframes blink{0%,100%{opacity:.8}50%{opacity:0}}
/* Composer */
.cm-composer{padding:10px 20px 14px;border-top:1px solid var(--border-soft);background:var(--bg-topbar);flex-shrink:0}
.cm-input-wrap{border:1px solid var(--border-input);border-radius:14px;background:var(--bg-input);overflow:hidden;transition:border-color .15s}
.cm-input-wrap:focus-within{border-color:var(--border-focus)}
.cm-textarea{width:100%;padding:12px 16px 6px;background:transparent;border:none;color:var(--text);font-size:13px;font-family:var(--display);outline:none;resize:none;line-height:1.5;min-height:44px;max-height:200px;display:block}
.cm-textarea::placeholder{color:var(--text-dim)}
.cm-pending-row{padding:6px 12px 0;display:flex;gap:6px;flex-wrap:wrap}
.cm-pending-img-wrap{position:relative;display:inline-block}
.cm-pending-img{height:48px;border-radius:4px;border:1px solid var(--border-input)}
.cm-remove-btn{position:absolute;top:-6px;right:-6px;background:#e05050;color:#fff;border:none;border-radius:50%;width:16px;height:16px;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.cm-doc-badge{display:inline-flex;align-items:center;gap:4px;background:rgba(255,240,210,.06);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-family:var(--mono);font-size:10px;color:var(--text-muted)}
.cm-doc-badge button{background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:11px;padding:0 2px;margin-left:2px}
.cm-actions{padding:6px 10px 8px;display:flex;align-items:center;gap:6px;border-top:1px solid var(--border-soft)}
.cm-act-btn{display:flex;align-items:center;gap:5px;background:rgba(255,240,210,.05);border:1px solid rgba(255,240,210,.08);border-radius:8px;padding:5px 10px;color:var(--text-dim);font-size:11px;cursor:pointer;font-family:var(--display);font-weight:500;white-space:nowrap}
.cm-act-btn:hover{background:rgba(255,240,210,.09);color:var(--text-muted)}
.cm-act-btn:disabled{opacity:.4;cursor:not-allowed}
.cm-act-btn.voice{color:var(--accent-2);border-color:rgba(201,165,106,.25);background:rgba(201,165,106,.07)}
.cm-act-btn.recording{color:#e05050;border-color:rgba(224,80,80,.4);background:rgba(224,80,80,.1)}
.cm-send-btn{display:flex;align-items:center;gap:6px;background:var(--accent);border:none;border-radius:8px;padding:7px 16px;color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:var(--display);box-shadow:0 2px 10px rgba(217,123,94,.3);white-space:nowrap}
.cm-send-btn:hover{background:#e0875f}.cm-send-btn:disabled{opacity:.5;cursor:not-allowed}
.cm-stop-btn{display:flex;align-items:center;gap:6px;background:rgba(224,80,80,.12);border:1px solid rgba(224,80,80,.4);border-radius:8px;padding:6px 14px;color:#e05050;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--display)}
/* Slash popup */
.cm-slash-popup{position:absolute;bottom:calc(100% + 6px);left:0;right:0;background:#1e1c18;border:1px solid var(--border-input);border-radius:8px;overflow:hidden;z-index:20;box-shadow:0 6px 20px rgba(0,0,0,.5);max-height:260px;overflow-y:auto}
.cm-slash-lbl{padding:5px 12px 3px;font-size:10px;font-weight:600;letter-spacing:.1em;color:var(--accent);text-transform:uppercase}
.cm-slash-item{padding:6px 12px;font-size:11px;font-family:var(--mono);cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;color:var(--text-muted)}
.cm-slash-item:hover{background:rgba(217,123,94,.08)}
.cm-slash-name{color:var(--accent)}.cm-slash-desc{color:var(--text-dim);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Error */
.cm-error{padding:8px 12px;background:rgba(224,80,80,.1);border:1px solid rgba(224,80,80,.3);border-radius:6px;color:#e05050;font-size:12px;font-family:var(--mono);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
/* Scrollbar */
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(255,240,210,.1);border-radius:2px}
/* Mobile: hide sidebar */
@media(max-width:640px){.cm-sidebar{display:none}}
</style>
</head>
<body>
<div id="root"></div>
<script type="text/babel">
const { useState, useEffect, useRef } = React;

// ── Auth token (URL param; cookie set by server on first load) ──────────────
const TOKEN = new URLSearchParams(location.search).get('token') || '';

// ── API helper ───────────────────────────────────────────────────────────────
const api = (path, opts = {}) =>
  fetch(path, {
    ...opts,
    credentials: 'same-origin',
    headers: { 'x-dashboard-token': TOKEN, ...(opts.headers || {}) },
  }).then(async r => {
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text().catch(() => ''))}`);
    return r.json();
  });

// ── Markdown ─────────────────────────────────────────────────────────────────
marked.setOptions({ breaks: true, gfm: true });

const renderMarkdown = (text) => {
  const html = marked.parse(text || '');
  return html.replace(/<pre>/g, '<pre><button class="copy-btn" onclick="window.__copyCode(this)">Copy</button>');
};

window.__copyCode = (btn) => {
  const code = btn.nextElementSibling?.textContent || '';
  navigator.clipboard?.writeText(code).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  });
};

// ── File helpers ─────────────────────────────────────────────────────────────
const MAX_TEXT = 100 * 1024;
const fileToDataUrl = f => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(f);
});
const fileToText = f => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => {
    let t = r.result;
    if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT) + '\n[truncated — file exceeds 100KB]';
    res(t);
  };
  r.onerror = () => rej(r.error);
  r.readAsText(f);
});
const TEXT_EXTS = ['.txt', '.md', '.csv', '.json'];
const isText = f => TEXT_EXTS.some(e => f.name.toLowerCase().endsWith(e));
const isImage = f => f.type.startsWith('image/');
const isPdf = f => f.name.toLowerCase().endsWith('.pdf');

const nowTime = () => new Date().toLocaleTimeString('en-US', { hour12: true });

// ── App ───────────────────────────────────────────────────────────────────────
const ChatMode = () => {
  const [agents,       setAgents]       = useState([]);
  const [sessions,     setSessions]     = useState([]);
  const [status,       setStatus]       = useState(null);
  const [skills,       setSkills]       = useState([]);
  const [activeSession,setActiveSession]= useState(null);
  const [activeAgent,  setActiveAgent]  = useState(null);
  const [messages,     setMessages]     = useState([]);
  const [streaming,    setStreaming]     = useState(false);
  const [draft,        setDraft]        = useState('');
  const [pendingImgs,  setPendingImgs]  = useState([]);
  const [pendingDocs,  setPendingDocs]  = useState([]);
  const [recording,    setRecording]    = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [playingIdx,   setPlayingIdx]   = useState(null);
  const [error,        setError]        = useState(null);

  const scrollRef    = useRef(null);
  const liveRef      = useRef(null);
  const abortRef     = useRef(null);
  const recorderRef  = useRef(null);
  const chunksRef    = useRef([]);
  const audioRef     = useRef(null);
  const fileRef      = useRef(null);
  const skipRef      = useRef(null);
  const taRef        = useRef(null);

  // ── Bootstrap ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!TOKEN) return;
    Promise.all([api('/api/agents'), api('/api/sessions'), api('/api/skills'), api('/api/status')])
      .then(([ags, sess, sk, st]) => {
        const active = (ags || []).filter(a => a.status === 'active');
        setAgents(active);
        const def = active.find(a => a.name === 'A.S.A.G.I') || active.find(a => a.name === 'Alfred') || active[0];
        setActiveAgent(def?.id || null);
        setSessions(sess || []);
        setSkills((sk || []).filter(s => s.name));
        setStatus(st || null);
      })
      .catch(err => setError(err.message));

    const t = setInterval(() => {
      api('/api/sessions').then(setSessions).catch(() => {});
      api('/api/status').then(setStatus).catch(() => {});
    }, 30000);
    return () => clearInterval(t);
  }, []);

  // ── Load session history ─────────────────────────────────────────────────
  useEffect(() => {
    if (!activeSession) { setMessages([]); return; }
    if (skipRef.current === activeSession) { skipRef.current = null; return; }
    let cancelled = false;
    const byId = Object.fromEntries(agents.map(a => [a.id, a.name]));
    api(`/api/sessions/${activeSession}/messages`)
      .then(rows => {
        if (cancelled) return;
        setMessages((rows || []).map(r => ({
          kind: r.role === 'user' ? 'user' : 'agent',
          who:  r.role === 'user' ? 'You' : (r.agent_name || byId[r.agent_id] || 'agent'),
          agent:r.role === 'user' ? null : (r.agent_name || byId[r.agent_id] || 'agent'),
          model:r.model || '',
          t:    r.created_at ? new Date(r.created_at).toLocaleTimeString('en-US',{hour12:true}) : '',
          body: r.content || '',
          streaming: false,
        })));
        const last = [...(rows || [])].reverse().find(r => r.role === 'assistant');
        if (last?.agent_id) setActiveAgent(last.agent_id);
      })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [activeSession]);

  // ── Auto-scroll ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, streaming]);

  // ── Auto-resize textarea ─────────────────────────────────────────────────
  useEffect(() => {
    const ta = taRef.current; if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [draft]);

  // ── Slash autocomplete ───────────────────────────────────────────────────
  const slash = (() => {
    if (!draft.startsWith('/')) return { open: false, matches: [], word: '' };
    const rest = draft.slice(1);
    const sp = rest.indexOf(' ');
    if (sp !== -1) return { open: false, matches: [], word: rest.slice(0, sp) };
    const q = rest.toLowerCase();
    return { open: true, matches: skills.filter(s => s.name.toLowerCase().startsWith(q)).slice(0, 8), word: rest };
  })();

  const acceptSlash = name => setDraft(`/${name} `);

  const expand = text => {
    if (!text.startsWith('/')) return text;
    const [name, ...rest] = text.slice(1).split(/\s+/);
    const sk = skills.find(s => s.name === name);
    if (!sk?.body) return text;
    const args = rest.join(' ').trim();
    return `[Skill: /${sk.name}]\n${sk.body}${args ? `\n\n---\n\n${args}` : ''}`;
  };

  // ── File pick ────────────────────────────────────────────────────────────
  const pickFiles = async files => {
    for (const f of [...files]) {
      if (isImage(f)) {
        const dataUrl = await fileToDataUrl(f);
        setPendingImgs(p => [...p, { name: f.name, dataUrl }]);
      } else if (isText(f)) {
        const text = await fileToText(f);
        setPendingDocs(p => [...p, { name: f.name, text }]);
      } else if (isPdf(f)) {
        setPendingDocs(p => [...p, { name: f.name, text: null }]);
      }
    }
  };

  const onPaste = async e => {
    const imgs = [...(e.clipboardData?.items ?? [])].filter(i => i.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    pickFiles(imgs.map(i => i.getAsFile()).filter(Boolean));
  };

  // ── Voice ────────────────────────────────────────────────────────────────
  const startRec = async () => {
    if (!navigator.mediaDevices?.getUserMedia) { setError('Microphone not supported in this browser'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
                 : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = e => { if (e.data?.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        chunksRef.current = [];
        if (!blob.size) { setRecording(false); return; }
        setRecording(false); setTranscribing(true);
        try {
          const fd = new FormData(); fd.append('file', blob, 'voice.webm');
          const r = await fetch('/api/audio/transcribe', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'x-dashboard-token': TOKEN }, body: fd,
          });
          if (!r.ok) throw new Error(r.status);
          const { text } = await r.json();
          if (text?.trim()) setDraft(d => d ? `${d} ${text.trim()}` : text.trim());
        } catch (err) { setError('Transcription failed: ' + err.message); }
        finally { setTranscribing(false); }
      };
      recorderRef.current = rec; rec.start(); setRecording(true); setError(null);
    } catch (err) { setError('Mic: ' + err.message); }
  };
  const stopRec = () => { const r = recorderRef.current; if (r?.state !== 'inactive') r.stop(); };

  // ── TTS ──────────────────────────────────────────────────────────────────
  const speak = async (msg, idx) => {
    if (playingIdx === idx) { audioRef.current?.pause(); audioRef.current = null; setPlayingIdx(null); return; }
    audioRef.current?.pause(); setPlayingIdx(idx);
    try {
      const agId = agents.find(a => a.name === msg.agent)?.id || activeAgent;
      const r = await fetch('/api/audio/speak', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dashboard-token': TOKEN },
        body: JSON.stringify({ text: msg.body, agentId: agId }),
      });
      if (!r.ok) throw new Error(r.status);
      const url = URL.createObjectURL(await r.blob());
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); audioRef.current = null; setPlayingIdx(null); };
      audio.onerror = () => { URL.revokeObjectURL(url); setPlayingIdx(null); setError('Playback failed'); };
      await audio.play();
    } catch (err) { setPlayingIdx(null); setError('TTS: ' + err.message); }
  };

  // ── Send ─────────────────────────────────────────────────────────────────
  const send = async () => {
    const text = draft.trim();
    if ((!text && !pendingImgs.length && !pendingDocs.length) || streaming) return;

    const attachments = pendingImgs.map(p => ({ url: p.dataUrl, name: p.name }));
    let docPrefix = '';
    for (const d of pendingDocs)
      docPrefix += d.text !== null
        ? `[file: ${d.name}]\n\`\`\`\n${d.text}\n\`\`\`\n\n`
        : `[file: ${d.name} — binary content not extracted]\n\n`;

    const fullText = docPrefix + (text || '');
    const sentText = fullText.startsWith('/') ? expand(fullText) : fullText;
    const slashSkill = text.startsWith('/') && sentText !== fullText ? text.slice(1).split(/\s+/)[0] : null;

    setDraft(''); setPendingImgs([]); setPendingDocs([]); setError(null);

    setMessages(m => [...m, {
      kind: 'user', who: 'You', t: nowTime(),
      body: text || (pendingImgs.length ? `[${pendingImgs.length} image(s)]` : '[file attached]'),
      attachments, docs: pendingDocs.map(d => d.name), slashSkill,
    }]);
    setStreaming(true);
    setMessages(m => {
      liveRef.current = m.length;
      return [...m, { kind:'agent', agent:'…', model:'', t:'…', body:'', streaming:true, activityLog:[{label:'connecting',done:false}] }];
    });

    let buf = '', agentName = null;

    const log = (label, done = false) => setMessages(m => m.map((msg, i) => i !== liveRef.current ? msg : {
      ...msg, activityLog: [...(msg.activityLog||[]).map(e=>({...e,done:true})), {label,done}],
    }));
    const updateLive = () => setMessages(m => m.map((msg, i) => i !== liveRef.current ? msg : {
      ...msg, agent: agentName || msg.agent, body: buf,
    }));

    try {
      const ctrl = new AbortController(); abortRef.current = ctrl;
      const r = await fetch('/api/chat', {
        method: 'POST', credentials: 'same-origin', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-dashboard-token': TOKEN },
        body: JSON.stringify({ message: sentText, sessionId: activeSession, agentId: activeAgent, ...(attachments.length ? { attachments } : {}) }),
      });
      if (!r.body) throw new Error('No SSE stream');
      const reader = r.body.getReader(); const dec = new TextDecoder(); let rbuf = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        rbuf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = rbuf.indexOf('\n\n')) !== -1) {
          const chunk = rbuf.slice(0, idx); rbuf = rbuf.slice(idx + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data: ')); if (!line) continue;
          let evt; try { evt = JSON.parse(line.slice(6)); } catch { continue; }
          if (evt.type === 'session' && !activeSession) {
            skipRef.current = evt.sessionId; setActiveSession(evt.sessionId);
            setSessions(s => s.some(x => x.id === evt.sessionId) ? s : [{ id: evt.sessionId, title: 'New chat', last: 'just now' }, ...s]);
          } else if (evt.type === 'agent') { agentName = evt.name; updateLive(); log('processing'); }
          else if (evt.type === 'chunk') { buf += evt.content; updateLive(); }
          else if (evt.type === 'tool') { log(`tool · ${evt.name}`, true); }
          else if (evt.type === 'done') {
            setMessages(m => m.map((msg, i) => i === liveRef.current ? { ...msg, streaming: false } : msg));
            api('/api/sessions').then(setSessions).catch(() => {});
          } else if (evt.type === 'error') { setError(evt.message); }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
      setMessages(m => m.map((msg, i) => i === liveRef.current ? { ...msg, streaming: false } : msg));
    } finally { abortRef.current = null; setStreaming(false); }
  };

  const stopStream = () => {
    abortRef.current?.abort();
    if (activeSession) fetch('/api/chat/stop', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-dashboard-token': TOKEN },
      body: JSON.stringify({ sessionId: activeSession }),
    }).catch(() => {});
  };

  // ── No token guard ───────────────────────────────────────────────────────
  if (!TOKEN) return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',flexDirection:'column',gap:12,padding:24}}>
      <div style={{color:'var(--accent)',fontSize:18,fontWeight:700}}>NeuroClaw Chat</div>
      <div className="cm-error" style={{margin:0}}>No token — open Chat Mode from the NeuroClaw dashboard.</div>
    </div>
  );

  const initials = 'NC'; // /api/status has no display_name; static badge

  const curSession = sessions.find(s => s.id === activeSession);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="cm-shell">

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <div className="cm-sidebar">
        <div className="cm-sb-hdr">
          <div className="cm-logo"><div className="cm-logo-dot"/>NEUROCLAW</div>
          <button className="cm-new-btn" onClick={() => {
            const def = agents.find(a=>a.name==='A.S.A.G.I')||agents.find(a=>a.name==='Alfred')||agents[0];
            setActiveAgent(def?.id||null); setActiveSession(null); setMessages([]);
          }}>+ New</button>
        </div>
        <div className="cm-sec-lbl">Sessions</div>
        <div className="cm-sessions">
          {sessions.length === 0 && <div style={{padding:'14px 16px',color:'var(--text-dim)',fontSize:11,fontFamily:'var(--mono)'}}>// no sessions yet</div>}
          {sessions.map(s => (
            <div key={s.id} className={'cm-sitem'+(activeSession===s.id?' active':'')} onClick={() => setActiveSession(s.id)}>
              <div className="cm-sitem-title">{s.title||s.id.slice(0,12)}</div>
              <div className="cm-sitem-meta">{s.last||''}</div>
            </div>
          ))}
        </div>
        <div className="cm-sb-foot">
          <div className="cm-av">{initials}</div>
          <div style={{fontSize:11,color:'var(--text-muted)',lineHeight:1.3}}>
            <div>NeuroClaw</div>
            <div style={{fontSize:10,color:'var(--text-dim)'}}>{agents.length} agents · online</div>
          </div>
        </div>
      </div>

      {/* ── Main ────────────────────────────────────────────────────────── */}
      <div className="cm-main">

        {/* Topbar */}
        <div className="cm-topbar">
          <div className="cm-chat-title">{curSession?.title||'New chat'}</div>
          <div className="cm-agent-pill">
            <div className="cm-pdot"/>
            <select value={activeAgent||''} onChange={e=>setActiveAgent(e.target.value)}>
              {agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>

        {/* Thread */}
        <div className="cm-thread" ref={scrollRef}>
          {messages.length===0 && (
            <div className="cm-empty">{activeSession?'// no messages yet':'// start a new chat or select a session'}</div>
          )}
          {messages.map((m,i) => {
            if (m.kind==='user') return (
              <div key={i} className="cm-umsg">
                {((m.attachments?.length||0)+(m.docs?.length||0))>0 && (
                  <div className="cm-attach-row">
                    {(m.attachments||[]).map((a,ai)=><img key={ai} src={a.url} alt={a.name} className="cm-attach-img"/>)}
                    {(m.docs||[]).map((d,di)=><span key={di} className="cm-attach-doc">📄 {d}</span>)}
                  </div>
                )}
                <div className="cm-ububble">{m.body}</div>
                <div className="cm-msg-meta">
                  You · {m.t}
                  {m.slashSkill && <span style={{marginLeft:6,color:'var(--accent-2)'}}>/{m.slashSkill}</span>}
                </div>
              </div>
            );
            const agRec = agents.find(a=>a.name===m.agent);
            const ava = agRec?._raw?.avatar_url||agRec?.avatar_url||null;
            return (
              <div key={i} className="cm-amsg">
                <div className="cm-aav">{ava?<img src={ava} alt={m.agent}/>:(m.agent||'?')[0].toUpperCase()}</div>
                <div className="cm-abody">
                  <div className="cm-ahdr">
                    <span className="cm-albl">{m.agent}</span>
                    {m.model&&<span className="cm-mtag">{m.model}</span>}
                    <span className="cm-msg-meta" style={{marginLeft:'auto'}}>{m.t}</span>
                    {m.body&&!m.streaming&&(
                      <button className="cm-speak-btn" onClick={()=>speak(m,i)} title={playingIdx===i?'Stop':'Read aloud'}>
                        {playingIdx===i?'■':'🔊'}
                      </button>
                    )}
                  </div>
                  {!m.body&&m.streaming&&(m.activityLog?.length||0)>0&&(
                    <div className="cm-activity">
                      {m.activityLog.map((e,ei)=>(
                        <div key={ei} className={'cm-act-row'+(e.done?'':' live')}>
                          <span className={e.done?'':'cm-spin'}>{e.done?'✓':'◌'}</span>
                          <span>{e.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div
                    className="cm-abubble cm-md"
                    ref={el=>{if(el&&m.body)el.innerHTML=renderMarkdown(m.body)}}
                  >
                    {!m.body&&m.streaming&&<span className="cm-cursor"/>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Composer */}
        <div className="cm-composer">
          {error&&(
            <div className="cm-error">
              {error}
              <button onClick={()=>setError(null)} style={{background:'none',border:'none',color:'#e05050',cursor:'pointer',fontSize:16,lineHeight:1}}>×</button>
            </div>
          )}
          <div className="cm-input-wrap">
            {(pendingImgs.length>0||pendingDocs.length>0)&&(
              <div className="cm-pending-row">
                {pendingImgs.map((p,i)=>(
                  <div key={i} className="cm-pending-img-wrap">
                    <img src={p.dataUrl} alt={p.name} className="cm-pending-img"/>
                    <button className="cm-remove-btn" onClick={()=>setPendingImgs(prev=>prev.filter((_,j)=>j!==i))}>×</button>
                  </div>
                ))}
                {pendingDocs.map((d,i)=>(
                  <span key={i} className="cm-doc-badge">
                    📄 {d.name}
                    <button onClick={()=>setPendingDocs(prev=>prev.filter((_,j)=>j!==i))}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div style={{position:'relative'}}>
              {slash.open&&(
                <div className="cm-slash-popup">
                  <div className="cm-slash-lbl">Skills · Tab to insert</div>
                  {slash.matches.map(s=>(
                    <div key={s.name} className="cm-slash-item" onMouseDown={e=>{e.preventDefault();acceptSlash(s.name);}}>
                      <span className="cm-slash-name">/{s.name}</span>
                      {s.description&&<span className="cm-slash-desc">{s.description}</span>}
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={taRef}
                className="cm-textarea"
                value={draft}
                onChange={e=>setDraft(e.target.value)}
                onPaste={onPaste}
                onKeyDown={e=>{
                  if(slash.open&&(e.key==='Tab'||(e.key==='Enter'&&slash.matches[0]?.name!==slash.word))){e.preventDefault();acceptSlash(slash.matches[0].name);return;}
                  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}
                }}
                placeholder={pendingImgs.length+pendingDocs.length>0?'Add a message or press Send…':'Message your agent — / for skills, paste images…'}
                disabled={streaming}
                rows={1}
              />
            </div>
            <div className="cm-actions">
              <input ref={fileRef} type="file" accept="image/*,.txt,.md,.csv,.json,.pdf" multiple
                     style={{display:'none'}} onChange={e=>{pickFiles(e.target.files);e.target.value='';}}/>
              <button className="cm-act-btn" onClick={()=>fileRef.current?.click()} disabled={streaming}>📎 Attach</button>
              <button
                className={'cm-act-btn voice'+(recording?' recording':'')}
                onClick={recording?stopRec:startRec}
                disabled={streaming||transcribing}
                title={recording?'Stop recording':transcribing?'Transcribing…':'Voice input'}
              >{recording?'● REC':transcribing?'…':'🎤 Voice'}</button>
              <div style={{flex:1}}/>
              {streaming
                ? <button className="cm-stop-btn" onClick={stopStream}>■ Stop</button>
                : <button className="cm-send-btn" onClick={send} disabled={streaming}>Send ↑</button>
              }
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<ChatMode/>);
</script>
<script>if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');</script>
</body>
</html>
```

- [ ] **Step 2: Start the dev server**

```bash
npm run dashboard
```

Expected output: `Dashboard listening on http://127.0.0.1:3141`

- [ ] **Step 3: Open Chat Mode in browser and verify shell loads**

Open: `http://localhost:3141/chat-mode?token=<your-DASHBOARD_TOKEN>`

Expected:
- Warm dark background loads (no flash of white)
- Sidebar shows "NEUROCLAW" logo with orange dot
- "Sessions" section visible, either empty or listing existing sessions
- Topbar shows "New chat" and agent picker dropdown populated with your agents
- Composer visible at bottom with Attach / Voice / Send buttons
- No console errors (open DevTools → Console)

- [ ] **Step 4: Send a test message and verify streaming**

Type "hello" in the composer and press Enter.

Expected:
- User bubble appears right-aligned with terracotta tint
- Agent bubble appears with activity log (connecting → processing)
- Text streams in chunk by chunk with blinking cursor
- On completion: cursor disappears, TTS 🔊 button appears
- No errors in console or error banner

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/chat-mode.html
git commit -m "feat(chat-mode): add standalone chat mode HTML app with Claude colors, markdown, voice, file uploads"
```

---

## Task 3: Add "Chat Mode" Button to `page-chat.jsx`

**Files:**
- Modify: `src/dashboard/v2/src/page-chat.jsx:479-481`

The topbar currently ends with the agent picker `<select>`. Add the Chat Mode button immediately after it.

- [ ] **Step 1: Add the button**

Find this block in `page-chat.jsx` (around line 479):

```jsx
          <select className="nc-select" value={activeAgent || ''} onChange={e => setActiveAgent(e.target.value)} style={{ width: 160 }}>
            {AGENTS.map(a => <option key={a.id} value={a.id}>@{a.name}</option>)}
          </select>
```

Replace it with:

```jsx
          <select className="nc-select" value={activeAgent || ''} onChange={e => setActiveAgent(e.target.value)} style={{ width: 160 }}>
            {AGENTS.map(a => <option key={a.id} value={a.id}>@{a.name}</option>)}
          </select>
          <button
            className="nc-btn ghost"
            style={{ padding: '5px 11px', fontSize: 11, whiteSpace: 'nowrap' }}
            title="Open Chat Mode in new tab"
            onClick={() => {
              const t = new URLSearchParams(location.search).get('token')
                     || document.cookie.match(/dashboard-token=([^;]+)/)?.[1]
                     || '';
              window.open('/chat-mode' + (t ? '?token=' + t : ''), '_blank');
            }}
          >
            ⚡ Chat Mode
          </button>
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors. (JSX files are not TypeScript, but `tsc` still type-checks the TS files to confirm nothing regressed.)

- [ ] **Step 3: Verify in dashboard**

Reload `http://localhost:3141/dashboard?token=<token>`, navigate to the Chat tab.

Expected:
- "⚡ Chat Mode" button appears to the right of the agent picker in the chat topbar
- Clicking it opens a new browser tab at `/chat-mode?token=...`
- The new tab loads Chat Mode with sessions and agents already populated

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/v2/src/page-chat.jsx
git commit -m "feat(chat-mode): add Chat Mode launch button to dashboard chat topbar"
```

---

## Task 4: PWA Smoke Test

No code changes — verification only.

- [ ] **Step 1: Verify manifest and service worker**

Open `http://localhost:3141/chat-mode?token=<token>` in Chrome.

Open DevTools → Application tab:
- **Manifest**: Should show "NeuroClaw Chat", theme color `#d97b5e`, icon loaded
- **Service Workers**: `/sw.js` should be registered and active
- **Cache Storage**: `neuroclaw-v1` cache should contain `/chat-mode`, `/chat-mode-manifest.json`, `/icon.svg`

- [ ] **Step 2: Test file attachment**

In Chat Mode:
1. Click **📎 Attach** — select a `.txt` or `.csv` file
2. Expected: filename badge appears above input (e.g., `📄 data.csv`)
3. Send a message — agent should receive the file content as a prefixed code block

Then:
1. Click **📎 Attach** — select an image file (PNG/JPG)
2. Expected: thumbnail preview appears above input
3. Send — agent should receive the image as an attachment

- [ ] **Step 3: Test voice input**

1. Click **🎤 Voice** — browser prompts for microphone permission, grant it
2. Speak a short phrase
3. Click **● REC** to stop
4. Expected: "…" shows while transcribing, then transcribed text appears in the input

- [ ] **Step 4: Test markdown rendering**

Ask your agent a question that produces a markdown response (e.g., "Give me a numbered list of 3 tips for writing good prompts").

Expected: The response renders with numbered list formatting, bold text in `**strong**` renders as bold with terracotta color, any code snippets render in a styled code block with a "Copy" button.

- [ ] **Step 5: Test PWA install on mobile (optional)**

On an iOS or Android device on the same network:
1. Open `http://<your-machine-ip>:3141/chat-mode?token=<token>`
2. iOS Safari: Share → Add to Home Screen → "NC Chat" with terracotta theme color
3. Android Chrome: browser shows "Add to Home Screen" banner or three-dot menu → Install app
4. Launch from home screen — app opens in standalone mode (no browser chrome)
5. Subsequent opens should not require the token (cookie persists from first visit)
