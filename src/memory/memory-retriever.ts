import { config } from '../config';
import { logger } from '../utils/logger';
import { callTool } from '../mcp/mcp-client';
import { searchMemoryIndex, touchMemoryAccess, type MemoryIndexRow } from './memory-service';
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

function searchSqlite(query: string, limit: number): RetrievalHit[] {
  const rows: MemoryIndexRow[] = searchMemoryIndex(query, limit);
  return rows.map(r => ({
    source:    'sqlite',
    type:      r.type,
    title:     r.title,
    summary:   r.summary ?? '',
    score:     rankScore({
      salience:      r.salience,
      importance:    r.importance,
      created_at:    r.created_at,
      last_accessed: r.last_accessed,
    }),
    agent_id:   r.agent_id,
    vault_path: r.vault_note_id,
    memory_id:  r.id,
    raw:        r,
  }));
}

// ── Source: NeuroVault MCP search ────────────────────────────────────────────

async function searchVault(query: string, limit: number): Promise<RetrievalHit[]> {
  if (!config.mcp.enabled || !config.mcp.neurovaultUrl) return [];
  try {
    const results = await vaultSearch({ query, limit });
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

async function searchExternalMcp(url: string, toolName: string, query: string, limit: number, source: RetrievalSource): Promise<RetrievalHit[]> {
  try {
    const result = await callTool(url, toolName, { query, q: query, limit });
    if (!result) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = Array.isArray(result) ? result :
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Array.isArray((result as any).results) ? (result as any).results :
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Array.isArray((result as any).items) ? (result as any).items : []));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return items.slice(0, limit).map((item: any): RetrievalHit => ({
      source,
      type:    String(item?.type ?? 'reference'),
      title:   String(item?.title ?? item?.name ?? 'untitled').slice(0, 120),
      summary: String(item?.summary ?? item?.snippet ?? item?.text ?? '').slice(0, 400),
      score:   clamp01(typeof item?.score === 'number' ? item.score : 0.5),
      raw:     item,
    }));
  } catch (err) {
    logger.warn(`memory-retriever: ${source} search failed`, { error: (err as Error).message });
    return [];
  }
}

// ── Public retrieve() ────────────────────────────────────────────────────────

export async function retrieve(opts: RetrieveOptions): Promise<CategorizedRetrieval> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const includeVault      = opts.includeVault      ?? config.mcp.enabled;
  const includeResearchLM = opts.includeResearchLM ?? !!config.mcp.researchlmUrl;
  const includeInsightsLM = opts.includeInsightsLM ?? !!config.mcp.insightslmUrl;

  const tasks: Promise<RetrievalHit[]>[] = [
    Promise.resolve(searchSqlite(opts.query, limit)),
  ];
  if (includeVault)      tasks.push(searchVault(opts.query, limit));
  if (includeResearchLM) tasks.push(searchExternalMcp(config.mcp.researchlmUrl, 'researchlm_search', opts.query, limit, 'researchlm'));
  if (includeInsightsLM) tasks.push(searchExternalMcp(config.mcp.insightslmUrl, 'insightslm_search_sources', opts.query, limit, 'insightslm'));

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
