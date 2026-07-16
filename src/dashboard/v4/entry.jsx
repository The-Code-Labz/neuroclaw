/**
 * entry.jsx — NeuroClaw dashboard v4 bundle entry point (Vite build)
 *
 * v4 is a visual + structural redesign test. It reuses data modules and most
 * pages from dashboard/v2, but loads a redesigned shell, a redesigned Overview,
 * and a v4-specific app router so the new layout can evolve without touching
 * the production v2 build.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';

window.React    = React;
window.ReactDOM = ReactDOM;

import * as markedModule from 'marked';
window.marked = markedModule;

// ── Eager shell + infra ─────────────────────────────────────────────────────
// v4 loads its own corrected icon set (always visible on dark surfaces), then
// shared data modules and the redesigned shell before the router loads pages.
import './src/icons.jsx';
import '../v2/src/data.jsx';
import '../v2/src/live-data.jsx';
import './src/shell.jsx';
import '../v2/src/page-connect.jsx';
import '../v2/tweaks-panel.jsx';

// ── v4 app router + redesigned Overview page ─────────────────────────────────
import './src/app.jsx';
