import { config } from '../config';
import { logger } from '../utils/logger';
import { callTool } from '../mcp/mcp-client';
import { searchMemoryIndex, touchMemoryAccess, listEmbeddedMemoryIndex, type MemoryIndexRow } from './memory-service';
import { embedText, unpackVector, cosine } from './embeddings';
import { vaultSearch } from './vault-client';
import { rankScore, clamp01 } from './memory-scorer';

// ── Types ────────────────────────────────────────────────────────────────────

export type RetrievalSource = 'sqlite' | 'vault' | 'researchlm' | 'insightslm';

export interface RetrievalHit {
  source:   RetrievalSource;
  type:     string;             // memory type for sqlite, content type for others
  title:    string;
  summary:  string;
  score:    number;             // composite 0–1
  agent_id?: string | null;
  vault_path?: string | null;
  memory_id?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw:      any;
}

export interface RetrieveOptions {
  query:     string;
  limit?:    number;            // overall cap, default 20
  agentId?:  string | null;
  sessionId?: string | null;
  includeVault?:      boolean;  // default: config.mcp.enabled
  includeResearchLM?: boolean;  // default: !!config.mcp.researchlmUrl
  includeInsightsLM?: boolean;  // default: !!config.mcp.insightslmUrl
}

export interface CategorizedRetrieval {
  query:       string;
  total:       number;
  memory:      RetrievalHit[];     // episodic + semantic + working
  procedures:  RetrievalHit[];     // procedural
  insights:    RetrievalHit[];     // insight + semantic-as-rule
  preferences: RetrievalHit[];     // preference
  raw:         RetrievalHit[];     // full ranked list
}

// ── Source: SQLite memory_index ──────────────────────────────────────────────

function rowToHit(r: MemoryIndexRow, scoreOverride?: number): RetrievalHit {
  return {
    source:    'sqlite',
    type:      r.type,
    title:     r.title,
    summary:   r.summary ?? '',
    score:     scoreOverride ?? rankScore({
      salience:      r.salience,
      importance:    r.importance,
      created_at:    r.created_at,
      last_accessed: r.last_accessed,
    }),
    agent_id:   r.agent_id,
    vault_path: r.vault_note_id,
    memory_id:  r.id,
    raw:        r,
  };
}

/**
 * Two-pass SQLite search:
 *   1. Embeddings pass — cosine over rows with stored vectors. High-quality,
 *      catches paraphrases/synonyms the lexical pass misses.
 *   2. Lexical pass — title/summary/tags LIKE %query%. Catches exact-phrase
 *      hits and rows from before embeddings were enabled.
 * Results are merged (lexical hits not already in the vector set are kept)
 * and de-duplicated by memory id.
 */
