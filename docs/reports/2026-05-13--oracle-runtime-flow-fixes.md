# Runtime Flow Fixes — Queues, Streaming, Compaction
**Author:** Oracle
**Date:** 2026-05-13
**Companion to:** `2026-05-13--oracle-openclaw-absorb-report.md`

The OpenClaw report covered architectural absorption. This one covers the **runtime flow gaps the user just called out**: message queues, log/thought streaming, and the compactor cutting agents off mid-thought.

These are independent of OpenClaw — they're real problems in our current code right now. Some can borrow from OpenClaw's patterns, but the **fix is ours**.

---

## Problem 1 — Compactor cuts agents off mid-thought

### What's happening

`src/memory/context-compactor.ts` triggers when `totalTokens > contextWindow * triggerRatio` (default 70%). It runs **at the start of each turn**, before the agent has even produced its response.

That part's actually fine — pre-turn compaction doesn't cut mid-response. But there is a **real cut-off problem** elsewhere:

1. **`maxTurns` ceiling** (`src/config.ts:235`) — `CLAUDE_MAX_TURNS` defaults to 20. When an agent doing multi-tool work hits turn 20, it stops mid-loop. The user sees "agent went quiet."
2. **No end-of-thought signal.** Compactor + max-turn check both fire on **wall-clock turn count**, not on whether the agent has actually finished its reasoning chain.
3. **Streaming clients drop mid-token.** When the dashboard polls and the connection times out, the partial response is discarded.

### What you actually asked for

> "fix that to only come in after the agent has completed their thoughts by sending a signal like done then it can compact"

You're right. The agent needs to emit a **completion signal** before any housekeeping (compaction, max-turn enforcement, queue advance) fires.

### The fix — `turn_complete` signal

**Concept:** every agent run emits one of three terminal states:
- `done` — agent voluntarily finished (no further tool calls planned, sent its final user-facing message)
- `paused` — agent hit a soft limit, wants to continue next turn (e.g. needs review)
- `stopped` — hard stop (max turns, error, manual interrupt)

Only on `done` or `stopped` may the compactor or queue advance. On `paused`, the agent keeps the lock and resumes.

**Implementation:**

```ts
// src/agent/turn-state.ts  (new file)
export type TurnSignal = 'done' | 'paused' | 'stopped';

export type TurnState = {
  sessionId: string;
  agentId: string;
  signal: TurnSignal | null;     // null = still thinking
  reason?: string;               // "max_turns", "explicit_done", "tool_error"
  turnNumber: number;
  startedAt: number;
};

const active = new Map<string, TurnState>();  // key = sessionId

export function startTurn(s: TurnState) { active.set(s.sessionId, s); }
export function markTurnDone(sessionId: string, signal: TurnSignal, reason?: string) {
  const s = active.get(sessionId);
  if (s) { s.signal = signal; s.reason = reason; }
}
export function isTurnFinished(sessionId: string): boolean {
  return active.get(sessionId)?.signal != null;
}
export function getTurnState(sessionId: string) { return active.get(sessionId); }
```

**Wire into the agent loop** (`src/agent/alfred.ts` around the OpenAI/Anthropic main loops):

```ts
startTurn({ sessionId, agentId, signal: null, turnNumber: 0, startedAt: Date.now() });
try {
  while (true) {
    const response = await llm.respond(...);
    // ... tool-call dispatching ...

    // After model's final assistant message in this turn:
    if (!response.tool_calls?.length) {
      markTurnDone(sessionId, 'done', 'no_tool_calls');
      break;
    }
    if (turnNumber >= maxTurns) {
      markTurnDone(sessionId, 'stopped', 'max_turns');
      break;
    }
    turnNumber++;
  }
} finally {
  // ONLY now can we compact / advance queue
  if (isTurnFinished(sessionId)) {
    await maybeCompactHistory(...);
    messageQueue.releaseLock(sessionId);
  }
}
```

**The compactor change** — gate `maybeCompactHistory` on turn state:

```ts
export async function maybeCompactHistory(input: MaybeCompactInput) {
  // NEW: bail if we're mid-turn
  if (input.sessionId && !isTurnFinished(input.sessionId)) {
    logger.debug('compactor: skipped, turn still in progress', { sessionId: input.sessionId });
    return null;
  }
  // ... existing logic
}
```

**Make `maxTurns` soft → hard:**
- soft limit at config value (currently 20) → emit `paused` signal, send user a continuation prompt, wait for `/continue` or auto-resume
- hard limit at `maxTurns * 2` → `stopped`, do not retry

