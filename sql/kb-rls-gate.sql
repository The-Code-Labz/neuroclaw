-- ============================================================================
-- neuroclaw_kb — RLS hard gate
-- Context: PGRST currently only exposes 9/17 configured schemas because the
-- authenticator/anon role is missing USAGE/SELECT grants on the other 8
-- (Mayumi/Oracle triage, 2026-07-07). The moment those grants land + the
-- PostgREST schema cache reloads, neuroclaw_kb becomes reachable over the
-- REST API. This migration ships BEFORE that grant/reload so the schema is
-- deny-by-default the instant it becomes visible, regardless of whatever
-- table-level GRANTs get added later.
--
-- Access model (confirmed against src/db/supabase.ts + src/kb/kb-ingest.ts /
-- kb-search.ts): the NeuroClaw backend talks to neuroclaw_kb EXCLUSIVELY via
-- SUPABASE_SERVICE_KEY (service_role, db.schema = neuroclaw_kb). No anon or
-- authenticated caller has any legitimate reason to touch this schema.
-- Therefore: enable RLS on all three tables, add ZERO policies. Default-deny
-- applies to every role except service_role.
--
-- ⚠️ PRE-FLIGHT — run this on the Supabase box BEFORE applying this file:
--   select rolname, rolbypassrls from pg_roles where rolname = 'service_role';
-- If rolbypassrls = true (standard for supabase/supabase self-hosted images),
-- service_role sails through RLS untouched and this migration is a pure gate
-- with zero blast radius on ingestion/search.
-- If rolbypassrls = false, UNCOMMENT the three `_service_role_bypass`
-- policies at the bottom BEFORE applying, or kb-ingest.ts / kb-search.ts will
-- start failing with "permission denied for table kb_pages" etc. the moment
-- this file runs. Do not guess — check first.
--
-- Idempotent: safe to re-run (ENABLE ROW LEVEL SECURITY is a no-op if already
-- enabled; policy creation is guarded).
-- ============================================================================

alter table neuroclaw_kb.kb_sources       enable row level security;
alter table neuroclaw_kb.kb_pages         enable row level security;
alter table neuroclaw_kb.kb_code_examples enable row level security;

-- No policies for anon / authenticated on purpose: default-deny.
-- If a legitimate public-read use case ever appears, add a narrow, explicit
-- SELECT policy here — do not disable RLS to work around it.

-- ── OPTIONAL — only if the pre-flight check above showed rolbypassrls = false ──
-- do $$ begin
--   if not exists (select 1 from pg_policies where schemaname = 'neuroclaw_kb'
--                  and tablename = 'kb_sources' and policyname = 'kb_sources_service_role_bypass') then
--     create policy kb_sources_service_role_bypass on neuroclaw_kb.kb_sources
--       for all to service_role using (true) with check (true);
--   end if;
--   if not exists (select 1 from pg_policies where schemaname = 'neuroclaw_kb'
--                  and tablename = 'kb_pages' and policyname = 'kb_pages_service_role_bypass') then
--     create policy kb_pages_service_role_bypass on neuroclaw_kb.kb_pages
--       for all to service_role using (true) with check (true);
--   end if;
--   if not exists (select 1 from pg_policies where schemaname = 'neuroclaw_kb'
--                  and tablename = 'kb_code_examples' and policyname = 'kb_code_examples_service_role_bypass') then
--     create policy kb_code_examples_service_role_bypass on neuroclaw_kb.kb_code_examples
--       for all to service_role using (true) with check (true);
--   end if;
-- end $$;

-- ── Verification ──────────────────────────────────────────────────────────
-- select tablename, rowsecurity from pg_tables
--   where schemaname = 'neuroclaw_kb';
-- select * from pg_policies where schemaname = 'neuroclaw_kb';
--
-- Smoke test as anon (should return empty set / permission denied, NOT rows):
--   curl -s "$SUPABASE_URL/rest/v1/kb_sources?select=source_id&limit=1" \
--     -H "apikey: $SUPABASE_ANON_KEY" -H "Accept-Profile: neuroclaw_kb"
-- ============================================================================
