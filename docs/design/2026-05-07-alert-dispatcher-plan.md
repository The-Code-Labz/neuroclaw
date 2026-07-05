# Alert Dispatcher & Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a central AlertDispatcher that all background systems feed into, delivering reliable Discord/Gotify notifications without routing through any LLM, plus a TaskHealthMonitor that alerts when tasks stall.

**Architecture:** A new `AlertDispatcher` module accepts structured alerts from any system, applies in-memory dedup, then fans out to hive_mind (always), notify_user DB (error+), Discord direct via bot client (warn+), Gotify HTTP push (warn+), and Composio Discord as a fallback. Sentinel's three broken LLM-mediated alert paths are replaced with direct `sendAlert()` calls. A new `TaskHealthMonitor` runs on a schedule and fires escalating alerts for tasks stuck in `doing`.

**Tech Stack:** TypeScript, discord.js (already installed), SQLite via existing `getDb()`, native `fetch` for Gotify, `@composio/core` (already installed) for Discord fallback.

---

## File Map

| File | Change |
|---|---|
| `src/system/hive-mind.ts` | Add `'alert_sent'` and `'task_health_alert'` to `HiveAction` union |
| `src/config.ts` | Add `alerts` and `taskHealth` getter properties |
| `src/integrations/discord-bot.ts` | Add `sendToChannel()` export |
| `src/system/alert-dispatcher.ts` | **New** — central alert routing |
| `src/system/task-health.ts` | **New** — stuck task scanner |
| `src/system/sentinel.ts` | Replace 3 LLM alert paths with `sendAlert()` |
| `src/dashboard/server.ts` | Import and start task health monitor |

---

### Task 1: Add new HiveAction types

**Files:**
- Modify: `src/system/hive-mind.ts`

- [ ] **Step 1: Add `alert_sent` and `task_health_alert` to the HiveAction union**

Open `src/system/hive-mind.ts`. Find the line `| 'sessions_cleaned_up';` (the last entry in the `HiveAction` union, around line 100). Add two new entries before the closing semicolon:

```typescript
  | 'alert_sent'
  | 'task_health_alert'
  | 'sessions_cleaned_up';
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/system/hive-mind.ts
git commit -m "feat: add alert_sent and task_health_alert to HiveAction"
```

---

### Task 2: Add config getters for alerts and task health

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add the `alerts` getter**

Open `src/config.ts`. Find the closing `};` of the exported config object (after the `livekit` getter). Add the `alerts` getter before that closing brace:

```typescript
  get alerts() {
    return {
      discordChannelId: process.env.ALERT_DISCORD_CHANNEL_ID?.trim() || null,
      discordBotId:     process.env.ALERT_DISCORD_BOT_ID?.trim()     || null,
      gotifyUrl:        process.env.GOTIFY_URL?.trim()                || null,
      gotifyToken:      process.env.GOTIFY_TOKEN?.trim()              || null,
      dedupWarnMin:     parseInt(process.env.ALERT_DEDUP_WARN_MIN  ?? '30', 10),
      dedupErrorMin:    parseInt(process.env.ALERT_DEDUP_ERROR_MIN ?? '10', 10),
    };
  },
  get taskHealth() {
    return {
      intervalMin: parseInt(process.env.TASK_HEALTH_INTERVAL_MIN ?? '5',   10),
      warnMin:     parseInt(process.env.TASK_HEALTH_WARN_MIN     ?? '30',  10),
      errorMin:    parseInt(process.env.TASK_HEALTH_ERROR_MIN    ?? '120', 10),
      criticalMin: parseInt(process.env.TASK_HEALTH_CRITICAL_MIN ?? '480', 10),
    };
  },
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add alerts and taskHealth config getters"
```

---

### Task 3: Add sendToChannel to discord-bot.ts

**Files:**
- Modify: `src/integrations/discord-bot.ts`

- [ ] **Step 1: Add the sendToChannel export**

Open `src/integrations/discord-bot.ts`. Find the `export function listBotGuilds(...)` function (around line 975). Add `sendToChannel` directly before it:

