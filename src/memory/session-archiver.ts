/**
 * Session Archiver — shared memory-extraction engine.
 *
 * Pulls a session's complete message history, replays every exchange through
 * the memory extractor, and indexes + vault-mirrors every resulting memory.
 * Used by:
 *   - the Curator (nightly sweep across all sessions)
 *   - session-cleanup (inline, immediately before deleting a bloat session)
 *
 * No transcript truncation and no vault caps — this is the fix for the Dream
 * Cycle's 64k cutoff and the during-chat per-session mirror cap.
 */

import { getDb } from '../db';
import { logHive } from '../system/hive-mind';
import { logger } from '../utils/logger';
import { config } from '../config';
import { extract, type ExtractInput } from './memory-extractor';
import { indexMemory, attachMemoryGraph } from './memory-service';
import { initialSalience } from './memory-scorer';
import { isDuplicateMemory } from './memory-pipeline';

/** Matches extract()'s internal assistant_text slice — windowing wider loses content. */
const ASSISTANT_WINDOW = 6000;

interface SessionRow {
  id:                     string;
  title:                  string | null;
  agent_id:               string | null;
  source:                 string | null;
  message_count:          number;
  archived_at:            string | null;
  archived_message_count: number;
}

interface MessageRow {
  role:       string;
  content:    string | null;
  agent_id:   string | null;
  created_at: string;
}

export interface ArchiveResult {
  ok:        boolean;   // false = at least one exchange failed extraction
  skipped:   boolean;   // true = no work done (already archived / no session)
  extracted: number;    // memories indexed
  exchanges: number;    // exchanges fed to the extractor
  reason?:   string;
}

// Per-session in-process lock. Prevents the Curator and cleanup (same Node
// process) from double-extracting one session concurrently. A restart
// mid-archive simply leaves archived_at unstamped → retried next sweep.
const inFlight = new Map<string, Promise<ArchiveResult>>();

/**
 * Archive every memory from a session. Idempotent: a no-op when the session is
 * already archived and unchanged (unless `opts.force`).
 */
export function archiveSessionMemories(
  sessionId: string,
  opts: { force?: boolean } = {},
): Promise<ArchiveResult> {
  const existing = inFlight.get(sessionId);
  if (existing) return existing;
  const p = doArchive(sessionId, opts).finally(() => inFlight.delete(sessionId));
  inFlight.set(sessionId, p);
  return p;
}

async function doArchive(sessionId: string, opts: { force?: boolean }): Promise<ArchiveResult> {
  const db = getDb();
  const session = db.prepare(`
    SELECT id, title, agent_id, source, message_count, archived_at, archived_message_count
    FROM sessions WHERE id = ?
  `).get(sessionId) as SessionRow | undefined;

  if (!session) {
    return { ok: false, skipped: true, extracted: 0, exchanges: 0, reason: 'no_such_session' };
  }

  // No-op if already archived and unchanged.
  if (!opts.force && session.archived_at && session.archived_message_count >= session.message_count) {
    return { ok: true, skipped: true, extracted: 0, exchanges: 0, reason: 'already_archived' };
  }

  const messages = db.prepare(`
    SELECT role, content, agent_id, created_at
    FROM messages WHERE session_id = ? ORDER BY created_at ASC
  `).all(sessionId) as MessageRow[];

  // Empty session — nothing to extract; stamp it so cleanup can proceed.
  if (messages.length === 0) {
    stampArchived(sessionId, session.message_count);
    return { ok: true, skipped: false, extracted: 0, exchanges: 0 };
  }

  const inputs = buildExchangeInputs(session, messages);

  // No assistant turns → nothing to extract. Still stamp so cleanup can proceed.
  if (inputs.length === 0) {
    stampArchived(sessionId, session.message_count);
    return { ok: true, skipped: false, extracted: 0, exchanges: 0 };
  }

  let extracted = 0;
  let failed = false;

  for (const input of inputs) {
    try {
      const memory = await extract(input);
      if (!memory) continue;                                  // not memorable / below threshold
      if (await isDuplicateMemory(memory, input.agent_id)) continue; // already captured

      const row = await indexMemory({
        type:       memory.type,
        title:      memory.title,
        summary:    memory.summary,
        tags:       memory.tags,
        importance: memory.importance,
        salience:   initialSalience(memory.importance),
        agent_id:   input.agent_id ?? null,
        session_id: sessionId,
      });

      // Graph-lite: attach entities + relationships extracted alongside the memory.
      // Mirrors ingestExchange() logic — best-effort, must not affect failed flag.
      if (config.memoryGraph.enabled && (memory.entities?.length || memory.relationships?.length)) {
        try {
          await attachMemoryGraph({
            memoryId:      row.id,
            entities:      memory.entities,
            relationships: memory.relationships,
          });
        } catch (err) {
          logger.warn('session-archiver: graph attach failed', {
            sessionId, error: (err as Error).message,
          });
        }
      }

      extracted++;
    } catch (err) {
      failed = true;
      logger.warn('session-archiver: exchange extraction failed', {
        sessionId, error: (err as Error).message,
      });
    }
  }

  // Only stamp archived_at if every exchange processed cleanly — a partial
  // failure leaves the session un-archived so it is retried next sweep.
  if (!failed) stampArchived(sessionId, session.message_count);

  try {
    logHive(
      'session_archived',
      `session-archiver: ${extracted} memory(ies) from session ${sessionId}`,
      session.agent_id ?? undefined,
      { session_id: sessionId, source: session.source, extracted, exchanges: inputs.length, complete: !failed },
    );
  } catch { /* best-effort */ }

  return {
    ok: !failed,
    skipped: false,
    extracted,
    exchanges: inputs.length,
    reason: failed ? 'partial_failure' : undefined,
  };
}

function stampArchived(sessionId: string, messageCount: number): void {
  getDb().prepare(`
    UPDATE sessions
    SET archived_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), archived_message_count = ?
    WHERE id = ?
  `).run(messageCount, sessionId);
}

/**
 * Walk the message list and produce one ExtractInput per assistant turn,
 * paired with the nearest preceding user turn. An over-long single assistant
 * message is split into ASSISTANT_WINDOW-sized windows so no content is lost.
 */
function buildExchangeInputs(session: SessionRow, messages: MessageRow[]): ExtractInput[] {
  const inputs: ExtractInput[] = [];
  let lastUser = '';
  for (const m of messages) {
    if (m.role === 'assistant') {
      const content = (m.content ?? '').trim();
      if (!content) continue;
      for (let off = 0; off < content.length; off += ASSISTANT_WINDOW) {
        inputs.push({
          source:         'chat',
          agent_id:       m.agent_id ?? session.agent_id ?? null,
          agent_name:     null,
          session_id:     session.id,
          user_text:      lastUser,
          assistant_text: content.slice(off, off + ASSISTANT_WINDOW),
          context_hint:   `archived session: ${session.title ?? session.id}`,
        });
      }
    } else {
      // user / system turn — remember as context for the next assistant turn
      lastUser = (m.content ?? '').slice(0, 4000);
    }
  }
  return inputs;
}
