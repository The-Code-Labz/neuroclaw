// Uploaded-document RAG layer (spec: uploaded-document-handling-overhaul — RAG stage).
//
// Owner: Jibril (design) — implemented here against the live KB infra.
//
// Parsed document markdown is chunked ONCE at parse time, embedded, and written
// to neuroclaw_kb.doc_chunks (pgvector, 1536-dim, text-embedding-3-small — the
// SAME locked model the KB + memory use). Rows are anchored to attachment_id and
// carry NO reference to the raw bucket object / signed URL / TTL — so when the
// raw file expires at 24h, these embeddings SURVIVE. That decouple is the point.
//
// HARD CONTRACT: flag-gated (DOC_RAG_ENABLED — defaults ON when DOC_ARCHIVE_ENABLED
// is on, unless explicitly disabled). Every function fails SOFT: on any error it
// logs and returns a null/empty result. Chunk embedding is inline (the doc_chunks
// embedding column is NOT NULL, so we can't use the KB insert-then-embed-via-job
// pattern) but the caller fires this fire-and-forget AFTER parse returns, so it
// never blocks the stream-open hot path (per A.S.A.G.I's parse-budget review).

import { createHash } from 'crypto';
import { chunkMarkdown } from '../kb/kb-chunker';
import { embedKbText } from '../kb/kb-embeddings';
import { getSupabase } from '../db/supabase';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';
import { rerank, rerankEnabled } from './reranker';

const DOC_TABLE = 'doc_chunks';               // resolves against neuroclaw_kb (client schema binding)
const SEARCH_RPC = 'doc_chunks_search';
const MAX_TOKENS = 8000;                       // matches the CHECK constraint bound

// ── Retrieval tuning (spec: rag-quality-overhaul, Fix 1 + Fix 5) ─────────────
// Strict cosine floor applied to the FINAL output when rerank is OFF or has
// FAILED — this is the "today" quality bar and must never be relaxed on fallback.
const OUTPUT_MINSCORE = 0.30;
// Low floor used ONLY to gather a rich candidate pool for the reranker. Trusted
// solely when a rerank actually succeeds (ASAGI regression #1 — floor decoupling).
const CANDIDATE_MINSCORE = parseFloat(process.env.RAG_CANDIDATE_MINSCORE ?? '0.10');
// How many vector candidates to over-fetch to feed the cross-encoder.
const RERANK_CANDIDATES = parseInt(process.env.RAG_RERANK_CANDIDATES ?? '30', 10);
// Cross-encoder relevance floor (ms-marco logit; >0 ≈ relevant, <0 ≈ not). If the
// TOP reranked hit falls below this, the whole pool is judged irrelevant and we
// fall back to cosine ordering rather than surface the "least-bad" junk chunk.
// A/B-validated: real answers scored +1.7..+5.9, an unanswerable query scored
// all-negative and promoted a citation-list chunk without this guard.
const RERANK_MINSCORE = parseFloat(process.env.RAG_RERANK_MINSCORE ?? '0');

/** Stable per-chunk id for rerank round-tripping. */
function hitId(h: DocSearchHit): string { return `${h.attachmentId}#${h.chunkIndex}`; }

/**
 * Rerank a candidate pool best-first (fail-soft). Reusable by both single-doc and
 * notebook paths. On success, returns the reranked hits (score overwritten with
 * the cross-encoder logit — higher=better). On any failure, returns input order
 * with reranked:false so the caller can re-impose the strict output floor.
 */
export async function rerankHits(
  query: string, hits: DocSearchHit[], topK: number,
): Promise<{ hits: DocSearchHit[]; reranked: boolean }> {
  if (!rerankEnabled() || hits.length === 0) return { hits: hits.slice(0, topK), reranked: false };
  const byId = new Map(hits.map(h => [hitId(h), h]));
  const { items, reranked } = await rerank(query, hits.map(h => ({ id: hitId(h), text: h.content })), topK);
  if (!reranked) return { hits, reranked: false };
  const out: DocSearchHit[] = [];
  for (const it of items) {
    const h = byId.get(it.id);
    if (h) out.push({ ...h, score: it.score });
  }
  return { hits: out, reranked: true };
}