```typescript
/**
 * Send a plain-text message to a Discord channel using any running bot.
 * Used by AlertDispatcher for code-level notifications — no LLM in path.
 * Returns { ok: false, error } on failure instead of throwing.
 */
export async function sendToChannel(
  channelId: string,
  text: string,
  botId?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    let bot: RunningBot | undefined;
    if (botId) {
      bot = running.get(botId);
    } else {
      for (const b of running.values()) {
        if (b.client.isReady()) { bot = b; break; }
      }
    }
    if (!bot || !bot.client.isReady()) {
      return { ok: false, error: 'no ready Discord bot available' };
    }
    const channel = await bot.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      return { ok: false, error: `channel ${channelId} not found or not text-based` };
    }
    await channel.send({ content: text });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors. `RunningBot` is defined in the same file (around line 212) and `running` is the `Map<string, RunningBot>` at line 220 — both are in scope.

- [ ] **Step 3: Commit**

```bash
git add src/integrations/discord-bot.ts
git commit -m "feat: export sendToChannel for code-level Discord alerts"
```

---

### Task 4: Create AlertDispatcher

**Files:**
- Create: `src/system/alert-dispatcher.ts`

- [ ] **Step 1: Create the file**

Create `src/system/alert-dispatcher.ts` with the following content:

```typescript
// AlertDispatcher — central notification router for all background systems.
//
// Delivery chain per severity:
//   info     → hive_mind only
//   warn     → hive_mind + Discord/Gotify (dedup 30 min)
//   error    → hive_mind + notify_user DB + Discord/Gotify (dedup 10 min)
//   critical → hive_mind + notify_user DB + Discord/Gotify (no dedup)
//
// Discord: direct bot client call (no LLM). Composio Discord fires as
// fallback only when no native bot is available.

import { config } from '../config';
import { getDb, createAgentUserMessage } from '../db';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';

export interface Alert {
  severity:  'info' | 'warn' | 'error' | 'critical';
  title:     string;
  body:      string;
  source:    string;
  dedupKey?: string;
}

const dedupMap = new Map<string, number>();

function isDuped(key: string, windowMin: number): boolean {
  const last = dedupMap.get(key);
  if (last === undefined) return false;
  return Date.now() - last < windowMin * 60_000;
}

function markFired(key: string): void {
  dedupMap.set(key, Date.now());
}

function formatDiscordMessage(alert: Alert): string {
  const emoji   = { info: '⚪', warn: '🟡', error: '🔴', critical: '🚨' }[alert.severity];
  const ts      = new Date().toLocaleString();
  const divider = '─'.repeat(40);
  return `${emoji} [${alert.severity.toUpperCase()}] ${alert.source}: ${alert.title}\n${divider}\n${alert.body}\n${ts}`;
}

async function sendDiscord(text: string): Promise<void> {
  const { discordChannelId, discordBotId } = config.alerts;
  if (!discordChannelId) return;

  const { sendToChannel } = await import('../integrations/discord-bot');
  const result = await sendToChannel(discordChannelId, text, discordBotId ?? undefined);

  if (!result.ok) {
    logger.warn('alert-dispatcher: Discord direct failed, trying Composio fallback', { error: result.error });
    await sendComposioDiscord(discordChannelId, text);
  }
}

async function sendComposioDiscord(channelId: string, text: string): Promise<void> {
  const { enabled, apiKey } = config.composio;
  if (!enabled || !apiKey) return;

  const db  = getDb();
  const row = db.prepare(
    `SELECT composio_user_id FROM agents
     WHERE status = 'active' AND composio_enabled = 1 AND composio_user_id IS NOT NULL
     LIMIT 1`,
  ).get() as { composio_user_id: string } | undefined;
  if (!row) return;

  try {
    const { Composio } = await import('@composio/core');
    const client = new Composio({ apiKey });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).actions.execute({
      actionName:  'DISCORD_SEND_MESSAGE_TO_CHANNEL',
      requestBody: {
        entityId: row.composio_user_id,
        input:    { channel_id: channelId, message: text },
      },
    });
  } catch (err) {
    logger.warn('alert-dispatcher: Composio Discord fallback failed', { error: (err as Error).message });
  }
}

