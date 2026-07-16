/**
 * broker/memoryDecorrupt.ts — one-time repair for over-scrubbed memory rows.
 *
 * Before the name-classification fix (see scrubber.ts `shouldScrubName`), the
 * memory scrubber replaced NON-sensitive identifier values (service URLs,
 * usernames, bucket names, …) with `***<NAME>***` placeholders on their way
 * into long-term memory. Those rows are now corrupted: an endpoint or username
 * reads back as a redaction marker.
 *
 * This sweep walks the memory surfaces that `scrubForMemory` touched and
 * restores the ORIGINAL identifier value wherever a placeholder for a
 * now-classified NON-sensitive secret appears.
 *
 * SAFETY INVARIANT — never un-redact a real credential:
 *   The replacement map is built ONLY from secrets where `shouldScrubName(name)`
 *   returns false (proven identifiers). A real credential's name always scrubs,
 *   so its placeholder can never enter the map and can never be un-redacted.
 *
 * Idempotent: replacing an already-restored value is a no-op. Best-effort: a
 * failure on one row/surface is logged and skipped, never thrown to the caller.
 */
import { getStorage } from './storage';
import { shouldScrubName } from './scrubber';
import { getDb } from '../db';
import { getMemoryStore } from '../memory/memory-store';
import { auditLog } from './audit';
import { logger } from '../utils/logger';

export interface DecorruptResult {
  /** placeholders repaired, per surface */
  memoriesRows: number;
  memoryIndexRows: number;
  /** identifier secrets that formed the restore map */
  restorableSecrets: number;
  dryRun: boolean;
}

/** Build `***NAME*** → value` for every NON-sensitive identifier secret. */
async function buildRestoreMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const list = await getStorage().list();
  for (const meta of list) {
    // Only ever restore proven identifiers — fail-closed guards real secrets.
    if (shouldScrubName(meta.name)) continue;
    const value = await getStorage().getValue(meta.name);
    if (!value) continue;
    map.set(`***${meta.name}***`, value);
  }
  return map;
}

/** Apply the restore map to a single string. Returns `[repaired, occurrences]`. */
function restoreString(text: string, map: Map<string, string>): [string, number] {
  if (!text || text.indexOf('***') === -1) return [text, 0];
  let out = text;
  let count = 0;
  for (const [placeholder, value] of map) {
    const parts = out.split(placeholder);
    if (parts.length === 1) continue;   // placeholder absent
    count += parts.length - 1;          // number of occurrences replaced
    out = parts.join(value);
  }
  return [out, count];
}

/**
 * Run the one-time sweep. Pass `{ dryRun: true }` to count without writing.
 */
export async function sweepMemoryDecorruption(
  opts: { dryRun?: boolean } = {},
): Promise<DecorruptResult> {
  const dryRun = opts.dryRun === true;
  const result: DecorruptResult = {
    memoriesRows: 0,
    memoryIndexRows: 0,
    restorableSecrets: 0,
    dryRun,
  };

  let map: Map<string, string>;
  try {
    map = await buildRestoreMap();
  } catch (err) {
    logger.warn('broker/memoryDecorrupt: failed to load secrets, aborting sweep', {
      err: (err as Error).message,
    });
    return result;
  }
  result.restorableSecrets = map.size;
  if (map.size === 0) return result;

  // ── Surface 1: legacy `memories` table (content) ──────────────────────────
  try {
    const db = getDb();
    const rows = db
      .prepare("SELECT id, content FROM memories WHERE content LIKE '%***%'")
      .all() as Array<{ id: string; content: string }>;
    const upd = db.prepare('UPDATE memories SET content = ? WHERE id = ?');
    for (const row of rows) {
      const [repaired, n] = restoreString(row.content, map);
      if (n > 0 && repaired !== row.content) {
        if (!dryRun) upd.run(repaired, row.id);
        result.memoriesRows += 1;
      }
    }
  } catch (err) {
    logger.warn('broker/memoryDecorrupt: memories-table sweep failed', {
      err: (err as Error).message,
    });
  }

  // ── Surface 2: memory_index (title + summary) ─────────────────────────────
  try {
    const store = await getMemoryStore();
    const rows = await store.listMemoryIndex({ limit: 100000 });
    for (const row of rows) {
      const [title, tn] = restoreString(row.title ?? '', map);
      const [summary, sn] = restoreString(row.summary ?? '', map);
      if (tn + sn === 0) continue;
      if (!dryRun) {
        await store.updateMemory(row.id, { title, summary });
      }
      result.memoryIndexRows += 1;
    }
  } catch (err) {
    logger.warn('broker/memoryDecorrupt: memory_index sweep failed', {
      err: (err as Error).message,
    });
  }

  const repaired = result.memoriesRows + result.memoryIndexRows;
  if (repaired > 0) {
    auditLog({
      event: 'scrub_triggered',
      agent: 'memory-decorrupt',
      session_id: 'migration',
      purpose: 'one-time memory de-corruption sweep',
      outcome: 'ok',
      detail:
        `${dryRun ? '[dry-run] ' : ''}restored ${repaired} row(s) ` +
        `(${result.memoriesRows} memories, ${result.memoryIndexRows} memory_index) ` +
        `from ${map.size} identifier placeholder(s)`,
    });
  }
  return result;
}

/**
 * One-time CLI runner. Dry-run by default (counts only); pass `--apply` to
 * write. Invoke with:  tsx src/broker/memoryDecorrupt.ts [--apply]
 */
if (require.main === module) {
  const apply = process.argv.includes('--apply');
  sweepMemoryDecorruption({ dryRun: !apply })
    .then((r) => {
      logger.info('broker/memoryDecorrupt: sweep complete', { ...r });
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...r }, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      logger.error('broker/memoryDecorrupt: sweep failed', { err: (err as Error).message });
      process.exit(1);
    });
}
