# System Audit Report — 2026-05-31

**Auditor:** Static analysis sweep (Claude Sonnet 4.6) + direct DB/runtime inspection  
**Scope:** Full codebase — agent core, Discord integration, run delivery, job worker, memory subsystem, config layer, broker, vision, dashboard/API, exec tools  
**Method:** Source tracing, schema inspection, DB stats snapshot, live service interrogation  
**Live stress test:** Not performed — see §7 for load-projection findings

---

## Executive Summary

**Overall Health Grade: C**

The system is operational and carrying a non-trivial backlog of correctness bugs in four high-risk zones: (1) run lifecycle and Discord delivery races, (2) the job worker's fatal `updated_at` column bug, (3) the broker's subprocess secret-exposure gap, and (4) a context compactor infinite-loop. The DB snapshot shows 511 dropped runs, 222 errors, a stuck claimed job, and a zombie pending job — all consistent with the found bugs. The 753MB SQLite DB (59% audio blobs, zero eviction) is a ticking operational risk.

**Top 5 Risks**

- **Job worker silent failure (CRITICAL):** `requeueJobWithoutAttemptIncrement` references a non-existent `updated_at` column, causing every 429-throttled job to permanently stick as `claimed` until the next server restart. Explains the stuck `b1f15dac` job visible in the DB snapshot.
- **Broker subprocess inherits full environment (HIGH):** In-process `broker.exec()` passes `{ ...process.env }` to child processes, including `NC_BROKER_HMAC_KEY`, `DASHBOARD_TOKEN`, and all API keys. Any shell command executed via the broker can exfiltrate all secrets.
- **Duplicate Discord delivery race (HIGH):** `run:terminal` can fire while `liveEditLoop` is still awaiting `flushLoopDone`, allowing `deliverRun` to post a second copy of the reply before `markRunDelivered` is called. Multiple independent trigger paths.
- **Context compactor infinite loop (HIGH):** `triggerRatio` (0.70) < `targetRatio` (0.75); every compaction pass leaves more tokens than the trigger threshold, causing re-fire on every subsequent turn.
- **`GET /api/env/:key` secret disclosure (HIGH):** Any authenticated dashboard session can extract every `process.env` value including `DASHBOARD_TOKEN` itself.

---

## Findings Table

