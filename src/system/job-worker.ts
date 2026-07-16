import { createHash } from 'crypto';
import {
  getDb,
  claimNextJob, completeJob, failJob, recoverStaleClaims, touchJobClaim, touchTaskHeartbeat,
  bumpFailureCount, wasTtsDelivered, markTtsDelivered,
  createSession, getAgentById,
  getCachedAudio, saveAudioCache, buildAudioCacheKey,
  type BackgroundAgentPayload, type CronRunPayload, type AgentTaskPayload,
  type TtsPayload, type MemoryExtractPayload, type EmbeddingGeneratePayload,
  type WorkflowRunPayload, type DreamCyclePayload, type MaintenancePayload,
  type JobRow,
} from '../db';
import { completeBackgroundTask, failBackgroundTask, getTask } from './background-tasks';
import { registerRunOwner, clearRunOwner } from './run-ownership';
import { registerStream, clearStream } from './stream-control';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';
import { translateClaudeError, isTimeoutAbort } from '../utils/claudeErrorLabel';
import type { TtsProvider } from '../audio/tts';
import { config } from '../config';

async function requeueJobWithoutAttemptIncrement(jobId: string): Promise<void> {
  const { getDb } = await import('../db');
  getDb().prepare(
    `UPDATE job_queue
     SET claimed_at = NULL,
         status     = 'pending'
     WHERE id = ?`
  ).run(jobId);
  logger.info('job-worker: job requeued for quota fallback (attempts unchanged)', { jobId });
}

function isQuotaError(err: unknown): boolean {
  const msg    = err instanceof Error ? err.message : String(err);
  const status = (err as any)?.httpStatus ?? (err as any)?.status;
  return status === 429 || msg.includes('rate limit') || msg.includes('usage limit') || msg.includes('quota');
}

let workerTimer: NodeJS.Timeout | null = null;
let _staleRecoverTick = 0;

export function startJobWorker(): void {
  const stale = recoverStaleClaims();
  if (stale > 0) logger.info(`job-worker: recovered ${stale} stale claimed job(s)`);
  workerTimer = setInterval(() => {
    _pollOnce().catch((err) => {
      logger.error('job-worker: unexpected poll error', { error: err instanceof Error ? err.message : String(err) });
    });
  }, 200);
  logger.info('job-worker: started');
}

export function stopJobWorker(): void {
  if (workerTimer) { clearInterval(workerTimer); workerTimer = null; }
}

// Immortal-live backstop — the BLUNT last resort. A wedged agent_task/
// background_agent run keeps its claim + task heartbeat fresh forever (the 20s
// timer fires regardless of token progress), so the per-job stale sweep
// (claimed_at, heartbeat-refreshed) never fires. This cap uses the IMMUTABLE
// first_claimed_at (never refreshed): any claimed task-bearing job past it has
// run longer than the backbone's own absolute ceiling AND Sentinel's targeted
// runaway interrupt → both graceful paths failed → force-fail the job + task.
//
// Wave-2 Item C (ASAGI FATAL): must sit ABOVE both graceful ceilings so it is
// genuinely the LAST line, not the first. Ordering (see config.ts absoluteMaxMs):
//   absoluteMaxMs (25m) < RUNAWAY_BUDGET_MS (30m) < WEDGED_JOB_CAP_MS (35m).
// The old 25m value sat BELOW the (old 45m) absoluteMaxMs, making the backbone's
// graceful bail dead code for 25–45m runs — raised to 35m to restore ordering.
const WEDGED_JOB_CAP_MS = 35 * 60 * 1000;

