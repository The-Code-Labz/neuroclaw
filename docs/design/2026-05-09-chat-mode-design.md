# Chat Mode — Design Spec
**Date:** 2026-05-09  
**Status:** Approved  

---

## Overview

A full-page, standalone chat UI that opens in a new browser tab from the NeuroClaw dashboard's Chat page. Designed to feel like ChatGPT/Claude/Gemini — voice input, file uploads, markdown rendering, and agent access — while being installable as a PWA for mobile use.

---

## Goals

- Provide a focused, distraction-free chat experience separate from the dashboard chrome
- Support voice input (mic → transcription) and TTS playback
- Support image and document file attachments
- Render agent responses as full markdown (bold, code blocks, lists, tables)
- Be installable as a PWA on mobile (iOS and Android) so users can open it from their home screen
- Leave a hook for future LiveKit-based live voice mode (same pattern as NeuroRoom)

---

## Implementation Strategy

**Option A — New standalone HTML page at `/chat-mode`** (chosen).

A single self-contained `chat-mode.html` file is served by a new Hono route. It is its own React mini-app with inline CSS, no dashboard chrome, and no shared CSS conflicts. The existing `/api/*` endpoints are reused without modification.

---

## Architecture

### New Files
| File | Purpose |
|------|---------|
| `src/dashboard/chat-mode.html` | Standalone React app — full Chat Mode UI |

### Modified Files
| File | Change |
|------|--------|
| `src/dashboard/server.ts` | Add `GET /chat-mode` route (token + cookie auth), add `GET /chat-mode-manifest.json` route, update `/sw.js` to cache `/chat-mode` |
| `src/dashboard/v2/src/page-chat.jsx` | Add "Chat Mode" button to the topbar that opens `/chat-mode?token=<token>` in a new tab |

### Token / Auth Flow
1. Dashboard "Chat Mode" button calls `window.open('/chat-mode?token=' + token, '_blank')`
2. `/chat-mode` route validates token via URL param OR `dashboard-token` cookie (same check as `/dashboard`)
3. On valid token: sets `dashboard-token` cookie (1 year, HttpOnly, SameSite=Strict, Path=/)
4. PWA cold-launches at `/chat-mode` (no token) — cookie handles auth transparently
5. Missing/wrong token: renders an inline error banner; API calls return 401

### Data Flow (no new backend endpoints)
| Operation | Endpoint |
|-----------|---------|
| Load agents | `GET /api/agents` |
| Load sessions | `GET /api/sessions` |
| Load session history | `GET /api/sessions/:id/messages` |
| Send message / stream | `POST /api/chat` → SSE |
| Voice transcription | `POST /api/audio/transcribe` |
| TTS playback | `POST /api/audio/speak` |
| Live agent status | `GET /api/status` |

All fetch calls attach the token via `x-dashboard-token` header (read from URL param on load, stored in a module-level variable).

---

## UI Components

### Layout: Option A — Sidebar + Main
```
┌──────────────┬─────────────────────────────────────────┐
│  ① Sidebar   │  ② Topbar                               │
│   Header     │  Session title · Agent pill · Chat Mode │
├──────────────┤─────────────────────────────────────────┤
│  ③ Session   │  ④ Message Thread                       │
│   List       │  SSE streaming · marked.js markdown     │
│              │  User bubbles (right) · Agent (left)    │
│              │  TTS speak button per message            │
├──────────────┤─────────────────────────────────────────┤
│  ⑥ Footer   │  ⑤ Composer                             │
│  Avatar +   │  Text · Attach · Voice · /Skills · Send  │
│  Agent count│                                           │
└──────────────┴─────────────────────────────────────────┘
```

### ① Sidebar Header
- NeuroClaw logo (dot + wordmark) on the left
- "**+ New**" button on the right — resets active session and agent to defaults