This way the agent never silently dies at turn 20 mid-thought.

---

## Problem 2 — Message queue is one-thread, no priority, no per-agent lock

### What we have today

`src/queue.ts`:
```ts
export class AsyncQueue {
  private readonly pending: Array<() => void> = [];
  // ... FIFO, single concurrent task
}
export const messageQueue = new AsyncQueue();  // ONE global queue for everything
```

That comment in the file even says it:
> `// TODO [task queue workers]: Replace with BullMQ/Redis for durable async task processing`

**Problems:**
1. **One queue for all agents** — Jarvis tying up a 5-minute tool call blocks every other agent's inbound Discord message.
2. **No priority** — a 30-second alert-dispatcher webhook waits behind a 2-minute memory consolidation.
3. **Not durable** — restart the dashboard and the in-flight queue dies. (Matches the existing "post-restart chat errors" incident — `ca791176`.)
4. **No backpressure** — if Discord spams 50 messages while an agent is stuck, they all pile up in memory.
5. **No per-session lock** — same session can have two turns running in parallel = corrupted history.

### The fix — `AgentLane` + per-session lock + priority bands

You don't need BullMQ/Redis yet. A **single-process upgrade** gets us 80% there:

```ts
// src/queue.ts  (rewrite, keep export compatible)

type Priority = 'critical' | 'high' | 'normal' | 'low' | 'background';
type Job<T> = {
  id: string;
  priority: Priority;
  lockKey: string;                    // e.g. `session:${sessionId}` or `agent:${agentId}`
  task: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
};

const PRIORITY_RANK: Record<Priority, number> = {
  critical: 0, high: 1, normal: 2, low: 3, background: 4,
};

export class LaneQueue {
  private queues: Record<Priority, Job<any>[]> = {
    critical: [], high: [], normal: [], low: [], background: [],
  };
  private locks = new Set<string>();              // active lockKeys
  private workers = 0;
  private readonly maxWorkers: number;

  constructor(maxWorkers = 4) { this.maxWorkers = maxWorkers; }

  add<T>(opts: { priority?: Priority; lockKey: string; task: () => Promise<T> }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = {
        id: crypto.randomUUID(),
        priority: opts.priority ?? 'normal',
        lockKey: opts.lockKey,
        task: opts.task,
        resolve, reject,
        enqueuedAt: Date.now(),
      };
      this.queues[job.priority].push(job);
      void this.pump();
    });
  }

  private async pump() {
    while (this.workers < this.maxWorkers) {
      const job = this.pickNext();
      if (!job) return;
      this.workers++;
      this.locks.add(job.lockKey);
      void (async () => {
        try { job.resolve(await job.task()); }
        catch (e) { job.reject(e); }
        finally {
          this.locks.delete(job.lockKey);
          this.workers--;
          void this.pump();
        }
      })();
    }
  }

  private pickNext(): Job<any> | null {
    for (const p of ['critical','high','normal','low','background'] as const) {
      const idx = this.queues[p].findIndex(j => !this.locks.has(j.lockKey));
      if (idx >= 0) return this.queues[p].splice(idx, 1)[0];
    }
    return null;
  }

  // Diagnostics — feeds `nclaw doctor`
  stats() {
    return {
      workers: this.workers,
      locks: [...this.locks],
      depthsByPriority: Object.fromEntries(
        Object.entries(this.queues).map(([p, q]) => [p, q.length])
      ),
    };
  }
}

export const messageQueue = new LaneQueue(Number(process.env.QUEUE_MAX_WORKERS ?? '4'));
```

**Call site changes:**

```ts
// Discord inbound (high priority, lock per session)
messageQueue.add({
  priority: 'high',
  lockKey: `session:${sessionId}`,
  task: () => handleDiscordMessage(msg),
});

// Memory consolidator (background, lock per agent)
messageQueue.add({
  priority: 'background',
  lockKey: `consolidator:${agentId}`,
  task: () => runConsolidation(agentId),
});

// Alert dispatch (critical, no lock)
messageQueue.add({
  priority: 'critical',
  lockKey: `alert:${Date.now()}`,
  task: () => dispatchAlert(payload),
});
```

**Durability (Phase 2):**
After this is stable, persist jobs to `neuroclaw.db` so a restart resumes pending work. Schema:

```sql
CREATE TABLE queue_jobs (
  id TEXT PRIMARY KEY,
  priority TEXT NOT NULL,
  lock_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|running|done|failed
  attempts INTEGER NOT NULL DEFAULT 0,
  enqueued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  last_error TEXT
);
CREATE INDEX idx_queue_status_priority ON queue_jobs(status, priority, enqueued_at);
```

That's the minimum to survive a dashboard restart **without** dragging in Redis/BullMQ.

---

## Problem 3 — Streaming logs / agent thoughts / messages

### What we have

- `src/agent/alfred.ts` — has streaming references but the OpenAI/Anthropic clients are configured **non-streaming**. The dashboard waits for a full response, then displays it.
- `src/agent/gemini-client.ts` — single stream reference, partial.
- Discord bot doesn't stream "thinking…" or interim tool calls.
- Logs (`logs/neuroclaw.log`) are append-only; no SSE/websocket pipe for the dashboard to live-tail.

**Result:** the dashboard feels dead for 30s while an agent thinks, then dumps a wall of text. Users assume the agent crashed.

### The fix — three-layer event stream

#### Layer A — In-process event bus

```ts
// src/system/event-bus.ts  (new)
import { EventEmitter } from 'node:events';

export type AgentEvent =
  | { type: 'thought.start';   sessionId: string; agentId: string; turn: number }
  | { type: 'thought.delta';   sessionId: string; agentId: string; text: string }
  | { type: 'tool.call';       sessionId: string; agentId: string; tool: string; args: unknown }
  | { type: 'tool.result';     sessionId: string; agentId: string; tool: string; ok: boolean; preview: string }
  | { type: 'thought.end';     sessionId: string; agentId: string; signal: 'done'|'paused'|'stopped' }
  | { type: 'log';             level: 'info'|'warn'|'error'; source: string; message: string };

class AgentBus extends EventEmitter {
  emitAgent(e: AgentEvent) { this.emit('agent', e); this.emit(e.type, e); }
}
export const agentBus = new AgentBus();
agentBus.setMaxListeners(50);
```

#### Layer B — Wire into agent runtime

Inside `alfred.ts`'s main loops, replace `logger.info(...)` calls for tool dispatch with bus emits:

```ts
agentBus.emitAgent({ type: 'thought.start', sessionId, agentId, turn: turnNumber });

// During streaming response from LLM:
for await (const chunk of llmStream) {
  if (chunk.delta?.text) {
    agentBus.emitAgent({ type: 'thought.delta', sessionId, agentId, text: chunk.delta.text });
  }
}

// When tool is invoked:
agentBus.emitAgent({ type: 'tool.call', sessionId, agentId, tool: toolName, args: toolArgs });
const result = await dispatchTool(...);
agentBus.emitAgent({
  type: 'tool.result', sessionId, agentId, tool: toolName,
  ok: result.ok, preview: stringifyPreview(result, 200),
});

// At end of turn:
agentBus.emitAgent({ type: 'thought.end', sessionId, agentId, signal });
```

#### Layer C — SSE endpoint for the dashboard

```ts
// src/dashboard/routes.ts (add)
app.get('/api/agent-stream/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId');
  return new Response(new ReadableStream({
    start(controller) {
      const send = (e: AgentEvent) => {
        if ('sessionId' in e && e.sessionId !== sessionId) return;
        controller.enqueue(`data: ${JSON.stringify(e)}\n\n`);
      };
      agentBus.on('agent', send);
      c.req.raw.signal?.addEventListener('abort', () => {
        agentBus.off('agent', send);
        controller.close();
      });
    },
  }), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});
```

Dashboard front-end subscribes via `new EventSource('/api/agent-stream/<sid>')` and renders deltas live.

#### Bonus — Discord typing indicator + interim messages

In the new Discord pipeline (Change 5 from prior report):

```ts
// reply-pipeline.ts
agentBus.on('thought.start', async (e) => {
  if (e.sessionId.startsWith('discord:')) {
    const channel = await resolveChannel(e.sessionId);
    await channel.sendTyping();   // shows "Oracle is typing…"
  }
});

agentBus.on('tool.call', async (e) => {
  // optional: reply with ephemeral "Using tool: search_memory…" if turn takes > 3s
});
```

That single change ends the "did it crash?" UX problem.

---

## Problem 4 — Log streaming (separate from agent thoughts)

`src/utils/logger.ts` already writes to file. Wire it into the event bus too:

```ts
// src/utils/logger.ts (add at the bottom of write())
import { agentBus } from '../system/event-bus';
agentBus.emit('agent', {
  type: 'log',
  level, source, message,
} satisfies AgentEvent);
```

