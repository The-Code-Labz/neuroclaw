// Background-generation delivery (v3.x).
//
// When a run finishes, its result must reach the surface the request came from.
// Dashboard runs are recovered by the client (session-open polling) — nothing to
// push. Discord runs have no live connection left, so the finished answer is
// posted into the originating channel here.
//
// deliverRun() is idempotent (guarded by runs.delivered) and is the single entry
// point used by both the run:terminal event subscriber and the retry sweeper.

import {
  getRun, markRunDelivered, bumpNotifyAttempts, saveMessage,
} from '../db';
import { runEvents, type RunTerminalEvent } from './event-bus';
import { postToChannel } from '../integrations/discord-bot';
import { logger } from '../utils/logger';

/** Retry cap before a Discord delivery is marked permanently failed. */
export const MAX_NOTIFY_ATTEMPTS = parseInt(process.env.RUN_DELIVERY_MAX_ATTEMPTS ?? '5', 10);

interface DiscordDeliveryTarget {
  botId:     string;
  channelId: string;
  messageId: string;
  userId:    string;
  guildId:   string | null;
}

/**
 * Deliver a terminal run's result to its origin surface. Idempotent: a run with
 * delivered !== 0 is skipped. Never throws.
 */
export async function deliverRun(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  if (run.delivered !== 0) return; // already delivered or permanently failed

  // ── Non-Discord origin (dashboard / CLI) ──────────────────────────────
  // The dashboard recovers via session-open polling. A 'done' run's assistant
  // message is already persisted; an 'error'/'dropped' run has none, so persist
  // an interrupted notice here so the transcript shows the failed turn once.
  if (run.origin !== 'discord') {
    if ((run.status === 'error' || run.status === 'dropped') && run.session_id) {
      const note = run.partial_output && run.partial_output.trim()
        ? `⚠️ This response was interrupted before it finished. Here's what I had so far:\n\n${run.partial_output}`
        : `⚠️ This response was interrupted before it finished${run.error_text ? ` (${run.error_text})` : ''}.`;
      try {
        saveMessage(run.session_id, 'assistant', note, run.initiating_agent_id ?? undefined);
      } catch (err) {
        logger.warn('run-delivery: saveMessage failed', { runId, err: String(err) });
      }
    }
    markRunDelivered(runId, 1);
    return;
  }

  // ── Discord origin ────────────────────────────────────────────────────
  if (run.status === 'stopped') { markRunDelivered(runId, 1); return; } // user stopped it — no post

  let target: DiscordDeliveryTarget | null = null;
  try {
    target = run.delivery_target
      ? JSON.parse(run.delivery_target) as DiscordDeliveryTarget
      : null;
  } catch {
    target = null;
  }
  if (!target || !target.channelId) {
    logger.warn('run-delivery: discord run has no usable delivery_target', { runId });
    markRunDelivered(runId, -1);
    return;
  }

  const text = run.status === 'done'
    ? (run.final_output ?? run.partial_output ?? '(empty response)')
    : (run.partial_output && run.partial_output.trim()
        ? `⚠️ That one got interrupted before it finished — here's what I had so far:\n\n${run.partial_output}`
        : `⚠️ That request got interrupted before it finished${run.error_text ? ` (${run.error_text})` : ''}.`);

  const result = await postToChannel(target.botId, target.channelId, text, {
    replyToMessageId: target.messageId,
    mentionUserId:    target.userId,
  });

  if (result.ok) {
    markRunDelivered(runId, 1);
    logger.info('run-delivery: delivered to discord', { runId, channelId: target.channelId });
  } else {
    const attempts = bumpNotifyAttempts(runId);
    logger.warn('run-delivery: discord post failed', { runId, attempts, err: result.error });
    if (attempts >= MAX_NOTIFY_ATTEMPTS) {
      markRunDelivered(runId, -1);
      logger.warn('run-delivery: giving up after max attempts', { runId });
    }
  }
}

/**
 * Subscribe to run:terminal so finished runs are delivered immediately.
 *
 * endRun can fire run:terminal twice for one run — e.g. chatStream/orchestrate
 * ends it with status='error', then the /api/chat catch-all ends it again. The
 * `delivered` flag alone is not enough to dedupe those: both deliverRun calls
 * pass the `delivered === 0` guard before either commits (the await on
 * postToChannel sits between read and write), which double-posts to Discord.
 * The in-flight set collapses concurrent emits for the same run into a single
 * delivery; the retry sweeper remains the backstop for anything left pending.
 */
export function startRunDelivery(): void {
  const inFlight = new Set<string>();
  runEvents.on('run:terminal', (e: RunTerminalEvent) => {
    if (inFlight.has(e.runId)) return; // duplicate emit for a run already being delivered
    inFlight.add(e.runId);
    deliverRun(e.runId)
      .catch(err => logger.warn('run-delivery: deliverRun threw', { runId: e.runId, err: String(err) }))
      .finally(() => inFlight.delete(e.runId));
  });
  logger.info('run-delivery: subscribed to run:terminal');
}
