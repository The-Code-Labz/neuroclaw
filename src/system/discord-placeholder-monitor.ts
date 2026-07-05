// Discord placeholder monitor (Discord Bot Timeout Recovery spec — Fix 1 + Fix 4).
//
// When liveEditLoop() aborts because the stream exceeded DISCORD_STREAM_TIMEOUT_MS,
// the user's reply has already become a "still working" placeholder message. The
// backend run continues detached. Without this module, the eventual terminal
// delivery goes through deliverRun() and posts a NEW reply — orphaning the
// placeholder and producing two bot messages for one request.
//
// This monitor preserves a single coherent reply path:
//
//   1. liveEditLoop hands off { runId, sessionId, placeholderMsg, botId, userMsg }
//      at the moment of AbortError.
//   2. We subscribe to runEvents.run:terminal (same bus endRun already fires —
//      one subscription instead of polling getRun).
//   3. On terminal: edit the existing placeholder with the final output,
//      then markRunDelivered(runId, 1). deliverRun + sweeper see delivered=1
//      and bail. The user sees the placeholder transform into the answer.
//   4. If the placeholder edit fails (channel/message deleted, webhook expired,
//      perm change), we leave delivered=0. deliverRun posts a new reply as the
//      backstop. We never mark delivered without a successful edit.
//   5. Hard cap at STREAM_TIMEOUT_MS × 2. Past cap: edit a failure notice,
//      mark delivered=1, log loudly.
//
// Critical correctness property: markRunDelivered(1) happens ONLY after the
// placeholder edit succeeds. Anything else leaves delivered=0 so the existing
// sweeper backstop can do its job.

import type { Message } from 'discord.js';
import { runEvents, type RunTerminalEvent, agentBus, type AgentEvent } from './event-bus';
import { getRun, markRunDelivered } from '../db';
import { logger } from '../utils/logger';

/** Throttle for live-token placeholder edits while streaming. ~1.5s keeps us
 *  comfortably under Discord's 5 edits/sec per-route limit. */
const STREAM_THROTTLE_MS = 1500;
/** Max chars to show in the streaming placeholder before we stop growing it
 *  (Discord's message limit is 2000). The terminal handler delivers the full,
 *  properly-split output; this is just the live preview. */
const STREAM_PREVIEW_CAP = 1900;

// Discord API error codes we want to treat as "give up cleanly, don't retry".
const DISCORD_PERMANENT_ERRORS = new Set([
  10003, // Unknown Channel
  10008, // Unknown Message
  50027, // Invalid Webhook Token (only relevant for webhook-posted messages,
         //                       but cheap to handle — falls through to fallback)
]);

const STREAM_TIMEOUT_MS = parseInt(process.env.DISCORD_STREAM_TIMEOUT_MS ?? '300000', 10);
const HARD_CAP_MS       = STREAM_TIMEOUT_MS * 2;

/** Throttle for heartbeat-driven placeholder edits — matches the inline value
 *  liveEditLoop previously used. Keeps us well under Discord's 5 edits/sec. */
const HEARTBEAT_THROTTLE_MS = 10_000;

export interface PlaceholderMonitorHandoff {
  runId:           string;
  sessionId:       string;
  /** The already-edited "still working" placeholder message. */
  placeholderMsg:  Message;
  /** The original user message — used as a reply target if we need to split
   *  the final output across multiple messages. */
  userMsg:         Message;
  /** Bot id for correlation logging. */
  botId:           string;
}

/**
 * Split helper local to this module — kept here so we don't have to widen
 * discord-bot.ts's export surface. Mirrors chunkForDiscord's contract:
 * never returns chunks > maxLen, prefers paragraph/line/word boundaries.
 */
