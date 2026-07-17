/**
 * themes/registry.ts — single source of truth for the NeuroClaw dashboard
 * theme engine.
 *
 * A "theme" is a named CSS custom-property surface. Nothing else changes —
 * no layout, no routing, no component logic. Each entry's `tokens` map is
 * emitted verbatim as `:root[data-theme="<id>"] { --k: v; ... }` (see
 * `generateThemeCss` below), plus a non-root `[data-theme="<id>"]` copy of
 * the same rule so any element (e.g. a swatch preview chip in the picker)
 * can locally scope itself to a theme's colors without touching
 * `document.documentElement`.
 *
 * Adding a new theme (Asia's Sanctuary / Phosphor / Glacier) is exactly:
 * push one more `ThemeDef` onto `THEMES`. No other file needs to change —
 * the registry drives the generated CSS (via the Vite virtual-module plugin
 * in vite.config.ts) and the live picker in page-settings.jsx's ThemesTab.
 */

export type ThemeMode = 'dark' | 'light';

export interface ThemePreview {
  /** Page background — used for the swatch's own background. */
  bg: string;
  /** A panel/surface color — used for the swatch's inner chip. */
  surface: string;
  /** The theme's accent — used for the swatch's highlight dot. */
  accent: string;
  /** Primary text color — used for the swatch's label dot contrast check. */
  text: string;
}

export interface ThemeDef {
  id: string;
  label: string;
  description: string;
  mode: ThemeMode;
  /** Small metadata used to render the swatch preview without duplicating
   *  the full token surface in JS — actual swatch coloring is done via CSS
   *  vars scoped to `[data-theme]`, this is just for sorting/labels/a11y. */
  preview: ThemePreview;
  /** Full CSS custom-property surface for this theme, keyed by `--var-name`.
   *  Values may reference other tokens in the same theme via `var(--x)` —
   *  they're emitted into the same CSS rule so that resolves correctly. */
  tokens: Record<string, string>;
}

export const DEFAULT_THEME_ID = 'neon-grid';

// ── Neon Grid — current live v2 look ("v3") ─────────────────────────────────
// Verbatim port of the :root block that used to live inline in
// src/dashboard/v2/index.html (the "Hybrid palette (v3)" block).
const NEON_GRID: ThemeDef = {
  id: 'neon-grid',
  label: 'Neon Grid',
  description: 'Cyberpunk magenta/cyan neon on black. The original v3 look.',
  mode: 'dark',
  preview: { bg: '#0b0f14', surface: '#10161e', accent: '#00b7ff', text: '#e6f1f8' },
  tokens: {
    '--bg-0': '#0b0f14',
    '--bg-1': '#0e131a',
    '--panel': '#10161e',
    '--line': '#1c2733',
    '--line-soft': '#161f29',
    '--text': '#e6f1f8',
    '--text-soft': '#8fa3b3',
    '--muted': '#5b6b7a',
    '--muted-2': '#33424f',
    '--accent': '#00b7ff',
    '--accent-2': '#00f5d4',
    '--violet': '#a78bfa',
    '--amber': '#e8b341',
    '--danger': '#fb3b5f',
    '--boundary': '#e0a949',
    '--green': '#2dd4a7',
    '--line-hard': '#26323f',
    '--glow-neon': '0 0 0 1px var(--line-hard)',
    '--glow-soft': 'none',
    '--mono': "'JetBrains Mono', ui-monospace, monospace",
    '--display': "'Space Grotesk', system-ui, sans-serif",
    // Text painted directly on a solid --accent/--accent-2 surface (buttons,
    // avatar badges). White reads well against this theme's bright cyan-blue
    // accent; Odyssey's lighter accent needs the opposite (near-black), which
    // is exactly why this is its own token rather than reusing --text.
    '--icon-on-accent': '#fff',
    // Shell dimensions (--shell-*) and chat height (--chat-h/--chat-min-h) are
    // NO LONGER defined per color-theme. They are owned exclusively by the
    // LAYOUTS registry below (data-layout axis) — a color theme sets palette,
    // a layout sets structure. Single source of truth = no drift.
  },
};

