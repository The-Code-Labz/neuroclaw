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

export const THEMES: ThemeDef[] = [NEON_GRID, ODYSSEY, SANCTUARY, PHOSPHOR, GLACIER];

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

export const LAYOUTS: LayoutDef[] = [COMPACT, COMFORTABLE];

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