| ID | Subsystem | Severity | Status | File:Line | Evidence |
|----|-----------|----------|--------|-----------|----------|
| JOB-001 | Job Worker | **critical** | confirmed | `src/system/job-worker.ts:22` | `requeueJobWithoutAttemptIncrement` references non-existent `updated_at` column; every 429-throttled job sticks as `claimed` permanently |
| JOB-002 | Job Worker | high | confirmed | `src/system/job-worker.ts:100` | 429 requeue path skips `attempts` increment; job retries forever with no backoff or cap |
| JOB-003 | Job Worker | high | confirmed | `src/system/job-worker.ts:37` | `recoverStaleClaims()` only called once at startup; stuck claimed jobs accumulate between restarts — currently 1 job stuck >1h |
| DB-001 | SQLite/Audio | high | confirmed | `src/db.ts:3719` | `pruneAudioCache()` exported but never called; 112 blobs (424MB = 59% of 753MB DB) accumulate unboundedly — all `hit_count=0` |
| MEM-001 | Context Compactor | high | confirmed | `src/memory/context-compactor.ts:159` | `triggerRatio` (0.70) < `targetRatio` (0.75); post-compaction tokens exceed trigger; compaction re-fires every turn |
| SEC-005 | Dashboard API | high | confirmed | `src/dashboard/routes.ts:3857` | `GET /api/env/:key` returns raw secret values including `DASHBOARD_TOKEN` to any authenticated caller |
| BROKER-001 | Broker | high | confirmed | `src/broker/routes/agent.ts:254` | `/inject` endpoint bypasses `resolveScope()`; supervisor can read secrets from any agent's private scope |
| BROKER-002 | Broker | high | confirmed | `src/broker/index.ts:90` | In-process `broker.exec()` passes `{ ...process.env }` to child; all secrets inherited |
| ALFRED-001 | Agent Core | high | confirmed | `src/agent/alfred.ts:892` | `throw streamErr` in non-ollama/non-voidai catch block skips `endRun`; run stays `running` forever |
| ALFRED-002 | Agent Core | high | confirmed | `src/agent/alfred.ts:2131` | `AbortSignal` forwarded only to `chatStreamMcp`; all other provider branches ignore it |
| ALFRED-003 | Agent Core | high | confirmed | `src/agent/alfred.ts:500` | Shared mutable `history[0]` written across `await` calls; concurrent requests race on system prompt |
| RUNNER-003 | Sub-agent Runner | high | confirmed | `src/system/sub-agent-runner.ts:221` | Pre-filtered `routes` array throws immediately on all-quota-exhausted state; no graceful degradation |
| DISCORD-001 | Discord Bot | high | confirmed | `src/integrations/discord-bot.ts:736` | Error catch block edits message without `await flushLoopDone`; flush loop can overwrite error notice |
| DISCORD-002 | Discord Bot | high | confirmed | `src/integrations/discord-bot.ts:839` | `run:terminal` fires while `liveEditLoop` awaits `flushLoopDone`; `deliverRun` sees `delivered=0` and posts duplicate |
| DISCORD-003 | Discord Monitor | high | confirmed | `src/system/discord-placeholder-monitor.ts:261` | `run:terminal` listener registered after slow HTTP round-trip; fast-completing runs miss the event |
| DELIVERY-001 | Run Delivery | high | confirmed | `src/system/run-delivery.ts:36` | TOCTOU gap in `delivered` flag; sweeper and event path can both pass the guard concurrently |
| DELIVERY-004 | Run Delivery | high | confirmed | `src/db.ts:2709` | `endRun` has no terminal-state guard; sweeper drop → agent resume → `endRun('done')` fires second `run:terminal` |
| TRIAGE-001 | Sub-agent Triage | high | confirmed | `src/system/sub-agent-triage.ts:114` | `kindOverride` paths bypass `isChatCapableModel()` guard entirely |
| MEM-002 | Dream Cycle | high | confirmed | `src/memory/dream-cycle.ts:449` | No dedup check in `writeVaultNoteTool`; 24h lookback on consecutive nightly runs creates duplicate memories |
| CFG-010 | Config/Sentinel | high | confirmed | `src/system/sentinel.ts:26` | Six sentinel config constants read at module-scope import time; hot-reload cannot update them |
| TURN-001 | Agent Core | medium | confirmed | `src/agent/turn-budget.ts:52` | `resolveTurnBudget()` never called in any runtime path; `max_turns_soft`/`max_turns_hard` agent fields are dead config |
| ALFRED-004 | Agent Core | medium | confirmed | `src/agent/alfred.ts:2479` | `@AgentName` regex requires trailing whitespace; bare `@AgentName` messages silently ignored |
| ALFRED-005 | Agent Core | medium | confirmed | `src/agent/alfred.ts:2483` | `@mention` to inactive agent falls through silently with no user notification |
| ALFRED-006 | Agent Core | medium | confirmed | `src/agent/alfred.ts:594` | `MAX_TOOL_ITERATIONS` exhaustion produces empty `finalText`; no terminal message emitted to user |
| TRIAGE-008 | Sub-agent Triage | medium | confirmed | `src/system/sub-agent-triage.ts:152` | `isChatCapableModel()` guard only applied to ollama path; litellm never validated |
| RUNNER-002 | Sub-agent Runner | medium | confirmed | `src/system/sub-agent-runner.ts:67` | In-memory `quotaExhaustedUntil` Map lost on restart; provider retried immediately |
| RUNNER-005 | Ollama Client | medium | confirmed | `src/agent/ollama-client.ts:4` | `resetOllamaClient()` never called by config-watcher; `OLLAMA_BASE_URL` change needs restart |
| RUNNER-006 | Sub-agent Runner | medium | confirmed | `src/system/sub-agent-runner.ts:67` | N concurrent calls all read provider healthy; all 429 before any marks exhausted |
| DISCORD-004 | Discord Monitor | medium | confirmed | `src/system/discord-placeholder-monitor.ts:159` | Optimistic `markRunDelivered` before edit; crash leaves stale placeholder permanently |
| DISCORD-005 | Discord Bot | medium | confirmed | `src/integrations/discord-bot.ts:1350` | No `guildCreate` listener; slash commands never registered to guilds joined after `ready` |
| DISCORD-006 | Discord Voice | medium | confirmed | `src/integrations/discord-voice.ts:480` | Concurrent `voiceStateUpdate` handlers race on session creation; orphaned `VoiceConnection` |
| DISCORD-008 | Discord Bot | medium | confirmed | `src/integrations/discord-bot.ts:726` | Same flush-race root cause as DISCORD-001 on non-timeout stream errors |
| DELIVERY-002 | Run Delivery | medium | confirmed | `src/system/discord-placeholder-monitor.ts:159` | Optimistic `markRunDelivered` races with `startRunDelivery` event subscriber |
| DELIVERY-003 | Run Delivery | medium | confirmed | `src/db.ts:2907` | `bumpNotifyAttempts`: two separate SQLite statements; cap enforcement not atomic |
| DELIVERY-005 | Stale Run Sweeper | medium | confirmed | `src/system/stale-run-sweeper.ts:161` | Double-filter with inconsistent effective grace periods |
| DELIVERY-008 | Discord Monitor | medium | confirmed | `src/system/discord-placeholder-monitor.ts:264` | Hard-cap `.finally` sets `delivered=1` even if `placeholder.edit()` failed; response permanently lost |
| MEM-003 | Context Compactor | medium | confirmed | `src/memory/context-compactor.ts:217` | `targetTokens` overwritten before `maxCompactTurns` cap check; returned plan inconsistent |
| MEM-004 | Dream Cycle | medium | confirmed | `src/memory/dream-cycle.ts:497` | `listMemoryIndex({ limit: 1000 })` silently drops older eligible memories |
| JOB-004 | Job Worker | medium | confirmed | `src/db.ts:3877` | Per-attempt error history not preserved; only most recent error visible on retrying jobs |
| JOB-005 | Job Worker | medium | confirmed | `src/db.ts:3877` | No dead-letter alerting for exhausted `background_agent`/`agent_task` jobs |
| JOB-006 | Cron Scheduler | medium | confirmed | `src/system/cron-scheduler.ts:46` | Non-idempotent job types default to `max_attempts=3`; transient failure causes duplicate execution |
| CFG-001 | Config | medium | confirmed | `src/config.ts:394` | `VISION_MODEL` code default `'gpt-4o'` vs `.env.example` `'gpt-4.1'` |
| CFG-002 | Config | medium | confirmed | `src/config.ts:197` | `COMPACT_TOKEN_THRESHOLD` code default 100000 vs `.env.example` 8000 — 12.5x discrepancy |
| CFG-011 | Config | medium | confirmed | `src/system/run-delivery.ts:19` | `RUN_DELIVERY_MAX_ATTEMPTS` at module scope; NaN → infinite retries |
| CFG-012 | Config | medium | confirmed | `src/system/attachment-registry.ts:43` | `LARGE_FILE_THRESHOLD` no NaN guard |
| CFG-013 | Config/Discord | medium | confirmed | `src/integrations/discord-bot.ts:427` | `DISCORD_STREAM_TIMEOUT_MS` at module scope; hot-reload ineffective |
| SEC-001 | Dashboard API | medium | confirmed | `src/dashboard/routes.ts:676` | `POST /webhooks/:slug` unauthenticated; no HMAC verification |
| SEC-002 | Dashboard API | medium | confirmed | `src/dashboard/routes.ts:719` | `/api/cookies/sync` CORS `*` runs before auth middleware |
| SEC-003 | Dashboard API | medium | confirmed | `src/dashboard/server.ts:367` | `GET /api/audio/file/:filename` registered before auth middleware; publicly accessible |
| SEC-010 | Dashboard API | medium | confirmed | `src/dashboard/routes.ts:5250` | `POST /api/cookies/sync` writes cookie values verbatim to `/root/.*`; CORS `*` |
| EXEC-001 | Exec Tools | medium | confirmed | `src/system/exec-tools.ts:162` | `bashRun()` no `settled` guard; duplicate `logAudit()` on spawn failure |
| EXEC-006 | DB Hot Path | medium | confirmed | `src/db.ts:2778` | `appendPartialOutput()` calls `getDb().prepare()` on every token; no prepared statement caching |
| VIS-003 | Vision | medium | confirmed | `src/vision/vision-service.ts:122` | `describeImages()` uses unbounded `Promise.all`; no concurrency cap |
| VIS-004 | Vision | medium | confirmed | `src/vision/vision-service.ts:94` | No per-provider `data:` URI validation; no size cap |
| VIS-007 | Vision/xAI | medium | confirmed | `src/image/xai-credentials.ts:67` | JWT refresh race; `triggerHermesRefresh()` returns before OAuth cycle completes |
| BROKER-003 | Broker | medium | confirmed | `src/broker/index.ts:104` | In-process exec scrubs only requested secrets; process.env-level secrets not scrubbed from output |
| BROKER-004 | Broker | medium | confirmed | `src/broker/index.ts:95` | In-process exec has no output cap; large subprocess output → unbounded memory |
| BROKER-006 | Broker | medium | confirmed | `src/broker/memoryScrub.ts:30` | `scrubForMemory()` fail-open; storage outage → unscrubbed secrets persist to `memories` table |
| ALFRED-007 | Agent Core | low | confirmed | `src/agent/alfred.ts:810` | `onChunk` fire-and-forget; errors silently swallowed |
| ALFRED-008 | Agent Core | low | confirmed | `src/agent/alfred.ts:1288` | Anthropic `max_tokens` continuation pushes unpaired turns to in-memory history without DB persistence |
| ALFRED-009 | Agent Core | low | confirmed | `src/agent/alfred.ts:2261` | `ownsRun` semantics rely on caller passing `runId`; no enforcement |
| DISCORD-007 | Discord Voice | low | confirmed | `src/integrations/discord-voice.ts:424` | `leave()` does not clear `speakingListeners`; memory leak on repeated join/leave |
| DELIVERY-006 | Stale Run Sweeper | low | confirmed | `src/system/stale-run-sweeper.ts:259` | `runDeliveryRetrySweep` no reentrancy guard; concurrent sweeps deliver same runs |
| DELIVERY-007 | Run Delivery | low | confirmed | `src/db.ts:2856` | `listStaleRuns` includes `paused` runs; paused runs idle >5 min silently dropped |
| DELIVERY-009 | Run Delivery | low | confirmed | `src/system/run-delivery.ts:42` | Non-Discord `done` runs marked `delivered=1` without verifying `saveMessage` succeeded |
| MEM-005 | Dream Cycle | low | confirmed | `src/memory/dream-cycle.ts:217` | 80-char signature truncation; unrelated memories can collide and be spuriously promoted |
| MEM-006 | Memory Extractor | low | confirmed | `src/memory/memory-extractor.ts:233` | Missing `components` defaults to `{}`; memory silently accepted with no quality signals |
| MEM-007 | Session Archiver | low | confirmed | `src/memory/session-archiver.ts:163` | Fully-deduplicated session gets `stampArchived()`; memories permanently lost if source memories later pruned |
| CFG-003 | Config | low | confirmed | `src/config.ts:609` | `LITELLM_MODEL` code default `'gpt-4o'` vs `.env.example` `'MiniMax-M2.7'` |
| CFG-004..009 | Config | low | confirmed | `src/config.ts:53,129,137,169,189,495` | Six `parseFloat()` calls with no NaN guard; non-numeric env var silently disables feature |
| CFG-015 | Config | low | confirmed | `src/dashboard/routes.ts:1902` | `HEARTBEAT_INTERVAL_SEC`/`DREAM_ENABLED` read via raw `process.env` instead of config getters |
| CFG-016 | Config | low | confirmed | `src/config.ts:383` | `CLAUDE_BACKEND` silently normalises invalid values to `'claude-cli'` |
| SEC-004 | Dashboard API | low | confirmed | `src/dashboard/routes.ts:1132` | Alfred name protection case-sensitive; `name='alfred'` bypasses rename guard |
| SEC-006 | Dashboard API | low | confirmed | `src/dashboard/routes.ts:4340` | Raw `err.message` in SSE error events leaks internal paths, base URLs, model names |
| SEC-007 | Dashboard API | low | confirmed | `src/dashboard/routes.ts:4458` | `/api/chat/resume` SSE leaks `agentBus` listeners on abnormally-closed connections |
| SEC-008 | Dashboard API | low | confirmed | `src/dashboard/routes.ts:4215` | `startRun()` before queue entry; concurrent same-session requests create orphaned `running` runs |
| SEC-011 | Dashboard API | low | confirmed | `src/dashboard/routes.ts:1069` | `GET /api/messages` without `session_id` returns last 100 messages from all sessions |
| SEC-012 | Dashboard API | low | confirmed | `src/dashboard/routes.ts:3447` | `/api/logs/stream` SSE cleanup relies solely on `onAbort`; no `finally` guard |
| EXEC-002..005 | Exec Tools | low | confirmed | various | Four `setInterval`/`setTimeout` handles not stored; timers cannot be stopped for graceful shutdown |
| VIS-001 | Vision | low | confirmed | `src/vision/vision-service.ts:54` | No API key guard before routing to `openrouter` |
| VIS-005 | Vision | low | confirmed | `src/vision/vision-service.ts:106` | `slice(0, NaN)` → `''`; non-numeric `VISION_MAX_DESCRIPTION_CHARS` silently empties all descriptions |
| VIS-006 | Vision/xAI | low | confirmed | `src/image/xai-credentials.ts:25` | `readFileSync` on hot path; blocks event loop under concurrent image generation |
| VIS-008 | Vision/xAI | low | confirmed | `src/image/xai-credentials.ts:29` | Falls back to `pool[0]` regardless of `last_status`; known-bad credential silently used |
| VIS-010 | Vision/Image | low | confirmed | `src/image/image-service.ts:47` | Empty `b64_json` produces corrupt `data:image/png;base64,` URI silently |
| BROKER-005..010 | Broker | low | confirmed | various | Rotation timestamp not verified; N8N key bypasses scope; `scrubOutput()` skips falsy secrets; name conventions not enforced |

