// One-time import: SQLite memory_index / memory_entities / memory_relationships
// → Supabase neuroclaw_kb. Embeddings are copied directly (BLOB → number[], same
// model/dims — NO re-embedding). Idempotent: upserts on `id`, so it's safe to
// re-run / resume. Drops the vault_* columns (vault removed).
import 'dotenv/config';
import { getDb } from '../src/db';
import { unpackVector } from '../src/memory/embeddings';
import { getSupabase } from '../src/db/supabase';

const db = getDb();
const sb = getSupabase();
const PAGE = 400;

function parseTags(raw: unknown): unknown[] {
  if (raw == null || raw === '') return [];
  try { const v = JSON.parse(String(raw)); return Array.isArray(v) ? v : []; } catch { return []; }
}

async function importTable(
  name: string,
  selectSql: string,
  mapRow: (r: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const total = (db.prepare(`SELECT COUNT(*) n FROM (${selectSql})`).get() as { n: number }).n;
  console.log(`\n${name}: ${total} rows`);
  let offset = 0, done = 0, failed = 0;
  while (offset < total) {
    const rows = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all(PAGE, offset) as Record<string, unknown>[];
    if (!rows.length) break;
    const payload = rows.map(mapRow);
    const { error } = await sb.from(name).upsert(payload, { onConflict: 'id' });
    if (error) { failed += rows.length; console.log(`  [${offset}] ERR ${error.message}`); }
    else done += rows.length;
    offset += rows.length;
    if ((offset / PAGE) % 10 === 0 || offset >= total) console.log(`  ${name}: ${done}/${total} imported (${failed} failed)`);
  }
}

(async () => {
  // 1. memory_index (FK target — must come first). Embeddings copied directly.
  await importTable(
    'memory_index',
    'SELECT id, type, title, summary, tags, importance, salience, agent_id, session_id, created_at, last_accessed, embedding, embedding_model FROM memory_index',
    (r) => {
      const buf = r.embedding as Buffer | null;
      const vec = buf ? unpackVector(buf) : null;
      return {
        id: r.id, type: r.type, title: r.title, summary: r.summary ?? null,
        tags: parseTags(r.tags),
        importance: r.importance ?? 0.5, salience: r.salience ?? 0.5,
        agent_id: r.agent_id ?? null, session_id: r.session_id ?? null,
        embedding: vec ? Array.from(vec) : null,
        embedding_model: r.embedding_model ?? null,
        created_at: r.created_at ?? null, last_accessed: r.last_accessed ?? null,
      };
    },
  );

  // 2. memory_entities
  await importTable(
    'memory_entities',
    'SELECT id, memory_id, name, entity_type, created_at FROM memory_entities',
    (r) => ({ id: r.id, memory_id: r.memory_id, name: r.name, entity_type: r.entity_type ?? null, created_at: r.created_at ?? null }),
  );

  // 3. memory_relationships
  await importTable(
    'memory_relationships',
    'SELECT id, memory_id, subject, verb, object, confidence, valid_from, valid_to, created_at FROM memory_relationships',
    (r) => ({
      id: r.id, memory_id: r.memory_id, subject: r.subject, verb: r.verb, object: r.object,
      confidence: r.confidence ?? 0.7, valid_from: r.valid_from ?? null, valid_to: r.valid_to ?? null, created_at: r.created_at ?? null,
    }),
  );

  console.log('\nimport complete.');
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