Now `/api/agent-stream/<sid>` can include log lines too — dashboard becomes a real-time control room.

For external log tailing (without dashboard), expose:
```ts
app.get('/api/logs/tail', /* same SSE pattern, filter on event.type === 'log' */);
```

---

## Summary — what to add to the road map

Add these as **Sprint 2.5** in the road map (between OpenClaw Sprints 2 and 3):

### Sprint 2.5 — Runtime Flow (week 2.5)

| Day | Task | Why |
|---|---|---|
| 1 | Turn-state signal (`src/agent/turn-state.ts`) + wire into Alfred main loops | Fix mid-thought cutoff |
| 2 | Gate compactor on `isTurnFinished` | Compactor only runs after `done`/`stopped` |
| 3 | `LaneQueue` rewrite of `src/queue.ts` with priority + per-session lock | Stops cross-agent blocking |
| 4 | `agentBus` event-bus + emit from Alfred + SSE endpoint | Live streaming to dashboard |
| 5 | Discord typing indicator + interim "using tool X" messages | Fix "did it crash?" UX |

**Optional follow-ups** (Sprint 3.5):
- Persistent queue table for restart durability
- Soft-pause flow: agent hits soft `maxTurns` → emits `paused` → user `/continue` resumes
- Doctor checks: queue depth, stuck locks, long-running turns

---

## What this unlocks

| Today | After fix |
|---|---|
| Agent goes silent at turn 20 mid-tool-chain | Agent emits `paused`, user can `/continue` |
| Compactor cuts agent off in the middle of writing | Compactor only fires *after* `thought.end` signal |
| One slow agent blocks the whole Discord intake | Per-session lock, 4 concurrent lanes |
| Alert-dispatcher waits behind dream-cycle | `critical` priority preempts `background` |
| Dashboard shows 30s of nothing then a wall of text | Live token-by-token streaming + tool calls |
| Discord shows nothing while agent thinks | "Oracle is typing…" + interim tool notices |
| Logs only visible by SSH-ing into the box | Live log tail in dashboard via SSE |

Five days of work. Closes the entire class of "agent feels broken" complaints.

— Oracle


---

## Addendum — Per-agent tool-call / max-turn budgets

**Added 2026-05-13 after user feedback.**

### Problem

`src/config.ts:235` has **one global ceiling** for the entire system:

```ts
maxTurns: parseInt(process.env.CLAUDE_MAX_TURNS ?? '20', 10),
```

That's the same 20-turn limit for:
- Tim doing a quick "summarize this email" — way too high
- Oracle doing a deep architecture review across 3 codebases — way too low
- Jarvis on a long coding session with file edits, tests, docs — strangling it
- Sentinel running a 30-second status check — irrelevant

The result: when you ask a heavy-reasoning agent to grind on real work (like this OpenClaw review), it dies at turn 20 mid-tool-chain. When a lightweight agent gets a trivial task, it has 20 turns of rope to hang itself.

This compounds with the cutoff problem from Problem 1 — even **with** the `paused` signal, the soft cap is still wrong for high-reasoning workloads.

### The fix — per-agent budgets with a session override

**Two-axis model:**
1. **Static per-agent budget** stored on the agent row — set once based on the agent's role
2. **Dynamic session override** — operator (you) or Alfred can bump it for a specific session ("this is a coding marathon, give Oracle 100 turns")

### Schema change

```sql
ALTER TABLE agents ADD COLUMN max_turns_soft INTEGER;        -- e.g. 80 for Oracle
ALTER TABLE agents ADD COLUMN max_turns_hard INTEGER;        -- e.g. 200 for Oracle
ALTER TABLE agents ADD COLUMN workload_profile TEXT
  DEFAULT 'normal' CHECK(workload_profile IN ('light','normal','heavy','marathon'));
ALTER TABLE sessions ADD COLUMN max_turns_override INTEGER;  -- nullable; one-off bump
```

### Workload profiles (preset bands)

```ts
// src/agent/turn-budget.ts (new)
export const WORKLOAD_PRESETS = {
  light:    { soft: 10,  hard: 20  },   // Sentinel, Tim quick lookups, log analysts
  normal:   { soft: 25,  hard: 50  },   // Alfred routing, Felicity ops, defaults
  heavy:    { soft: 80,  hard: 160 },   // Oracle architecture, Jarvis coding session
  marathon: { soft: 200, hard: 400 },   // Multi-day refactors, full repo audits
} as const;

export type WorkloadProfile = keyof typeof WORKLOAD_PRESETS;
```