**Total: 91 findings — 1 critical, 25 high, 32 medium, 33 low**

---

## DB State

### Live Snapshot (2026-05-31)

| Metric | Value |
|--------|-------|
| Active agents | 44 |
| DB file size | **753 MB** |
| Audio blobs in DB | **424 MB (59% of total, 112 rows, all `hit_count=0`)** |
| memory_index rows | 15,923 |
| Active sessions | 361 |
| Total runs | 4,025 |
| Runs — done | 3,286 |
| Runs — dropped | 511 |
| Runs — error | 222 |
| Runs — stopped | 6 |
| Runs — running | 1 (active) |
| Stuck claimed jobs | **1** (b1f15dac, >1h, `agent_task` for Rossweisse) |
| Zombie pending jobs | **1** (5e559764, `dream_cycle`, attempts=3/3, never failed) |
| DB integrity check | **ok** |

### Job Queue Sub-issues

- **30 failed `tts_synthesize` jobs:** VoidAI HTTP 400 ZodError — agent's `tts_voice` value not in allowed list. Will accumulate until fixed in DB.
- **6 failed `agent_task` jobs:** Agent `a1627754` not found (deactivated). Job worker hits max_attempts with no re-routing.
- **1,441 runs with `delivered=0`, `status=done`:** All have `delivery_target=NULL` — direct chat/dashboard runs. Not a real delivery failure; `delivered=1` is never set for non-Discord runs. Counter is misleading but harmless.

