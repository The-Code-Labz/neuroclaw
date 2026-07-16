// Cross-encoder reranker client (spec: rag-quality-overhaul — Fix 1).
//
// A self-hosted cross-encoder (ms-marco-MiniLM-L6-v2) rescoring stage that runs
// on top of vector/hybrid retrieval: over-fetch N candidates by embedding
// similarity, then let the cross-encoder re-order them by ACTUAL relevance to the
// query (vector similarity ≈ "same topic"; cross-encoder ≈ "answers this query").
//
// Service:  POST {RAG_RERANK_URL}/rerank  {query, memories: string[], top_k}
//           → [{text, score}]  (sorted best-first; score is a logit, higher=better)
//           GET  /health  → 200 liveness
//
// HARD CONTRACT: fail-soft in EVERY path. Disabled / down / timeout / malformed
// response → returns the input order unchanged with reranked:false, so the caller
// can decide whether to trust the low-floor candidate pool or re-apply a strict
// floor. NEVER throws. A 60s negative-cache avoids hammering a down service.

import { logger } from '../utils/logger';

export interface RerankItem { id: string; text: string }
export interface RerankOutcome { items: Array<{ id: string; score: number }>; reranked: boolean }

const DEFAULT_URL = 'http://100.89.249.230:8001';
const HEALTH_TTL_MS = 60_000;

let healthCache: { ok: boolean; ts: number } | null = null;

export function rerankEnabled(): boolean {
  return process.env.RAG_RERANK_ENABLED === 'true' || process.env.RAG_RERANK_ENABLED === '1';
}

function baseUrl(): string {
  return (process.env.RAG_RERANK_URL || DEFAULT_URL).trim().replace(/\/+$/, '');
}

function timeoutMs(): number {
  return parseInt(process.env.RAG_RERANK_TIMEOUT_MS ?? '4000', 10);
}

/** Cached /health probe (60s TTL). Fail-soft: unreachable → false → passthrough. */
async function healthy(): Promise<boolean> {
  const now = Date.now();
  if (healthCache && now - healthCache.ts < HEALTH_TTL_MS) return healthCache.ok;
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(2000) });
    const ok = res.ok;
    healthCache = { ok, ts: now };
    if (!ok) logger.warn('reranker: /health non-200, disabling rerank until TTL', { status: res.status });
    return ok;
  } catch (err) {
    healthCache = { ok: false, ts: now };
    logger.warn('reranker: /health unreachable, disabling rerank until TTL', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Rerank candidate items best-first via the cross-encoder.
 *
 * @returns { items, reranked } where reranked=true ONLY if the service actually
 *   rescored. On any failure returns the input order (reranked:false) so the
 *   caller knows NOT to trust a lowered candidate floor.
 *
 * Duplicate-text handling (ASAGI Q3): identical texts map back to ids via a FIFO
 * queue so we never mis-assign; if the service returns a text we can't match, it
 * is skipped rather than guessed.
 */
export async function rerank(query: string, items: RerankItem[], topK: number): Promise<RerankOutcome> {
  const passthrough = (): RerankOutcome => ({
    items: items.slice(0, topK).map(i => ({ id: i.id, score: 0 })),
    reranked: false,
  });
  try {
    const q = (query ?? '').trim();
    if (!rerankEnabled() || items.length === 0 || !q) return passthrough();
    if (!(await healthy())) return passthrough();

    const res = await fetch(`${baseUrl()}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, memories: items.map(i => i.text), top_k: Math.min(topK, items.length) }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!res.ok) { logger.warn('reranker: /rerank non-200, fallback', { status: res.status }); return passthrough(); }

    const data = await res.json() as Array<{ text?: string; score?: number }>;
    if (!Array.isArray(data) || !data.length) return passthrough();

    // text → FIFO queue of ids (handles duplicate chunk texts deterministically).
    const byText = new Map<string, string[]>();
    for (const it of items) {
      const arr = byText.get(it.text);
      if (arr) arr.push(it.id); else byText.set(it.text, [it.id]);
    }

    const out: Array<{ id: string; score: number }> = [];
    for (const d of data) {
      if (typeof d?.text !== 'string') continue;
      const ids = byText.get(d.text);
      if (ids && ids.length) out.push({ id: ids.shift()!, score: Number(d.score ?? 0) });
    }
    if (!out.length) return passthrough();
    return { items: out.slice(0, topK), reranked: true };
  } catch (err) {
    logger.warn('reranker: rerank failed (non-fatal, fallback to vector order)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return passthrough();
  }
}