// ── Odyssey — v4 redesign token set ─────────────────────────────────────────
// Verbatim port of the :root block from src/dashboard/v4/v4.css (lines 1-106:
// the token block + "legacy aliases so inline styles and v2 pages keep
// rendering" block), so existing v2 pages/components render unchanged.
const ODYSSEY: ThemeDef = {
  id: 'odyssey',
  label: 'Odyssey',
  description: 'Warm charcoal + vivid cyan-blue. The v4 redesign token set.',
  mode: 'dark',
  preview: { bg: '#0E1015', surface: '#181C24', accent: '#5BCEFF', text: '#F4F4F5' },
  tokens: {
    // Backgrounds
    '--bg-canvas': '#0E1015',
    '--bg-base': '#13161C',
    '--surface-1': '#181C24',
    '--surface-2': '#20252F',
    '--surface-elevated': '#2A303C',
    // Text
    '--text-primary': '#F4F4F5',
    '--text-secondary': '#C4C5C9',
    '--text-tertiary': '#8B8B94',
    '--text-disabled': '#6A6B72',
    '--text-inverted': '#0B0C10',
    // Borders
    '--border-subtle': 'rgba(244, 244, 245, 0.08)',
    '--border-default': 'rgba(244, 244, 245, 0.16)',
    '--border-strong': 'rgba(244, 244, 245, 0.28)',
    // Accent
    '--accent': '#5BCEFF',
    '--accent-hover': '#7DD8FF',
    '--accent-active': '#4AA8E0',
    '--accent-soft': 'rgba(91, 206, 255, 0.14)',
    '--accent-soft-strong': 'rgba(91, 206, 255, 0.26)',
    // Semantic
    '--success': '#6EE7B7',
    '--warning': '#FCD34D',
    '--error': '#FCA5A5',
    '--info': 'var(--accent)',
    // Icon ramp
    '--icon-default': '#BFC1C7',
    '--icon-hover': '#F4F4F5',
    '--icon-active': 'var(--accent)',
    '--icon-disabled': '#6A6B72',
    '--icon-on-accent': 'var(--text-inverted)',
    // Interaction states
    '--state-hover-bg': 'rgba(237, 242, 247, 0.06)',
    '--state-active-bg': 'rgba(237, 242, 247, 0.10)',
    '--focus-ring': '0 0 0 2px rgba(91, 206, 255, 0.40)',
    // Legacy aliases — keep every existing v2 var name resolvable
    '--accent-2': 'var(--accent)',
    '--accent-muted-bg': 'var(--accent-soft)',
    '--green': 'var(--success)',
    '--amber': 'var(--warning)',
    '--danger': 'var(--error)',
    '--violet': 'var(--accent)',
    '--boundary': 'var(--warning)',
    '--text': 'var(--text-primary)',
    '--text-soft': 'var(--text-secondary)',
    '--text-muted': 'var(--text-tertiary)',
    '--muted': 'var(--text-tertiary)',
    '--muted-2': 'var(--text-disabled)',
    '--bg-void': 'var(--bg-canvas)',
    '--bg-0': 'var(--bg-canvas)',
    '--bg-1': 'var(--bg-base)',
    '--bg-hover': 'var(--state-hover-bg)',
    '--bg-elevated': 'var(--surface-2)',
    '--panel': 'var(--surface-1)',
    '--line': 'var(--border-default)',
    '--line-soft': 'var(--border-subtle)',
    '--line-hard': 'var(--border-strong)',
    '--border': 'var(--border-default)',
    // Elevation
    '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.24)',
    '--shadow-md': '0 4px 12px rgba(0, 0, 0, 0.28)',
    '--shadow-lg': '0 12px 32px rgba(0, 0, 0, 0.36)',
    '--glow-soft': 'none',
    '--glow-neon': 'inset 0 0 0 1px var(--border-strong)',
    // Type
    '--mono': "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    '--display': "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    // Radius
    '--radius-sm': '10px',
    '--radius-md': '14px',
    '--radius-lg': '18px',
    '--radius-xl': '24px',
    '--radius-full': '999px',
    // Shell dimensions + chat height now owned by the LAYOUTS registry (see below).
  },
};

// ── Sanctuary — light warm cream/paper + brass ──────────────────────────────
// Token values from Asia's design deliverable (task 0b97b164,
// docs/design/theme-palettes/dashboard-theme-palettes-v1.md §1). Body text
// 13.4:1 / 14.2:1 (AAA); accent/status colors verified AA or AA-large — see
// that doc's contrast table. Mapped 1:1 onto the Odyssey token surface below.
// --text-tertiary corrected 2026-07-14 (A.S.A.G.I gate + Asia ruling):
// original #8A7E68 on #F4EFE6 = 3.48:1, fails AA. #6A5F4D = 4.74:1.
const SANCTUARY: ThemeDef = {
  id: 'sanctuary',
  label: 'Sanctuary',
  description: 'Warm parchment, brass, ink. A reading room at 4pm — calm and unhurried.',
  mode: 'light',
  preview: { bg: '#F4EFE6', surface: '#FBF8F1', accent: '#B8862B', text: '#2C2418' },
  tokens: {
    // Backgrounds
    '--bg-canvas': '#F4EFE6',
    '--bg-base': '#F4EFE6',
    '--surface-1': '#FBF8F1',
    '--surface-2': '#F0E9DC',
    '--surface-elevated': '#E8DFCE',
    // Text
    '--text-primary': '#2C2418',
    '--text-secondary': '#5A4F3D',
    '--text-tertiary': '#6A5F4D',
    '--text-disabled': '#A99C86',
    '--text-inverted': '#FBF8F1',
    // Borders
    '--border-subtle': '#E1D7C2',
    '--border-default': '#D0C3A6',
    '--border-strong': '#B8A98A',
    // Accent
    '--accent': '#B8862B',
    '--accent-hover': '#C99535',
    '--accent-active': '#9D721F',
    '--accent-soft': 'rgba(184, 134, 43, 0.12)',
    '--accent-soft-strong': 'rgba(184, 134, 43, 0.24)',
    // Semantic
    '--success': '#5E7A3F',
    '--warning': '#C68A2E',
    '--error': '#A8472E',
    '--info': '#6B7D8C',
    // Icon ramp
    '--icon-default': '#6B5F4A',
    '--icon-hover': '#2C2418',
    '--icon-active': 'var(--accent)',
    '--icon-disabled': '#8A7E68',
    '--icon-on-accent': 'var(--text-inverted)',
    // Interaction states
    '--state-hover-bg': 'rgba(44, 36, 24, 0.05)',
    '--state-active-bg': 'rgba(44, 36, 24, 0.09)',
    '--focus-ring': '0 0 0 2px rgba(184, 134, 43, 0.40)',
    // Legacy aliases
    '--accent-2': 'var(--accent)',
    '--accent-muted-bg': 'var(--accent-soft)',
    '--green': 'var(--success)',
    '--amber': 'var(--warning)',
    '--danger': 'var(--error)',
    '--violet': '#8B6B9E',
    '--boundary': 'var(--warning)',
    '--text': 'var(--text-primary)',
    '--text-soft': 'var(--text-secondary)',
    '--text-muted': 'var(--text-tertiary)',
    '--muted': 'var(--text-tertiary)',
    '--muted-2': 'var(--text-disabled)',
    '--bg-void': 'var(--bg-canvas)',
    '--bg-0': 'var(--bg-canvas)',
    '--bg-1': 'var(--bg-base)',
    '--bg-hover': 'var(--state-hover-bg)',
    '--bg-elevated': 'var(--surface-2)',
    '--panel': 'var(--surface-1)',
    '--line': 'var(--border-default)',
    '--line-soft': 'var(--border-subtle)',
    '--line-hard': 'var(--border-strong)',
    '--border': 'var(--border-default)',
    // Elevation
    '--shadow-sm': '0 1px 2px rgba(46, 36, 24, 0.06), 0 1px 4px rgba(46, 36, 24, 0.04)',
    '--shadow-md': '0 4px 12px rgba(46, 36, 24, 0.08), 0 2px 6px rgba(46, 36, 24, 0.05)',
    '--shadow-lg': '0 12px 32px rgba(46, 36, 24, 0.10), 0 4px 12px rgba(46, 36, 24, 0.06)',
    '--glow-soft': 'none',
    '--glow-neon': 'inset 0 0 0 1px var(--border-strong)',
    // Type — reuses the same preloaded font stacks as Neon Grid/Odyssey
    '--mono': "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    '--display': "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    // Radius
    '--radius-sm': '10px',
    '--radius-md': '14px',
    '--radius-lg': '18px',
    '--radius-xl': '24px',
    '--radius-full': '999px',
    // Shell dimensions + chat height now owned by the LAYOUTS registry (see below).
  },
};

