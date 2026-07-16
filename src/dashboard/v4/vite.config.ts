import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vite build config for the NeuroClaw dashboard v4 (visual redesign test).
//
// Run:  npm run build:dashboard:v4
// Output: src/dashboard/v4/dist/
//
// The Hono server (server.ts) serves /dashboard-v4 from this dist directory.
// v4 reuses all page logic from ../v2; only index.html's CSS tokens and
// component skin differ.

export default defineConfig({
  // Root is the v4 directory (where this config lives).
  root: path.resolve(__dirname),

  // All built asset URLs are prefixed with /dashboard-v4/ so the Hono server
  // can serve them from /dashboard-v4/assets/* without extra rewriting.
  base: '/dashboard-v4/',

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
    chunkSizeWarningLimit: 2000,
  },
});
