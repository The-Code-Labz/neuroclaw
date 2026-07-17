import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { transformSync } from 'esbuild';

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

// ── Theme token CSS, generated from the registry ────────────────────────────
// src/themes/registry.ts is the single source of truth for theme tokens.
// This plugin evaluates it at build/dev time (via esbuild, already a Vite
// dependency) and exposes the generated CSS as a virtual module so no CSS
// file ever has to be hand-kept in sync with the registry.
function themeTokensPlugin(): Plugin {
  const virtualId = 'virtual:theme-tokens.css';
  const resolvedId = '\0' + virtualId;
  const registryPath = path.resolve(__dirname, 'src/themes/registry.ts');

  function generate(): string {
    const source = fs.readFileSync(registryPath, 'utf-8');
    const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
    const mod = { exports: {} as Record<string, any> };
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', 'require', code)(mod, mod.exports, require);
    // Emit all THREE axes into the same virtual module: color themes, then
    // layout presets, then design (shape) packs. Single stylesheet + single
    // import in entry.jsx = one deterministic order, no cross-stylesheet
    // cascade race (ASAGI blocker #5). No conflict: --shell-*/--chat-* live
    // ONLY in layouts, --radius-*/--btn-* live ONLY in designs — none of the
    // three axes ever defines the same custom property, so source order
    // between them is irrelevant (kept theme→layout→design for readability).
    const themeCss = mod.exports.generateThemeCss(mod.exports.THEMES);
    const layoutCss = mod.exports.generateLayoutCss(mod.exports.LAYOUTS);
    const designCss = mod.exports.generateDesignCss(mod.exports.DESIGNS);
    return themeCss + '\n' + layoutCss + '\n' + designCss;
  }

  return {
    name: 'vite-plugin-theme-tokens',
    resolveId(id) {
      if (id === virtualId) return resolvedId;
    },
    load(id) {
      if (id === resolvedId) return generate();
    },
    configureServer(server) {
      // Regenerate + hot-reload the virtual CSS whenever registry.ts changes.
      server.watcher.add(registryPath);
      server.watcher.on('change', (file) => {
        if (file === registryPath) {
          const mod = server.moduleGraph.getModuleById(resolvedId);
          if (mod) server.reloadModule(mod);
        }
      });
    },
  };
}

export default defineConfig({
  // Root is the v2 directory (where this config lives).
  root: path.resolve(__dirname),

  // All built asset URLs are prefixed with /dashboard/ so the Hono server
  // can serve them from /dashboard/assets/* without extra rewriting.
  base: '/dashboard/',

  plugins: [
    themeTokensPlugin(),
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