async function _recoverWedgedJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - WEDGED_JOB_CAP_MS).toISOString();
  const wedged = getDb().prepare(`
    SELECT * FROM job_queue
    WHERE status = 'claimed'
      AND type IN ('agent_task','background_agent')
      AND first_claimed_at IS NOT NULL
      AND first_claimed_at < ?
  `).all(cutoff) as JobRow[];
  if (wedged.length === 0) return;

  const { updateTask } = await import('../system/task-manager');
  const { deactivateAgent } = await import('../db');
  for (const job of wedged) {
    try {
      getDb().prepare(`UPDATE job_queue SET status='failed', error=?, completed_at=? WHERE id=?`)
        .run('wedged: exceeded absolute run cap (plane timeout failed to fire)', new Date().toISOString(), job.id);
      const p = JSON.parse(job.payload) as { taskId?: string; agentId?: string };
      if (p.taskId) {
        const t = getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(p.taskId) as { status: string } | undefined;
        if (t && t.status === 'doing') {
          bumpFailureCount(p.taskId);
          updateTask(p.taskId, { status: 'failed', last_error: 'Run wedged past absolute cap — aborted by watchdog.' });
          if (p.agentId && getAgentById(p.agentId)?.temporary === 1) {
            const open = (getDb().prepare(
              `SELECT COUNT(*) n FROM tasks WHERE agent_id = ? AND status IN ('todo','doing','review') AND id != ?`,
            ).get(p.agentId, p.taskId) as { n: number }).n;
            if (open === 0) { deactivateAgent(p.agentId); }
          }
        }
      }
      logHive('task_recovered', `job-worker: force-failed wedged ${job.type} job past ${WEDGED_JOB_CAP_MS / 60000}min cap`, undefined, { jobId: job.id });
      logger.warn('job-worker: force-failed wedged job', { jobId: job.id, type: job.type, firstClaimedAt: job.first_claimed_at });
    } catch (err) {
      logger.warn('job-worker: wedged-job recovery error', { jobId: job.id, error: (err as Error).message });
    }
  }
}

// Each 200ms tick claims and dispatches one job. Since claimNextJob uses an
// IMMEDIATE transaction, concurrent ticks cannot double-claim. Multiple LLM
// jobs run concurrently (intentional — one worker, many in-flight promises).
async function _pollOnce(): Promise<void> {
  if (++_staleRecoverTick >= 300) {   // every 300 × 200ms = 60 seconds
    _staleRecoverTick = 0;
    const recovered = recoverStaleClaims();
    if (recovered > 0) logger.info(`job-worker: recovered ${recovered} stale claim(s) mid-run`);
    await _recoverWedgedJobs().catch(err => logger.warn('job-worker: wedged-job sweep error', { error: (err as Error).message }));
  }
  const job = claimNextJob();
  if (!job) return;

  logHive('job_claimed', `job-worker: claimed ${job.type} job (attempt ${job.attempts})`, undefined, { jobId: job.id });

  // Heartbeat the claim so recoverStaleClaims (60s) never re-claims this job
  // while it is still running — re-running re-executes side effects (the cause
  // of duplicate TTS voice notes). Cleared in finally.
  // Also stamp the task's liveness heartbeat (if this job runs a task) so
  // Sentinel/watchdog can tell a busy task from a dead one — fixes the
  // false-stale reassignment loop. Pure timer: fires through long tool calls.
  let heartbeatTaskId: string | null = null;
  try {
    const p = JSON.parse(job.payload) as { taskId?: string };
    if (typeof p.taskId === 'string') heartbeatTaskId = p.taskId;
  } catch { /* non-task payloads have no taskId */ }

  const heartbeat = setInterval(() => {
    try { touchJobClaim(job.id); } catch { /* best-effort */ }
    if (heartbeatTaskId) {
      try { touchTaskHeartbeat(heartbeatTaskId); } catch { /* best-effort */ }
    }
  }, 20_000);
  if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
    (heartbeat as unknown as { unref: () => void }).unref();
  }

  try {
    let result: string;
    switch (job.type) {
      case 'background_agent':
        result = await _runBackgroundAgent(JSON.parse(job.payload) as BackgroundAgentPayload);
        break;
      case 'agent_task':
        result = await _runAgentTask(JSON.parse(job.payload) as AgentTaskPayload, job.attempts, job.max_attempts);
        break;
      case 'cron_run':
        result = await _runCronJob(JSON.parse(job.payload) as CronRunPayload);
        break;
      case 'tts_synthesize':
        result = await _runTtsJob(JSON.parse(job.payload) as TtsPayload);
        break;
      case 'memory_extract':
        result = await _runMemoryExtractJob(JSON.parse(job.payload) as MemoryExtractPayload);
        break;
      case 'embedding_generate':
        result = await _runEmbeddingJob(JSON.parse(job.payload) as EmbeddingGeneratePayload);
        break;
      case 'workflow_run':
        result = await _runWorkflowJob(JSON.parse(job.payload) as WorkflowRunPayload);
        break;
      case 'dream_cycle':
        result = await _runDreamCycleJob(JSON.parse(job.payload) as DreamCyclePayload);
        break;
      case 'maintenance':
        result = await _runMaintenanceJob(JSON.parse(job.payload) as MaintenancePayload);
        break;
      default:
        throw new Error(`Unknown job type: ${(job as JobRow).type}`);
    }
    completeJob(job.id, result);
    logHive('job_done', `job-worker: ${job.type} completed`, undefined, { jobId: job.id });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const displayError = translateClaudeError(err);
    // 429 quota errors: requeue without burning retry budget.
    if (isQuotaError(err)) {
      await requeueJobWithoutAttemptIncrement(job.id);
      logger.warn('job-worker: quota 429 — requeued without burning retry', { jobId: job.id, type: job.type });
      logHive('job_quota_requeued', `job-worker: ${job.type} requeued (quota 429)`, undefined, { jobId: job.id });
      return;
    }
    failJob(job.id, error);
    logHive('job_failed', `job-worker: ${job.type} failed: ${displayError.slice(0, 120)}`, undefined, {
      jobId: job.id, attempt: job.attempts,
    });
    logger.error('job-worker: job failed', { jobId: job.id, type: job.type, error: displayError });
  } finally {
    clearInterval(heartbeat);
  }
}