async function sendGotify(alert: Alert): Promise<void> {
  const { gotifyUrl, gotifyToken } = config.alerts;
  if (!gotifyUrl || !gotifyToken) return;

  const priority = { info: 1, warn: 4, error: 7, critical: 10 }[alert.severity];
  try {
    const res = await fetch(`${gotifyUrl}/message?token=${gotifyToken}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        title:    `[${alert.severity.toUpperCase()}] ${alert.source}: ${alert.title}`,
        message:  alert.body,
        priority,
      }),
    });
    if (!res.ok) {
      logger.warn('alert-dispatcher: Gotify returned non-ok', { status: res.status });
    }
  } catch (err) {
    logger.warn('alert-dispatcher: Gotify error', { error: (err as Error).message });
  }
}

export async function sendAlert(alert: Alert): Promise<void> {
  const key = alert.dedupKey ?? alert.title;

  // 1. Always log to hive_mind
  logHive(
    'alert_sent',
    alert.title,
    undefined,
    { severity: alert.severity, source: alert.source, body: alert.body.slice(0, 500) },
  );

  // 2. notify_user DB write for error and critical
  if (alert.severity === 'error' || alert.severity === 'critical') {
    try {
      createAgentUserMessage({
        fromAgentId: 'alert-dispatcher',
        fromName:    alert.source,
        kind:        alert.severity === 'critical' ? 'error' : 'warn',
        body:        `**${alert.title}**\n\n${alert.body}`,
      });
    } catch (err) {
      logger.warn('alert-dispatcher: notify_user write failed', { error: (err as Error).message });
    }
  }

  // 3. info stops here — no external channels
  if (alert.severity === 'info') return;

  // 4. Dedup check (critical always fires)
  if (alert.severity !== 'critical') {
    const { dedupWarnMin, dedupErrorMin } = config.alerts;
    const windowMin = alert.severity === 'warn' ? dedupWarnMin : dedupErrorMin;
    if (isDuped(key, windowMin)) {
      logger.debug('alert-dispatcher: suppressed by dedup', { key, severity: alert.severity });
      return;
    }
  }

  markFired(key);
  const text = formatDiscordMessage(alert);

  // 5. Discord + Gotify in parallel (failures are logged, never thrown)
  await Promise.allSettled([
    sendDiscord(text),
    sendGotify(alert),
  ]);
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors. If `createAgentUserMessage` complains about `kind: 'error'` or `kind: 'warn'`, open `src/db.ts`, find the `AgentUserMessageKind` type, and confirm those strings are in the union. They should be — the type includes `'info' | 'warn' | 'error' | ...`.

- [ ] **Step 3: Commit**

```bash
git add src/system/alert-dispatcher.ts
git commit -m "feat: add AlertDispatcher — central alert routing with dedup, Discord, Gotify"
```

---

### Task 5: Create TaskHealthMonitor

**Files:**
- Create: `src/system/task-health.ts`

- [ ] **Step 1: Create the file**

Create `src/system/task-health.ts` with the following content:

```typescript
// TaskHealthMonitor — watches tasks stuck in 'doing' and alerts via AlertDispatcher.
//
// Independent of Sentinel's escalation ladder. Sentinel nudges agents;
// this monitor alerts the human. Three tiers: warn (30m), error (2h), critical (8h).
// Dedup key includes the tier so each task fires each tier at most once per window.

import { getDb } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { sendAlert } from './alert-dispatcher';

interface StuckTask {
  id:         string;
  title:      string;
  updated_at: string;
  agent_name: string | null;
}

function findStuckTasks(minMinutes: number): StuckTask[] {
  const threshold = new Date(Date.now() - minMinutes * 60_000).toISOString();
  return getDb().prepare(`
    SELECT t.id, t.title, t.updated_at, a.name AS agent_name
    FROM tasks t
    LEFT JOIN agents a ON t.agent_id = a.id
    WHERE t.status  = 'doing'
      AND t.archived = 0
      AND t.updated_at < ?
    ORDER BY t.updated_at ASC
  `).all(threshold) as StuckTask[];
}

export async function runTaskHealthScan(): Promise<{ checked: number }> {
  const { warnMin, errorMin, criticalMin } = config.taskHealth;
  const stuckTasks = findStuckTasks(warnMin);

  for (const task of stuckTasks) {
    const minutesStuck  = Math.round((Date.now() - new Date(task.updated_at).getTime()) / 60_000);
    const agentSuffix   = task.agent_name ? ` (assigned: ${task.agent_name})` : '';

    let severity: 'warn' | 'error' | 'critical';
    let tier:     string;
    let body:     string;

    if (minutesStuck >= criticalMin) {
      severity = 'critical';
      tier     = 'critical';
      body     = `"${task.title}" has been stuck for ${minutesStuck}m${agentSuffix} — Sentinel escalation failed.`;
    } else if (minutesStuck >= errorMin) {
      severity = 'error';
      tier     = 'error';
      body     = `"${task.title}" still stuck after ${minutesStuck}m${agentSuffix} — needs attention.`;
    } else {
      severity = 'warn';
      tier     = 'warn';
      body     = `"${task.title}" has been in-progress for ${minutesStuck}m${agentSuffix}.`;
    }

    try {
      await sendAlert({
        severity,
        source:   'task_health',
        title:    `Task stuck for ${minutesStuck}m: "${task.title}"`,
        body,
        dedupKey: `task_health_${task.id}_${tier}`,
      });
    } catch (err) {
      logger.warn('task-health: sendAlert failed', { taskId: task.id, error: (err as Error).message });
    }
  }

  return { checked: stuckTasks.length };
}

let healthTimer: NodeJS.Timeout | null = null;

export function startTaskHealthMonitor(): void {
  const intervalMs = config.taskHealth.intervalMin * 60_000;

  healthTimer = setInterval(() => {
    runTaskHealthScan().catch(err =>
      logger.warn('task-health: scan error', { error: (err as Error).message }),
    );
  }, intervalMs);

  logger.info('task-health: monitor started', {
    intervalMin: config.taskHealth.intervalMin,
    warnMin:     config.taskHealth.warnMin,
    errorMin:    config.taskHealth.errorMin,
    criticalMin: config.taskHealth.criticalMin,
  });
}

export function stopTaskHealthMonitor(): void {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/system/task-health.ts
git commit -m "feat: add TaskHealthMonitor — escalating alerts for stuck tasks"
```

---

### Task 6: Fix Sentinel's three broken alert paths

**Files:**
- Modify: `src/system/sentinel.ts`

- [ ] **Step 1: Add the sendAlert import**

Open `src/system/sentinel.ts`. Find the existing imports block (lines 11–19). Add the `sendAlert` import after the existing imports:

```typescript
import { sendAlert } from './alert-dispatcher';
```

- [ ] **Step 2: Add alert call to checkInWithAgent**

In `checkInWithAgent`, find the `logger.info('sentinel: check-in complete', ...)` line near the end of the function (around line 173). Add the `sendAlert` call immediately after it:

```typescript
  logger.info('sentinel: check-in complete', { taskId: task.id, agentName: agent.name, replyLen: reply.length });

  sendAlert({
    severity: 'warn',
    source:   'sentinel',
    title:    `Sentinel checked in with ${agent.name} about stalled task "${task.title}"`,
    body:     `Task has been in-progress for ${minutesStale}m. Agent response: "${reply.slice(0, 200)}"`,
    dedupKey: `sentinel_checkin_${task.id}`,
  }).catch(err => logger.warn('sentinel: sendAlert failed', { error: (err as Error).message }));
```

Note: `.catch()` makes it fire-and-forget so it doesn't block the escalation flow.

- [ ] **Step 3: Add alert call to requestReassignment**

In `requestReassignment`, find the `logger.info('sentinel: task reassigned', ...)` line near the end of the function (around line 269). Add the `sendAlert` call immediately after it:

```typescript
  logger.info('sentinel: task reassigned', { taskId: task.id, newAgentName: newAgent.name });

  sendAlert({
    severity: 'warn',
    source:   'sentinel',
    title:    `Sentinel reassigned "${task.title}" to ${newAgent.name}`,
    body:     `Previous agent was stalled. ${newAgent.name} has been onboarded with task context.\nOnboard reply: "${onboardReply.slice(0, 200)}"`,
    dedupKey: `sentinel_reassign_${task.id}`,
  }).catch(err => logger.warn('sentinel: sendAlert failed', { error: (err as Error).message }));
```

- [ ] **Step 4: Replace markBlocked's Alfred LLM call with a direct alert**

In `markBlocked`, find this block (around lines 296–308):

```typescript
  // Notify Alfred so he can alert the user via Discord
  if (alfred) {
    const sessionId = createSession(alfred.id, `[sentinel] blocked: ${task.title.slice(0, 50)}`);
    const msg =
      `[Sentinel → Alfred] BLOCKED TASK ALERT\n\n` +
      `Task: "${task.title}" is fully blocked.\n` +
      (task.description ? `Description: ${task.description}\n` : '') +
      `\nThis task has been stalled, checked in on, and reassigned — and is still not progressing.\n` +
      `Last agent response: "${(state.agent_response ?? 'none').slice(0, 400)}"\n\n` +
      `Please alert the user via Discord as soon as possible with the task title and the fact it is blocked.`;
    try {
      await chatStream(msg, sessionId, () => {}, alfred.system_prompt ?? '', alfred.id);
    } catch { /* best-effort */ }
  }
```

Delete that entire block and replace it with:

```typescript
  await sendAlert({
    severity: 'critical',
    source:   'sentinel',
    title:    `Task "${task.title}" is fully blocked`,
    body:     `Stalled through check-in and reassignment.\nLast agent response: "${(state.agent_response ?? 'none').slice(0, 300)}"`,
    dedupKey: `sentinel_blocked_${task.id}`,
  });
```

- [ ] **Step 5: Remove now-unused imports from sentinel.ts**

Check if `createSession`, `getAlfredAgent`, `chatStream` are still used elsewhere in the file after removing the Alfred call. `createSession` is used in `checkInWithAgent` and `requestReassignment`. `getAlfredAgent` is used in `requestReassignment`. `chatStream` is used in `checkInWithAgent` and `requestReassignment`. All three are still needed — no removals required.

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/system/sentinel.ts
git commit -m "fix: replace Sentinel's LLM-mediated alerts with direct AlertDispatcher calls"
```

---

### Task 7: Wire TaskHealthMonitor into server.ts

**Files:**
- Modify: `src/dashboard/server.ts`

- [ ] **Step 1: Add the import**

Open `src/dashboard/server.ts`. Find the line `import { startSentinel } from '../system/sentinel';` (around line 26). Add the task-health import directly after it:

```typescript
import { startSentinel } from '../system/sentinel';
import { startTaskHealthMonitor } from '../system/task-health';
```

- [ ] **Step 2: Start the monitor**

Find the line `startSentinel();` (around line 314). Add the task health monitor start directly after it:

```typescript
  startSentinel();
  startTaskHealthMonitor();
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Final commit**

```bash
git add src/dashboard/server.ts
git commit -m "feat: start TaskHealthMonitor alongside Sentinel in server bootstrap"
```

---

## Self-Review Checklist

- [x] **spec coverage — AlertDispatcher delivery chain:** Tasks 1–4 cover all five channels (hive_mind, notify_user, Discord direct, Gotify, Composio fallback) with correct severity gates and dedup
- [x] **spec coverage — TaskHealthMonitor:** Task 5 covers all three tiers (warn/error/critical), per-tier dedup keys, archived task exclusion, configurable thresholds
- [x] **spec coverage — Sentinel fixes:** Task 6 covers all three broken paths; `markBlocked` Alfred LLM call fully removed
- [x] **spec coverage — sendToChannel:** Task 3 covers the new discord-bot.ts export
- [x] **spec coverage — config vars:** Task 2 covers all 10 new env vars from the spec
- [x] **No placeholders:** All code blocks are complete and concrete
- [x] **Type consistency:** `Alert` interface defined in Task 4 and used identically in Tasks 5 and 6; `sendToChannel` signature defined in Task 3 and called correctly in Task 4
- [x] **HiveAction union:** `'alert_sent'` added in Task 1, used in Task 4's `logHive('alert_sent', ...)` call
