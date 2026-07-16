// Native Notebook / Collection RAG (spec: 2026-07-06-native-notebook-rag-design).
//
// Owner: Jibril (design) · Reviewer: A.S.A.G.I · implemented here against the
// dormant doc-handling overhaul (Stages 1–3) and the live KB infra.
//
// A "notebook" is a named collection of already-parsed+embedded documents. It
// replaces the external NotebookLM MCP server: create a notebook, add sources
// (uploaded attachments or URLs), then ask questions ACROSS all its documents
// with cited answers. This is built ENTIRELY on top of existing pieces —
//   • parse:  attachment-registry parseAttachment() → DocuFlow /parse/url
//   • embed:  doc-rag chunkAndEmbedDocument() → neuroclaw_kb.doc_chunks (1536)
//   • search: doc-rag searchNotebook() → doc_chunks_search_notebook RPC
// The ONLY new state is the notebook container + a join table (both in Supabase,
// so multi-doc retrieval is one RPC) and an ephemeral per-session active pointer
// (SQLite). doc_chunks is NEVER modified — single-doc RAG cannot regress.
//
// SCOPE (ASAGI §2): notebooks are GLOBAL in this single-operator deployment.
// session_id is provenance only, NOT an access-control gate — same as KB/memory.
// The attachment-ownership check on add_source STAYS (protects the ephemeral
// upload, not the notebook).
//
// HARD CONTRACT: flag-gated (DOC_NOTEBOOKS_ENABLED). Every function fails soft.

import { randomUUID } from 'crypto';
import { getSupabase } from '../db/supabase';
import { getActiveNotebook, setActiveNotebook } from '../db';
import { getAttachment, parseAttachment, registerAttachment } from './attachment-registry';
import {
  chunkAndEmbedDocument, retrieveNotebookCandidates, rerankHits, type DocSearchHit,
  RAG_CANDIDATE_MINSCORE, RAG_RERANK_CANDIDATE_COUNT, RAG_OUTPUT_MINSCORE, RAG_RERANK_MINSCORE,
} from './doc-rag';
import { rerankEnabled } from './reranker';
import { bgChatCompletion } from '../agent/openai-client';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';

const NB_TABLE  = 'doc_notebooks';
const SRC_TABLE = 'doc_notebook_sources';

// notebook_ask retrieval + synthesis tunables (§4.2, §6; rag-quality-overhaul Fix 5).
// Per-source cap is now a CEILING FOR MULTI-DOC notebooks only (adaptive) — a
// single/few-doc notebook uses the full topK so its answers aren't starved (D1).
const ASK_MAX_PER_DOC = parseInt(process.env.NOTEBOOK_ASK_MAX_PER_DOC ?? '3', 10); // 0 = no cap
// At/below this source count the per-source cap is disabled entirely.
const DIVERSITY_MIN_SOURCES = parseInt(process.env.NOTEBOOK_DIVERSITY_MIN_SOURCES ?? '2', 10);
const ASK_TIMEOUT_MS  = parseInt(process.env.NOTEBOOK_ASK_TIMEOUT ?? '120000', 10);
// URL-source ingestion caps.
const URL_FETCH_TIMEOUT_MS = parseInt(process.env.NOTEBOOK_URL_TIMEOUT ?? '20000', 10);
const URL_MAX_BYTES        = 50 * 1024 * 1024;

export function docNotebooksEnabled(): boolean {
  // Mirrors docRagEnabled()/docArchiveEnabled(). Independent flag, but notebooks
  // are meaningless unless docs are actually parsed+embedded (DOC_ARCHIVE/RAG).
  return process.env.DOC_NOTEBOOKS_ENABLED === 'true' || process.env.DOC_NOTEBOOKS_ENABLED === '1';
}

export interface NotebookRow {
  id: string; session_id: string; title: string;
  description: string | null; created_at: string; updated_at: string;
}
export interface NotebookSourceRow {
  notebook_id: string; attachment_id: string;
  source_title: string | null; source_kind: string | null; added_at: string;
}

interface Result<T> { ok: boolean; error?: string; data?: T }

// ── Notebook CRUD ──────────────────────────────────────────────────────────

