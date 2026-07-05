# Token Optimization Design
_Date: 2026-05-10_

## Goals

1. **Prompt caching** — reduce redundant token processing for the Anthropic API path by marking stable system prompt content with `cache_control` headers. All other providers get structural ordering that maximizes their own server-side prefix caching.
2. **Memory score filtering** — only inject memories with meaningful relevance to the current message, eliminating low-signal noise from the system prompt block.

Both changes must boost system quality and never degrade it. The nano model pricing context means quality (signal-to-noise) matters more than raw cost reduction.

---

## Part 1: Prompt Caching

### Provider capability matrix

| Provider | Strategy | Mechanism |
|---|---|---|
| `anthropic` (api backend) | Explicit `cache_control` blocks | Anthropic SDK `TextBlockParam[]` with `cache_control: { type: 'ephemeral' }` |
| `openrouter` + `anthropic/*` model | Explicit `cache_control` blocks | Passes through to Anthropic |
| `openrouter` + other models | Structural ordering only | Provider-side prefix cache |
| `voidai` / OpenAI-compatible | Structural ordering only | Auto prefix cache ≥ 1024 tokens, no headers needed |
| `ollama` | Structural ordering only | llama.cpp KV cache is automatic |
| `claude-cli` / `codex-cli` | Structural ordering only | CLI surface, no API caching |

"Structural ordering" means: stable content always comes before dynamic content in the system prompt string. This maximises the overlap that providers use for their own prefix caches.

### Stable vs dynamic split

Every provider path builds `activeSystemPrompt` by concatenating:

```
base system prompt          ← stable
+ team section              ← stable (changes only when agents are added/renamed)
+ skills block              ← stable
─────────────────────────── ← split point
+ memory block              ← dynamic (query-dependent, changes every turn)
+ cross-session context     ← dynamic
+ shared comms notes        ← dynamic
+ extra turn context        ← dynamic (nclaw CLI, Discord ids, etc.)
```

**Structural ordering** (all providers): enforce this split is never violated — dynamic content must always be appended after stable content. The current code already does this; the design formalises it as an invariant.

**Explicit caching** (Anthropic API + Anthropic-via-OpenRouter): change `system: activeSystemPrompt` (string) to `system: buildCachedSystemBlocks(stablePrompt, dynamicContext)` which returns `Anthropic.Messages.TextBlockParam[]`:

```ts
[
  { type: 'text', text: stablePrompt, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: dynamicContext },  // omitted if empty
]
```

If `dynamicContext` is empty the array contains only the stable block. The Anthropic SDK accepts `system` as either a string or this array format.

### Provider capability check

A pure function `supportsExplicitCache(provider: string, model: string): boolean` encodes the known-safe set:

- `provider === 'anthropic'` and backend is `anthropic-api` → `true`
- `provider === 'openrouter'` and `model.startsWith('anthropic/')` → `true`
- everything else → `false`

This is hardcoded for now (no env var toggle) to keep it simple and safe. Adding a new provider is a one-line change.

### Cache hit tracking

The Anthropic `message_start` event carries:
- `usage.cache_read_input_tokens` — tokens served from cache (no charge or reduced charge)
- `usage.cache_creation_input_tokens` — tokens written to cache this turn

The OpenAI-compatible `usage` object carries:
- `prompt_tokens_details.cached_tokens`

Both are captured alongside `realInputTokens` / `realOutputTokens` and passed to `logAnalytics('cache_hit', { ... })` so cache performance is visible in the dashboard without separate instrumentation.

### Files affected

| File | Change |
|---|---|
| `src/agent/alfred.ts` | `chatStreamAnthropic`: split stable/dynamic prompt, call `buildCachedSystemBlocks` when provider supports it; capture cache usage from `message_start` event |
| `src/system/prompt-cache.ts` | New file: `buildCachedSystemBlocks()` and `supportsExplicitCache()` |

---

## Part 2: Memory Score Filtering

### Problem

`buildMemoryContextBlock()` in `src/memory/memory-tools.ts` retrieves up to `preinjectMax` hits and injects all of them regardless of relevance score. Low-scoring memories (score < 0.3) add noise to the system prompt and compete with high-signal content, which degrades output quality especially on smaller models.

### Solution

Add `MEMORY_PREINJECT_MIN_SCORE` env var (default `0.45`) to config. In `buildMemoryContextBlock()`, after `retrieve()` returns, filter each category array before building the injected block:

```ts
const minScore = config.memory.preinjectMinScore; // default 0.45
const passes = (hit: RetrievalHit) =>
  hit.score >= minScore || (hit.raw?.importance ?? 0) >= 0.9;
```

The `importance >= 0.9` bypass ensures memories that were explicitly marked critical are never silently dropped even if they aren't semantically close to the current query text.

If filtering removes all hits, `buildMemoryContextBlock()` returns `''` — no injection. This is the same behaviour as today when `result.total === 0`, so downstream code requires no changes.

### Config addition

```
MEMORY_PREINJECT_MIN_SCORE=0.45   # filter threshold (0–1); lower = more memories injected
```

Tuning guidance:
- `0.6+` — high-precision, injects only very relevant memories; may miss useful context
- `0.45` — default, good signal-to-noise for general use
- `0.3` — permissive, useful if agents are missing important context

### Files affected

| File | Change |
|---|---|
| `src/memory/memory-tools.ts` | Filter each category array by `score >= minScore || importance >= 0.9` before building block |
| `src/config.ts` | Add `memory.preinjectMinScore` from `MEMORY_PREINJECT_MIN_SCORE` (default `0.45`) |
| `.env.example` | Document `MEMORY_PREINJECT_MIN_SCORE` |

---

## What is explicitly out of scope

- Gemini context caching API (completely different model, separate feature)
- Response-level caching (full LLM output cache for identical inputs)
- Ollama-specific KV cache control (already automatic, nothing to do)
- Codex CLI / Claude CLI caching (no API surface)
- OpenRouter non-Anthropic explicit caching (structural ordering is sufficient)

---

## Success criteria

- Anthropic API turns within the same session show `cache_read_input_tokens > 0` in analytics after the first turn
- Memory block in system prompts contains only hits with `score >= 0.45` or `importance >= 0.9`
- No provider path errors due to unrecognised `cache_control` fields
- `npx tsc --noEmit` passes with zero errors