// ── Phosphor — green terminal/matrix on near-black ──────────────────────────
// RESOLVED 2026-07-14 (A.S.A.G.I gate): Asia's task-0b97b164 deliverable
// predates this registry and used an earlier brief's amber/copper naming for
// "Phosphor" (that palette wasn't discarded — it just needs a different
// name). Asia has ruled this branch's on-tree green-matrix definition is
// canonical for "Phosphor" going forward. WCAG ratios computed and verified
// below.
const PHOSPHOR: ThemeDef = {
  id: 'phosphor',
  label: 'Phosphor',
  description: 'Matrix green on near-black. Late-night terminal, high focus, low glare.',
  mode: 'dark',
  preview: { bg: '#080A08', surface: '#10140F', accent: '#39FF6A', text: '#C8FFCE' },
  tokens: {
    // Backgrounds
    '--bg-canvas': '#080A08',
    '--bg-base': '#0C0F0C',
    '--surface-1': '#10140F',
    '--surface-2': '#161C15',
    '--surface-elevated': '#1E261C',
    // Text
    '--text-primary': '#C8FFCE',
    '--text-secondary': '#8FE39B',
    '--text-tertiary': '#5B9463',
    '--text-disabled': '#3D5C42',
    '--text-inverted': '#051006',
    // Borders
    '--border-subtle': 'rgba(184, 255, 190, 0.08)',
    '--border-default': 'rgba(184, 255, 190, 0.16)',
    '--border-strong': 'rgba(184, 255, 190, 0.30)',
    // Accent
    '--accent': '#39FF6A',
    '--accent-hover': '#5CFF87',
    '--accent-active': '#22CC4E',
    '--accent-soft': 'rgba(57, 255, 106, 0.14)',
    '--accent-soft-strong': 'rgba(57, 255, 106, 0.26)',
    // Semantic
    '--success': '#34D399',
    '--warning': '#FFD166',
    '--error': '#FF5C5C',
    '--info': '#5BCEFF',
    // Icon ramp
    '--icon-default': '#7FBF87',
    '--icon-hover': '#C8FFCE',
    '--icon-active': 'var(--accent)',
    '--icon-disabled': '#3D5C42',
    '--icon-on-accent': 'var(--text-inverted)',
    // Interaction states
    '--state-hover-bg': 'rgba(57, 255, 106, 0.06)',
    '--state-active-bg': 'rgba(57, 255, 106, 0.10)',
    '--focus-ring': '0 0 0 2px rgba(57, 255, 106, 0.45)',
    // Legacy aliases
    '--accent-2': 'var(--accent)',
    '--accent-muted-bg': 'var(--accent-soft)',
    '--green': 'var(--success)',
    '--amber': 'var(--warning)',
    '--danger': 'var(--error)',
    '--violet': '#9B7FE8',
    '--boundary': 'var(--warning)',
    '--text': 'var(--text-primary)',
    '--text-soft': 'var(--text-secondary)',
    '--text-muted': 'var(--text-tertiary)',
    '--muted': 'var(--text-tertiary)',
    '--muted-2': 'var(--text-disabled)',
    '--bg-void': 'var(--bg-canvas)',
    '--bg-0': 'var(--bg-canvas)',
    '--bg-1': 'var(--bg-base)',
    '--bg-hover': 'var(--state-hover-bg)',
    '--bg-elevated': 'var(--surface-2)',
    '--panel': 'var(--surface-1)',
    '--line': 'var(--border-default)',
    '--line-soft': 'var(--border-subtle)',
    '--line-hard': 'var(--border-strong)',
    '--border': 'var(--border-default)',
    // Elevation
    '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.32), 0 1px 4px rgba(0, 0, 0, 0.18)',
    '--shadow-md': '0 4px 12px rgba(0, 0, 0, 0.40), 0 2px 6px rgba(0, 0, 0, 0.22)',
    '--shadow-lg': '0 12px 32px rgba(0, 0, 0, 0.50), 0 4px 12px rgba(0, 0, 0, 0.30)',
    '--glow-soft': '0 0 24px rgba(57, 255, 106, 0.10)',
    '--glow-neon': 'inset 0 0 0 1px var(--border-strong)',
    // Type — mono-forward display stack fits the terminal read
    '--mono': "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    '--display': "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    // Radius
    '--radius-sm': '10px',
    '--radius-md': '14px',
    '--radius-lg': '18px',
    '--radius-xl': '24px',
    '--radius-full': '999px',
    // Shell dimensions + chat height now owned by the LAYOUTS registry (see below).
  },
};