// ── Legacy runners ─────────────────────────────────────────────────────────

async function _runBackgroundAgent(payload: BackgroundAgentPayload): Promise<string> {
  // Dynamic import avoids the registry → alfred → registry circular dep.
  const { chatStream } = await import('../agent/alfred');
  let response = '';
  try {
    await chatStream(
      payload.taskDescription,
      payload.sessionId,
      (chunk) => { response += chunk; },
      payload.systemPrompt,
      payload.agentId,
      undefined,
      undefined,
      undefined,
      payload.runId,
    );
    const task = getTask(payload.taskId);
    if (!task) {
      logger.warn('job-worker: background task not in memory (post-restart run), skipping SSE emit', {
        taskId: payload.taskId, agentName: payload.agentName,
      });
      // Still update SQLite so the task does not stay stuck at 'doing' forever.
      try {
        const { updateTask: dbUpdateTask, getTaskById } = await import('../system/task-manager');
        const sqliteTask = getTaskById(payload.taskId);
        if (sqliteTask) {
          dbUpdateTask(payload.taskId, { status: 'done', output: response.slice(0, 10_000) });
          logger.info('job-worker: updated SQLite task status to done (post-restart)', { taskId: payload.taskId });
        }
        // Mirror completeBackgroundTask: an ephemeral spawned agent must not
        // stay active until TTL reap just because the in-memory map was lost
        // across a restart. (matches the post-restart failure path below)
        const { deactivateAgent, getAgentById: getAgent } = await import('../db');
        if (getAgent(payload.agentId)?.temporary === 1) {
          deactivateAgent(payload.agentId);
          logHive('agent_deactivated', 'temp agent deactivated after post-restart background task completion', payload.agentId);
        }
      } catch (err) {
        logger.warn('job-worker: failed to update SQLite task on post-restart completion', {
          taskId: payload.taskId, error: (err as Error).message,
        });
      }
    } else {
      completeBackgroundTask(payload.taskId, response, true);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const task = getTask(payload.taskId);
    if (task) {
      failBackgroundTask(payload.taskId, error);
    } else {
      // Post-restart: in-memory map is gone; update SQLite and deactivate agent directly.
      try {
        const { updateTask: dbUpdateTask } = await import('../system/task-manager');
        const { deactivateAgent, getAgentById: getAgent } = await import('../db');
        dbUpdateTask(payload.taskId, { status: 'failed', last_error: error.slice(0, 2000) });
        // Only deactivate ephemeral spawned agents — persistent agents run
        // background work too and must stay active. (matches background-tasks.ts)
        if (getAgent(payload.agentId)?.temporary === 1) {
          deactivateAgent(payload.agentId);
        }
      } catch (innerErr) {
        logger.warn('job-worker: failed to update SQLite task on post-restart failure', {
          taskId: payload.taskId, error: (innerErr as Error).message,
        });
      }
    }
    throw err;
  }
  return response;
}

async function _runAgentTask(payload: AgentTaskPayload, attempts: number, maxAttempts: number): Promise<string> {
  const { chatStream } = await import('../agent/alfred');
  const { updateTask, buildTaskAncestry } = await import('../system/task-manager');

  const agent = getAgentById(payload.agentId);
  if (!agent) throw new Error(`agent_task: agent ${payload.agentId} not found`);

  // Resume an existing DEDICATED work session if this task already has one (a
  // retried/recovered agent_task), so the re-run sees prior context instead of
  // starting blank. Only reuse 'agent_task'-source sessions — never the creator's
  // chat session (assign_task_to_agent binds the orchestrator's session_id, and
  // running task work there would pollute the user's conversation).
  const existing = getDb().prepare(
    `SELECT t.session_id AS session_id, s.source AS source
     FROM tasks t LEFT JOIN sessions s ON s.id = t.session_id WHERE t.id = ?`,
  ).get(payload.taskId) as { session_id: string | null; source: string | null } | undefined;
  // freshSession (L3 same-agent retry) forces a new session so a zombie run of the
  // same agent can't interleave into the resumed conversation (stillOwner() can't
  // distinguish them — same agent_id). Otherwise resume the dedicated work session.
  const sessionId = (!payload.freshSession && existing?.session_id && existing.source === 'agent_task')
    ? existing.session_id
    : createSession(payload.agentId, `Task: ${payload.taskTitle.slice(0, 60)}`, 'agent_task');
  // Link the work session to the task so the holdout reviewer (buildArtifact in
  // holdout-reviewer.ts reads task.session_id) grades THIS run's actual output.
  // Without this link, task.session_id stayed empty → the reviewer saw "(no
  // session output)" and bounced real, completed work back to 'todo'.
  updateTask(payload.taskId, { status: 'doing', session_id: sessionId });
  // Track this run so a tool-dispatch ownership check can stop it executing tools
  // if it gets reassigned or force-failed mid-run. Cleared in finally.
  registerRunOwner(sessionId, payload.taskId, payload.agentId);
  // Register an abort handle for THIS run so Sentinel's runaway pass (Wave-2
  // Item C) can call stopStream(sessionId) to interrupt a live-but-runaway turn.
  // Threaded into chatStream below; cleared in the finally to avoid leaks across
  // retries. No-op behaviorally until something actually aborts it.
  const runawaySignal = registerStream(sessionId);

  const stillOwner = (): boolean => {
    const row = getDb().prepare('SELECT agent_id FROM tasks WHERE id = ?').get(payload.taskId) as { agent_id: string | null } | undefined;
    return !!row && row.agent_id === payload.agentId;
  };

  const base = payload.taskDescription
    ? `${payload.taskTitle}\n\n${payload.taskDescription}`
    : payload.taskTitle;
  // Prepend goal ancestry (owning project + parent chain) so the agent works the
  // INTENT, not just the literal title. Rides the volatile user message — never
  // the stable system prefix — so the prompt-cache stable-prefix split (WS1) is
  // untouched. Empty for flat tasks → byte-identical to before.
  const ancestry = buildTaskAncestry(payload.taskId);
  const userMessage = ancestry ? `${ancestry}\n\n${base}` : base;

  let response = '';
  try {
    await chatStream(
      userMessage,
      sessionId,
      (chunk) => { response += chunk; },
      agent.system_prompt ?? '',
      payload.agentId,
      undefined,      // onMeta
      undefined,      // attachments
      undefined,      // extraSystemContext
      undefined,      // runId
      runawaySignal,  // Wave-2 Item C: external abort handle
    );
    // Some provider planes (e.g. codex, kimi) persist the assistant turn to the
    // session but don't feed this streamed accumulator, leaving `response` empty.
    // That made the holdout reviewer grade an empty string and bounce real work
    // back to 'todo'. Recover the actual output from the session before review.
    if (!response.trim()) {
      const { getSessionMessages } = await import('../db');
      const lastAssistant = getSessionMessages(sessionId).reverse().find(m => m.role === 'assistant');
      if (lastAssistant?.content?.trim()) {
        response = lastAssistant.content;
        logger.info('job-worker: recovered empty agent_task output from session', { taskId: payload.taskId, agentId: payload.agentId, len: response.length });
      }
    }
    // Route through 'review' — applyHoldoutVerdict() fires automatically via
    // setImmediate in task-manager.ts and will advance to done/todo/failed.
    if (stillOwner()) {
      updateTask(payload.taskId, { status: 'review', output: response });
    } else {
      logger.warn('job-worker: task reassigned mid-run — skipping stale success write', { taskId: payload.taskId, agentId: payload.agentId });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const displayError = translateClaudeError(err);
    const isAbort = isTimeoutAbort(err);

    // Quota 429: don't burn the retry budget — _pollOnce requeues this job
    // without incrementing attempts. Just surface the error.
    if (isQuotaError(err)) { void error; throw err; }

    // Reassigned away mid-run (Sentinel): the NEW agent's job owns the task now.
    // Finalize THIS job without retrying — return (don't throw) so failJob does
    // not re-pend it, and don't touch the budget/status (stale write).
    if (!stillOwner()) {
      logger.warn('job-worker: task reassigned mid-run — finalizing old job without retry', { taskId: payload.taskId, agentId: payload.agentId });
      return displayError;
    }

    // failure_count/max_retries is the SINGLE retry budget (job max_attempts is
    // headroom). Bump atomically; abort/timeout is non-retriable; otherwise retry
    // while within budget. Same comparison the holdout-reviewer uses.
    const newCount = bumpFailureCount(payload.taskId);
    const maxRetries = (getDb().prepare('SELECT max_retries FROM tasks WHERE id = ?')
      .get(payload.taskId) as { max_retries: number } | undefined)?.max_retries ?? 3;
    const terminal = isAbort || newCount >= maxRetries;

    if (terminal) {
      updateTask(payload.taskId, { status: 'failed', last_error: displayError });
      // Temp-agent leak fix: deactivate the ephemeral agent if it has no other
      // open work, instead of waiting for the TTL reap.
      try {
        if (agent.temporary === 1) {
          const open = getDb().prepare(
            `SELECT COUNT(*) AS n FROM tasks
             WHERE agent_id = ? AND status IN ('todo', 'doing', 'review') AND id != ?`,
          ).get(payload.agentId, payload.taskId) as { n: number };
          if (open.n === 0) {
            const { deactivateAgent } = await import('../db');
            deactivateAgent(payload.agentId);
            logHive('agent_deactivated', 'temp agent deactivated after permanent agent_task failure', payload.agentId);
          }
        }
      } catch (deactErr) {
        logger.warn('job-worker: temp agent deactivation after failed agent_task threw', {
          agentId: payload.agentId, error: (deactErr as Error).message,
        });
      }
      if (isAbort) logger.warn('job-worker: agent_task failed (abort, non-retriable)', { taskId: payload.taskId, attempts, maxAttempts });
      // Return (NOT throw): the job completes and the task is terminally failed.
      // failure_count decided this, so we must not let failJob re-pend the job.
      void error;
      return displayError;
    }

    // Retriable within budget: return to 'todo' and throw so the job re-pends
    // (re-executes). job max_attempts is set high for agent_task so the job layer
    // never caps before failure_count does.
    updateTask(payload.taskId, { status: 'todo' });
    void error;
    throw err;
  } finally {
    clearRunOwner(sessionId);
    clearStream(sessionId);   // Wave-2 Item C: release the abort handle
  }
  return response;
}

async function _runCronJob(payload: CronRunPayload): Promise<string> {
  const { executeJobNow } = await import('./cron-scheduler');
  const runId = await executeJobNow(payload.jobId, payload.triggeredBy);
  return runId;
}

// ── New job runners ────────────────────────────────────────────────────────

// Idempotency key for one Discord voice-note chunk delivery: same channel +
// source message + chunk index + spoken text ⇒ same key, so a re-run never
// posts the same audio twice. The chunk index is part of the key so two chunks
// with identical text in one reply don't collide (which would silently drop the
// second).
function ttsDeliveryKey(channelId: string, messageId: string | undefined, chunkIndex: number, text: string): string {
  return `${channelId}:${messageId ?? 'none'}:${chunkIndex}:${createHash('md5').update(text).digest('hex')}`;
}

async function _runTtsJob(payload: TtsPayload): Promise<string> {
  const { synthesize, resolveAgentVoice, chunkTextForTts } = await import('../audio/tts');

  // Resolve voice config from agent if present.
  let provider = payload.provider;
  let voiceId  = payload.voiceId ?? '';
  let agentName: string | undefined;
  if (payload.agentId) {
    const agent = getAgentById(payload.agentId);
    if (agent) {
      const resolved = resolveAgentVoice(agent);
      if (!payload.provider) provider = resolved.provider;
      if (!voiceId) voiceId = resolved.voiceId;
      agentName = agent.name;
    }
  }

  const ctx = payload.discordContext;

  // Split inside the job so the chunks of one reply synthesize+deliver
  // sequentially, in order. (Enqueuing one job per chunk let concurrent worker
  // ticks deliver them out of order.) Each chunk is cached and delivered
  // independently and idempotently, so a retry replays only what didn't land.
  const chunks = chunkTextForTts(payload.text, config.audio.ttsChunkChars);

  let delivered = 0;
  let skipped   = 0;
  let totalBytes = 0;
  let anyCached  = false;
  let lastMime   = 'audio/mpeg';
  const undelivered: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    // 1. Resolve audio (cache hit or fresh synthesis). Synthesis errors throw
    //    and fail the whole job — retryable, as before.
    const cacheKey = buildAudioCacheKey(provider, voiceId || 'default', 'default', chunk);
    const cached = getCachedAudio(cacheKey);
    let audioBuf: Buffer;
    let mimeType: string;
    if (cached) {
      anyCached = true;
      audioBuf  = Buffer.from(cached.audio_blob);
      mimeType  = cached.mime_type;
      logger.info('job-worker: tts cache hit', { cacheKey, chunk: i, hits: cached.hit_count + 1 });
    } else {
      const out = await synthesize({
        text: chunk,
        provider: provider as TtsProvider,
        voiceId: voiceId || undefined,
        format: payload.format ?? 'mp3',
        agentName,
      });
      // Store using the resolved model so different-quality voices don't cross-contaminate.
      saveAudioCache(out.provider, out.voiceId || voiceId || 'default', out.model || 'default', chunk, out.mimeType, out.buffer);
      audioBuf = out.buffer;
      mimeType = out.mimeType;
    }
    lastMime    = mimeType;
    totalBytes += audioBuf.length;

    // 2. Deliver to Discord — the only step with an external side effect. Skip
    //    chunks already delivered (idempotent across retries). On success, mark
    //    the ledger immediately after the post resolves (no awaitable gap) so the
    //    duplicate-on-rerun window is as tight as an external post allows.
    if (ctx?.channelId) {
      const dkey = ttsDeliveryKey(ctx.channelId, ctx.messageId, i, chunk);
      if (wasTtsDelivered(dkey)) {
        skipped++;
        continue;
      }
      const { postAudioToChannel } = await import('../integrations/discord-bot');
      let result: { ok: boolean; error?: string };
      try {
        result = await postAudioToChannel(ctx.botId, ctx.channelId, audioBuf, {
          replyToMessageId: ctx.messageId,
          mimeType,
        });
      } catch (err) {
        result = { ok: false, error: (err as Error).message };
      }
      if (result.ok) {
        markTtsDelivered(dkey);
        delivered++;
        logger.info('job-worker: tts audio delivered to discord', { channelId: ctx.channelId, chunk: i });
      } else {
        logger.warn('job-worker: tts discord delivery failed', { channelId: ctx.channelId, chunk: i, err: result.error });
        undelivered.push(`chunk ${i}: ${result.error ?? 'unknown'}`);
      }
    }
  }

  // If a chunk was meant for Discord but didn't land, throw so the job re-pends
  // and retries (delivered chunks are skipped on the retry via the ledger).
  // Previously delivery failures were swallowed and the job marked done, so a
  // transient Discord error silently lost the voice note for good.
  if (ctx?.channelId && undelivered.length > 0) {
    throw new Error(`tts: ${undelivered.length}/${chunks.length} chunk(s) failed to deliver — ${undelivered.join('; ')}`);
  }

  return JSON.stringify({
    cached:   anyCached,
    mimeType: lastMime,
    size:     totalBytes,
    chunks:   chunks.length,
    delivered,
    skipped,
  });
}

async function _runMemoryExtractJob(payload: MemoryExtractPayload): Promise<string> {
  const { ingestExchange } = await import('../memory/memory-pipeline');
  const result = await ingestExchange({
    source: payload.source,
    agent_id: payload.agent_id,
    agent_name: payload.agent_name,
    session_id: payload.session_id,
    user_text: payload.user_text,
    assistant_text: payload.assistant_text,
    context_hint: payload.context_hint,
  });
  return JSON.stringify(result);
}

async function _runEmbeddingJob(payload: EmbeddingGeneratePayload): Promise<string> {
  // KB targets write to Supabase. Use the pinned embedder (1536 + model guard).
  if (payload.target === 'kb_pages' || payload.target === 'kb_code_examples') {
    const { embedKbText } = await import('../kb/kb-embeddings');
    const vector = await embedKbText(payload.text);
    if (!vector) return JSON.stringify({ ok: false, reason: 'embedder_disabled' });
    const { getSupabase } = await import('../db/supabase');
    const { error } = await getSupabase()
      .from(payload.target)
      .update({ embedding: vector })
      .eq('id', payload.rowId!);
    if (error) throw new Error(`kb embed: ${error.message}`);
    return JSON.stringify({ ok: true, target: payload.target, rowId: payload.rowId });
  }

  // Memory on Supabase (MEMORY_BACKEND=supabase): same pinned embedder so new
  // vectors stay comparable to the imported BLOBs (1536 / text-embedding-3-small).
  if (payload.target === 'memory') {
    const { embedKbText } = await import('../kb/kb-embeddings');
    const vector = await embedKbText(payload.text);
    if (!vector) return JSON.stringify({ ok: false, reason: 'embedder_unavailable_or_model_mismatch' });
    const { getSupabase } = await import('../db/supabase');
    const { error } = await getSupabase()
      .from('memory_index')
      .update({ embedding: vector, embedding_model: 'text-embedding-3-small' })
      .eq('id', payload.rowId!);
    if (error) throw new Error(`mem embed: ${error.message}`);
    return JSON.stringify({ ok: true, target: 'memory', rowId: payload.rowId });
  }

  // Legacy SQLite memory path (no target, uses memoryIndexId).
  const { embedText, packVector } = await import('../memory/embeddings');
  const result = await embedText(payload.text);
  if (!result) return JSON.stringify({ ok: false, reason: 'embedder_disabled' });

  const { getDb } = await import('../db');
  getDb().prepare('UPDATE memory_index SET embedding = ?, embedding_model = ? WHERE id = ?')
    .run(packVector(result.vector), result.model, payload.memoryIndexId);
  return JSON.stringify({ ok: true, model: result.model });
}

async function _runWorkflowJob(payload: WorkflowRunPayload): Promise<string> {
  const { executeWorkflow } = await import('../workflows/executor');
  const { findWorkflow } = await import('../workflows/discovery');

  const loaded = findWorkflow(payload.workflowName);
  if (!loaded) throw new Error(`workflow_run: workflow "${payload.workflowName}" not found`);
  if ('error' in loaded) throw new Error(`workflow_run: workflow "${payload.workflowName}" load error: ${loaded.error}`);

  const run = await executeWorkflow(loaded.workflow, payload.input, payload.runId ? { resumeRunId: payload.runId } : {});
  return JSON.stringify({ ok: true, runId: run.id, status: run.status });
}

async function _runDreamCycleJob(_payload: DreamCyclePayload): Promise<string> {
  const { runDreamCycle } = await import('../memory/dream-cycle');
  const result = await runDreamCycle();
  return JSON.stringify(result);
}

async function _runMaintenanceJob(payload: MaintenancePayload): Promise<string> {
  switch (payload.task) {
    case 'curator_sweep': {
      const { runMemorySweep } = await import('../system/curator');
      const result = await runMemorySweep();
      return JSON.stringify(result);
    }
    case 'heartbeat_batch': {
      const { runHeartbeats } = await import('../system/heartbeat');
      const result = await runHeartbeats();
      return JSON.stringify(result);
    }
    case 'session_cleanup': {
      const { cleanupStaleSessions } = await import('../system/session-cleanup');
      const { pruneAudioCache } = await import('../db');
      const result = await cleanupStaleSessions();
      // Pure age-based sweep (minHits=0): audio_cache holds multi-MB TTS blobs and
      // is by far the largest table; keeping frequently-hit-but-old entries let it
      // grow to >half the DB. Blobs regenerate on demand, so age alone governs.
      const ttlDays = parseInt(process.env.AUDIO_CACHE_TTL_DAYS ?? '7', 10);
      const pruned = pruneAudioCache(ttlDays, 0);
      if (pruned > 0) logger.info(`job-worker: pruned ${pruned} audio cache entries older than ${ttlDays}d`);
      return JSON.stringify(result);
    }
    default:
      throw new Error(`maintenance: unknown task "${payload.task}"`);
  }
}