---

## Config Audit

### Key Default Mismatches

| Variable | Code Default | .env.example | Risk |
|----------|-------------|--------------|------|
| `VISION_MODEL` | `'gpt-4o'` | `'gpt-4.1'` | Lower-quality vision when unset |
| `COMPACT_TOKEN_THRESHOLD` | `100000` | `8000` | Compaction almost never fires |
| `LITELLM_MODEL` | `'gpt-4o'` | `'MiniMax-M2.7'` | Wrong provider silently used |
| `CLAUDE_BACKEND` | `'claude-cli'` on invalid input | Explicit, no fallback | Typos silently route to CLI |
| `RUN_DELIVERY_MAX_ATTEMPTS` | module-scope const | — | NaN → infinite retries |

### Undocumented (61 vars in code, not in .env.example)

Key missing entries: `BG_PROVIDER`, `BG_MODEL`, `KIMI_API_KEY`, `KIMI_API_MODEL`, `LITELLM_*`, `OLLAMA_*`, `VENICE_*`, `SKILL_FORGE_*`, `DECOMPOSER_*`, `APPROVAL_*`, `TASK_HEALTH_*`, `ALERT_*`, `SONAR_SMART_*`

### Unused (39 vars in .env.example, no live consumer)

Key ones: `NC_BROKER_*`, `INFISICAL_*` (may be consumed by external sidecar), `SENTINEL_MODEL`, `DISCORD_STREAM_TIMEOUT_MS`, `BROWSER_USE_API_KEY`