### ② Topbar
- Session title (current session name, or "New chat")
- Agent picker pill — dropdown showing all active agents, current agent highlighted with a glowing dot
- **"⚡ Chat Mode"** button in `page-chat.jsx` — `window.open('/chat-mode?token=...', '_blank')`

### ③ Session List
- Fetched from `GET /api/sessions` on mount, polled every 30s
- Each item: session title, agent name, relative time
- Active session: left border accent + subtle background tint
- Click → loads history via `GET /api/sessions/:id/messages`

### ④ Message Thread
- **User bubbles**: right-aligned, terracotta-tinted background, rounded `16px 16px 4px 16px`
- **Agent bubbles**: left-aligned with avatar, activity log during streaming, markdown body
- **Activity log**: shown while `body === ''` and `streaming === true` — same spinner/checkmark pattern as existing chat
- **Markdown**: `marked.parse(body)` → `innerHTML` on the bubble's content div; re-rendered on every SSE `chunk` event
- **Code blocks**: rendered with a small "copy" button (Clipboard API)
- **TTS button**: appears on completed (non-streaming) agent messages; same `POST /api/audio/speak` flow as existing chat
- **Auto-scroll**: scrolls to bottom on new messages and streaming updates

### ⑤ Composer
Multi-line input box styled with a rounded border that glows on focus.

**Action buttons (bottom row of input box):**
- **📎 Attach** — opens hidden `<input type="file">` accepting images + text documents
- **🎤 Voice** — toggles mic recording; same MediaRecorder → `/api/audio/transcribe` flow as existing chat. Shows "● REC" in red while recording, "…" while transcribing.
- **/ Skills** — opens slash-command autocomplete popup (same logic as existing chat)
- **Send ↑** — submits; Enter key also sends (Shift+Enter for newline)

**File attachment preview:**
- Images: thumbnail strip above the input, with × to remove each
- Documents: filename badge (e.g., `📄 report.csv`) with × to remove

**Slash-command autocomplete:**
- Same popup behavior as existing chat — `/` triggers it, Tab or Enter inserts
- Fetches skills list from `window.NC_DATA?.SKILLS` (populated from `GET /api/skills` on mount)

**Voice mode hook (future):**
- A "🎙 Live" toggle button in the topbar (initially hidden/disabled) will activate LiveKit-based continuous voice mode using the same room pattern as NeuroRoom
- Design reserves space for it; implementation is a future phase

### ⑥ Sidebar Footer
- User avatar circle: initials from `display_name` field in `GET /api/status` response, falling back to `"NC"` if absent
- Agent count + online status from `GET /api/status`

---

## Color System — Claude-inspired Warm Dark

```css
--bg-dark:      #1a1814;   /* sidebar background */
--bg-main:      #201e1b;   /* main area background */
--bg-topbar:    #1c1a17;   /* topbar + composer background */
--bg-input:     #161412;   /* composer input background */

--text:         #f0ece4;   /* primary text */
--text-soft:    #c8c4bc;   /* secondary text / agent bubble body */
--text-muted:   #9a9490;   /* inactive sessions, placeholders */
--text-dim:     #6b6560;   /* timestamps, labels, metadata */

--accent:       #d97b5e;   /* terracotta — primary accent (agent name, active session border, send button, logo dot) */
--accent-2:     #c9a56a;   /* warm amber — secondary accent (Inspector button, mic button) */

--border:       rgba(255,240,210,0.07);   /* default panel borders */
--border-soft:  rgba(255,240,210,0.05);   /* subtler dividers */
--border-input: rgba(255,240,210,0.12);   /* composer input border */
--border-focus: rgba(217,123,94,0.40);    /* input focus ring */

--user-bubble-bg:     rgba(217,123,94,0.15);
--user-bubble-border: rgba(217,123,94,0.30);
--agent-bubble-bg:    rgba(255,240,210,0.04);
--agent-bubble-border:rgba(255,240,210,0.08);
```

Typography: `Space Grotesk` (body), `JetBrains Mono` (code, timestamps, tags) — both already loaded by the main dashboard via Google Fonts CDN.