// ── Glacier — cool nordic slate, calm professional dark ─────────────────────
// RESOLVED 2026-07-14 (A.S.A.G.I gate): same reconciliation as Phosphor
// above — Asia's earlier-brief deliverable used "Glacier" for a cool-light
// palette; Asia has ruled this branch's on-tree cool-nordic-slate DARK
// definition is canonical going forward. WCAG ratios computed and verified
// below.
const GLACIER: ThemeDef = {
  id: 'glacier',
  label: 'Glacier',
  description: 'Cool nordic slate. Calm, professional, low-chroma dark workspace.',
  mode: 'dark',
  preview: { bg: '#10151C', surface: '#1B222D', accent: '#7FB5E0', text: '#E5EAF0' },
  tokens: {
    // Backgrounds
    '--bg-canvas': '#10151C',
    '--bg-base': '#151B24',
    '--surface-1': '#1B222D',
    '--surface-2': '#232B38',
    '--surface-elevated': '#2C3644',
    // Text
    '--text-primary': '#E5EAF0',
    '--text-secondary': '#B4BFCC',
    '--text-tertiary': '#7C8B9C',
    '--text-disabled': '#566171',
    '--text-inverted': '#0D1117',
    // Borders
    '--border-subtle': 'rgba(229, 234, 240, 0.07)',
    '--border-default': 'rgba(229, 234, 240, 0.14)',
    '--border-strong': 'rgba(229, 234, 240, 0.24)',
    // Accent
    '--accent': '#7FB5E0',
    '--accent-hover': '#96C4EC',
    '--accent-active': '#5A8FC2',
    '--accent-soft': 'rgba(127, 181, 224, 0.14)',
    '--accent-soft-strong': 'rgba(127, 181, 224, 0.26)',
    // Semantic
    '--success': '#A3BE8C',
    '--warning': '#EBCB8B',
    '--error': '#C56872',
    '--info': 'var(--accent)',
    // Icon ramp
    '--icon-default': '#9FB0C2',
    '--icon-hover': '#E5EAF0',
    '--icon-active': 'var(--accent)',
    '--icon-disabled': '#566171',
    '--icon-on-accent': 'var(--text-inverted)',
    // Interaction states
    '--state-hover-bg': 'rgba(229, 234, 240, 0.05)',
    '--state-active-bg': 'rgba(229, 234, 240, 0.09)',
    '--focus-ring': '0 0 0 2px rgba(127, 181, 224, 0.40)',
    // Legacy aliases
    '--accent-2': 'var(--accent)',
    '--accent-muted-bg': 'var(--accent-soft)',
    '--green': 'var(--success)',
    '--amber': 'var(--warning)',
    '--danger': 'var(--error)',
    '--violet': '#B48EAD',
    '--boundary': 'var(--warning)',
    '--text': 'var(--text-primary)',
    '--text-soft': 'var(--text-secondary)',
    '--text-muted': 'var(--text-tertiary)',
    '--muted': 'var(--text-tertiary)',
    '--muted-2': 'var(--text-disabled)',
    '--bg-void': 'var(--bg-canvas)',
    '--bg-0': 'var(--bg-canvas)',
    '--bg-1': 'var(--bg-base)',
    '--bg-hover': 'var(--state-hover-bg)',
    '--bg-elevated': 'var(--surface-2)',
    '--panel': 'var(--surface-1)',
    '--line': 'var(--border-default)',
    '--line-soft': 'var(--border-subtle)',
    '--line-hard': 'var(--border-strong)',
    '--border': 'var(--border-default)',
    // Elevation
    '--shadow-sm': '0 1px 2px rgba(4, 8, 14, 0.28), 0 1px 4px rgba(4, 8, 14, 0.16)',
    '--shadow-md': '0 4px 12px rgba(4, 8, 14, 0.34), 0 2px 6px rgba(4, 8, 14, 0.20)',
    '--shadow-lg': '0 12px 32px rgba(4, 8, 14, 0.42), 0 4px 12px rgba(4, 8, 14, 0.26)',
    '--glow-soft': 'none',
    '--glow-neon': 'inset 0 0 0 1px var(--border-strong)',
    // Type
    '--mono': "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    '--display': "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    // Radius
    '--radius-sm': '10px',
    '--radius-md': '14px',
    '--radius-lg': '18px',
    '--radius-xl': '24px',
    '--radius-full': '999px',
    // Shell dimensions + chat height now owned by the LAYOUTS registry (see below).
  },
};

