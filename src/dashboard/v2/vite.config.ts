import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vite build config for the NeuroClaw dashboard.
//
// This replaces the browser-side Babel transpile + 36 individual JSX requests
// with a single pre-built, minified bundle served with immutable caching.
//
// Run:  npm run build:dashboard
// Output: src/dashboard/v2/dist/
//
// The Hono server (server.ts) automatically serves dist/index.html when
// dist/ exists, and falls back to the raw JSX + Babel dev path otherwise.

export default defineConfig({
  // Root is the v2 directory (where this config lives).
  root: path.resolve(__dirname),

  // All built asset URLs are prefixed with /dashboard/ so the Hono server
  // can serve them from /dashboard/assets/* without extra rewriting.
  base: '/dashboard/',

  plugins: [
    react({
      // 'classic' JSX transform: converts JSX to React.createElement() calls.
      // NOTE: @vitejs/plugin-react v6+ with classic runtime does NOT auto-inject
      // `import React from 'react'`. Files that call React APIs at module-eval
      // time (e.g. app.jsx's ReactDOM.createRoot().render(<App/>)) must import
      // React explicitly. Page components that only call React.useState etc.
      // inside component functions are fine because those run during React's
      // async render phase, after entry.jsx has set window.React = React.
      jsxRuntime: 'classic',
    }),
  ],

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
    // Chunk size warning threshold — we expect a large bundle since all pages
    // are loaded eagerly. A future step can add lazy-loading per-page.
    chunkSizeWarningLimit: 2000,
  },
});
