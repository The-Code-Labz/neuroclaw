// Lazy Supabase client for the knowledge base. MUST stay lazy so dotenv loads
// before we read env vars (same rule as agent/openai-client.ts).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    const { supabaseUrl, supabaseServiceKey } = config.kb;
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('kb: SUPABASE_URL / SUPABASE_SERVICE_KEY not configured');
    }
    // The schema is a runtime string, so supabase-js binds the schema generic to
    // `string` rather than the default `"public"` literal — cast back to the
    // default-typed client (Database is `any`, so .from()/.rpc() still resolve).
    client = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Target the dedicated KB schema so .from()/.rpc() resolve unqualified.
      db: { schema: config.kb.dbSchema },
    }) as unknown as SupabaseClient;
  }
  return client;
}

/** Test seam: drop the cached client (e.g. after a config hot-reload). */
export function resetSupabase(): void { client = null; }