---

## Schema Issues

| Severity | Description |
|----------|-------------|
| medium | **`runs` `initSchema` DDL out of sync:** Defines only 3 status values; live DB has 7. Fresh DB without migrations rejects `stopped`/`dropped`/etc. |
| medium | **Zombie pending job `5e559764`:** `attempts=3`, `max_attempts=3`, `status='pending'`. Never re-claimed, never failed. Pollutes pending count. |
| medium | **Stuck claimed job `b1f15dac`:** Claimed >1h ago, `attempts=2/3`. Runtime has no periodic reclaim mechanism. |
| low | Composio tables created lazily in `src/composio/connection-policy.ts`; invisible to schema audit tooling |

---

## Deployment Model — Important Correction

**The systemd service runs `tsx` directly — NOT compiled `dist/`.** The `CLAUDE.md` description of a "compiled systemd deploy" requiring `npm run build` is **incorrect**.

```
ExecStart=/home/neuroclaw-v1/node_modules/.bin/tsx src/dashboard/server.ts
```

Source changes take effect after **service restart only** — no build step required.

---

## Stress Test Results

*Static analysis only — no live stress test performed.*

1. **Job Worker Deadlock (JOB-001 — CRITICAL):** Under any 429, all throttled-path work is silently abandoned until restart. Worker appears healthy but all quota-triggered retries fail.
2. **Context Compactor Storm (MEM-001 — HIGH):** After first context fill, every chat turn triggers a summarizer LLM call. 10 concurrent near-limit sessions = 10× summarizer quota consumption.
3. **Duplicate Discord Posts (DISCORD-002 + DELIVERY-001 — HIGH):** Frequency scales with Discord API latency and number of concurrent active Discord sessions.
4. **Vision API Rate Exhaustion (VIS-003 — MEDIUM):** Unbounded `Promise.all`. 5 users × 5 attachments = 25 simultaneous vision calls, no throttling.
5. **DB Performance Degradation (DB-001 — HIGH):** 753MB SQLite (424MB audio blobs, zero eviction). Every WAL checkpoint processes full 753MB. Grows at ~4MB per TTS call.
6. **Sub-agent Provider Race (RUNNER-006 — MEDIUM):** 25 concurrent sub-agents can exhaust an entire provider rate-limit window in one burst.
7. **DB Hot-Path Prepare() (EXEC-006 — MEDIUM):** `appendPartialOutput()` recompiles SQL on every LLM token. 10 sessions × 50 tokens/sec = 500 synchronous compilations/sec blocking the event loop.