// ── AIOS — crimson command-center on deep charcoal ──────────────────────────
// Token values from Asia's design deliverable, mapped 1:1 onto the Odyssey
// token surface. Oracle contrast gate 2026-07-16 (recomputed independently
// via WCAG relative-luminance): text-primary/bg 18.17:1 (AAA), tertiary/bg
// 7.22:1 (AAA), icon-on-accent(#fff)/accent 4.20:1, accent/surface-1 4.27:1
// — all pass. Per-accent --icon-on-accent = white (crimson needs light icon).
const AIOS: ThemeDef = {
  id: 'aios',
  label: 'AIOS',
  description: 'AI OS command center. Crimson on deep charcoal-black — cinematic, high-contrast, and operations-serious.',
  mode: 'dark',
  preview: { bg: '#090A0D', surface: '#15171C', accent: '#E33B4F', text: '#F5F5F6' },
  tokens: {
    // Backgrounds
    '--bg-canvas': '#090A0D',
    '--bg-base': '#0F1014',
    '--surface-1': '#15171C',
    '--surface-2': '#1D2026',
    '--surface-elevated': '#272A32',
    // Text
    '--text-primary': '#F5F5F6',
    '--text-secondary': '#C6C7CB',
    '--text-tertiary': '#9A9CA3',
    '--text-disabled': '#656870',
    '--text-inverted': '#0B0C10',
    // Borders
    '--border-subtle': 'rgba(245, 245, 246, 0.08)',
    '--border-default': 'rgba(245, 245, 246, 0.16)',
    '--border-strong': 'rgba(245, 245, 246, 0.28)',
    // Accent
    '--accent': '#E33B4F',
    '--accent-hover': '#F04D61',
    '--accent-active': '#BF293C',
    '--accent-soft': 'rgba(227, 59, 79, 0.14)',
    '--accent-soft-strong': 'rgba(227, 59, 79, 0.26)',
    // Semantic
    '--success': '#63D69A',
    '--warning': '#F1B84B',
    '--error': '#FF6678',
    '--info': '#72B7FF',
    // Icon ramp
    '--icon-default': '#B9BBC1',
    '--icon-hover': '#F5F5F6',
    '--icon-active': 'var(--accent)',
    '--icon-disabled': '#656870',
    '--icon-on-accent': '#fff',
    // Interaction states
    '--state-hover-bg': 'rgba(245, 245, 246, 0.06)',
    '--state-active-bg': 'rgba(245, 245, 246, 0.10)',
    '--focus-ring': '0 0 0 2px rgba(227, 59, 79, 0.45)',
    // Legacy aliases — keep every existing v2 var name resolvable
    '--accent-2': 'var(--accent)',
    '--accent-muted-bg': 'var(--accent-soft)',
    '--green': 'var(--success)',
    '--amber': 'var(--warning)',
    '--danger': 'var(--error)',
    '--violet': '#A78BFA',
    '--boundary': 'var(--warning)',
    '--text': 'var(--text-primary)',
    '--text-soft': 'var(--text-secondary)',
    '--text-muted': 'var(--text-tertiary)',
    '--muted': 'var(--text-tertiary)',
    '--muted-2': 'var(--text-disabled)',
    '--bg-void': 'var(--bg-canvas)',
    '--bg-0': 'var(--bg-canvas)',
    '--bg-1': 'var(--bg-base)',
    '--bg-hover': 'var(--state-hover-bg)',
    '--bg-elevated': 'var(--surface-2)',
    '--panel': 'var(--surface-1)',
    '--line': 'var(--border-default)',
    '--line-soft': 'var(--border-subtle)',
    '--line-hard': 'var(--border-strong)',
    '--border': 'var(--border-default)',
    // Elevation
    '--shadow-sm': '0 1px 2px rgba(3, 0, 1, 0.34), 0 1px 4px rgba(54, 4, 12, 0.10)',
    '--shadow-md': '0 4px 12px rgba(3, 0, 1, 0.42), 0 2px 8px rgba(54, 4, 12, 0.14)',
    '--shadow-lg': '0 12px 32px rgba(3, 0, 1, 0.54), 0 4px 14px rgba(54, 4, 12, 0.18)',
    '--glow-soft': '0 0 24px rgba(227, 59, 79, 0.08)',
    '--glow-neon': 'inset 0 0 0 1px var(--border-strong)',
    // Type
    '--mono': "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    '--display': "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    // Radius — Odyssey verbatim
    '--radius-sm': '10px',
    '--radius-md': '14px',
    '--radius-lg': '18px',
    '--radius-xl': '24px',
    '--radius-full': '999px',
  },
};