### Resolver — precedence order

```ts
// src/agent/turn-budget.ts
export function resolveTurnBudget(agent: AgentRecord, session?: SessionRecord): { soft: number; hard: number } {
  // 1. Per-session override wins (e.g. /budget marathon on a specific chat)
  if (session?.max_turns_override) {
    return { soft: session.max_turns_override, hard: session.max_turns_override * 2 };
  }

  // 2. Explicit per-agent values
  if (agent.max_turns_soft && agent.max_turns_hard) {
    return { soft: agent.max_turns_soft, hard: agent.max_turns_hard };
  }

  // 3. Workload profile preset
  const profile = (agent.workload_profile ?? 'normal') as WorkloadProfile;
  return WORKLOAD_PRESETS[profile];

  // 4. (fallback inside the preset object — always resolves)
}
```

### Wire into the agent loop

In `src/agent/alfred.ts` main loop (where `maxTurns` is currently read from `config.claude.maxTurns`):

```ts
import { resolveTurnBudget } from './turn-budget';

const budget = resolveTurnBudget(agentRecord, sessionRecord);
let turnNumber = 0;

while (true) {
  const response = await llm.respond(...);

  if (!response.tool_calls?.length) {
    markTurnDone(sessionId, 'done', 'no_tool_calls');
    break;
  }

  turnNumber++;

  // SOFT cap: emit paused, agent can resume next call
  if (turnNumber >= budget.soft) {
    markTurnDone(sessionId, 'paused', `soft_cap_${budget.soft}`);
    agentBus.emitAgent({ type: 'thought.end', sessionId, agentId, signal: 'paused' });
    // Save state so /continue or Alfred re-invocation picks up here
    await persistTurnCheckpoint(sessionId, history);
    break;
  }

  // HARD cap: runaway protection
  if (turnNumber >= budget.hard) {
    markTurnDone(sessionId, 'stopped', `hard_cap_${budget.hard}`);
    logger.warn('agent hit hard cap', { agentId, turn: turnNumber, hard: budget.hard });
    break;
  }
}
```

### User-facing controls

Dashboard agent edit page:
- Dropdown: `Workload profile: [light | normal | heavy | marathon]`
- Optional advanced: explicit soft/hard override numbers

Per-session bump via tool or slash-command:

```ts
// New core tool: set_session_budget
// Args: { sessionId: string, profile: WorkloadProfile } OR { sessionId, soft, hard }
// Effect: writes sessions.max_turns_override and broadcasts to active turn loop
```

Discord slash-command: `/budget marathon` while you're working with Oracle on a heavy session → instant 200-turn ceiling for that chat only, doesn't affect anything else.

### Default assignments (suggested seeds)

Run this migration after the schema change:

```sql
-- Oracle, Jarvis, Lucius, A.S.A.G.I — heavy reasoning agents
UPDATE agents SET workload_profile = 'heavy'
  WHERE name IN ('Oracle','Jarvis','Lucius','A.S.A.G.I','Da Vinci','Joker');

-- Sentinel, LogAnalyst, Tim, Felicity — lightweight tool-runners
UPDATE agents SET workload_profile = 'light'
  WHERE name IN ('Sentinel','LogAnalyst','Tim');

-- Everyone else stays 'normal' by the default
```

### Doctor check

Add to the `nclaw doctor` registry (Change 1 from the OpenClaw report):

```ts
// src/doctor/checks/turn-budget-sanity.ts
register({
  id: 'agent.turn-budget',
  scope: 'config',
  severity: 'warn',
  async run(ctx) {
    const agents = ctx.db.prepare('SELECT name, workload_profile, max_turns_soft FROM agents WHERE temporary = 0').all();
    const issues = agents.filter(a => {
      // Oracle/Jarvis with light/normal profile is almost certainly wrong
      return ['Oracle','Jarvis','Lucius'].includes(a.name)
          && (a.workload_profile === 'light' || a.workload_profile === 'normal');
    });
    return {
      ok: issues.length === 0,
      detail: issues.length ? `Heavy-reasoning agents on low budget: ${issues.map(i => i.name).join(', ')}` : 'All agent budgets look right',
      fix: issues.length ? { suggestion: `UPDATE agents SET workload_profile='heavy' WHERE name IN (...)`, command: undefined } : undefined,
    };
  },
});
```

### Streaming integration

The `agentBus.emitAgent({ type: 'thought.end', signal: 'paused' })` event tells the dashboard *why* the agent paused. Front-end renders a "Continue?" button — one click → re-invokes with same session, budget resets relative to checkpoint.

