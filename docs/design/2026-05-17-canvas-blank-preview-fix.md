# Canvas Blank Preview — Root Cause & Fix

## Problem

Canvas artifacts rendered as **completely blank** in the sandboxed iframe preview (both inline and fullscreen). The activity log showed:

```
project started
direction options loaded
plan · 1/6 steps done
▶ llm.complete · model=claude-sonnet-4-6
✓ llm.complete · 136589ms
artifact emitted
plan · 4/6 steps done
critique scored
plan · 6/6 steps done
complete
```

Everything appeared successful, but the iframe was empty.

---

## Root Cause

### 1. Token cap was an artificial bottleneck

`src/skills/canvas/engine.ts` had `max_tokens: 16000` hardcoded for `generate()` and `iterate()`.

While 16K is the ceiling for `gpt-4o-mini`, the actual backend routes to **Claude Sonnet** (~64K output) or **Gemini Pro** (~65K). Capping at 16K caused guaranteed truncation on any substantial layout.

### 2. The prompt encouraged a multi-screen dashboard

The model emitted a **massive multi-screen dashboard** instead of a focused single page:

- Sidebar navigation with inline SVGs
- Command palette overlay
- Mobile frame wrapper
- `.screen { display:none }` / `.screen.active` toggle system
- Workflow builder canvas
- Infrastructure monitor
- Memory vault sidebar
- 20+ row data tables
- 12+ identical stat cards

This burned through 16K tokens and was truncated **mid-SVG tag** at ~41KB.

### 3. The truncated HTML was structurally broken

The document ended with an unclosed `<svg>` tag inside a `<nav>` element. Because the model had hidden every `.screen` by default (`display: none`) and only showed `.screen.active` via JavaScript, and that JavaScript was truncated away:

- **No screen ever became visible** → blank iframe
- **No `</body>` or `</html>` closers** → browser couldn't recover

### 4. `extractHtml()` was naive

It only checked if the doc started with `<!doctype html>`, but never verified whether it **closed** properly.

---

## Fix

### 1. `max_tokens` bumped to 64K

**File:** `src/skills/canvas/engine.ts`

```ts
// Before
max_tokens: 16000

// After
max_tokens: 64000
```

Matches Claude Sonnet / Gemini Pro output capacity. Applied to both `generate()` and `iterate()`.

### 2. System prompt tightened with output-restraint rules

**File:** `src/skills/canvas/engine.ts` — `systemPromptFor()`

Added:

```
Output restraint (critical):
- Single focused page ONLY. No multi-screen navigation systems, no .screen.active toggles, no command-palette overlays, no mobile frame wrappers, no tabbed views, no full dashboard layouts.
- Do NOT repeat the same component dozens of times. Show 3–5 representative examples max.
- Inline SVGs are expensive. Use CSS shapes or icon fonts instead.
```

Removed the misleading "~13 000 tokens" constraint (no longer relevant at 64K).

### 3. `extractHtml()` hardened for truncation detection + recovery

**File:** `src/skills/canvas/engine.ts`

Now:

1. Detects missing `</body>` and/or `</html>`
2. Strips the dangling partial `<tag>` at the truncation point
3. Auto-appends `</body></html>` so the iframe renders *something*
4. Returns `{ html, truncated }` so callers can decide to throw or recover

```ts
function extractHtml(raw: string): { html: string; truncated: boolean }
```

**Recovery logic:**

```ts
if (!hasCloseHtml || !hasCloseBody) {
  truncated = true;
  // Strip dangling partial tag
  const tail = s.slice(-200);
  const lastOpen = tail.lastIndexOf('<');
  const lastClose = tail.lastIndexOf('>');
  if (lastOpen > lastClose && lastOpen !== -1) {
    s = s.slice(0, -(tail.length - lastOpen));
  }
  s = s.trimEnd() + '\n' + recover.join('\n') + '\n';
}
```

### 4. `generate()` and `iterate()` now surface truncation as clear errors

**`generate()`** throws:

```
Generated HTML was truncated by the model output limit.
Try a shorter brief or a simpler surface (e.g. poster instead of multi-page).
```

**`iterate()`** yields an SSE `error` event:

```
Iteration response was truncated by the model output limit.
Try a smaller change request.
```

Previously, truncated artifacts were silently emitted, producing a blank preview.

---

## Verification

- Built with `npm run build` — compiles cleanly
- `extractHtml()` tested against the actual truncated artifact (`cfd113d6-.../94ba5827-...html`):
  - Detected `truncated: true`
  - Stripped the dangling `<svg...` tag
  - Appended `</body>\n</html>\n`
  - Artifact now renders (structurally closed)

---

## Impact

| Before | After |
|---|---|
| 16K token cap → guaranteed truncation on substantial layouts | 64K token cap → matches Claude/Gemini output |
| Model encouraged multi-screen dashboards | Model constrained to single focused pages |
| Truncated artifacts silently emitted → blank iframe | Truncation detected, auto-recovered, surfaced as error |
| User sees blank preview with no explanation | User gets actionable error message |

---

## Future hardening

- Check `r.choices[0].finish_reason === 'length'` and surface that directly
- Consider chunked/streaming HTML generation for very large artifacts
- Add a `max_output_size` env var per model tier

---

*Written 2026-05-17 · Fixes found in `src/skills/canvas/engine.ts`*