// ── Monitor — amber analytics terminal, monospace-forward ────────────────────
// Oracle contrast gate 2026-07-16: text-primary/bg 16.72:1 (AAA), tertiary/bg
// 6.65:1, icon-on-accent(#11100D)/accent 8.85:1, accent/surface-1 8.53:1 —
// all pass. --icon-on-accent = near-black (amber needs a dark icon). --display
// is the mono stack, intentional for the analytics-terminal read.
const MONITOR: ThemeDef = {
  id: 'monitor',
  label: 'Monitor',
  description: 'Analytics terminal. Amber signal color, warm-black surfaces, and monospace-forward operational clarity.',
  mode: 'dark',
  preview: { bg: '#0B0A08', surface: '#18140E', accent: '#F0A02B', text: '#F3EBDD' },
  tokens: {
    // Backgrounds
    '--bg-canvas': '#0B0A08',
    '--bg-base': '#110F0B',
    '--surface-1': '#18140E',
    '--surface-2': '#211B12',
    '--surface-elevated': '#2C2417',
    // Text
    '--text-primary': '#F3EBDD',
    '--text-secondary': '#C9BBA4',
    '--text-tertiary': '#A69375',
    '--text-disabled': '#6E604C',
    '--text-inverted': '#11100D',
    // Borders
    '--border-subtle': 'rgba(243, 235, 221, 0.08)',
    '--border-default': 'rgba(243, 235, 221, 0.16)',
    '--border-strong': 'rgba(243, 235, 221, 0.28)',
    // Accent
    '--accent': '#F0A02B',
    '--accent-hover': '#FFB747',
    '--accent-active': '#C97C17',
    '--accent-soft': 'rgba(240, 160, 43, 0.14)',
    '--accent-soft-strong': 'rgba(240, 160, 43, 0.26)',
    // Semantic
    '--success': '#76D49B',
    '--warning': '#F4C35B',
    '--error': '#F2766D',
    '--info': '#70B7DB',
    // Icon ramp
    '--icon-default': '#B9AA91',
    '--icon-hover': '#F3EBDD',
    '--icon-active': 'var(--accent)',
    '--icon-disabled': '#6E604C',
    '--icon-on-accent': '#11100D',
    // Interaction states
    '--state-hover-bg': 'rgba(240, 160, 43, 0.06)',
    '--state-active-bg': 'rgba(240, 160, 43, 0.10)',
    '--focus-ring': '0 0 0 2px rgba(240, 160, 43, 0.45)',
    // Legacy aliases — keep every existing v2 var name resolvable
    '--accent-2': 'var(--accent)',
    '--accent-muted-bg': 'var(--accent-soft)',
    '--green': 'var(--success)',
    '--amber': 'var(--warning)',
    '--danger': 'var(--error)',
    '--violet': '#B596D9',
    '--boundary': 'var(--warning)',
    '--text': 'var(--text-primary)',
    '--text-soft': 'var(--text-secondary)',
    '--text-muted': 'var(--text-tertiary)',
    '--muted': 'var(--text-tertiary)',
    '--muted-2': 'var(--text-disabled)',
    '--bg-void': 'var(--bg-canvas)',
    '--bg-0': 'var(--bg-canvas)',
    '--bg-1': 'var(--bg-base)',
    '--bg-hover': 'var(--state-hover-bg)',
    '--bg-elevated': 'var(--surface-2)',
    '--panel': 'var(--surface-1)',
    '--line': 'var(--border-default)',
    '--line-soft': 'var(--border-subtle)',
    '--line-hard': 'var(--border-strong)',
    '--border': 'var(--border-default)',
    // Elevation
    '--shadow-sm': '0 1px 2px rgba(6, 4, 0, 0.34), 0 1px 4px rgba(72, 43, 0, 0.10)',
    '--shadow-md': '0 4px 12px rgba(6, 4, 0, 0.42), 0 2px 8px rgba(72, 43, 0, 0.14)',
    '--shadow-lg': '0 12px 32px rgba(6, 4, 0, 0.54), 0 4px 14px rgba(72, 43, 0, 0.18)',
    '--glow-soft': '0 0 24px rgba(240, 160, 43, 0.08)',
    '--glow-neon': 'inset 0 0 0 1px var(--border-strong)',
    // Type — mono-forward display is intentional for the analytics-terminal read
    '--mono': "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    '--display': "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    // Radius — Odyssey verbatim
    '--radius-sm': '10px',
    '--radius-md': '14px',
    '--radius-lg': '18px',
    '--radius-xl': '24px',
    '--radius-full': '999px',
  },
};

