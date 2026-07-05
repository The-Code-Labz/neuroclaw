// Verify the SQLite→Supabase memory import: row counts + embedding counts per
// table must match. GATE before cutover — any MISMATCH means re-run / investigate.
import 'dotenv/config';
import { getDb } from '../src/db';
import { getSupabase } from '../src/db/supabase';

const db = getDb();
const sb = getSupabase();

const sqliteCount = (q: string) => (db.prepare(q).get() as { n: number }).n;
async function supaCount(table: string, embeddedOnly = false): Promise<number> {
  let q = sb.from(table).select('*', { count: 'exact', head: true });
  if (embeddedOnly) q = q.not('embedding', 'is', null);
  const { count, error } = await q;
  if (error) { console.log(`  supa ${table} err: ${error.message}`); return -1; }
  return count ?? 0;
}

(async () => {
  let failed = false;
  const pairs: Array<[string, boolean]> = [
    ['memory_index', true],
    ['memory_entities', false],
    ['memory_relationships', false],
  ];
  for (const [table, hasEmb] of pairs) {
    const sTotal = sqliteCount(`SELECT COUNT(*) n FROM ${table}`);
    const pTotal = await supaCount(table);
    const okTotal = sTotal === pTotal;
    let embLine = '';
    if (hasEmb) {
      const sEmb = sqliteCount(`SELECT COUNT(*) n FROM ${table} WHERE embedding IS NOT NULL`);
      const pEmb = await supaCount(table, true);
      const okEmb = sEmb === pEmb;
      embLine = ` | embedded ${sEmb}=${pEmb} ${okEmb ? 'OK' : 'MISMATCH'}`;
      if (!okEmb) failed = true;
    }
    console.log(`${table}: total ${sTotal}=${pTotal} ${okTotal ? 'OK' : 'MISMATCH'}${embLine}`);
    if (!okTotal) failed = true;
  }
  console.log(failed ? '\nGATE: ❌ MISMATCH — do not cut over' : '\nGATE: ✅ all match');
  process.exit(failed ? 1 : 0);
})();