async function searchSqlite(query: string, limit: number): Promise<RetrievalHit[]> {
  const merged = new Map<string, RetrievalHit>();

  // Pass 1: vector search. Embeds the query, scores the candidate set,
  // promotes rows with cosine ≥ 0.30 (below that the match is usually noise).
  const queryEmb = await embedText(query);
  if (queryEmb) {
    const rows = listEmbeddedMemoryIndex({ limit: 400 });
    const scored: Array<{ row: MemoryIndexRow; score: number }> = [];
    for (const r of rows) {
      const vec = unpackVector(r.embedding ?? null);
      if (!vec) continue;
      const sim = cosine(queryEmb.vector, vec);
      if (sim >= 0.30) scored.push({ row: r, score: sim });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const { row, score } of scored.slice(0, limit)) {
      // Blend cosine with the existing salience/importance/recency rank so
      // semantically-close-but-stale memories don't always beat fresher rows.
      const baseline = rankScore({ salience: row.salience, importance: row.importance, created_at: row.created_at, last_accessed: row.last_accessed });
      const blended  = 0.6 * score + 0.4 * baseline;
      merged.set(row.id, rowToHit(row, blended));
    }
  }

  // Pass 2: lexical fallback. Adds rows that don't have embeddings (legacy
  // and below-min-chars rows) plus exact-phrase hits the vector pass missed.
  const lexical = searchMemoryIndex(query, limit);
  for (const r of lexical) {
    if (!merged.has(r.id)) merged.set(r.id, rowToHit(r));
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Source: NeuroVault MCP search ────────────────────────────────────────────

/**
 * Sanitize a memory query before sending it to the NeuroVault MCP. The vault
 * MCP backs onto Supabase's PostgREST `or=(...ilike.%X%)` filter syntax,
 * which fails to parse when the query contains commas, brackets, parens,
 * newlines, or unbalanced quotes — exactly the chars we end up with when
 * augmenting messages with image descriptions like `[Image 1 "x": ...]`.
 *
 * Strip those, collapse whitespace, and cap length so a multi-paragraph
 * augmented message becomes a tight keyword-y query that still surfaces
 * semantically related vault notes.
 */
function sanitizeVaultQuery(raw: string): string {
  return raw
    .replace(/[\[\]\(\)"'`*\\]/g, ' ')   // remove filter-syntax-breaking chars
    .replace(/[,;]/g, ' ')                // commas/semicolons split filter clauses
    .replace(/\s+/g, ' ')                 // collapse whitespace + newlines
    .trim()
    .slice(0, 240);                       // PostgREST URL has a length cap; keep it tight
}

async function searchVault(query: string, limit: number): Promise<RetrievalHit[]> {
  if (!config.mcp.enabled || !config.mcp.neurovaultUrl) return [];
  const sanitized = sanitizeVaultQuery(query);
  if (!sanitized || sanitized.length < 2) return [];
  try {
    const results = await vaultSearch({ query: sanitized, limit });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return results.map((item: any): RetrievalHit => {
      const title = String(item?.title ?? item?.filename ?? item?.path ?? 'untitled').slice(0, 120);
      const summary = String(item?.summary ?? item?.snippet ?? item?.excerpt ?? '').slice(0, 400);
      const type = String(item?.type ?? inferTypeFromPath(item?.path) ?? 'episodic');
      // Vault hits don't carry our salience/importance — give them a moderate
      // baseline that lets fresh memorable content compete with stale SQLite rows.
      const baseScore = clamp01(typeof item?.score === 'number' ? item.score : 0.55);
      return {
        source:    'vault',
        type,
        title,
        summary,
        score:     baseScore,
        vault_path: item?.path ?? item?.note_id ?? null,
        raw:        item,
      };
    });
  } catch (err) {
    logger.warn('memory-retriever: vault search failed', { error: (err as Error).message });
    return [];
  }
}

function inferTypeFromPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const seg = p.split('/')[0]?.toLowerCase();
  switch (seg) {
    case 'procedures': return 'procedural';
    case 'projects':   return 'project';
    case 'agents':     return 'preference';
    case 'logs':       return 'episodic';
    case 'insights':   return 'insight';
    default:           return undefined;
  }
}

// ── Source: ResearchLM / InsightsLM (best-effort, optional) ──────────────────
// Fan-out is OFF unless the user names a tool that actually exists on the
// configured server. We cache "tool not found" per (url, tool) so the warning
// only fires once instead of every retrieve.

const toolNotFoundCache = new Set<string>();

async function searchExternalMcp(url: string, toolName: string | '', query: string, limit: number, source: RetrievalSource): Promise<RetrievalHit[]> {
  if (!url || !toolName) return [];                 // not configured
  const key = `${url}::${toolName}`;
  if (toolNotFoundCache.has(key)) return [];        // already known broken — silent skip

  try {
    // We send several common arg shapes so the same setting works for
    // search-shaped tools (`{ query, limit }`), QA-shaped tools (`{ q }`),
    // and rag_chat-shaped tools (`{ message, notebook_id? }`).
    const result = await callTool(url, toolName, { query, q: query, message: query, limit });
    if (!result) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = Array.isArray(result) ? result :
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Array.isArray((result as any).results) ? (result as any).results :
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Array.isArray((result as any).items) ? (result as any).items :
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Array.isArray((result as any).sources) ? (result as any).sources :
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Array.isArray((result as any).matches) ? (result as any).matches : []))));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return items.slice(0, limit).map((item: any): RetrievalHit => ({
      source,
      type:    String(item?.type ?? 'reference'),
      title:   String(item?.title ?? item?.name ?? item?.heading ?? 'untitled').slice(0, 120),
      summary: String(item?.summary ?? item?.snippet ?? item?.text ?? item?.content ?? '').slice(0, 400),
      score:   clamp01(typeof item?.score === 'number' ? item.score : 0.5),
      raw:     item,
    }));
  } catch (err) {
    const msg = (err as Error).message;
    // Permanently disable on "Tool not found" so every retrieve doesn't spam.
    if (/Tool not found/i.test(msg) || /-32601/.test(msg) || /-32603/.test(msg)) {
      toolNotFoundCache.add(key);
      logger.warn(`memory-retriever: ${source} tool '${toolName}' not found on server — fan-out disabled until restart`, { url });
    } else {
      logger.warn(`memory-retriever: ${source} search failed`, { error: msg });
    }
    return [];
  }
}

