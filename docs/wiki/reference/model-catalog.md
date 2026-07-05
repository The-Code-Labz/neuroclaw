---
title: Model catalog
order: 40
---

# Model catalog

The model catalog is a live SQLite-backed database of every model available across NeuroClaw's supported providers. On startup the catalog is populated automatically and then refreshed once per hour. It records each model's tier, pricing, and availability, and acts as the source of truth for the triage system when picking which model to use for a given request.

## Providers

NeuroClaw tracks models across these providers:

| Provider | Source |
|---|---|
| `voidai` | Fetched live from the VoidAI `/v1/models` endpoint (OpenAI-compatible) |
| `anthropic` | Seeded from a hardcoded list of current Claude models |
| `codex` | Seeded from the Codex CLI allowlist (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2`) |
| `gemini` | Seeded from common Gemini CLI model ids (`gemini-3-pro`, `gemini-2.5-pro`, `gemini-2.5-flash`, etc.) |

VoidAI is the only provider for which the catalog can discover new models at runtime. Anthropic, Codex, and Gemini entries are kept current by re-seeding on each refresh cycle.

## Tier classification

Every model is assigned one of three tiers: `low`, `mid`, or `high`. Tier determines which model gets picked during triage and which budget guard threshold applies.

Classification is done by matching the model ID against two ordered pattern lists. Low patterns are checked first so cheaper variants of otherwise-expensive model families (e.g. `gpt-5-mini`, `claude-haiku-4-5`) are not mistakenly promoted by a high-tier base pattern.

**Low patterns** (matched first): `haiku`, `-mini`, `-nano`, `gpt-3.5`, `gpt-4o-mini`, `flash`, `flash-lite`, `1b`, `3b`, `7b`, `8b`, `phi-`, `tiny`, `small`

**High patterns** (matched if not low): `opus`, `o1`–`o9` (reasoning models), `gpt-5`, `gpt-4.5`, `ultra`, `405b`, `llama-3.*70b`, `llama-4`, `gemini-.*ultra`, `sonar-pro`, `reasoner`

Anything that does not match either list falls into `mid`.

The auto-classified tier is stored in the database. If a user pins a tier override via the API, the `tier_overridden` flag is set and subsequent refreshes leave the tier alone until the override is cleared.

## Known pricing table

Pricing is stored as USD per 1,000 tokens (input / output). The catalog matches model IDs against a priority-ordered pattern list; first match wins. For models not in the list, tier-based fallback rates apply.

**Tier fallbacks** (used when no pattern matches):

| Tier | Input per 1K | Output per 1K |
|---|---|---|
| `high` | $15.00 | $60.00 |
| `mid` | $3.00 | $12.00 |
| `low` | $0.50 | $1.50 |

**Anthropic:**

| Pattern | Input per 1K | Output per 1K |
|---|---|---|
| opus-4, opus-3 | $15.00 | $75.00 |
| sonnet-4, sonnet-3-7, sonnet-3-5, sonnet | $3.00 | $15.00 |
| haiku-4 | $1.00 | $5.00 |
| haiku-3-5 | $0.80 | $4.00 |
| haiku | $0.25 | $1.25 |

**OpenAI:**

| Pattern | Input per 1K | Output per 1K |
|---|---|---|
| gpt-5.1, gpt-5 | $10.00 | $30.00 |
| gpt-4.5 | $75.00 | $150.00 |
| gpt-4o-mini | $0.15 | $0.60 |
| gpt-4o, chatgpt-4o | $2.50 | $10.00 |
| gpt-4-turbo | $10.00 | $30.00 |
| gpt-4 | $30.00 | $60.00 |
| gpt-3.5 | $0.50 | $1.50 |
| o3-mini, o1-mini | $3.00 | $12.00 |
| o3 | $60.00 | $240.00 |
| o1 | $15.00 | $60.00 |

**Google:**

| Pattern | Input per 1K | Output per 1K |
|---|---|---|
| gemini-2.*flash, gemini-1.5-flash | $0.075 | $0.30 |
| gemini-1.5-pro | $1.25 | $5.00 |
| gemini.*ultra | $7.00 | $21.00 |

**Other families (approximate):**

| Pattern | Input per 1K | Output per 1K |
|---|---|---|
| deepseek-v3 | $0.14 | $0.28 |
| deepseek-r1 | $0.55 | $2.19 |
| qwen-2.*72b | $0.40 | $1.20 |
| llama-3.*70b | $0.59 | $0.79 |
| mistral-large | $2.00 | $6.00 |

## Auto-refresh

`startCatalogRefresh()` is called once at server startup. It runs an initial refresh immediately and then repeats every hour. Each cycle contacts the provider's model list endpoint (or re-seeds the hardcoded list), upserts new or updated entries, and marks any model that was previously available but no longer appears in the response as unavailable (`is_available = 0`). Every refresh is logged to the `audit_logs` table.

You can trigger a manual refresh without waiting for the next scheduled cycle via the API:

```
POST /api/models/refresh?provider=voidai
```

## Overrides

Two types of overrides are available. Both survive the hourly refresh cycle — the auto-classifier and auto-pricer skip any row where the corresponding `_overridden` flag is set.

### Pin a tier

```
POST /api/models/:provider/:modelId/tier
{ "tier": "high" }
```

To clear the override and return to auto-classification, send `{ "tier": null }`.

### Pin a price

```
POST /api/models/:provider/:modelId/price
{ "input": 5.00, "output": 20.00 }
```

Send `{ "input": null, "output": null }` to reset to the catalog's derived price.

## Model triage

When an agent's `model_tier` is set to `auto`, NeuroClaw runs a complexity classifier on the incoming message text and selects a model from the appropriate catalog tier rather than using a fixed model.

### Heuristic classifier

The default classifier (`classifyComplexity`) scores the request text across several signals and produces a score from 0 to 1:

| Signal | Score contribution |
|---|---|
| Text length > 200 characters | +0.10 |
| Text length > 800 characters | +0.15 |
| Text length > 4000 characters | +0.15 |
| Code content detected | +0.25 |
| One or more step verbs (plan, architect, refactor…) | +0.20 |
| Three or more step verbs | +0.10 |
| Reasoning signals (why, prove, tradeoffs, root cause…) | +0.25 |
| Tool-use signals (run, deploy, fetch, merge…) | +0.05 |

The final score is compared against two thresholds to pick a tier:

- score ≥ 0.50 → `high`
- score ≥ 0.25 → `mid`
- below 0.25 → `low`

Results are cached in memory for 5 minutes (LRU, capped at 500 entries) so repeated messages with the same text are classified without re-running the scorer.

### LLM-assisted triage

When `TRIAGE_LLM_ENABLED=true`, scores that fall inside a configurable grey zone (`TRIAGE_BORDER_LOW` to `TRIAGE_BORDER_HIGH`) are escalated to a secondary LLM call. A cheap low-tier model is given the task text and asked to return a JSON object with `tier`, `confidence`, and `reasoning`. If the call succeeds, the LLM's tier replaces the heuristic result. If it fails, the heuristic result is used as-is.

The classifier model defaults to the alphabetically-first low-tier VoidAI model in the catalog. You can pin a specific model with `TRIAGE_LLM_MODEL`.

LLM escalation decisions are recorded in the Hive Mind as `triage_llm_used` events.

### Depth penalty

Sub-agents spawned inside other agents are penalized to avoid Opus-level models being used deep in spawn pyramids:

| Spawn depth | Effect |
|---|---|
| 0 or 1 | No penalty |
| 2 | `high` capped to `mid` |
| 3 or deeper | Any tier capped to `low` |

## Spend tracking

Every LLM call is logged to the `model_spend` table with provider, model ID, tier, input token count, output token count, and the session and agent IDs. Cost estimates are computed at query time by joining against the `model_catalog` pricing.

The spend API (`GET /api/models/spend`) returns three views:

- **lastHour** — aggregate totals (tokens, calls, estimated cost) across all models in the past hour
- **byTier** — the same breakdown grouped by tier
- **byModel** — per-model breakdown, ordered by estimated cost descending, limited to the top 20 models

### Budget guard

When budget limits are configured, `pickModelAsync` enforces them before confirming a model choice. If a session or hourly token cap is exceeded and the selected tier is not already `low`, the tier is downgraded one step (`high → mid`, `mid → low`) and the decision is logged to the Hive Mind as a `triage_budget_downgrade` event.

## API routes

All routes require the `?token=` query parameter or `x-dashboard-token` header.

| Method | Path | Description |
|---|---|---|
| GET | `/api/models` | List catalog entries. Optional `?provider=`, `?tier=`, `?includeUnavailable=1` |
| POST | `/api/models/refresh` | Trigger immediate catalog refresh. Optional `?provider=voidai\|anthropic\|codex\|gemini` |
| POST | `/api/models/:provider/:modelId/tier` | Pin or clear a tier override |
| POST | `/api/models/:provider/:modelId/price` | Pin or clear a price override |
| GET | `/api/models/spend` | Spend summary for the past hour (totals, by tier, by model) |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TRIAGE_LLM_ENABLED` | `true` | Enable LLM-assisted triage for borderline scores |
| `TRIAGE_LLM_MODEL` | *(cheapest low-tier)* | Model to use for the LLM classifier; defaults to the first low-tier VoidAI model |
| `TRIAGE_BORDER_LOW` | `0.40` | Lower bound of the grey zone; LLM is consulted when score ≥ this value |
| `TRIAGE_BORDER_HIGH` | `0.55` | Upper bound of the grey zone; LLM is consulted when score ≤ this value |
| `BUDGET_SESSION_TOKENS` | `200000` | Per-session token cap; `0` disables the guard |
| `BUDGET_HOUR_TOKENS` | `1000000` | Rolling-hour token cap; `0` disables the guard |
