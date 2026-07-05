# Alert Dispatcher & Observability Design

**Date:** 2026-05-07  
**Status:** Approved  
**Goal:** Make NeuroClaw reliable and observable — reliable Discord/Gotify alerts when things go wrong, and live visibility into stuck tasks — without routing any notifications through an LLM.

---

## Problem Statement

Sentinel detects stalled tasks and escalates them, but its alert delivery is broken in two ways:

1. `markBlocked` tells Alfred via a new LLM session to "alert the user via Discord" — Alfred may or may not call the Discord tool, making notifications unreliable.
2. `checkInWithAgent` and `requestReassignment` produce no user-visible signal at all.

Tasks can be stuck for hours with no alert reaching the user. There is also no independent monitoring of task health separate from Sentinel's escalation ladder.

---

## Architecture

```
Background systems (Sentinel, TaskHealthMonitor, future systems)
         │
         ▼
  AlertDispatcher                ← src/system/alert-dispatcher.ts
  ├── hive_mind log (always)
  ├── notify_user DB write (error + critical)
  ├── Discord direct send (warn+)
  ├── Gotify HTTP push (warn+)
  └── Composio Discord (warn+, fallback)

  TaskHealthMonitor              ← src/system/task-health.ts
  └── feeds AlertDispatcher

  Sentinel                       ← src/system/sentinel.ts (modified)
  └── 3 alert paths → AlertDispatcher (replaces LLM calls)
```

**Core principle:** Nothing that needs to alert the user goes through an LLM call. AlertDispatcher is pure code.

---

## Component 1: AlertDispatcher

**File:** `src/system/alert-dispatcher.ts`

### Interface

```typescript
interface Alert {
  severity:  'info' | 'warn' | 'error' | 'critical';
  title:     string;
  body:      string;
  source:    string;   // 'sentinel', 'task_health', 'heartbeat', etc.
  dedupKey?: string;   // defaults to title if omitted
}

export async function sendAlert(alert: Alert): Promise<void>
```

### Severity → Delivery Matrix

| Severity | Hive Mind | notify_user (dashboard) | Discord / Gotify | Dedup window |
|---|---|---|---|---|
| `info` | yes | no | no | — |
| `warn` | yes | no | yes | 30 min |
| `error` | yes | yes | yes | 10 min |
| `critical` | yes | yes | yes | none (always fires) |

### Dedup

In-memory `Map<dedupKey, lastFiredTimestamp>`. Resets on server restart. For `warn` and `error`, if the same `dedupKey` fired within the dedup window, skip Discord/Gotify but still log to hive_mind. `critical` always fires regardless.

### Delivery Channels

**1. Hive Mind** — always. Action: `alert_sent`. Includes severity, source, title.

**2. notify_user DB write** — `error` and `critical` only. Uses `createAgentUserMessage()` directly, no LLM. Appears in dashboard Comms → Notifications tab.

**3. Discord direct** — `warn`+. Requires `ALERT_DISCORD_CHANNEL_ID`. Uses a new `sendToChannel(botId, channelId, text)` export added to `discord-bot.ts` that accesses the running bot's `discord.js` Client directly — no LLM in path. Bot auto-selected from first active bot if `ALERT_DISCORD_BOT_ID` is omitted.

**4. Gotify** — `warn`+. Requires `GOTIFY_URL` + `GOTIFY_TOKEN`. Pure `fetch` POST to `${GOTIFY_URL}/message?token=${GOTIFY_TOKEN}`. Gotify priority mapped: warn=4, error=7, critical=10.

**5. Composio Discord** — `warn`+. True fallback: fires only when `ALERT_DISCORD_CHANNEL_ID` is set but no active native bot is available in the running map. Uses Composio's `DISCORD_SEND_MESSAGE_TO_CHANNEL` action. Prevents double-posting to the same channel when both are configured.

Channels 3 and 4 fire in parallel. Channel 5 fires only if channel 3 is unavailable. A failure in any channel does not block others. All delivery errors are logged but never thrown.

### Discord Message Format

```
🟡 [WARN] sentinel: Sentinel checked in with Coder about stalled task "Build auth flow"
────────────────────────────────────────
Task has been in-progress for 12 minutes without update.
Agent response recorded.
2026-05-07 14:32
```

Severity emoji: `info=⚪ warn=🟡 error=🔴 critical=🚨`

### New Environment Variables

| Variable | Default | Notes |
|---|---|---|
| `ALERT_DISCORD_CHANNEL_ID` | — | Channel to post alerts to |
| `ALERT_DISCORD_BOT_ID` | — | Optional; auto-picks first active bot |
| `GOTIFY_URL` | — | Gotify server base URL |
| `GOTIFY_TOKEN` | — | Gotify app token |
| `ALERT_DEDUP_WARN_MIN` | `30` | Dedup window for warn alerts |
| `ALERT_DEDUP_ERROR_MIN` | `10` | Dedup window for error alerts |

