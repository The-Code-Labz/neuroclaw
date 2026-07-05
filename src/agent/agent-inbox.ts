/**
 * Agent Inbox — surfaces async agent-to-agent messages into an agent's next turn.
 *
 * Turn-based agents have no way to receive a message that arrives with no
 * accompanying turn (e.g. Herald's new-teammate broadcasts). This module drains
 * an agent's pending `agent_messages` into a text block that chatStream()
 * appends to the agent's system prompt, and marks that batch `delivered`.
 *
 * FIFO: at most INBOX_DRAIN_MAX messages are surfaced + drained per turn; any
 * surplus stays `pending` and is surfaced on the next turn — nothing is ever
 * silently dropped, and no message is starved by newer arrivals.
 */

import { getPendingAgentMessages, markAgentMessagesDelivered } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';

/** Max messages surfaced + drained per turn. Surplus waits for the next turn. */
const INBOX_DRAIN_MAX = 25;
/** Per-message content truncation in the inbox block. */
const CONTENT_MAX = 240;

/** "2h ago" / "3d ago" — plain epoch delta, so timezone is irrelevant. */
function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Fetch the oldest pending agent_messages for `agentId`, format them into an
 * inbox block, mark that batch `delivered`, and return the block. Returns `''`
 * when the inbox is disabled, when there is nothing pending, or on any error —
 * it never throws, so an agent turn is never broken by inbox logic.
 */
export function formatAndDrainInbox(agentId: string): string {
  if (!config.agentInbox.enabled) return '';
  try {
    const pending = getPendingAgentMessages(agentId, INBOX_DRAIN_MAX);
    if (pending.length === 0) return '';

    markAgentMessagesDelivered(pending.map(m => m.id));

    const lines = pending.map(m => {
      const body = m.content.length > CONTENT_MAX
        ? m.content.slice(0, CONTENT_MAX) + '…'
        : m.content;
      return `- From ${m.from_name} (${relativeTime(m.created_at)}): ${body.replace(/\s*\n+\s*/g, ' ')}`;
    });

    return '\n\n---\n' +
      '📬 Messages received while you were away (informational — no reply required):\n' +
      lines.join('\n');
  } catch (err) {
    logger.warn('agent-inbox: drain failed', { agentId, error: (err as Error).message });
    return '';
  }
}