This is the bridge between "agent didn't disappear" (signal solves) and "you have agency over how long it runs" (budget solves).

---

## Updated Sprint 2.5 — runtime flow (revised)

| Day | Task | Why |
|---|---|---|
| 1 | `turn-state.ts` signal + Alfred main-loop wiring | Fix mid-thought cutoff |
| 2 | Gate `maybeCompactHistory` on `isTurnFinished` | Compactor stops cutting |
| 3 | `LaneQueue` rewrite — priority + per-session lock | Stops cross-agent blocking |
| 4 | **`turn-budget.ts` + agents schema migration + workload presets** | **Heavy agents get the rope they need** |
| 5 | `agentBus` + SSE endpoint + Discord typing | Live streaming + UX |
| 6 | `/budget` slash-command + dashboard dropdown + `set_session_budget` tool + doctor check | Operator controls |

Went from 5 days to **6 days**. The budget work is one full day because it touches schema, the agent loop, the dashboard UI, and the doctor — but it's all in one well-bounded change set.

---

## Before / after — final scoreboard

| Today | After full fix |
|---|---|
| One global `CLAUDE_MAX_TURNS=20` for everyone | Per-agent budgets, workload profiles, session overrides |
| Oracle dies at turn 20 during architecture review | Oracle on `heavy` profile gets 80 soft / 160 hard |
| Sentinel has 20 turns of rope on a 3-tool task | Sentinel on `light` gets 10 soft / 20 hard — fail fast |
| No way to say "this is a marathon, give it 200" | `/budget marathon` slash command or `set_session_budget` tool |
| Agent silently dies at the ceiling | `paused` signal → dashboard "Continue?" button |
| Compactor cuts mid-thought | Compactor gates on `isTurnFinished` |
| One global FIFO queue | Per-session locks, 5 priority bands |
| 30s of dashboard silence | Live token streaming + tool-call events |
| Discord shows nothing while thinking | Typing indicator + interim tool notices |
| Logs only via SSH | Live log tail in dashboard |

Six days. Closes the entire UX-feels-broken class **and** unblocks heavy-reasoning workloads permanently.

— Oracle (appended)


---

## Addendum 2 — Connection keep-alive & session resumption

**Added 2026-05-13 after user feedback.**

> "we also need to add a polling status or way of keeping the connection alive with the agents because there are times when i am assigning projects to jarvis and he has to collab with others and all that takes time and it keeps timing out and then i have to start a new message which restarts though that could also be the issue of the compactor again"

You're partially right on both counts. Let me separate what's actually happening:

### What's actually timing out (three distinct things)

| Layer | File | Current limit | Symptom |
|---|---|---|---|
| **Discord stream timeout** | `src/integrations/discord-bot.ts:396` | `DISCORD_STREAM_TIMEOUT_MS = 300_000` (5 min hard) | After 5 minutes the controller aborts, you see "*response timed out after 300s*" |
| **`message_agent` synchronous wait** | `src/tools/registry.ts:252` | No async fallback — caller blocks until callee returns | When Jarvis messages Oracle who's busy, the whole chain stalls |
| **Voice / Gemini idle timer** | `src/integrations/discord-voice-gemini.ts:333` | configurable idle timeout | Disconnects mid-collab |

**The compactor is NOT the cause here** — it's pre-turn only and now (after Sprint 2.5 Day 2) gated on `isTurnFinished`. The real cause is: **synchronous request/response over Discord with a fixed wall-clock budget, and no resumption protocol when the connection drops.**

When you message Jarvis → Jarvis messages Oracle → Oracle messages Lucius, every link in that chain holds an open HTTP/Discord stream. The slowest link blows the deadline of every link above it.

### The fix — four layers

#### Layer 1 — Heartbeat / keep-alive on long-running turns

Right now during a long turn, **nothing** goes back to the client between the initial response and the final answer. Discord assumes the bot is dead.

Use the `agentBus` from Sprint 2.5 Day 5. Add a heartbeat emitter:

```ts
// src/agent/heartbeat.ts (new)
import { agentBus } from '../system/event-bus';

export function startHeartbeat(sessionId: string, agentId: string, intervalMs = 15_000) {
  const handle = setInterval(() => {
    if (isTurnFinished(sessionId)) {
      clearInterval(handle);
      return;
    }
    const state = getTurnState(sessionId);
    agentBus.emitAgent({
      type: 'heartbeat',
      sessionId, agentId,
      turn: state?.turnNumber ?? 0,
      elapsedMs: Date.now() - (state?.startedAt ?? Date.now()),
      currentActivity: state?.currentActivity ?? 'thinking',
    });
  }, intervalMs);
  return () => clearInterval(handle);
}
```