// ── Public retrieve() ────────────────────────────────────────────────────────

export async function retrieve(opts: RetrieveOptions): Promise<CategorizedRetrieval> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const includeVault      = opts.includeVault      ?? config.mcp.enabled;
  // Only fan out to the optional knowledge MCPs when BOTH the URL and the
  // search-tool name are configured. Without a tool name we have no way to
  // know what to call, so silent-skip is correct.
  const includeResearchLM = opts.includeResearchLM ?? !!(config.mcp.researchlmUrl && config.mcp.researchlmSearchTool);
  const includeInsightsLM = opts.includeInsightsLM ?? !!(config.mcp.insightslmUrl && config.mcp.insightslmSearchTool);

  const tasks: Promise<RetrievalHit[]>[] = [
    searchSqlite(opts.query, limit),
  ];
  if (includeVault)      tasks.push(searchVault(opts.query, limit));
  if (includeResearchLM) tasks.push(searchExternalMcp(config.mcp.researchlmUrl, config.mcp.researchlmSearchTool, opts.query, limit, 'researchlm'));
  if (includeInsightsLM) tasks.push(searchExternalMcp(config.mcp.insightslmUrl, config.mcp.insightslmSearchTool, opts.query, limit, 'insightslm'));

  const groups = await Promise.all(tasks);
  const merged: RetrievalHit[] = ([] as RetrievalHit[]).concat(...groups);

  // De-duplicate by vault_path|title (keep highest score).
  const dedup = new Map<string, RetrievalHit>();
  for (const hit of merged) {
    const key = (hit.vault_path ?? '') + '||' + hit.title.toLowerCase();
    const existing = dedup.get(key);
    if (!existing || existing.score < hit.score) dedup.set(key, hit);
  }
  const ranked = Array.from(dedup.values()).sort((a, b) => b.score - a.score).slice(0, limit);

  // Touch salience for SQLite hits we're returning (best-effort).
  for (const hit of ranked) {
    if (hit.source === 'sqlite' && hit.memory_id) {
      try { touchMemoryAccess(hit.memory_id); } catch { /* best-effort */ }
    }
  }

  return categorize(opts.query, ranked);
}

function categorize(query: string, ranked: RetrievalHit[]): CategorizedRetrieval {
  const memory:      RetrievalHit[] = [];
  const procedures:  RetrievalHit[] = [];
  const insights:    RetrievalHit[] = [];
  const preferences: RetrievalHit[] = [];
  for (const h of ranked) {
    switch (h.type) {
      case 'procedural':
      case 'procedure':
        procedures.push(h); break;
      case 'insight':
      case 'semantic':
        insights.push(h); break;
      case 'preference':
        preferences.push(h); break;
      default:
        memory.push(h);
    }
  }
  return { query, total: ranked.length, memory, procedures, insights, preferences, raw: ranked };
}
