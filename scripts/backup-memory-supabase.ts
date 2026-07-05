// Local backup of the Supabase long-term memory tables (neuroclaw_kb).
//
// Why this exists: memory now lives on the self-hosted Supabase on a SEPARATE
// server reachable only via the HTTPS PostgREST gateway (no direct Postgres /
// pg_dump access from here). This script exports memory_index (incl. the 1536-d
// embedding vectors), memory_entities, and memory_relationships to local gzipped
// NDJSON so we hold a fresh, restorable snapshot we control — independent of
// whatever backup policy the remote box has.
//
// Run manually:  npx tsx scripts/backup-memory-supabase.ts
// Scheduled via: neuroclaw-memory-backup.timer (systemd, daily)
//
// Output:  backups/memory-export/<table>-<ts>.ndjson.gz  +  manifest-<ts>.json
// Rotation: keeps the newest MEMORY_BACKUP_KEEP (default 14) snapshots.

import 'dotenv/config';
import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getSupabase } from '../src/db/supabase';

const TABLES = ['memory_index', 'memory_entities', 'memory_relationships'] as const;
// Per-table request chunk. memory_index rows carry the full 1536-d embedding
// (~19.5 KB/row as text) so its page must stay well under the gateway's ~8 MB
// response cap (200 ≈ 3.9 MB); the embedding-free tables can pull larger chunks.
// Pagination advances by ACTUAL rows returned, so a smaller server-side cap is
// handled correctly regardless of the requested size.
const PAGE_BY_TABLE: Record<string, number> = {
  memory_index: 200,
  memory_entities: 1000,
  memory_relationships: 1000,
};
const MAX_RETRY = 3;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const KEEP = Math.max(1, parseInt(process.env.MEMORY_BACKUP_KEEP || '14', 10) || 14);
const BACKUP_DIR = process.env.MEMORY_BACKUP_DIR || join(process.cwd(), 'backups', 'memory-export');

// Filesystem-safe ISO timestamp: 2026-06-25T23-59-59-123Z
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Stream all rows of `table` (paginated, ordered by id for stable ranges) into
// a gzipped NDJSON file. Returns the row count written.
async function dumpTable(table: string, file: string): Promise<number> {
  const sb = getSupabase();
  const page = PAGE_BY_TABLE[table] ?? 500;
  const gzip = createGzip();
  const out = createWriteStream(file);
  const sink = pipeline(gzip, out); // resolves when fully flushed to disk

  // Fetch one chunk, retrying transient "fetch failed" (connection resets under
  // load) with backoff. A PostgREST error is not transient — fail immediately.
  async function fetchPage(from: number): Promise<Record<string, unknown>[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await sb.from(table).select('*').order('id', { ascending: true }).range(from, from + page - 1);
        if (res.error) throw Object.assign(new Error(`${table}: ${res.error.message}`), { fatal: true });
        return (res.data ?? []) as Record<string, unknown>[];
      } catch (err) {
        if ((err as { fatal?: boolean }).fatal || attempt >= MAX_RETRY) throw err;
        await sleep(1000 * attempt);
      }
    }
  }

  let total = 0;
  try {
    // Advance by rows ACTUALLY returned (robust if the gateway caps page size
    // below `page`); stop only when a chunk comes back empty.
    for (let from = 0; ; ) {
      const data = await fetchPage(from);
      if (data.length === 0) break;
      for (const row of data) {
        if (!gzip.write(JSON.stringify(row) + '\n')) {
          await new Promise<void>(res => gzip.once('drain', res));
        }
      }
      total += data.length;
      from += data.length;
    }
  } catch (err) {
    gzip.destroy();
    await sink.catch(() => {}); // swallow the abort from destroy()
    throw err;
  }

  gzip.end();
  await sink;
  return total;
}

// Keep only the newest KEEP snapshots; delete older manifests + their files.
async function rotate(): Promise<number> {
  const entries = (await readdir(BACKUP_DIR)).filter(f => f.startsWith('manifest-') && f.endsWith('.json'));
  entries.sort(); // ISO-ish stamps sort chronologically
  const stale = entries.slice(0, Math.max(0, entries.length - KEEP));
  let removed = 0;
  for (const manifest of stale) {
    const ts = manifest.slice('manifest-'.length, -'.json'.length);
    const all = await readdir(BACKUP_DIR);
    for (const f of all) {
      if (f.includes(ts)) { await rm(join(BACKUP_DIR, f), { force: true }); removed++; }
    }
  }
  return removed;
}

async function main(): Promise<void> {
  await mkdir(BACKUP_DIR, { recursive: true });
  const ts = stamp();
  const counts: Record<string, number> = {};
  const files: string[] = [];

  console.log(`memory backup → ${BACKUP_DIR} (ts=${ts})`);
  for (const table of TABLES) {
    const name = `${table}-${ts}.ndjson.gz`;
    const n = await dumpTable(table, join(BACKUP_DIR, name));
    counts[table] = n;
    files.push(name);
    console.log(`  ${table.padEnd(22)} ${n} rows → ${name}`);
  }

  const manifest = { timestamp: ts, schema: process.env.KB_DB_SCHEMA || 'neuroclaw_kb', counts, files };
  await writeFile(join(BACKUP_DIR, `manifest-${ts}.json`), JSON.stringify(manifest, null, 2));

  const removed = await rotate();
  console.log(`manifest written; rotation removed ${removed} stale file(s); keeping newest ${KEEP}`);
  console.log(`✅ done: ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(', ')}`);
}

main().catch(err => { console.error('❌ memory backup failed:', (err as Error).message); process.exit(1); });
