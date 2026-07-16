-- ============================================================================
-- public API-key RPCs — revoke anonymous EXECUTE (defense in depth)
-- Context: PostgREST audit of supabase.neurolearninglabs.com (Tim recon +
-- Nightwing on-box verification, 2026-07-07). PostgREST exposes 5 functions in
-- the `public` schema. Confirmed via service_role OpenAPI:
--   /rpc/get_my_profile, /rpc/upsert_my_api_key, /rpc/has_my_api_key,
--   /rpc/delete_my_api_key, /rpc/get_api_key_for_user
--
-- Live anon behaviour (recon):
--   get_my_profile()          -> 200 []   (executes as anon, returns empty)
--   has_my_api_key()          -> 401 42501 "permission denied for table user_api_keys"
--   get_api_key_for_user(...) -> 401 42501 (same)
-- => NO key leaks TODAY, and ONLY because the underlying table `user_api_keys`
--    has no anon GRANT. The anon EXECUTE grant on these functions is a LANDMINE:
--    the day `user_api_keys` gets an anon grant, OR any of these functions flips
--    to SECURITY DEFINER, anonymous callers instantly exfiltrate other users'
--    API keys. Close the EXECUTE grant now so the table grant is not the only
--    thing standing between the internet and everyone's keys.
--
-- ROOT CAUSE: Postgres grants EXECUTE to the PUBLIC pseudo-role by default on
-- every new function, and `anon` inherits PUBLIC. Revoking from PUBLIC is the
-- actual fix; revoking from `anon` explicitly is belt-and-suspenders.
--
-- Signature-agnostic (revokes every overload by name) and idempotent.
-- Leaves `authenticated` and `service_role` EXECUTE intact — real logged-in
-- users can still manage their own keys; the backend uses service_role.
-- ============================================================================

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'get_api_key_for_user',
        'upsert_my_api_key',
        'delete_my_api_key',
        'has_my_api_key',
        'get_my_profile'
      )
  loop
    execute format('revoke execute on function %s from anon', r.sig);
    execute format('revoke execute on function %s from public', r.sig);
    raise notice 'revoked EXECUTE from anon,public on %', r.sig;
  end loop;
end $$;

-- ── SEPARATE, HIGHER-SEVERITY FINDING — horizontal privilege escalation ──────
-- get_api_key_for_user(_user_id text) takes an ARBITRARY user id, NOT auth.uid().
-- Even after the anon revoke above, ANY *authenticated* user can pass another
-- user's id and read their key (assuming the function body is SECURITY DEFINER
-- or the caller otherwise reaches user_api_keys). This is an IDOR/BOLA-class
-- bug that the anon revoke does NOT fix. Recommended hardening — restrict this
-- one to service_role only, so nothing user-facing can call it:
--
--   do $$
--   declare r record;
--   begin
--     for r in select p.oid::regprocedure as sig from pg_proc p
--              join pg_namespace n on n.oid=p.pronamespace
--              where n.nspname='public' and p.proname='get_api_key_for_user'
--     loop
--       execute format('revoke execute on function %s from authenticated', r.sig);
--     end loop;
--   end $$;
--
-- BETTER long-term fix (owned by whoever authored the function): rewrite it to
-- ignore any caller-supplied id and use auth.uid() internally, or drop it in
-- favour of get_my_profile()/has_my_api_key() which are already self-scoped.
-- Do NOT ship the authenticated-revoke blindly if a legitimate backend flow
-- calls it with service_role — service_role is unaffected either way, so it is
-- safe, but confirm no *authenticated* client depends on it first.

-- ── VERIFICATION (run as anon after applying) ────────────────────────────────
-- All five must return 401/403 (permission denied to EXECUTE), not 200:
--   curl -s -o /dev/null -w "%{http_code}\n" -X POST \
--     "$SUPABASE_URL/rest/v1/rpc/get_my_profile" \
--     -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
--     -H "Content-Type: application/json" -d '{}'
-- Catalog check (Studio SQL editor):
--   select p.proname, p.prosecdef as security_definer,
--          array(select r.rolname from pg_roles r
--                where has_function_privilege(r.rolname, p.oid, 'EXECUTE')
--                  and r.rolname in ('anon','authenticated','service_role','PUBLIC')) as can_execute
--   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--   where n.nspname='public'
--     and p.proname in ('get_api_key_for_user','upsert_my_api_key',
--                       'delete_my_api_key','has_my_api_key','get_my_profile');
--   -- expect 'anon' absent from can_execute for all five.
-- ============================================================================