---

## Component 2: Task Health Monitor

**File:** `src/system/task-health.ts`

### Purpose

Independent of Sentinel's escalation ladder. Watches the clock on tasks in `doing` status and alerts the user directly at configurable thresholds. Sentinel manages agent nudging; Task Health Monitor manages user visibility.

### Schedule

Runs every `TASK_HEALTH_INTERVAL_MIN` (default 5) minutes via `setInterval`. Started in `server.ts` alongside `startSentinel()`.

### Alert Tiers

| Time in `doing` | Severity | Message |
|---|---|---|
| ≥ `TASK_HEALTH_WARN_MIN` (30m) | `warn` | Task "X" has been in-progress for 30m (assigned: Coder) |
| ≥ `TASK_HEALTH_ERROR_MIN` (2h) | `error` | Task "X" still stuck after 2h — needs attention |
| ≥ `TASK_HEALTH_CRITICAL_MIN` (8h) | `critical` | Task "X" has been stuck for 8h — escalation failed |

**Dedup key pattern:** `task_health_{taskId}_{tier}` — each task fires each tier at most once per dedup window. A task does not spam every 5 minutes; it fires once per tier crossing.

Archived tasks (`archived = 1`) are excluded.

### New Environment Variables

| Variable | Default | Notes |
|---|---|---|
| `TASK_HEALTH_INTERVAL_MIN` | `5` | How often the scanner runs |
| `TASK_HEALTH_WARN_MIN` | `30` | Minutes before first alert |
| `TASK_HEALTH_ERROR_MIN` | `120` | Minutes before error alert |
| `TASK_HEALTH_CRITICAL_MIN` | `480` | Minutes before critical alert |

---

## Component 3: Sentinel Modifications

**File:** `src/system/sentinel.ts`

Three changes. The escalation ladder logic, `sentinel_task_state` table, and LLM check-in calls are all preserved.

### `checkInWithAgent` — add alert after LLM call

Keep the existing `chatStream()` call (agent response is useful escalation context). After it completes, call:

```typescript
sendAlert({
  severity: 'warn',
  source:   'sentinel',
  title:    `Sentinel checked in with ${agent.name} about stalled task "${task.title}"`,
  body:     `Task has been in-progress for ${minutesStale}m. Agent response recorded.`,
  dedupKey: `sentinel_checkin_${task.id}`,
});
```

### `requestReassignment` — add alert after reassignment

Keep the Alfred LLM call for picking the best agent. After reassignment completes:

```typescript
sendAlert({
  severity: 'warn',
  source:   'sentinel',
  title:    `Sentinel reassigned "${task.title}" to ${newAgent.name}`,
  body:     `Previous agent was stalled. ${newAgent.name} has been onboarded with task context.`,
  dedupKey: `sentinel_reassign_${task.id}`,
});
```

### `markBlocked` — remove Alfred LLM call, replace with direct alert

**Remove** the `chatStream()` call to Alfred entirely. Replace with:

```typescript
sendAlert({
  severity: 'critical',
  source:   'sentinel',
  title:    `Task "${task.title}" is fully blocked`,
  body:     `Stalled through check-in and reassignment.\nLast agent response: "${(state.agent_response ?? 'none').slice(0, 300)}"`,
  dedupKey: `sentinel_blocked_${task.id}`,
});
```

This is the primary bug fix. `critical` severity has no dedup, so it always fires immediately.

---

## Component 4: discord-bot.ts Addition

**File:** `src/integrations/discord-bot.ts`

Add one exported function:

```typescript
export async function sendToChannel(
  channelId: string,
  text: string,
  botId?: string,
): Promise<{ ok: boolean; error?: string }>
```

Looks up the bot from the `running` map (auto-selects first ready bot if `botId` omitted), fetches the channel via `client.channels.fetch(channelId)`, calls `channel.send(text)`. Returns `{ ok: false, error }` on failure rather than throwing, so AlertDispatcher can log and continue.

---

## Files Changed

| File | Change |
|---|---|
| `src/system/alert-dispatcher.ts` | **New** — central alert routing |
| `src/system/task-health.ts` | **New** — stuck task scanner |
| `src/integrations/discord-bot.ts` | **Modified** — add `sendToChannel` export |
| `src/system/sentinel.ts` | **Modified** — 3 alert paths → `sendAlert()` |
| `src/dashboard/server.ts` | **Modified** — start task health monitor |
| `src/config.ts` | **Modified** — new alert + task health env vars |

---

## What This Does Not Change

- Sentinel's escalation ladder (check-in → reassign → block) is unchanged
- `sentinel_task_state` schema is unchanged
- The LLM check-in call in `checkInWithAgent` is preserved (agent response is useful)
- The Alfred LLM call in `requestReassignment` for picking the best agent is preserved
- No new DB tables required