/**
 * Rerank-or-floor: the ASAGI regression #1 fix. When rerank is ON we've fetched a
 * rich low-floor pool; a SUCCESSFUL rerank re-orders it → keep topK. If rerank is
 * OFF or FAILS, we DO NOT trust the low candidate floor — re-apply the strict
 * OUTPUT floor + vector order so a reranker outage never leaks low-cosine junk.
 */
async function rerankOrFloor(query: string, candidates: DocSearchHit[], topK: number): Promise<DocSearchHit[]> {
  if (!rerankEnabled()) {
    // Candidates were already fetched at the strict floor → behaviour unchanged.
    return candidates.slice(0, topK);
  }
  const { hits, reranked } = await rerankHits(query, candidates, topK);
  if (reranked) {
    // hits[].score now carries the cross-encoder logit. Trust the rerank ordering
    // only when the TOP hit clears the relevance floor; otherwise the pool is weak
    // and cosine ordering is safer than a confidently-wrong rerank (A/B Q3).
    if (hits.length && hits[0].score >= RERANK_MINSCORE) return hits.slice(0, topK);
    logger.info('doc-rag: rerank low-confidence (top hit below floor) → cosine fallback', {
      topRerankScore: hits[0]?.score ?? null, floor: RERANK_MINSCORE,
    });
  }
  return candidates.filter(h => h.score >= OUTPUT_MINSCORE).sort((a, b) => b.score - a.score).slice(0, topK);
}

export function docRagEnabled(): boolean {
  // Off if explicitly disabled. Otherwise tracks the archive flag — RAG only
  // makes sense when documents are actually going through the bucket/parse path.
  if (process.env.DOC_RAG_ENABLED === 'false' || process.env.DOC_RAG_ENABLED === '0') return false;
  if (process.env.DOC_RAG_ENABLED === 'true' || process.env.DOC_RAG_ENABLED === '1') return true;
  return process.env.DOC_ARCHIVE_ENABLED === 'true' || process.env.DOC_ARCHIVE_ENABLED === '1';
}

/** sha256 hex of normalized chunk text — the embed-once dedup key. */
function chunkHash(text: string): string {
  const norm = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(norm).digest('hex');
}

/** Rough token estimate (~4 chars/token), clamped to the CHECK bound. */
function estimateTokens(text: string): number {
  return Math.min(MAX_TOKENS, Math.max(1, Math.ceil(text.length / 4)));
}

export interface DocEmbedResult {
  ok: boolean;
  chunks: number;
  embedded: number;
  skipped?: boolean;   // already embedded (idempotent re-parse) → no work done
  error?: string;
}

/**
 * Chunk + embed a parsed document ONCE and upsert into doc_chunks.
 *
 * Idempotent: if this attachment already has chunk rows, returns early (a
 * re-parse never re-embeds). UNIQUE(attachment_id, chunk_index) + onConflict
 * upsert makes a partial-then-retry safe. Fails soft — never throws to caller.
 */