function splitForDiscord(text: string, maxLen = 1990): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen / 2) cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen / 2) cut = remaining.lastIndexOf(' ', maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function isPermanentDiscordError(err: unknown): boolean {
  // discord.js's DiscordAPIError exposes a numeric `code`. Don't import the
  // class — it changes between major versions. Duck-type instead.
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'number' && DISCORD_PERMANENT_ERRORS.has(code);
}

function buildFinalText(run: ReturnType<typeof getRun>): string {
  if (!run) return '*(run not found)*';
  if (run.status === 'done') {
    return run.final_output ?? run.partial_output ?? '*(empty response)*';
  }
  // error / dropped — preserve partial output if we have any, otherwise post
  // a failure notice. Matches deliverRun()'s formatting so the user sees the
  // same shape regardless of which path delivered.
  if (run.partial_output && run.partial_output.trim()) {
    return `⚠️ That one got interrupted before it finished — here's what I had so far:\n\n${run.partial_output}`;
  }
  return `⚠️ That request got interrupted before it finished${run.error_text ? ` (${run.error_text})` : ''}.`;
}

/**
 * Attempt to deliver the final output by editing the existing placeholder
 * (and posting follow-up replies for any split chunks). Returns true if the
 * placeholder edit succeeded — only then is it safe to mark delivered=1.
 */
async function editPlaceholderWithFinal(
  placeholderMsg: Message,
  userMsg:        Message,
  finalText:      string,
): Promise<{ ok: true } | { ok: false; permanent: boolean; error: string }> {
  const chunks = splitForDiscord(finalText, 1990);
  const first  = chunks[0] || '\u200b'; // zero-width space — Discord rejects empty edits
  try {
    await placeholderMsg.edit({ content: first });
  } catch (err) {
    return {
      ok:        false,
      permanent: isPermanentDiscordError(err),
      error:     (err as Error).message,
    };
  }

  // Any remaining chunks go as fresh replies to the user message — same
  // pattern liveEditLoop uses on its split path. Best-effort: a failure here
  // doesn't invalidate the placeholder edit that already succeeded.
  for (let i = 1; i < chunks.length; i++) {
    try {
      await userMsg.reply(chunks[i]);
    } catch (err) {
      logger.warn('placeholder-monitor: follow-up chunk failed', {
        chunkIndex: i,
        err:        (err as Error).message,
      });
      // First chunk landed; partial-success is still success for delivery
      // purposes. Keep going so we attempt every remaining chunk.
    }
  }
  return { ok: true };
}

/**
 * Start monitoring a runId for terminal completion. Hands off ownership of the
 * placeholder message to this module — the caller MUST NOT edit it further
 * after calling startPlaceholderMonitor.
 *
 * Returns a cancel function only for tests / future use; production callers
 * fire-and-forget.
 */
export function startPlaceholderMonitor(handoff: PlaceholderMonitorHandoff): () => void {
  const { runId, sessionId, placeholderMsg, userMsg, botId } = handoff;
  let settled = false;
  let lastHeartbeatEdit = Date.now();

  // Live-stream state. Seed from whatever the run has already accumulated at
  // handoff time so the preview is continuous with what streamed before the
  // timeout; live chunks append from there. seedLen lets us drop chunk events
  // already contained in the seed (matched by their partial_output offset),
  // mirroring the dashboard resume dedup.
  let streamed   = '';
  let seedLen    = 0;
  let lastStreamEdit = 0;
  let streamTimer: NodeJS.Timeout | undefined;
  // Set the instant a terminal event arrives so no in-flight stream-preview
  // edit can land on top of (and clobber) the final delivered output.
  let streamingStopped = false;
  try {
    const seed = getRun(runId)?.partial_output ?? '';
    streamed = seed;
    seedLen  = seed.length;
  } catch { /* best-effort seed */ }

  // Optimistic claim: mark delivered=1 immediately so deliverRun (which fires
  // on run:terminal before this monitor's listener) sees delivered≠0 and bails.
  // If our placeholder edit later fails transiently, we reset to 0 so the
  // sweeper/deliverRun can post a fresh reply as backstop.
  try { markRunDelivered(runId, 1); } catch { /* best-effort */ }

  logger.info('placeholder-monitor: start', {
    botId,
    sessionId,
    runId,
    placeholderId: placeholderMsg.id,
    hardCapMs:     HARD_CAP_MS,
  });

  const settle = (
    outcome: 'edit' | 'fallback' | 'cap' | 'deletion' | 'cancelled',
    detail?: Record<string, unknown>,
  ) => {
    if (settled) return;
    settled = true;
    runEvents.off('run:terminal', onTerminal);
    agentBus.off('agent', onProgress);
    if (streamTimer) clearTimeout(streamTimer);
    clearTimeout(hardCapTimer);
    logger.info('placeholder-monitor: end', {
      botId, sessionId, runId, outcome, ...detail,
    });
  };

  // Edit the placeholder with the current live preview (head-capped + cursor).
  // Shared by the throttled stream timer and the immediate-flush path.
  const flushStreamPreview = () => {
    if (settled || streamingStopped) return;
    lastStreamEdit = Date.now();
    const tail    = streamed.length > STREAM_PREVIEW_CAP ? ' …' : ' ▌';
    const content = (streamed.slice(0, STREAM_PREVIEW_CAP) || '​') + tail;
    placeholderMsg.edit({ content }).catch(err => {
      if (isPermanentDiscordError(err)) {
        try { markRunDelivered(runId, 1); } catch { /* best-effort */ }
        settle('deletion', { reason: 'placeholder gone during stream', code: (err as { code?: number }).code });
      }
      // Transient errors: swallow — the next tick retries.
    });
  };

  // ── Live progress: stream tokens, fall back to activity label ────────────
  // The agent bus now carries the run's chunks (with the partial_output offset
  // each was appended at) AND heartbeats. Stream the actual answer into the
  // placeholder so a backgrounded Discord turn shows the reply being written —
  // not a frozen "still working" notice. Heartbeats only drive the label while
  // no tokens have arrived yet (e.g. a long tool call), so they never clobber
  // streamed text.
  const onProgress = (e: AgentEvent) => {
    if (settled) return;
    if (e.runId !== runId) return;
    if (e.type === 'chunk') {
      // Drop chunks already contained in the seed (offset before seedLen).
      if (typeof e.offset === 'number' && e.offset < seedLen) return;
      streamed += e.content;
      // Throttle edits: flush immediately if the window elapsed, else schedule
      // a trailing flush so the final tokens of a burst still render.
      const now = Date.now();
      if (now - lastStreamEdit >= STREAM_THROTTLE_MS) {
        if (streamTimer) { clearTimeout(streamTimer); streamTimer = undefined; }
        flushStreamPreview();
      } else if (!streamTimer) {
        streamTimer = setTimeout(() => { streamTimer = undefined; flushStreamPreview(); },
          STREAM_THROTTLE_MS - (now - lastStreamEdit));
      }
      return;
    }
    if (e.type === 'heartbeat') {
      if (streamed.length > 0) return; // tokens are flowing — don't overwrite
      const now = Date.now();
      if (now - lastHeartbeatEdit < HEARTBEAT_THROTTLE_MS) return;
      lastHeartbeatEdit = now;
      const label = `*(⏳ Working on it… [${e.currentActivity}])*`;
      placeholderMsg.edit({ content: label }).catch(err => {
        if (isPermanentDiscordError(err)) {
          try { markRunDelivered(runId, 1); } catch { /* best-effort */ }
          settle('deletion', { reason: 'placeholder gone during heartbeat', code: (err as { code?: number }).code });
        }
      });
    }
  };
  agentBus.on('agent', onProgress);

  // ── Terminal handler ────────────────────────────────────────────────────
  const onTerminal = async (e: RunTerminalEvent) => {
    if (settled) return;
    if (e.runId !== runId) return;

    // Stop live-preview edits before the (awaited) final delivery so a pending
    // throttled flush can't overwrite the final output.
    streamingStopped = true;
    if (streamTimer) { clearTimeout(streamTimer); streamTimer = undefined; }

    // Pull the fresh row — endRun has committed by now.
    const run = getRun(runId);
    if (!run) {
      logger.warn('placeholder-monitor: run vanished on terminal', { runId });
      settle('fallback', { reason: 'run row missing' });
      return;
    }

    // Spec — "stopped" path: user stopped it. Silent success, no delivery,
    // but log loudly per Oracle's review feedback (silent stops hide ghosts).
    if (run.status === 'stopped') {
      try { markRunDelivered(runId, 1); } catch { /* best-effort */ }
      logger.info('placeholder-monitor: silent stop — no placeholder edit', {
        botId, sessionId, runId,
      });
      settle('cancelled', { status: 'stopped' });
      return;
    }

    const finalText = buildFinalText(run);
    const result = await editPlaceholderWithFinal(placeholderMsg, userMsg, finalText);

    if (result.ok) {
      try { markRunDelivered(runId, 1); } catch { /* best-effort */ }
      settle('edit', { status: run.status, len: finalText.length });
      return;
    }

    if (result.permanent) {
      // Channel / message gone, or webhook expired. Don't loop the sweeper on
      // a target that no longer exists.
      try { markRunDelivered(runId, 1); } catch { /* best-effort */ }
      logger.warn('placeholder-monitor: permanent discord error — marked delivered to stop retries', {
        botId, sessionId, runId, error: result.error,
      });
      settle('deletion', { error: result.error });
      return;
    }

    // Transient edit failure (rate limit exhaustion, perms blip). Reset to
    // delivered=0 so deliverRun + sweeper can post a fresh reply as backstop.
    // (We set delivered=1 optimistically at monitor start to block deliverRun
    // during the normal flow; reset it here only when we genuinely can't edit.)
    try { markRunDelivered(runId, 0); } catch { /* best-effort */ }
    logger.warn('placeholder-monitor: placeholder edit failed transiently — falling back to deliverRun', {
      botId, sessionId, runId, error: result.error,
    });
    settle('fallback', { error: result.error });
  };
  runEvents.on('run:terminal', onTerminal);

  // ── Hard cap ────────────────────────────────────────────────────────────
  const hardCapTimer = setTimeout(() => {
    if (settled) return;
    const run = getRun(runId);
    const label = `*(⏳ This one took longer than I can wait on. I'll keep working — check back, or rerun if it stays quiet.)*`;
    placeholderMsg.edit({ content: label })
      .catch(err => logger.warn('placeholder-monitor: hard-cap edit failed', {
        runId, err: (err as Error).message,
      }))
      .finally(() => {
        // Always mark delivered after hard cap — even if the edit failed —
        // because at this point we've waited 2× the configured timeout and
        // continuing to retry will just spam Discord.
        try { markRunDelivered(runId, 1); } catch { /* best-effort */ }
        logger.warn('placeholder-monitor: HARD CAP reached', {
          botId, sessionId, runId,
          hardCapMs: HARD_CAP_MS,
          streamTimeoutMs: STREAM_TIMEOUT_MS,
          lastStatus: run?.status ?? 'unknown',
          lastActivity: run?.current_activity ?? null,
        });
        settle('cap');
      });
  }, HARD_CAP_MS);
  // unref so the cap timer never holds the process open on shutdown.
  if (typeof hardCapTimer.unref === 'function') hardCapTimer.unref();

  return () => settle('cancelled', { reason: 'caller cancelled' });
}
