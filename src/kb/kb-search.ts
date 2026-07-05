import { getSupabase } from '../db/supabase';
import { embedKbText } from './kb-embeddings';
import { config } from '../config';
import { logger } from '../utils/logger';

export async function searchKnowledgeBase(query: string, opts?: { source?: string; limit?: number }) {
  try {
    const embedding = await embedKbText(query);
    if (!embedding) return { ok: false, results: [], error: 'embedding unavailable' };
    const { data, error } = await getSupabase().rpc('match_pages', {
      query_embedding: embedding,
      match_count: opts?.limit ?? config.kb.matchCount,
      filter_source: opts?.source ?? null,
    });
    if (error) return { ok: false, results: [], error: error.message };
    return { ok: true, results: (data ?? []) as Array<{ url: string; source_id: string; content: string; similarity: number }> };
  } catch (err) {
    logger.warn('kb: searchKnowledgeBase failed', { err: (err as Error).message });
    return { ok: false, results: [], error: (err as Error).message };
  }
}

export async function searchCodeExamples(query: string, opts?: { source?: string; limit?: number }) {
  try {
    const embedding = await embedKbText(query);
    if (!embedding) return { ok: false, results: [], error: 'embedding unavailable' };
    const { data, error } = await getSupabase().rpc('match_code_examples', {
      query_embedding: embedding,
      match_count: opts?.limit ?? config.kb.matchCount,
      filter_source: opts?.source ?? null,
    });
    if (error) return { ok: false, results: [], error: error.message };
    return { ok: true, results: (data ?? []) as Array<{ url: string; source_id: string; content: string; summary: string; similarity: number }> };
  } catch (err) {
    logger.warn('kb: searchCodeExamples failed', { err: (err as Error).message });
    return { ok: false, results: [], error: (err as Error).message };
  }
}

export async function listSources() {
  try {
    const { data, error } = await getSupabase().from('kb_sources')
      .select('source_id, title, summary').order('source_id');
    if (error) return { ok: false, sources: [], error: error.message };
    return { ok: true, sources: (data ?? []) as Array<{ source_id: string; title: string; summary: string | null }> };
  } catch (err) {
    logger.warn('kb: listSources failed', { err: (err as Error).message });
    return { ok: false, sources: [], error: (err as Error).message };
  }
}

export interface KbSourceDetail {
  source_id: string;
  title: string | null;
  summary: string | null;
  total_words: number | null;
  created_at: string | null;
  updated_at: string | null;
  page_count: number;
  code_count: number;
}

/** Sources with per-source page + code-example counts (for the RAG Docs view). */
export async function listSourcesDetailed(): Promise<{ ok: boolean; sources: KbSourceDetail[]; error?: string }> {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('kb_sources')
      .select('source_id, title, summary, total_words, created_at, updated_at')
      .order('updated_at', { ascending: false });
    if (error) return { ok: false, sources: [], error: error.message };
    const rows = (data ?? []) as Array<Omit<KbSourceDetail, 'page_count' | 'code_count'>>;
    // Count pages + code examples per source in parallel (scales with #sources, not #pages).
    const sources = await Promise.all(rows.map(async (s) => {
      const [pages, code] = await Promise.all([
        sb.from('kb_pages').select('*', { count: 'exact', head: true }).eq('source_id', s.source_id),
        sb.from('kb_code_examples').select('*', { count: 'exact', head: true }).eq('source_id', s.source_id),
      ]);
      return { ...s, page_count: pages.count ?? 0, code_count: code.count ?? 0 };
    }));
    return { ok: true, sources };
  } catch (err) {
    logger.warn('kb: listSourcesDetailed failed', { err: (err as Error).message });
    return { ok: false, sources: [], error: (err as Error).message };
  }
}

export interface KbPage {
  id: number;
  source_id: string;
  url: string;
  chunk_number: number;
  content: string;
  metadata: Record<string, unknown> | null;
  embedding_ready: boolean;
  created_at: string | null;
}

/** All indexed pages/chunks for one source, ordered by url then chunk. */
export async function listSourcePages(
  sourceId: string,
  opts?: { limit?: number; offset?: number },
): Promise<{ ok: boolean; pages: KbPage[]; total: number; error?: string }> {
  try {
    const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 1000);
    const offset = Math.max(opts?.offset ?? 0, 0);
    const sb = getSupabase();
    const { data, error, count } = await sb.from('kb_pages')
      .select('id, source_id, url, chunk_number, content, metadata, embedding, created_at', { count: 'exact' })
      .eq('source_id', sourceId)
      .order('url', { ascending: true })
      .order('chunk_number', { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) return { ok: false, pages: [], total: 0, error: error.message };
    const pages = (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as number,
      source_id: r.source_id as string,
      url: r.url as string,
      chunk_number: r.chunk_number as number,
      content: r.content as string,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      embedding_ready: r.embedding != null, // vector present ⇒ searchable
      created_at: (r.created_at as string | null) ?? null,
    }));
    return { ok: true, pages, total: count ?? pages.length };
  } catch (err) {
    logger.warn('kb: listSourcePages failed', { err: (err as Error).message });
    return { ok: false, pages: [], total: 0, error: (err as Error).message };
  }
}