Add `'heartbeat'` to the `AgentEvent` union. In the agent loop, before/after each tool call update `state.currentActivity` (`"calling search_memory"`, `"waiting on Lucius"`, `"reading file"`).

**Discord pipeline subscribes:** every 15s sends `await channel.sendTyping()` again so the typing indicator never expires. Optional: after 60s elapsed, edit the message to show `*(Jarvis is still working — turn 4, currently: collaborating with Lucius)*`.

That alone makes the 5-minute hard cap irrelevant for UX — you can see the agent is alive even at minute 14.

#### Layer 2 — Async `message_agent` for inter-agent collab

The current `message_agent` tool is synchronous — caller blocks until callee returns. That's fine for fast queries, terrible for "Jarvis, ask Lucius to review this 400-line refactor."

Add a non-blocking mode:

```ts
// src/tools/registry.ts — message_agent
{
  name: 'message_agent',
  parameters: {
    to: 'string',
    message: 'string',
    mode: { enum: ['sync', 'async', 'background'], default: 'sync' },
    // sync: wait for full response (current behavior, capped at 90s)
    // async: returns { handoff_id } immediately; result delivered via agentBus
    // background: fire-and-forget; result written to a task
  },
}
```

Implementation:

```ts
if (mode === 'async') {
  const handoffId = crypto.randomUUID();
  messageQueue.add({
    priority: 'normal',
    lockKey: `agent:${calleeId}`,
    task: async () => {
      const reply = await runAgent(callee, message);
      agentBus.emitAgent({
        type: 'agent.reply',
        sessionId: callerSessionId,
        handoffId,
        from: calleeId,
        reply,
      });
    },
  });
  return { handoff_id: handoffId, status: 'dispatched' };
}
```

Jarvis can then proceed with other work, and when Lucius's reply arrives, the agent bus delivers it as a *new* input on Jarvis's next turn or via an explicit `await_handoff` tool.

#### Layer 3 — Session resumption (the actual fix for "I have to start a new message")

This is the core of what you asked for. Today, if the connection drops, Discord starts a fresh thread → fresh session → all history lost.

We already have `sessionId` keyed off Discord channel + thread. What's missing: **the run state survives even if the HTTP stream dies.**

