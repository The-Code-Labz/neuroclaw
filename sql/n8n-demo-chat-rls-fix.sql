-- ============================================================================
-- public.n8n_demo_chat — close anonymous read/write/delete exposure
-- Context: prior PostgREST audit (Supabase PostgREST audit found exposure)
-- flagged this table as fully open to the `anon` role — no RLS, leaking chat
-- history / session data and allowing anon INSERT/UPDATE/DELETE. Independent
-- of the neuroclaw_kb sequencing — ship as soon as verified.
--
-- ⚠️ Before applying, confirm how n8n actually talks to this table:
--   - If the n8n workflow node uses the Supabase SERVICE_ROLE key → safe to
--     go straight to default-deny (no anon/authenticated policies). n8n's
--     service_role calls bypass RLS (assuming standard rolbypassrls=true —
--     see the pre-flight note in kb-rls-gate.sql) and are unaffected.
--   - If the n8n workflow / a public chat widget calls this table with the
--     ANON key directly (common for "demo" tables wired straight into a
--     frontend), a blanket default-deny will break that widget. In that case
--     use the scoped policy at the bottom instead of the deny-all block.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.n8n_demo_chat enable row level security;

-- ── Default case: n8n reaches this table via service_role only ────────────
-- No policies added → anon/authenticated get zero rows and zero writes.
-- (Nothing further needed here; presence of RLS + absence of policies IS
-- the fix.)

-- ── Alternative: if a public widget genuinely needs anon SELECT (read-only,
-- e.g. showing a public demo transcript) but writes must stay locked to the
-- backend — uncomment ONLY the read policy, never open insert/update/delete
-- to anon:
-- create policy n8n_demo_chat_anon_read_only on public.n8n_demo_chat
--   for select to anon using (true);

-- ── Belt-and-suspenders: strip the table-level GRANTs from anon too ───────────
-- RLS (enabled above, no policy) already forces anon to 0 rows / rejected
-- writes even while the GRANTs remain. But recon confirmed anon currently holds
-- SELECT/INSERT/UPDATE/DELETE grants on this table (that is what made the live
-- CRUD possible pre-RLS). Revoking them removes the second half of the exposure
-- so a future accidental permissive policy can't re-open writes. Safe: the
-- backend / n8n reach this table via service_role, which is unaffected.
-- Idempotent. If the anon-read policy above is in use, keep `select` granted:
revoke insert, update, delete on public.n8n_demo_chat from anon;
-- revoke select on public.n8n_demo_chat from anon;   -- also strip reads unless the demo widget needs anon SELECT

-- ── Verification ──────────────────────────────────────────────────────────
-- select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' and tablename = 'n8n_demo_chat';
-- select * from pg_policies where schemaname = 'public' and tablename = 'n8n_demo_chat';
--
-- Smoke test as anon (should now be blocked, not return/accept rows):
--   curl -s "$SUPABASE_URL/rest/v1/n8n_demo_chat?select=*&limit=1" \
--     -H "apikey: $SUPABASE_ANON_KEY"
--   curl -s -X POST "$SUPABASE_URL/rest/v1/n8n_demo_chat" \
--     -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
--     -d '{}'   # expect 401/403, not 201
-- ============================================================================