---

## Immediate Fixes (staged — requires approval before applying)

### Fix 1 — JOB-001 (CRITICAL): Remove non-existent `updated_at` column reference

**File:** `src/system/job-worker.ts:18-26`

```diff
- getDb().prepare(
-   `UPDATE job_queue
-    SET claimed_at  = NULL,
-        status      = 'pending',
-        updated_at  = datetime('now')
-    WHERE id = ?`
- ).run(jobId);
+ getDb().prepare(
+   `UPDATE job_queue
+    SET claimed_at = NULL,
+        status     = 'pending'
+    WHERE id = ?`
+ ).run(jobId);
```

**Correctness property:** Every 429-throttled job is re-queued as pending instead of permanently stuck.

---

### Fix 2 — JOB-003 (HIGH): Periodic stale claim recovery in the poll loop

**File:** `src/system/job-worker.ts` — add before `claimNextJob()` call

```diff
+let _staleRecoverTick = 0;
 async function _pollOnce(): Promise<void> {
+  if (++_staleRecoverTick >= 300) {   // every 300 × 200ms = 60 seconds
+    _staleRecoverTick = 0;
+    const recovered = recoverStaleClaims();
+    if (recovered > 0) logger.info(`job-worker: recovered ${recovered} stale claim(s) mid-run`);
+  }
   const job = claimNextJob();
```

**Correctness property:** Jobs stuck longer than 60s are recovered during continuous operation, not only on restart.

---

### Fix 3 — DB-001 (HIGH): Wire `pruneAudioCache()` into maintenance job

**File:** `src/system/job-worker.ts:370-390` — inside `'session_cleanup'` case

```diff
 case 'session_cleanup': {
   const { cleanupStaleSessions } = await import('../system/session-cleanup');
+  const { pruneAudioCache } = await import('../db');
   const result = await cleanupStaleSessions();
+  const pruned = pruneAudioCache(30, 1);
+  if (pruned > 0) logger.info(`job-worker: pruned ${pruned} stale audio cache entries`);
   return JSON.stringify(result);
 }
```