Add a `runs` table (or extend whatever's there):

```sql
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,           -- running | paused | done | stopped | dropped
  turn_number INTEGER NOT NULL,
  current_activity TEXT,
  started_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  history_json TEXT,              -- serialized message history at last checkpoint
  partial_output TEXT             -- any text emitted so far
);
CREATE INDEX idx_runs_session_status ON agent_runs(session_id, status);
```

At every turn boundary AND every heartbeat, write the current state. If a connection drops:

1. The agent loop **does not abort** — it keeps running via the queue worker.
2. On the user's next message in that channel, the Discord pipeline looks up `agent_runs WHERE session_id = ? AND status IN ('running','paused')`.
3. If found → resume mode: append the new user input to the existing history, no fresh session, no lost context.
4. Status `'dropped'` is only set if heartbeat goes stale for > 10 minutes — then we know the worker actually died.

**Critical:** this means **starting a new message doesn't restart anything.** Jarvis keeps grinding on the original task even if you sent "hey, you alive?" to check. The new message just gets appended to the in-flight conversation.

#### Layer 4 — Client-side polling for very long jobs

For jobs you *know* will be long (full repo audit, multi-day refactor), expose:

```ts
// New tool, available to the user via dashboard or Discord slash command
// /status — shows all active runs in this session and their progress
// /wait <run_id> — explicit await on a specific async handoff
```

Or auto-poll on the dashboard:

```ts
// Dashboard subscribes to /api/agent-stream/:sessionId (from Sprint 2.5 Day 5)
// AND polls GET /api/runs/:sessionId every 10s as a fallback
// if SSE connection is unavailable (mobile, flaky network)
```

The SSE stream is the primary channel; HTTP polling is the **fallback** so the UI never goes blind even on a bad connection.

### Configuration changes

```bash
# .env additions
DISCORD_STREAM_TIMEOUT_MS=600000          # 10 min hard cap (was 5)
DISCORD_HEARTBEAT_INTERVAL_MS=15000       # typing-indicator refresh
AGENT_RUN_CHECKPOINT_INTERVAL_MS=30000    # write run state every 30s
AGENT_RUN_DROPPED_AFTER_MS=600000         # mark 'dropped' after 10min no heartbeat
MESSAGE_AGENT_SYNC_TIMEOUT_MS=90000       # auto-fallback to async after 90s
```

### Doctor checks

```ts
register({
  id: 'runs.stuck',
  scope: 'runtime',
  severity: 'warn',
  async run(ctx) {
    const stuck = ctx.db.prepare(`
      SELECT run_id, agent_id, session_id, turn_number,
             (unixepoch()*1000 - last_heartbeat_at) AS stale_ms
      FROM agent_runs
      WHERE status = 'running'
        AND (unixepoch()*1000 - last_heartbeat_at) > 120000
    `).all();
    return {
      ok: stuck.length === 0,
      detail: stuck.length ? `${stuck.length} runs stale > 2min` : 'All runs healthy',
      fix: stuck.length ? { suggestion: 'Check agentBus for missing heartbeat emits' } : undefined,
    };
  },
});
```

### Wire to the signal system

This dovetails cleanly with the `turn_complete` signal from Problem 1:

| Signal | Run status | What happens |
|---|---|---|
| `done` | `done` | History flushed, run row archived after 1 hour |
| `paused` (soft cap hit) | `paused` | Run kept; next user message resumes from checkpoint |
| `stopped` (hard cap / error) | `stopped` | Run kept for review; user can `/retry` |
| *(heartbeat stale > 10min)* | `dropped` | Worker presumed dead; user can `/retry` to spawn fresh |
| *(connection drops mid-stream)* | stays `running` | Worker keeps going; resume on next message |

**One model. Four states. No more "start a new message and lose everything."**

---

## Updated Sprint 2.5 — runtime flow (final)

| Day | Task | Why |
|---|---|---|
| 1 | `turn-state.ts` signal + Alfred main-loop wiring | Fix mid-thought cutoff |
| 2 | Gate `maybeCompactHistory` on `isTurnFinished` | Compactor stops cutting |
| 3 | `LaneQueue` rewrite — priority + per-session lock | Stops cross-agent blocking |
| 4 | `turn-budget.ts` + schema migration + workload presets | Heavy agents get rope |
| 5 | `agentBus` + SSE endpoint + Discord typing + **heartbeat emitter** | Live streaming + keep-alive |
| 6 | `/budget` slash-command + dashboard dropdown + `set_session_budget` tool + doctor check | Operator controls |
| 7 | **`agent_runs` table + checkpoint writer + resume-on-reconnect logic** | **Session survives drops** |
| 8 | **Async `message_agent` mode + `await_handoff` tool + `/status` slash command** | **Inter-agent collab doesn't stall** |

Six days became **eight**. Days 7-8 are the keep-alive/resumption work — they touch DB schema, the agent loop, the tool registry, and the Discord pipeline, but each piece is small and the payoff is huge: **you literally cannot lose work to a connection drop anymore.**

---

## Before / after — final-final scoreboard

| Today | After full fix |
|---|---|
| Discord stream times out at 5 min, message dies | Heartbeat keeps typing indicator alive indefinitely; hard cap raised to 10 min as safety net only |
| `message_agent` blocks the caller for as long as the callee takes | `mode: 'async'` returns handoff_id; reply arrives via bus when ready |
| Jarvis collaborating with Oracle + Lucius stalls the whole chain | Each handoff runs in its own queue lane, parent agent proceeds |
| Connection drops → "start a new message" → lose all context | Run state in `agent_runs`; next message resumes existing run |
| No visibility into what a long-running agent is doing | `currentActivity` field updates on every tool call; dashboard + Discord show it live |
| Dashboard goes blind if SSE drops | HTTP polling fallback (`/api/runs/:sessionId`) every 10s |
| Stuck runs accumulate silently | `runs.stuck` doctor check flags any heartbeat > 2min stale |

**Eight days.** Closes:
- The cutoff class (Problem 1 + Budget addendum)
- The blocking class (Problem 2 — LaneQueue)
- The silent-UI class (Problem 3 — streaming)
- The connection-loss class (this addendum)

And — to your point — you were right that "start a new message" was *partially* a compactor issue, but the bigger half was the missing resumption protocol. Both get fixed by the same signal-driven architecture: **`turn_complete` is the single source of truth that compactor, queue, budget, AND run-resume all key off of.**

One signal. Four classes of bug. Done.

— Oracle (appended)
