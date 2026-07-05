import { EventEmitter }  from 'events';
import { randomUUID }    from 'crypto';
import { config }        from '../config';
import { logger }        from '../utils/logger';
import { ingestExchange } from './memory-pipeline';
import { parse }         from './importers';
import type { ImportSource, ImportedConversation } from './importers';
import {
  createImportSession,
  getImportSession,
  updateImportProgress,
  finishImportSession,
  type ImportSession,
} from '../db';

export { type ImportSession };

// One emitter shared across all import runs. Each run emits on its own
// importId channel so SSE subscribers can filter by ID.
export const importEvents = new EventEmitter();
importEvents.setMaxListeners(100);

// Only one import may run at a time to avoid saturating the LLM endpoint.
let _activeImportId: string | null = null;
export function getActiveImportId(): string | null { return _activeImportId; }

export type StartImportResult = {
  ok:        true;
  importId:  string;
} | {
  ok:        false;
  reason:    string;
  httpStatus: number;
}

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

export async function startImport(
  buffer:   Buffer,
  source:   ImportSource,
  filename: string,
): Promise<StartImportResult> {
  if (buffer.length > MAX_FILE_BYTES) {
    return { ok: false, reason: 'File exceeds 50 MB. Split the export into smaller files.', httpStatus: 413 };
  }
  if (_activeImportId) {
    return { ok: false, reason: 'Another import is already running.', httpStatus: 409 };
  }

  let conversations: ImportedConversation[];
  try {
    conversations = parse(buffer, source);
  } catch (err) {
    return { ok: false, reason: `Parse error: ${err instanceof Error ? err.message : String(err)}`, httpStatus: 400 };
  }

  const total = conversations.reduce((n, c) => n + c.exchanges.length, 0);
  const importId = randomUUID();
  createImportSession(importId, source, filename, total);
  _activeImportId = importId;

  _runImport(importId, conversations, total).catch((err) => {
    logger.error('import: runner crashed', { importId, error: String(err) });
    finishImportSession(importId, 'failed', String(err));
    importEvents.emit(`${importId}:done`, { error: String(err) });
    _activeImportId = null;
  });

  return { ok: true, importId };
}

export function cancelImport(importId: string): boolean {
  const session = getImportSession(importId);
  if (!session || session.status !== 'running') return false;
  finishImportSession(importId, 'cancelled');
  _activeImportId = null;
  importEvents.emit(`${importId}:done`, { cancelled: true });
  return true;
}

async function _runImport(
  importId:      string,
  conversations: ImportedConversation[],
  total:         number,
): Promise<void> {
  let processed = 0, created = 0, skipped = 0;
  let cancelled = false;

  // Flatten the (conversation, exchange) cartesian into a single work queue so
  // the worker pool can pull tasks without nested-loop bookkeeping. Order is
  // preserved so progress events still feel roughly chronological.
  const queue: Array<{ user: string; assistant: string }> = [];
  for (const conv of conversations) {
    for (const ex of conv.exchanges) {
      queue.push({ user: ex.user, assistant: ex.assistant });
    }
  }

  const concurrency = Math.max(1, Math.min(config.memory.importConcurrency, queue.length || 1));
  let cursor = 0;

  // One worker = one in-flight ingestExchange (= one outstanding LLM call to
  // VoidAI). Workers pull from the shared cursor until the queue drains or the
  // import is cancelled. Progress counters / SSE events are bumped inline by
  // whichever worker finishes next — order is "completion order", not source
  // order, which is fine for the dashboard's running totals.
  async function worker(): Promise<void> {
    while (true) {
      if (cancelled) return;
      const idx = cursor++;
      if (idx >= queue.length) return;

      // Cheap per-task cancellation check. The DB hit here is small
      // (single-row SELECT) and only runs every (concurrency)-th task in
      // practice, so it doesn't dominate.
      const session = getImportSession(importId);
      if (session?.status === 'cancelled') {
        cancelled = true;
        return;
      }

      const ex = queue[idx];
      try {
        const result = await ingestExchange({
          source:         'chat',
          user_text:      ex.user,
          assistant_text: ex.assistant,
        });
        if (result.ok && result.memory_id) created++; else skipped++;
      } catch {
        skipped++;
      }

      processed++;
      updateImportProgress(importId, processed, created, skipped);
      importEvents.emit(importId, { processed, total, created, skipped, status: 'running' });
    }
  }

  try {
    logger.info('import: starting parallel run', { importId, total: queue.length, concurrency });
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (cancelled) {
      _activeImportId = null;
      return;
    }

    finishImportSession(importId, 'done');
    importEvents.emit(`${importId}:done`, { created, skipped, total: processed });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishImportSession(importId, 'failed', error);
    importEvents.emit(`${importId}:done`, { error });
  } finally {
    _activeImportId = null;
  }
}
