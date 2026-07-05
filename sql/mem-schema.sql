-- ============================================================================
-- NeuroClaw Memory — Supabase schema migration
-- Target: self-hosted Supabase (supabase.your-domain.com)
-- Creates memory_index / memory_entities / memory_relationships + match_memories
-- RPC in the EXISTING `neuroclaw_kb` schema (already exposed via PGRST_DB_SCHEMAS
-- + granted to service_role, so NO PostgREST restart is needed this time).
-- Idempotent: safe to re-run.
--
-- Mirrors sql/kb-schema.sql conventions: tables → RPC → grants → indexes, with
-- the vector index in a non-fatal DO block (HNSW → ivfflat → skip) and the
-- pgvector operator schema-qualified (extensions.<=>) because the extensions
-- schema is not on PostgREST's RPC search_path.
-- ============================================================================

set search_path to neuroclaw_kb, public, extensions;

-- ── Tables ──────────────────────────────────────────────────────────────────
-- `id` is text (existing UUIDs from SQLite). `type` is free text (17 live values,
-- no enum). `tags` is jsonb (imported from the SQLite JSON-array string). No
-- vault_* columns — the Obsidian vault is removed.

create table if not exists neuroclaw_kb.memory_index (
  id              text primary key,
  type            text not null,
  title           text not null,
  summary         text,
  tags            jsonb default '[]'::jsonb,
  importance      real default 0.5,
  salience        real default 0.5,
  agent_id        text,
  session_id      text,
  embedding       vector(1536),
  embedding_model text,
  content_search  tsvector generated always as
                    (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,''))) stored,
  created_at      timestamptz default now(),
  last_accessed   timestamptz
);

create table if not exists neuroclaw_kb.memory_entities (
  id          text primary key,
  memory_id   text not null references neuroclaw_kb.memory_index(id) on delete cascade,
  name        text not null,
  entity_type text,
  created_at  timestamptz default now()
);

create table if not exists neuroclaw_kb.memory_relationships (
  id          text primary key,
  memory_id   text not null references neuroclaw_kb.memory_index(id) on delete cascade,
  subject     text not null,
  verb        text not null,
  object      text not null,
  confidence  real default 0.7,
  valid_from  timestamptz default now(),
  valid_to    timestamptz,
  created_at  timestamptz default now()
);

-- ── Match RPC (vector recall; no agent filter — matches current searchSqlite) ─
create or replace function neuroclaw_kb.match_memories(
  query_embedding vector(1536),
  match_count     int default 20
) returns table (
  id text, type text, title text, summary text, tags jsonb,
  importance real, salience real, agent_id text, session_id text,
  last_accessed timestamptz, similarity float
) language plpgsql stable as $$
begin
  return query
  select m.id, m.type, m.title, m.summary, m.tags, m.importance, m.salience,
         m.agent_id, m.session_id, m.last_accessed,
         1 - (m.embedding operator(extensions.<=>) query_embedding) as similarity
  from neuroclaw_kb.memory_index m
  where m.embedding is not null
  order by m.embedding operator(extensions.<=>) query_embedding
  limit match_count;
end;
$$;

-- ── Aggregate RPCs (server-side GROUP BY for the dashboard + entity views) ───
create or replace function neuroclaw_kb.memory_count_by_type()
returns table (type text, n bigint) language sql stable as $$
  select type, count(*) as n from neuroclaw_kb.memory_index group by type order by n desc;
$$;

create or replace function neuroclaw_kb.memory_top_entities(match_count int default 50)
returns table (name text, mentions bigint, last_seen timestamptz) language sql stable as $$
  select name, count(*) as mentions, max(created_at) as last_seen
  from neuroclaw_kb.memory_entities
  group by lower(name), name
  order by mentions desc, last_seen desc
  limit match_count;
$$;

-- ── Privileges (run before indexes so a vector-index failure can't leave the
--    role read-only on these new tables) ──────────────────────────────────────
grant all on all tables    in schema neuroclaw_kb to service_role;
grant all on all sequences in schema neuroclaw_kb to service_role;
grant execute on all functions in schema neuroclaw_kb to service_role;
alter default privileges in schema neuroclaw_kb grant all on tables to service_role;
alter default privileges in schema neuroclaw_kb grant execute on functions to service_role;

-- ── Plain indexes (work on any PostgreSQL) ───────────────────────────────────
create index if not exists memory_index_fts_idx    on neuroclaw_kb.memory_index using gin (content_search);
create index if not exists memory_index_agent_idx   on neuroclaw_kb.memory_index (agent_id);
create index if not exists memory_index_type_idx    on neuroclaw_kb.memory_index (type);
create index if not exists memory_index_created_idx on neuroclaw_kb.memory_index (created_at);
create index if not exists memory_entities_name_idx on neuroclaw_kb.memory_entities (lower(name));
create index if not exists memory_entities_mem_idx  on neuroclaw_kb.memory_entities (memory_id);
create index if not exists memory_rel_subject_idx   on neuroclaw_kb.memory_relationships (lower(subject));
create index if not exists memory_rel_object_idx    on neuroclaw_kb.memory_relationships (lower(object));
create index if not exists memory_rel_mem_idx       on neuroclaw_kb.memory_relationships (memory_id);

-- ── Vector ANN index (best-effort, non-fatal: HNSW → ivfflat → skip) ─────────
do $$
begin
  begin
    create index if not exists memory_index_embedding_idx
      on neuroclaw_kb.memory_index using hnsw (embedding vector_cosine_ops)
      with (m = 16, ef_construction = 64);
    raise notice 'mem: memory_index HNSW index created';
  exception when others then
    raise notice 'mem: HNSW unavailable (%) — trying ivfflat', sqlerrm;
    begin
      create index if not exists memory_index_embedding_idx
        on neuroclaw_kb.memory_index using ivfflat (embedding vector_cosine_ops) with (lists = 100);
      raise notice 'mem: memory_index ivfflat index created';
    exception when others then
      raise notice 'mem: no vector index (%) — recall uses seq scan', sqlerrm;
    end;
  end;
end $$;
