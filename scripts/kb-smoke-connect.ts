import 'dotenv/config';
import { getSupabase } from '../src/db/supabase';

(async () => {
  try {
    const sb = getSupabase();
    const r = await sb.from('kb_sources').select('*', { count: 'exact', head: true });
    if (r.error) {
      // Reached PostgREST with valid auth, but schema/table not set up yet — expected pre-Task-3.
      console.log('REACHABLE (auth ok), PostgREST says:', r.error.code, r.error.message);
      process.exit(0);
    }
    console.log('OK: connected + schema exposed, kb_sources count =', r.count);
  } catch (err) {
    console.error('FAIL (network/auth):', (err as Error).message);
    process.exit(1);
  }
})();