// ── Agentic — cool muted steel-slate, calm professional ─────────────────────
// Oracle contrast gate 2026-07-16: text-primary/bg 15.42:1 (AAA), tertiary/bg
// 6.16:1, icon-on-accent(#0E141A)/accent 8.06:1, accent/surface-1 6.81:1 —
// all pass. --icon-on-accent = near-black (steel needs a dark icon).
const AGENTIC: ThemeDef = {
  id: 'agentic',
  label: 'Agentic',
  description: 'Agentic OS. Muted steel on slate-dark — calm, professional, restrained, and low-chroma.',
  mode: 'dark',
  preview: { bg: '#11161D', surface: '#1C242E', accent: '#91AFC4', text: '#E8EDF2' },
  tokens: {
    // Backgrounds
    '--bg-canvas': '#11161D',
    '--bg-base': '#161D25',
    '--surface-1': '#1C242E',
    '--surface-2': '#252F3B',
    '--surface-elevated': '#303C49',
    // Text
    '--text-primary': '#E8EDF2',
    '--text-secondary': '#BBC5CF',
    '--text-tertiary': '#8998A8',
    '--text-disabled': '#5D6976',
    '--text-inverted': '#0E141A',
    // Borders
    '--border-subtle': 'rgba(232, 237, 242, 0.07)',
    '--border-default': 'rgba(232, 237, 242, 0.14)',
    '--border-strong': 'rgba(232, 237, 242, 0.24)',
    // Accent
    '--accent': '#91AFC4',
    '--accent-hover': '#A8C1D2',
    '--accent-active': '#708FA7',
    '--accent-soft': 'rgba(145, 175, 196, 0.14)',
    '--accent-soft-strong': 'rgba(145, 175, 196, 0.26)',
    // Semantic
    '--success': '#8FBEA6',
    '--warning': '#D6B978',
    '--error': '#D08186',
    '--info': '#8BB8D4',
    // Icon ramp
    '--icon-default': '#A4B1BE',
    '--icon-hover': '#E8EDF2',
    '--icon-active': 'var(--accent)',
    '--icon-disabled': '#5D6976',
    '--icon-on-accent': '#0E141A',
    // Interaction states
    '--state-hover-bg': 'rgba(232, 237, 242, 0.05)',
    '--state-active-bg': 'rgba(232, 237, 242, 0.09)',
    '--focus-ring': '0 0 0 2px rgba(145, 175, 196, 0.42)',
    // Legacy aliases — keep every existing v2 var name resolvable
    '--accent-2': 'var(--accent)',
    '--accent-muted-bg': 'var(--accent-soft)',
    '--green': 'var(--success)',
    '--amber': 'var(--warning)',
    '--danger': 'var(--error)',
    '--violet': '#A79ABA',
    '--boundary': 'var(--warning)',
    '--text': 'var(--text-primary)',
    '--text-soft': 'var(--text-secondary)',
    '--text-muted': 'var(--text-tertiary)',
    '--muted': 'var(--text-tertiary)',
    '--muted-2': 'var(--text-disabled)',
    '--bg-void': 'var(--bg-canvas)',
    '--bg-0': 'var(--bg-canvas)',
    '--bg-1': 'var(--bg-base)',
    '--bg-hover': 'var(--state-hover-bg)',
    '--bg-elevated': 'var(--surface-2)',
    '--panel': 'var(--surface-1)',
    '--line': 'var(--border-default)',
    '--line-soft': 'var(--border-subtle)',
    '--line-hard': 'var(--border-strong)',
    '--border': 'var(--border-default)',
    // Elevation
    '--shadow-sm': '0 1px 2px rgba(4, 9, 14, 0.28), 0 1px 4px rgba(34, 54, 69, 0.12)',
    '--shadow-md': '0 4px 12px rgba(4, 9, 14, 0.36), 0 2px 8px rgba(34, 54, 69, 0.16)',
    '--shadow-lg': '0 12px 32px rgba(4, 9, 14, 0.46), 0 4px 14px rgba(34, 54, 69, 0.20)',
    '--glow-soft': '0 0 24px rgba(145, 175, 196, 0.06)',
    '--glow-neon': 'inset 0 0 0 1px var(--border-strong)',
    // Type
    '--mono': "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    '--display': "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    // Radius — Odyssey verbatim
    '--radius-sm': '10px',
    '--radius-md': '14px',
    '--radius-lg': '18px',
    '--radius-xl': '24px',
    '--radius-full': '999px',
  },
};

export const THEMES: ThemeDef[] = [NEON_GRID, ODYSSEY, SANCTUARY, PHOSPHOR, GLACIER, AIOS, MONITOR, AGENTIC];

export function findTheme(id: string | null | undefined): ThemeDef {
  return THEMES.find(t => t.id === id) ?? THEMES.find(t => t.id === DEFAULT_THEME_ID) ?? THEMES[0];
}

/** Emits the CSS rule(s) for a single theme: root scope + a non-root scope
 *  (for isolated swatch previews) + a bare :root default for the default theme
 *  so pre-JS/no-JS paints still land on the right theme. */
