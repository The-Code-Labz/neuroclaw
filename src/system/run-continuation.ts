// Auto-continuation for completed background runs.
//
// When a run finishes with status=done, the initiating agent fires a brief
// follow-up turn that bridges the completed work back into the conversation.
// Dashboard: chatStream saves the response to the session; the existing
//   page-chat.jsx poll detects the continuation run's terminal status and
//   reloads messages, picking up the new assistant message.
// Discord: run-delivery.ts already posted the raw answer; this posts a
//   concise follow-up message to the same channel.
//
// Loop guard: continuation runs have origin='continuation' and are skipped
// by this listener, so no infinite chain is possible.

import {
  getRun, startRun, endRun, getAgentById, type RunRecord,
} from '../db';
import { runEvents, type RunTerminalEvent } from './event-bus';
import { chatStream } from '../agent/alfred';
import { postToChannel } from '../integrations/discord-bot';
import { logger } from '../utils/logger';

const CONTINUATION_PROMPT =
  '[BACKGROUND TASK COMPLETE] You just finished a background task in this session. ' +
  'Your completed output is already saved as your most recent message in the conversation history. ' +
  'In 1–3 sentences: summarize the key outcome, then either ask if the user has questions or ' +
  'suggest a clear next step. Do not repeat the full output verbatim.';

async function continuationTurn(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  if (run.origin === 'continuation') return;           // loop guard
  if (run.origin === 'subtask-continuation') return;   // owned by subtask-continuation.ts
  if (run.delivered !== 0) return;                    // already delivered live — skip follow-up
  if (!run.session_id || !run.initiating_agent_id) return;

  const agentRecord = getAgentById(run.initiating_agent_id);
  if (!agentRecord) return;
  if (agentRecord.provider === 'mcp') return;          // MCP agents proxy to external tools; skip

  const continuationRunId = startRun({
    origin:             'continuation',
    sessionId:          run.session_id,
    initiatingAgentId:  run.initiating_agent_id,
    parentRunId:        runId,
    userMessage:        '[bg-continuation]',
  });

  let output = '';
  try {
    await chatStream(
      '[bg-continuation]',
      run.session_id,
      (chunk) => { output += chunk; },
      agentRecord.system_prompt ?? '',
      run.initiating_agent_id,
      undefined,              // onMeta — not needed for continuation
      undefined,              // attachments
      CONTINUATION_PROMPT,    // extraSystemContext
      continuationRunId,
      undefined,              // signal
      true,                   // suppressUserMessage — do not persist '[bg-continuation]' to DB
    );
  } catch (err) {
    endRun(continuationRunId, { status: 'error', error_text: String(err) });
    logger.warn('run-continuation: chatStream failed', {
      runId, continuationRunId, err: String(err),
    });
    return;
  }

  // Discord: post follow-up to same channel (run-delivery already posted the raw answer).
  if (run.origin === 'discord' && output.trim()) {
    const target = parseDeliveryTarget(run);
    if (target) {
      const result = await postToChannel(target.botId, target.channelId, output, {
        mentionUserId: target.userId,
        // No replyToMessageId — avoids 404 if the original message was deleted.
      });
      if (!result.ok) {
        logger.warn('run-continuation: discord follow-up failed', {
          runId, err: result.error,
        });
      }
    }
  }
}

interface DeliveryTarget {
  botId:     string | undefined;
  channelId: string;
  userId:    string | undefined;
}

function parseDeliveryTarget(run: RunRecord): DeliveryTarget | null {
  if (!run.delivery_target) return null;
  try {
    const t = JSON.parse(run.delivery_target) as Record<string, unknown>;
    if (typeof t.channelId !== 'string') return null;
    return {
      botId:     typeof t.botId === 'string'  ? t.botId     : undefined,
      channelId: t.channelId,
      userId:    typeof t.userId === 'string'  ? t.userId    : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Subscribe to run:terminal so completed runs fire a follow-up agent turn.
 * Call once from server startup alongside startRunDelivery().
 */
export function startRunContinuation(): void {
  const inFlight = new Set<string>();
  runEvents.on('run:terminal', (e: RunTerminalEvent) => {
    if (e.status !== 'done') return;             // only continue on success
    if (inFlight.has(e.runId)) return;
    inFlight.add(e.runId);
    continuationTurn(e.runId)
      .catch(err =>
        logger.warn('run-continuation: continuationTurn threw', {
          runId: e.runId, err: String(err),
        }),
      )
      .finally(() => inFlight.delete(e.runId));
  });
  logger.info('run-continuation: subscribed to run:terminal');
}