export async function createNotebook(input: {
  sessionId: string | null; title: string; description?: string;
}): Promise<Result<NotebookRow>> {
  try {
    if (!docNotebooksEnabled()) return { ok: false, error: 'notebooks disabled' };
    const title = (input.title ?? '').trim();
    if (!title) return { ok: false, error: 'title required' };

    const now = new Date().toISOString();
    const row: NotebookRow = {
      id: randomUUID(),
      session_id: input.sessionId ?? 'orphan',
      title,
      description: (input.description ?? '').trim() || null,
      created_at: now,
      updated_at: now,
    };
    const { error } = await getSupabase().from(NB_TABLE).insert(row);
    if (error) return { ok: false, error: error.message };
    logHive('kb_ingested', `notebook: created "${title}"`, undefined, { notebookId: row.id });
    return { ok: true, data: row };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** GLOBAL list (ASAGI §2 — session not a filter). Includes source_count. */
export async function listNotebooks(): Promise<Result<Array<NotebookRow & { source_count: number }>>> {
  try {
    if (!docNotebooksEnabled()) return { ok: false, error: 'notebooks disabled' };
    const sb = getSupabase();
    const { data, error } = await sb.from(NB_TABLE).select('*').order('updated_at', { ascending: false });
    if (error) return { ok: false, error: error.message };
    const notebooks = (data as NotebookRow[]) ?? [];

    // Source counts, one grouped read.
    const counts = new Map<string, number>();
    const { data: srcRows } = await sb.from(SRC_TABLE).select('notebook_id');
    for (const r of (srcRows as Array<{ notebook_id: string }>) ?? []) {
      counts.set(r.notebook_id, (counts.get(r.notebook_id) ?? 0) + 1);
    }
    return { ok: true, data: notebooks.map(n => ({ ...n, source_count: counts.get(n.id) ?? 0 })) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getNotebook(notebookId: string): Promise<NotebookRow | null> {
  try {
    if (!docNotebooksEnabled() || !notebookId) return null;
    const { data, error } = await getSupabase().from(NB_TABLE).select('*').eq('id', notebookId).maybeSingle();
    if (error) return null;
    return (data as NotebookRow) ?? null;
  } catch { return null; }
}

/** Resolve an explicit notebook_id, else the session's active pointer. */
export async function resolveNotebookId(explicit: string | undefined, sessionId: string | null): Promise<string | null> {
  if (explicit?.trim()) return explicit.trim();
  if (sessionId) return getActiveNotebook(sessionId);
  return null;
}

export function useNotebook(sessionId: string | null, notebookId: string): void {
  if (sessionId) setActiveNotebook(sessionId, notebookId);
}

/**
 * Delete a notebook and its membership rows. doc_chunks are intentionally NOT
 * touched — parsed+embedded content persists for single-doc RAG and any other
 * notebook that references the same attachment (no-data-loss design, §2/§8).
 */
export async function deleteNotebook(notebookId: string): Promise<Result<{ id: string }>> {
  try {
    if (!docNotebooksEnabled()) return { ok: false, error: 'notebooks disabled' };
    if (!notebookId) return { ok: false, error: 'notebook_id required' };
    const sb = getSupabase();
    await sb.from(SRC_TABLE).delete().eq('notebook_id', notebookId);   // membership only
    const { error } = await sb.from(NB_TABLE).delete().eq('id', notebookId);
    if (error) return { ok: false, error: error.message };
    logHive('kb_ingested', `notebook: deleted ${notebookId}`, undefined, { notebookId });
    return { ok: true, data: { id: notebookId } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Sources ────────────────────────────────────────────────────────────────

export async function listNotebookSources(notebookId: string): Promise<Result<NotebookSourceRow[]>> {
  try {
    if (!docNotebooksEnabled()) return { ok: false, error: 'notebooks disabled' };
    if (!notebookId) return { ok: false, error: 'notebook_id required' };
    const { data, error } = await getSupabase()
      .from(SRC_TABLE).select('*').eq('notebook_id', notebookId).order('added_at', { ascending: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: (data as NotebookSourceRow[]) ?? [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Add a source (attachment_id OR https URL) to a notebook.
 * Ensures the doc is parsed AND embedded (ASAGI fix: explicit chunkAndEmbedDocument
 * — the parseViaBucket embed side-effect only fires when DOC_ARCHIVE is on), then
 * inserts the membership row. Attachment ownership is verified per-session (§8).
 */
export async function addNotebookSource(input: {
  notebookId: string;
  source: string;
  sessionId: string | null;
  agentId?: string | null;
}): Promise<Result<{ attachment_id: string; source_title: string | null; source_kind: string; embedded: { chunks: number; embedded: number } }>> {
  try {
    if (!docNotebooksEnabled()) return { ok: false, error: 'notebooks disabled' };
    const nb = await getNotebook(input.notebookId);
    if (!nb) return { ok: false, error: `notebook "${input.notebookId}" not found` };

    const raw = (input.source ?? '').trim();
    if (!raw) return { ok: false, error: 'source required (attachment_id or URL)' };

    let attachmentId: string;
    let sourceKind: 'file' | 'url';

    if (/^https?:\/\//i.test(raw)) {
      if (/youtube\.com|youtu\.be/i.test(raw)) {
        return { ok: false, error: 'YouTube URLs are not parsable in v1 — extract a transcript to a .txt attachment first, then add that.' };
      }
      const fetched = await fetchUrlSource(raw);
      if (!fetched.ok || !fetched.data) return { ok: false, error: fetched.error ?? 'url fetch failed' };
      const reg = registerAttachment({
        sessionId: input.sessionId ?? 'orphan',
        name: fetched.data.name,
        data: fetched.data.base64,
        mime: fetched.data.mime,
      });
      if (!reg.ok) return { ok: false, error: `url register failed: ${reg.error}` };
      attachmentId = reg.descriptor.id;
      sourceKind = 'url';
    } else {
      // attachment_id path — verify ownership (protects the ephemeral upload).
      const rec = getAttachment(raw);
      if (!rec) return { ok: false, error: `no attachment "${raw}" — it may have expired or never existed` };
      if (input.sessionId && rec.sessionId !== input.sessionId) {
        return { ok: false, error: 'attachment belongs to a different session' };
      }
      attachmentId = rec.id;
      sourceKind = 'file';
    }

    // Ensure parsed markdown exists.
    const parsed = await parseAttachment(attachmentId);
    if (parsed !== 'ok') {
      const rec = getAttachment(attachmentId);
      return { ok: false, error: `document could not be parsed${rec?.parseError ? `: ${rec.parseError}` : ''}` };
    }
    const rec = getAttachment(attachmentId);
    const markdown = rec?.parsedContent?.markdown ?? '';
    const title = rec?.parsedContent?.title || rec?.name || null;

    // Ensure chunks exist — explicit + idempotent (ASAGI §5.1).
    const embed = await chunkAndEmbedDocument({
      attachmentId, sessionId: input.sessionId, markdown, agentId: input.agentId,
    });
    if (!embed.ok && !embed.skipped) {
      return { ok: false, error: `embedding failed: ${embed.error ?? 'unknown'}` };
    }

    // Insert membership (idempotent — PK (notebook_id, attachment_id)).
    const { error } = await getSupabase().from(SRC_TABLE).upsert({
      notebook_id: input.notebookId,
      attachment_id: attachmentId,
      source_title: title,
      source_kind: sourceKind,
      added_at: new Date().toISOString(),
    }, { onConflict: 'notebook_id,attachment_id' });
    if (error) return { ok: false, error: error.message };

    // Bump notebook updated_at.
    await getSupabase().from(NB_TABLE).update({ updated_at: new Date().toISOString() }).eq('id', input.notebookId);

    logHive('kb_ingested', `notebook: added source "${title ?? attachmentId}"`, input.agentId ?? undefined,
            { notebookId: input.notebookId, attachmentId, chunks: embed.chunks });
    return {
      ok: true,
      data: { attachment_id: attachmentId, source_title: title, source_kind: sourceKind,
              embedded: { chunks: embed.chunks, embedded: embed.embedded } },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchUrlSource(url: string): Promise<Result<{ name: string; mime: string; base64: string }>> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS), redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `url HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { ok: false, error: 'empty url response' };
    if (buf.length > URL_MAX_BYTES) return { ok: false, error: 'url content too large' };
    const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
    // Derive a filename with a supported extension so the registry accepts it.
    let name = url.split('/').pop()?.split('?')[0] || 'source';
    if (!/\.[a-z0-9]{1,6}$/i.test(name)) {
      const ext = mime.includes('pdf') ? 'pdf'
        : mime.includes('html') ? 'html'
        : mime.includes('markdown') ? 'md'
        : 'txt';
      name = `${name}.${ext}`;
    }
    return { ok: true, data: { name, mime, base64: buf.toString('base64') } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── notebook_ask (multi-doc retrieval + cited synthesis) ────────────────────

export interface NotebookAnswer {
  ok: boolean;
  answer?: string;
  citations?: Array<{ title: string; attachment_id: string; chunks_used: number }>;
  retrieved_chunks?: number;
  error?: string;
}

export async function askNotebook(input: {
  notebookId: string;
  question: string;
  topK?: number;
}): Promise<NotebookAnswer> {
  try {
    if (!docNotebooksEnabled()) return { ok: false, error: 'notebooks disabled' };
    const nb = await getNotebook(input.notebookId);
    if (!nb) return { ok: false, error: `notebook "${input.notebookId}" not found` };
    const question = (input.question ?? '').trim();
    if (!question) return { ok: false, error: 'question required' };

    const topK = input.topK ?? (rerankEnabled() ? 12 : 10);

    // 1) Over-fetch a candidate pool. When rerank is ON we pull a rich low-floor
    //    pool (ASAGI regression #2 — the over-fetch must feed the reranker, not a
    //    stale topK*2); when OFF, keep the prior topK*2 strict-floor behaviour.
    const candidateCount = rerankEnabled() ? Math.max(RAG_RERANK_CANDIDATE_COUNT, topK * 2) : topK * 2;
    const candidateFloor = rerankEnabled() ? RAG_CANDIDATE_MINSCORE : RAG_OUTPUT_MINSCORE;
    const pool = await retrieveNotebookCandidates({
      query: question, notebookId: input.notebookId, limit: candidateCount, minScore: candidateFloor,
    });
    if (!pool.length) {
      return { ok: true, answer: 'No relevant passages were found in this notebook for that question.', citations: [], retrieved_chunks: 0 };
    }

    // 2) Rerank the WHOLE pool (relevance) before capping. On fallback, re-impose
    //    the strict output floor so a reranker outage never leaks low-cosine junk.
    let ranked: DocSearchHit[];
    if (rerankEnabled()) {
      const r = await rerankHits(question, pool, pool.length);
      const cosineFallback = () => pool.filter(h => h.score >= RAG_OUTPUT_MINSCORE).sort((a, b) => b.score - a.score);
      // Trust rerank ordering only when the top hit clears the relevance floor;
      // an all-negative pool (docs can't answer the question) falls back to cosine
      // rather than surfacing a confidently-wrong "least-bad" chunk (A/B Q3).
      ranked = (r.reranked && r.hits.length && r.hits[0].score >= RAG_RERANK_MINSCORE)
        ? r.hits
        : cosineFallback();
    } else {
      ranked = pool;
    }
    if (!ranked.length) {
      return { ok: true, answer: 'No relevant passages were found in this notebook for that question.', citations: [], retrieved_chunks: 0 };
    }

    // 3) Adaptive per-source cap → truncate to topK.
    const sourceCount = new Set(ranked.map(h => h.attachmentId)).size;
    const hits = applyDiversityCap(ranked, topK, sourceCount);

    // Source titles for citation (join membership).
    const srcRes = await listNotebookSources(input.notebookId);
    const titleById = new Map<string, string>();
    for (const s of srcRes.data ?? []) titleById.set(s.attachment_id, s.source_title || s.attachment_id);

    // Build cited context block.
    const blocks = hits.map(h => {
      const title = titleById.get(h.attachmentId) ?? h.attachmentId;
      return `[Source: "${title}" (attachment_id: ${h.attachmentId})]\n${h.content}`;
    }).join('\n\n');

    const system = 'You answer questions strictly from the provided document excerpts. '
      + 'Cite sources inline by their title (e.g. According to "Annual Report 2025", ...). '
      + 'If the excerpts do not contain the answer, say so plainly. Do not invent facts or sources.';
    const user = `Question: ${question}\n\nExcerpts:\n${blocks}`;

    const completion = await Promise.race([
      bgChatCompletion(
        { model: 'x', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 1200 },
        { label: 'notebook_ask' },
      ),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('notebook_ask synthesis timed out')), ASK_TIMEOUT_MS)),
    ]);
    const answer = completion.choices?.[0]?.message?.content?.trim() || '(no answer generated)';

    // Citation summary — count chunks used per source.
    const used = new Map<string, number>();
    for (const h of hits) used.set(h.attachmentId, (used.get(h.attachmentId) ?? 0) + 1);
    const citations = [...used.entries()].map(([attachment_id, chunks_used]) => ({
      title: titleById.get(attachment_id) ?? attachment_id, attachment_id, chunks_used,
    }));

    return { ok: true, answer, citations, retrieved_chunks: hits.length };
  } catch (err) {
    logger.warn('doc-notebooks: askNotebook failed', { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Adaptive per-source diversity cap (rag-quality-overhaul D1/Fix 5).
 *
 * `hits` arrive ALREADY RANKED (rerank order, else vector order) — this preserves
 * that order rather than re-sorting on the (now cross-encoder) score.
 *
 * - single/few-doc notebooks (sourceCount ≤ DIVERSITY_MIN_SOURCES) → NO cap, use
 *   the full topK (fixes the "≤3 chunks total" starvation on 1-source notebooks).
 * - genuinely multi-doc notebooks → cap per source, scaled so topK is filled
 *   fairly: max(ceil(topK / sourceCount), ASK_MAX_PER_DOC).
 */
function applyDiversityCap(hits: DocSearchHit[], topK: number, sourceCount: number): DocSearchHit[] {
  if (ASK_MAX_PER_DOC <= 0 || sourceCount <= DIVERSITY_MIN_SOURCES) return hits.slice(0, topK);
  const maxPerDoc = Math.max(Math.ceil(topK / sourceCount), ASK_MAX_PER_DOC);
  const perDoc = new Map<string, number>();
  const kept: DocSearchHit[] = [];
  for (const h of hits) {                       // preserve incoming ranked order
    const n = perDoc.get(h.attachmentId) ?? 0;
    if (n >= maxPerDoc) continue;
    perDoc.set(h.attachmentId, n + 1);
    kept.push(h);
  }
  return kept.slice(0, topK);
}