---

## File Handling

### Images
- Accepted: `image/png`, `image/jpeg`, `image/gif`, `image/webp`
- `FileReader.readAsDataURL()` → base64 data URL
- Sent in `/api/chat` body as `attachments: [{ url: dataUrl, name: filename }]`
- Preview: thumbnail strip above composer input

### Text Documents
- Accepted: `.txt`, `.md`, `.csv`, `.json` (by MIME type + extension)
- `FileReader.readAsText()` → UTF-8 string
- Max 100 KB extracted; if larger, truncated with appended `\n[truncated — file exceeds 100KB]`
- Injected at the top of the sent message as:
  ```
  [file: filename.csv]
  ```
  ```
  {file content}
  ```
- The user's typed text follows below the file block

### PDFs
- Shown as a filename badge: `📄 document.pdf`
- Injected into message as: `[file: document.pdf — binary content not extracted]`
- Full PDF text extraction deferred to a future iteration (requires server-side parsing)

---

## Markdown Rendering

- Parser: `marked.js` v9 via CDN (`https://cdn.jsdelivr.net/npm/marked@9/marked.min.js`)
- Configuration: `marked.setOptions({ breaks: true, gfm: true })`
- Rendered with `element.innerHTML = marked.parse(accumulatedBuffer)`
- Re-rendered on every SSE `chunk` event (Marked is synchronous and fast; no debouncing needed)
- Code blocks: a `<button class="copy-btn">Copy</button>` is injected after each `<pre><code>` block via a post-render DOM pass
- No HTML sanitization — agent output is trusted internal content

---

## PWA

### Meta Tags in `chat-mode.html`
```html
<link rel="manifest" href="/chat-mode-manifest.json">
<meta name="theme-color" content="#d97b5e">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="NC Chat">
<link rel="apple-touch-icon" href="/icon.svg">
```

### `/chat-mode-manifest.json` Route (new, in `server.ts`)
```json
{
  "name": "NeuroClaw Chat",
  "short_name": "NC Chat",
  "description": "Talk to your AI agents",
  "start_url": "/chat-mode",
  "scope": "/chat-mode",
  "display": "standalone",
  "background_color": "#1a1814",
  "theme_color": "#d97b5e",
  "icons": [{ "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable" }]
}
```

### Auth Cookie
The `/chat-mode` route handler mirrors the `/dashboard` pattern:
- Accept token via `?token=` query param OR `dashboard-token` cookie
- On valid token from URL: set `dashboard-token` cookie (1 year, HttpOnly, SameSite=Strict, Path=/)
- PWA installed on home screen opens `/chat-mode` with no token; cookie satisfies auth

### Service Worker Update (`/sw.js` in `server.ts`)
Add `/chat-mode` to the `SHELL` array so the app shell is cached for offline load:
```js
const SHELL = ['/manifest.json', '/chat-mode-manifest.json', '/icon.svg', '/favicon.svg', '/chat-mode'];
```

### SW Registration (in `chat-mode.html`)
```js
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
```

---

## The "Chat Mode" Button (in `page-chat.jsx`)

Added to the existing topbar, right of the agent picker:

```jsx
<button
  className="nc-btn ghost"
  style={{ padding: '5px 11px', fontSize: 11 }}
  title="Open Chat Mode in new tab"
  onClick={() => {
    const token = new URLSearchParams(location.search).get('token') 
                  || document.cookie.match(/dashboard-token=([^;]+)/)?.[1] 
                  || '';
    window.open('/chat-mode' + (token ? '?token=' + token : ''), '_blank');
  }}
>
  ⚡ Chat Mode
</button>
```

---

## Out of Scope (this phase)

- LiveKit live voice mode (reserved; button slot exists in topbar)
- PDF text extraction (filename badge only)
- Offline chat history (SW caches shell only; messages require network)
- Message editing or regeneration
- Conversation search
- Custom agent personas or system prompt editing from Chat Mode
