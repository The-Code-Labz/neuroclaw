# Provider Usage Tab — Design Spec
_Date: 2026-05-09_

## Goal

Add a dedicated **Usage** page to the NeuroClaw dashboard that shows per-provider token consumption, call counts, and estimated cost across configurable time ranges. Fix the existing Analytics page provider donut, which currently shows tier splits (HIGH/MID/LOW) instead of real provider names.

---

## Scope

- New dashboard page: **Usage** (`page-usage.jsx`)
- Nav entry in `shell.jsx`
- One-line fix in `alfred.ts`: Claude CLI path logs provider as `'anthropic'` — change to `'claude-cli'`
- Two new query functions in `model-spend.ts`
- One new API endpoint in `routes.ts`: `GET /api/analytics/usage?hours=N`
- Fix Analytics page provider donut in `live-data.jsx` (use real provider names from new endpoint instead of tier splits)

Out of scope: custom date ranges, CSV export, budget alerts.

---

## Architecture

### 1. `alfred.ts` — provider key fix

The `chatStreamClaudeCli()` function currently calls `logSpend({ provider: 'anthropic', ... })`. Change to `provider: 'claude-cli'`. This is the only change needed to distinguish Claude CLI from Anthropic API in historical spend data going forward.

No schema migration required — `model_spend` already stores `provider` as a free-text field.

### 2. `model-spend.ts` — two new query functions

**`spendByProvider(hours: number): ProviderUsageRow[]`**

```sql
SELECT
  s.provider,
  SUM(s.input_tokens + s.output_tokens) AS total_tokens,
  SUM(s.input_tokens)  AS input_tokens,
  SUM(s.output_tokens) AS output_tokens,
  COUNT(*) AS call_count,
  COALESCE(SUM(
    (s.input_tokens  / 1000.0) * COALESCE(c.cost_per_1k_input,  0) +
    (s.output_tokens / 1000.0) * COALESCE(c.cost_per_1k_output, 0)
  ), 0) AS est_cost_usd
FROM model_spend s
LEFT JOIN model_catalog c
  ON c.provider = s.provider AND c.model_id = s.model_id
WHERE s.created_at > datetime('now', '-N hours')
GROUP BY s.provider
ORDER BY total_tokens DESC
```

**`spendByProviderAndAgent(hours: number): ProviderAgentRow[]`**

```sql
SELECT
  s.provider,
  s.agent_id,
  COALESCE(a.name, 'unknown') AS agent_name,
  SUM(s.input_tokens + s.output_tokens) AS total_tokens,
  COUNT(*) AS call_count
FROM model_spend s
LEFT JOIN agents a ON a.id = s.agent_id
WHERE s.created_at > datetime('now', '-N hours')
GROUP BY s.provider, s.agent_id
ORDER BY s.provider, total_tokens DESC
```

### 3. `routes.ts` — new endpoint

```
GET /api/analytics/usage?hours=24
```

Returns:
```json
{
  "byProvider": [ ProviderUsageRow[] ],
  "byProviderAgent": [ ProviderAgentRow[] ]
}
```

`hours` parameter: 1, 24, 168 (7d), 720 (30d). Defaults to 24. Protected by the standard dashboard token auth.

### 4. `page-usage.jsx` — new dashboard page

#### Layout

```
[USAGE]                                    [1H] [24H] [7D] [30D]

TOTAL TOKENS    TOTAL CALLS    EST COST    TOP PROVIDER
128,441         847            $2.34       VoidAI

PROVIDER BREAKDOWN
┌────────────────────────────────────────────────────────────┐
│ PROVIDER     TOKENS       CALLS   EST COST    SHARE        │
├────────────────────────────────────────────────────────────┤
│ ▶ VoidAI      89,210       524     $1.62     ████░░ 69%    │
│ ▶ Claude CLI  ~34,120      203     —         ██░░░░ 27%    │
│ ▶ Gemini CLI  ~5,111       120     —         █░░░░░  4%    │
└────────────────────────────────────────────────────────────┘

(expanded VoidAI row — per-agent breakdown)
      Alfred         52,100    310
      Researcher     25,000    150
      Coder          12,110     64
```

#### Behavior

- **Time range tabs** (1H / 24H / 7D / 30D): each click fetches `/api/analytics/usage?hours=N`, re-renders the table. Default: 24H.
- **Expandable rows**: clicking the `▶` triangle on a provider row shows the agent breakdown for that provider. Only agents with at least one call in the window are shown. Toggle on second click.
- **`~` prefix**: applied to token counts for `codex` and `gemini` providers (these use `estimateTokens()` internally). All other providers show exact counts. No prefix on call counts.
- **Cost column**: shown only for providers with catalog pricing (`voidai`, `anthropic`, `openrouter`, `ollama`). CLI-only providers (`claude-cli`, `codex`, `gemini`) show `—` since cost-per-token data is not available.
- **Empty state**: if `model_spend` has no rows for the selected window, show "No usage recorded in this period."

#### Token estimation flag

| Provider | Token source | Display |
|---|---|---|
| `voidai` | API response | exact |
| `anthropic` | API response | exact |
| `claude-cli` | SDK `result.usage` (when available) | exact |
| `codex` | `estimateTokens()` | `~` prefix |
| `gemini` | `estimateTokens()` | `~` prefix |
| `openrouter` | API response | exact |
| `ollama` | API response | exact |

### 5. `live-data.jsx` — fix Analytics page provider donut

Replace the current `providerSplit` calculation (which maps `byTier` → tier names) with a call to the new `/api/analytics/usage?hours=1` endpoint. Map `byProvider` rows to the donut format:

```js
providerSplit = byProvider.map(p => ({
  name: providerLabel(p.provider),   // 'VoidAI', 'Claude CLI', etc.
  share: p.total_tokens / totalTokens,
  color: providerColor(p.provider),
}))
```

This requires adding `usage` to the live-data tick calls array and using it to populate `providerSplit`.

---

## Provider Display Names

Consistent mapping used in both the Usage page and the Analytics donut fix:

| `provider` value | Display name |
|---|---|
| `voidai` | VoidAI |
| `anthropic` | Anthropic API |
| `claude-cli` | Claude CLI |
| `codex` | Codex CLI |
| `gemini` | Gemini CLI |
| `openrouter` | OpenRouter |
| `ollama` | Ollama |
| anything else | title-cased |

---

## Nav Registration

Add "Usage" entry to `shell.jsx` nav, in the OBSERVE group (alongside Analytics, Health, Logs). Icon: `bar-chart` or similar from `icons.jsx`.

---

## Files Changed

| File | Change |
|---|---|
| `src/agent/alfred.ts` | Change `provider: 'anthropic'` → `provider: 'claude-cli'` in `chatStreamClaudeCli()` |
| `src/system/model-spend.ts` | Add `spendByProvider()` and `spendByProviderAndAgent()` |
| `src/dashboard/routes.ts` | Add `GET /api/analytics/usage` endpoint |
| `src/dashboard/v2/src/page-usage.jsx` | New file |
| `src/dashboard/v2/src/live-data.jsx` | Add usage endpoint to tick, fix `providerSplit` |
| `src/dashboard/v2/src/shell.jsx` | Add Usage nav entry |

No DB migrations. No new dependencies.