export async function chunkAndEmbedDocument(input: {
  attachmentId: string;
  sessionId: string | null;
  markdown: string;
  agentId?: string | null;
}): Promise<DocEmbedResult> {
  try {
    if (!docRagEnabled()) return { ok: false, chunks: 0, embedded: 0, error: 'doc rag disabled' };
    const md = (input.markdown ?? '').trim();
    if (!md) return { ok: true, chunks: 0, embedded: 0 };

    const sb = getSupabase();
    const session = input.sessionId ?? 'orphan';

    // Idempotency guard: skip if this attachment is already embedded.
    const { count, error: cErr } = await sb
      .from(DOC_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('attachment_id', input.attachmentId);
    if (!cErr && (count ?? 0) > 0) {
      return { ok: true, chunks: count ?? 0, embedded: 0, skipped: true };
    }

    const chunks = chunkMarkdown(md);
    if (!chunks.length) return { ok: true, chunks: 0, embedded: 0 };

    let embedded = 0;
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i];
      const vector = await embedKbText(content);   // pinned 1536 / model-guarded; null on failure
      if (!vector) continue;                        // skip un-embeddable chunk; NOT NULL forbids a null row
      rows.push({
        attachment_id: input.attachmentId,
        session_id:    session,
        chunk_index:   i,
        content_hash:  chunkHash(content),
        content,
        token_count:   estimateTokens(content),
        embedding:     vector,
      });
      embedded++;
    }

    if (!rows.length) return { ok: false, chunks: chunks.length, embedded: 0, error: 'no chunks embedded' };

    const { error } = await sb.from(DOC_TABLE).upsert(rows, { onConflict: 'attachment_id,chunk_index' });
    if (error) return { ok: false, chunks: chunks.length, embedded: 0, error: error.message };

    logHive('kb_ingested', `doc-rag: embedded ${embedded}/${chunks.length} chunk(s) for attachment ${input.attachmentId}`,
            input.agentId ?? undefined, { attachmentId: input.attachmentId, chunks: chunks.length, embedded });
    return { ok: true, chunks: chunks.length, embedded };
  } catch (err) {
    logger.warn('doc-rag: chunkAndEmbedDocument failed (non-fatal)', {
      attachmentId: input.attachmentId, error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, chunks: 0, embedded: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface DocSearchHit {
  attachmentId: string;
  chunkIndex:   number;
  content:      string;
  tokenCount:   number;
  score:        number;
}

/**
 * Retrieve the top-K most relevant chunks for a query, scoped to a single
 * attachment (or a whole session). Embeds the query with the pinned model and
 * calls the cosine-KNN RPC. Fails soft — returns [] on any error.
 */
export async function searchDocument(input: {
  query: string;
  attachmentId?: string | null;
  sessionId?: string | null;
  topK?: number;
  minScore?: number;
}): Promise<DocSearchHit[]> {
  try {
    if (!docRagEnabled()) return [];
    if (!input.attachmentId && !input.sessionId) {
      logger.warn('doc-rag: searchDocument requires attachmentId or sessionId (scope guard)');
      return [];
    }
    const q = (input.query ?? '').trim();
    if (!q) return [];

    const vector = await embedKbText(q);
    if (!vector) return [];

    // Tuned topK only when rerank is on → byte-identical behaviour when off.
    const topK = input.topK ?? (rerankEnabled() ? 8 : 6);
    // Over-fetch a rich low-floor pool for rerank; strict floor otherwise.
    const candidateCount = rerankEnabled() ? Math.max(RERANK_CANDIDATES, topK) : topK;
    const candidateFloor = rerankEnabled() ? CANDIDATE_MINSCORE : (input.minScore ?? OUTPUT_MINSCORE);

    const { data, error } = await getSupabase().rpc(SEARCH_RPC, {
      q_embedding:  vector,
      q_attachment: input.attachmentId ?? null,
      q_session:    input.sessionId ?? null,
      q_topk:       candidateCount,
      q_minscore:   candidateFloor,
    });
    if (error) { logger.warn('doc-rag: searchDocument rpc failed', { error: error.message }); return []; }

    const candidates = (data as Array<Record<string, unknown>> ?? []).map(r => ({
      attachmentId: String(r.attachment_id),
      chunkIndex:   Number(r.chunk_index),
      content:      String(r.content),
      tokenCount:   Number(r.token_count),
      score:        Number(r.score),
    }));
    return rerankOrFloor(q, candidates, topK);
  } catch (err) {
    logger.warn('doc-rag: searchDocument failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

const SEARCH_NOTEBOOK_RPC = 'doc_chunks_search_notebook';

/**
 * Multi-document retrieval: cosine-KNN over ALL chunks belonging to a notebook
 * (spec: native-notebook-rag). Embeds the query with the pinned model and calls
 * the notebook-scoped RPC that joins doc_notebook_sources to doc_chunks. Fails
 * soft — returns [] on any error. doc_chunks itself is never modified.
 */
export async function searchNotebook(input: {
  query: string;
  notebookId: string;
  topK?: number;
  minScore?: number;
}): Promise<DocSearchHit[]> {
  try {
    if (!docRagEnabled()) return [];
    if (!input.notebookId) return [];
    const q = (input.query ?? '').trim();
    if (!q) return [];

    const topK = input.topK ?? (rerankEnabled() ? 12 : 10);
    const candidateCount = rerankEnabled() ? Math.max(RERANK_CANDIDATES, topK) : topK;
    const candidateFloor = rerankEnabled() ? CANDIDATE_MINSCORE : (input.minScore ?? OUTPUT_MINSCORE);

    const candidates = await notebookVectorFetch(q, input.notebookId, candidateCount, candidateFloor);
    return rerankOrFloor(q, candidates, topK);
  } catch (err) {
    logger.warn('doc-rag: searchNotebook failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Raw vector KNN over a notebook's chunks — NO rerank, NO diversity cap. Used by
 *  askNotebook so it can rerank the full candidate pool THEN apply the adaptive
 *  per-source cap (ASAGI regression #2 — over-fetch must feed the reranker). */
async function notebookVectorFetch(
  query: string, notebookId: string, limit: number, minScore: number,
): Promise<DocSearchHit[]> {
  const vector = await embedKbText(query);
  if (!vector) return [];
  const { data, error } = await getSupabase().rpc(SEARCH_NOTEBOOK_RPC, {
    q_embedding:   vector,
    q_notebook_id: notebookId,
    q_topk:        limit,
    q_minscore:    minScore,
  });
  if (error) { logger.warn('doc-rag: notebookVectorFetch rpc failed', { error: error.message }); return []; }
  return (data as Array<Record<string, unknown>> ?? []).map(r => ({
    attachmentId: String(r.attachment_id),
    chunkIndex:   Number(r.chunk_index),
    content:      String(r.content),
    tokenCount:   Number(r.token_count),
    score:        Number(r.score),
  }));
}

/** Public wrapper: raw notebook candidate pool for the ask path (rerank happens
 *  in askNotebook, before the adaptive diversity cap). Fail-soft → []. */
export async function retrieveNotebookCandidates(input: {
  query: string; notebookId: string; limit: number; minScore?: number;
}): Promise<DocSearchHit[]> {
  try {
    if (!docRagEnabled() || !input.notebookId) return [];
    const q = (input.query ?? '').trim();
    if (!q) return [];
    return notebookVectorFetch(q, input.notebookId, input.limit, input.minScore ?? OUTPUT_MINSCORE);
  } catch (err) {
    logger.warn('doc-rag: retrieveNotebookCandidates failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// Re-export for callers that need the low candidate floor / candidate count.
export const RAG_CANDIDATE_MINSCORE = CANDIDATE_MINSCORE;
export const RAG_RERANK_CANDIDATE_COUNT = RERANK_CANDIDATES;
export const RAG_OUTPUT_MINSCORE = OUTPUT_MINSCORE;
export const RAG_RERANK_MINSCORE = RERANK_MINSCORE;

/** Hard-delete all chunks for an attachment (e.g. session delete). Fails soft. */
export async function deleteDocChunks(attachmentId: string): Promise<void> {
  try {
    if (!docRagEnabled()) return;
    const { error } = await getSupabase().from(DOC_TABLE).delete().eq('attachment_id', attachmentId);
    if (error) logger.warn('doc-rag: deleteDocChunks failed', { attachmentId, error: error.message });
  } catch (err) {
    logger.warn('doc-rag: deleteDocChunks error (non-fatal)', {
      attachmentId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
