-- ============================================================================
-- READ-ONLY introspection — run in the Supabase Studio SQL editor ON THE BOX.
-- Neither the NeuroClaw host nor the recon host can reach pg_catalog: pg ports
-- 5432/6543 are firewalled, PostgREST does not expose pg_catalog, and there is
-- no exec_sql RPC. These five queries give the definitive RLS / default-ACL /
-- grant picture that closes out the audit. Nothing here mutates anything.
--
-- Paste the whole file into Studio → SQL editor → Run. Expected results noted
-- inline so the user can eyeball pass/fail without interpreting raw catalogs.
-- ============================================================================

-- (1) RLS enabled per table in public + our KB/mem schemas ---------------------
-- EXPECT: n8n_demo_chat.relrowsecurity = true AFTER n8n-demo-chat-rls-fix.sql.
select n.nspname   as schema,
       c.relname   as table,
       c.relrowsecurity  as rls_enabled,
       c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r'
  and n.nspname in ('public','neuroclaw_kb','neuroclaw_mem')
order by 1,2;

-- (2) Default privileges (the landmine that auto-grants future objects) --------
-- EXPECT: no rows granting anon/PUBLIC. A row here means every NEW table/function
-- in that schema is auto-granted to that role — the reason "demo" tables keep
-- re-opening. defaclobjtype: 'r'=table, 'f'=function, 'S'=sequence.
select nsp.nspname            as schema,
       pg_get_userbyid(d.defaclrole) as owner,
       d.defaclobjtype        as obj_type,
       d.defaclacl            as default_acl
from pg_default_acl d
left join pg_namespace nsp on nsp.oid = d.defaclnamespace
order by 1,3;

-- (3) Schema-level USAGE — which schemas can anon/authenticated even enter ----
-- EXPECT: anon should have USAGE on 'public' (PostgREST needs it) but ideally
-- NOT on storage/graphql_public/neuroclaw_kb/neuroclaw_mem.
select nspname as schema,
       has_schema_privilege('anon',          nspname, 'USAGE') as anon_usage,
       has_schema_privilege('authenticated', nspname, 'USAGE') as auth_usage,
       has_schema_privilege('service_role',  nspname, 'USAGE') as svc_usage
from pg_namespace
where nspname in ('public','storage','graphql_public','neuroclaw_kb','neuroclaw_mem')
order by 1;

-- (4) Table-level grants held by anon (the actual CRUD surface) ----------------
-- EXPECT after fixes: anon holds NO privileges on n8n_demo_chat, and NONE on
-- storage.objects / storage.buckets beyond what Supabase ships intentionally.
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where grantee in ('anon','authenticated','PUBLIC')
  and table_schema in ('public','storage','graphql_public')
order by table_schema, table_name, grantee, privilege_type;

-- (5) Function EXECUTE grants held by anon (the RPC surface) -------------------
-- EXPECT after api-key-rpc-lockdown.sql: anon absent for all five key RPCs.
-- Also surfaces security_type=DEFINER — any DEFINER function anon can execute is
-- a priority review item.
select r.routine_schema,
       r.routine_name,
       r.security_type,                 -- INVOKER (safe-ish) vs DEFINER (audit!)
       g.grantee,
       g.privilege_type
from information_schema.routines r
left join information_schema.role_routine_grants g
       on g.specific_name = r.specific_name
      and g.routine_schema = r.routine_schema
where r.routine_schema = 'public'
  and (g.grantee in ('anon','authenticated','PUBLIC') or g.grantee is null)
order by r.routine_name, g.grantee;

-- ── BONUS — storage & graphql anon reachability (catalog-level) ---------------
-- storage.objects / storage.buckets RLS + anon grants. Supabase ships RLS ON
-- for storage.objects with policies; confirm no over-broad anon policy exists.
select schemaname, tablename, policyname, roles, cmd, qual
from pg_policies
where schemaname = 'storage'
order by tablename, policyname;
-- ============================================================================