**Correctness property:** Audio blobs older than 30 days with 0 hits are evicted; DB size stays bounded.

---

### Fix 4 — MEM-001 (HIGH): Correct `targetRatio` to be less than `triggerRatio`

**In `.env`:** Set `COMPACT_TARGET_RATIO=0.55` (or change code default in `src/config.ts:191`).

**Correctness property:** Post-compaction token count is below trigger threshold; compaction does not re-fire on next turn.

---

## Restart/Rebuild Checklist

**No build step needed — service uses `tsx` directly.**

### Step 1 — Fix stuck DB jobs (before restart)

```bash
# Fail zombie pending job (attempts exhausted, never failed cleanly)
sqlite3 /home/neuroclaw-v1/neuroclaw.db "
  UPDATE job_queue
  SET status='failed',
      error='Manual fix 2026-05-31: max_attempts exhausted, never failJob-d'
  WHERE status='pending' AND attempts >= max_attempts;
"

# Release stuck claimed job (will retry after restart)
sqlite3 /home/neuroclaw-v1/neuroclaw.db "
  UPDATE job_queue
  SET status='pending', claimed_at=NULL
  WHERE status='claimed' AND claimed_at < datetime('now', '-5 minutes');
"

# Verify
sqlite3 /home/neuroclaw-v1/neuroclaw.db "
  SELECT status, COUNT(*) FROM job_queue WHERE status IN ('claimed','pending') GROUP BY status;
"
```

### Step 2 — Apply code fixes, verify TypeScript

```bash
# Apply fixes (JOB-001, JOB-003, DB-001, MEM-001) then:
npx tsc --noEmit
```

### Step 3 — Restart

```bash
systemctl restart neuroclaw-dashboard.service
journalctl -u neuroclaw-dashboard.service -f -n 80
```

### Step 4 — Verify (post-restart)

```bash
# DB integrity
sqlite3 neuroclaw.db "PRAGMA integrity_check;"

# No stuck claimed jobs
sqlite3 neuroclaw.db "SELECT id, type, attempts, claimed_at FROM job_queue WHERE status='claimed';"

# No zombie pending
sqlite3 neuroclaw.db "SELECT status, COUNT(*) FROM job_queue GROUP BY status;"

# Service health
curl -s "http://localhost:3141/api/status?token=$(grep DASHBOARD_TOKEN .env | cut -d= -f2)" | python3 -m json.tool

# No new run errors in first 5 minutes
sqlite3 neuroclaw.db "SELECT COUNT(*) FROM runs WHERE status='error' AND created_at > datetime('now', '-5 minutes');"
```

---

## Deferred / Needs Decision

| # | Item | Risk | Recommendation |
|---|------|------|----------------|
| D-1 | BROKER-002: `broker.exec()` inherits full `process.env` | HIGH — scrubbing wrong key silently breaks skills | Define explicit env allowlist for child processes; strip everything else |
| D-2 | SEC-005: `GET /api/env/:key` returns raw secrets | HIGH — breaking route breaks dashboard reveal UI | Restrict to hardcoded non-sensitive allowlist; remove API keys from accessible set |
| D-3 | MEM-001: What `targetRatio` to set | HIGH — too low aggressively loses conversation context | Start at 0.55; tune per agent workload profile |
| D-4 | MEM-002: Dream cycle dedup strategy | MEDIUM — wrong watermark skips sessions | Store rolling watermark in `config_items`; simpler than new column migration |
| D-5 | DELIVERY-007: Paused run in stale sweeper | MEDIUM — excluding may leave crashed paused runs permanently | Exclude `paused` from `listStaleRuns`; require manual cleanup for crashed paused runs |
| D-6 | SEC-010: Cookie sync CORS/path sanitization | MEDIUM — fixing CORS may break browser extension | Restrict CORS to dashboard origin; sanitize cookie field names for path traversal |
| D-7 | DB-001 long-term: Move audio blobs to filesystem | MEDIUM — migration effort | Implement filesystem audio cache next sprint; VACUUM DB after pruning (~400MB reclaimed) |

---

*End of report. 91 findings: 1 critical, 25 high, 32 medium, 33 low.*  
*Immediate action required on: JOB-001 (critical), JOB-003, DB-001, MEM-001, BROKER-002, SEC-005, DISCORD-002.*