function ruleFor(theme: ThemeDef): string {
  const decls = Object.entries(theme.tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  const selectors = [`:root[data-theme="${theme.id}"]`, `[data-theme="${theme.id}"]`];
  if (theme.id === DEFAULT_THEME_ID) selectors.push(':root:not([data-theme])');
  return `${selectors.join(',\n')} {\n${decls}\n}`;
}

export function generateThemeCss(themes: ThemeDef[] = THEMES): string {
  return themes.map(ruleFor).join('\n\n') + '\n';
}

// ════════════════════════════════════════════════════════════════════════════
// LAYOUT AXIS — structure/density, orthogonal to the color axis above.
//
// A "layout" is the SINGLE OWNER of the shell's structural tokens:
//   --shell-sidebar-width / --shell-sidebar-rail / --shell-topbar-height /
//   --shell-footer-height / --shell-pad / --shell-gap
// plus --chat-h / --chat-min-h (which DERIVE from the shell dims above).
//
// The `.app` CSS grid in index.html consumes these via var(--shell-*). Any
// color theme (data-theme) pairs with any layout (data-layout) — VS-Code-style
// two-axis theming. Adding a layout is exactly: push one LayoutDef onto LAYOUTS.
//
// IMPORTANT (mobile safety): layout presets only reshape the DESKTOP base grid.
// index.html freezes grid-template-rows to the compact literals at the <=1024px
// breakpoint so a roomy layout's taller topbar/footer never reaches tablet/mobile
// (where hardcoded magic-numbers like the session-drawer top/bottom assume 56/32).
// ════════════════════════════════════════════════════════════════════════════

export interface LayoutDef {
  id: string;
  label: string;
  description: string;
  /** Structural CSS custom properties. --chat-h may reference the --shell-*
   *  tokens in the same rule (emitted into one CSS block, so it resolves). */
  tokens: Record<string, string>;
}

export const DEFAULT_LAYOUT_ID = 'compact';

// Chat pane height derived from the shell dims — mirrors v4.css's own formula.
// (topbar + footer + 32px page padding subtracted from the viewport.)
const CHAT_H = 'calc(100vh - var(--shell-topbar-height) - var(--shell-footer-height) - 32px)';

// ── Compact — the current live v2 look ("v3"). DEFAULT (zero visual change). ──
const COMPACT: LayoutDef = {
  id: 'compact',
  label: 'Compact',
  description: 'Dense, information-first. The classic NeuroClaw layout.',
  tokens: {
    '--shell-sidebar-width': '240px',
    '--shell-sidebar-rail': '64px',
    '--shell-topbar-height': '56px',
    '--shell-footer-height': '32px',
    '--shell-pad': '12px',
    '--shell-gap': '12px',
    '--chat-h': CHAT_H,
    '--chat-min-h': '580px',
  },
};

// ── Comfortable — the v4 redesign dimensions. Roomier, calmer. ───────────────
const COMFORTABLE: LayoutDef = {
  id: 'comfortable',
  label: 'Comfortable',
  description: 'Roomier spacing and a wider sidebar. The v4 layout.',
  tokens: {
    '--shell-sidebar-width': '264px',
    '--shell-sidebar-rail': '80px',
    '--shell-topbar-height': '68px',
    '--shell-footer-height': '44px',
    '--shell-pad': '18px',
    '--shell-gap': '18px',
    '--chat-h': CHAT_H,
    '--chat-min-h': '580px',
  },
};

// ── Cockpit — ultra-dense, tighter than Compact. Info-first command grid. ────
// Dims deliberately DENSER than Compact (240/64/56/32/12/12). Only reshapes the
// >1024px desktop base grid; index.html freezes mobile/tablet to compact
// literals, so the 52px topbar never reaches the hardcoded mobile magic numbers.
const COCKPIT: LayoutDef = {
  id: 'cockpit',
  label: 'Cockpit',
  description: 'Ultra-dense, information-first command layout. Tighter than Compact.',
  tokens: {
    '--shell-sidebar-width': '208px',
    '--shell-sidebar-rail': '56px',
    '--shell-topbar-height': '52px',
    '--shell-footer-height': '28px',
    '--shell-pad': '10px',
    '--shell-gap': '10px',
    '--chat-h': CHAT_H,
    '--chat-min-h': '580px',
  },
};

// ── Focus — spacious, roomier than Comfortable. Calm, generous breathing room. ─
// Dims deliberately ROOMIER than Comfortable (264/80/68/44/18/18). Desktop-only
// (same mobile-freeze safety as Comfortable, which already ships non-compact
// desktop dims).
const FOCUS: LayoutDef = {
  id: 'focus',
  label: 'Focus',
  description: 'Spacious, calm layout with softer pacing and more breathing room. Roomier than Comfortable.',
  tokens: {
    '--shell-sidebar-width': '288px',
    '--shell-sidebar-rail': '88px',
    '--shell-topbar-height': '76px',
    '--shell-footer-height': '52px',
    '--shell-pad': '24px',
    '--shell-gap': '24px',
    '--chat-h': CHAT_H,
    '--chat-min-h': '580px',
  },
};

export const LAYOUTS: LayoutDef[] = [COMPACT, COMFORTABLE, COCKPIT, FOCUS];

export function findLayout(id: string | null | undefined): LayoutDef {
  return LAYOUTS.find(l => l.id === id) ?? LAYOUTS.find(l => l.id === DEFAULT_LAYOUT_ID) ?? LAYOUTS[0];
}

/** Emits the CSS rule(s) for a single layout: root scope + a non-root scope
 *  (parity with themes) + a bare :root default for the default layout so
 *  first-visit / no-JS / pre-hydration paints get real shell dimensions
 *  instead of collapsing the grid to `auto` (ASAGI blocker #1). */
function layoutRuleFor(layout: LayoutDef): string {
  const decls = Object.entries(layout.tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  const selectors = [`:root[data-layout="${layout.id}"]`, `[data-layout="${layout.id}"]`];
  if (layout.id === DEFAULT_LAYOUT_ID) selectors.push(':root:not([data-layout])');
  return `${selectors.join(',\n')} {\n${decls}\n}`;
}

export function generateLayoutCss(layouts: LayoutDef[] = LAYOUTS): string {
  return layouts.map(layoutRuleFor).join('\n\n') + '\n';
}
