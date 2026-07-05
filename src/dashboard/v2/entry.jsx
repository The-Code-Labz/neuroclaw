/**
 * entry.jsx — NeuroClaw dashboard bundle entry point (Vite build)
 *
 * This file is the entry for `npm run build:dashboard`. It:
 * 1. Imports React/ReactDOM and exposes them as globals (window.React etc.)
 *    so that page components — which reference React.useState, React.useEffect,
 *    etc. without explicit imports — continue to work unchanged.
 * 2. Imports `marked` and `livekit-client` from npm (replacing CDN scripts).
 * 3. Imports all page modules in the exact order they appear as <script> tags
 *    in NeuroClaw.html, preserving the global assignment dependency chain
 *    (e.g. window.NC_DATA set in data.jsx before live-data.jsx reads it).
 */

import React from 'react';
import ReactDOM from 'react-dom/client';

// Make React available as a global so page components can call React.useState,
// React.useEffect, etc. without importing React themselves.
window.React    = React;
window.ReactDOM = ReactDOM;

// marked — used as window.marked.parse() in page-chat.jsx and page-docs.jsx.
// Kept eager (shared) so both the chat and docs chunks can use window.marked.
import * as markedModule from 'marked';
window.marked = markedModule;

// NOTE: livekit-client is NO LONGER imported here. It is heavy (~hundreds of KB)
// and used only by page-neuroroom.jsx, which now imports it itself so Vite emits
// it inside the neuroroom chunk (loaded on demand). See §3.4.

// ── Eager shell + infra (the entry chunk) ──────────────────────────────────
// These set window globals (Icon, NC_DATA, NC_API, Section, useTweaks, etc.) that
// every lazily-loaded page chunk reads via the global object. They MUST stay in
// the entry chunk and load before any page renders. page-connect.jsx stays eager
// too: it defines ConnectScreen, which app.jsx references directly (not via the
// window-global convention), so they must share the entry chunk's scope.
// Order matters: each module may read globals set by an earlier one.
import './src/icons.jsx';
import './src/data.jsx';
import './src/live-data.jsx';
import './src/shell.jsx';
import './src/page-connect.jsx';
import './tweaks-panel.jsx';

// ── Pages are code-split ────────────────────────────────────────────────────
// app.jsx's PAGES map lazy-loads each page chunk on first navigation via
// lazyPage(). No eager page imports here — that is the whole point of §3.4.
import './src/app.jsx';
