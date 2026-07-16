import { bgChatCompletion } from '../agent/openai-client';
import { config } from '../config';
import { logger } from '../utils/logger';
import { indexMemory } from '../memory/memory-service';

const THROTTLE_N = 5;
const VALID_DIMENSIONS = new Set(['preference', 'domain', 'pattern', 'goal']);

let contextCache: string = '';
let contextCacheAt: number = 0;
const CONTEXT_CACHE_TTL_MS = 2000;
const turnCounters = new Map<string, number>();

const INJECTION_PATTERNS = [
  /\bignore\b/i, /\bdisregard\b/i, /\byou are\b/i,
  /\byour role\b/i, /^assistant:/i, /^system:/i,
];

function sanitize(text: string): string {
  return text
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      return trimmed.length > 0 &&
        !trimmed.startsWith('```') &&
        !INJECTION_PATTERNS.some(p => p.test(trimmed));
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface UserDimension {
  dimension: 'preference' | 'domain' | 'pattern' | 'goal';
  value:     string;
}

export interface UserProfilerInput {
  sessionId:     string;
  agentId?:      string;
  userText:      string;
  assistantText: string;
}

export async function update(input: UserProfilerInput): Promise<void> {
  try {
    const count = (turnCounters.get(input.sessionId) ?? 0) + 1;
    turnCounters.set(input.sessionId, count);
    if (count % THROTTLE_N !== 0) return;

    const model = config.voidai.decomposerModel ?? config.voidai.model;
    let dimensions: UserDimension[] = [];
    try {
      const resp = await bgChatCompletion({
        model,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Extract observable user characteristics from this exchange. ' +
              'Output JSON: { "dimensions": [ { "dimension": "preference"|"domain"|"pattern"|"goal", "value": "short factual statement" } ] }. ' +
              'Max 4 items. Only clear, observable facts. Empty array if nothing notable.',
          },
          {
            role: 'user',
            content: `User: ${input.userText.slice(0, 600)}\nAssistant: ${input.assistantText.slice(0, 600)}`,
          },
        ],
        temperature: 0.2,
      }, { label: 'user-profiler', preferGemini: true });
      const raw = resp.choices[0]?.message?.content ?? '{}';
      dimensions = (JSON.parse(raw) as { dimensions?: UserDimension[] }).dimensions ?? [];
    } catch (err) {
      logger.debug('user-profiler: extraction failed', { error: String(err) });
      return;
    }

    for (const d of dimensions.slice(0, 4)) {
      if (!d.value?.trim()) continue;
      if (!VALID_DIMENSIONS.has(d.dimension)) continue;
      try {
        await indexMemory({
          type:       'user_model',
          title:      `[${d.dimension}] ${d.value.slice(0, 100)}`,
          summary:    d.value,
          tags:       [d.dimension],
          importance: 0.6,
          salience:   0.7,
          agent_id:   input.agentId ?? null,
          session_id: input.sessionId,
        });
      } catch (err) {
        logger.debug('user-profiler: indexMemory failed', { error: String(err) });
      }
    }
  } catch (err) {
    logger.debug('user-profiler: update failed', { error: String(err) });
  }
}

let contextRefreshing = false;

// Refresh the cached user-context string from the active memory store. Routed
// through the store (not raw memory_index SQL) so it reads the correct backend
// after the Supabase cutover. The store orders by recency rather than salience,
// which is acceptable for the small user_model set surfaced here.
async function refreshContext(): Promise<void> {
  if (contextRefreshing) return;
  contextRefreshing = true;
  try {
    const { getMemoryStore } = await import('../memory/memory-store');
    const rows = await (await getMemoryStore()).listMemoryIndex({ type: 'user_model', limit: 8 });
    const facts = rows
      .map(r => sanitize(r.summary ?? r.title))
      .filter(Boolean)
      .slice(0, 5)
      .join('. ');
    contextCache = facts ? `\n\n---\nUser context: ${facts}` : '';
    contextCacheAt = Date.now();
  } catch (err) {
    logger.debug('user-profiler: getContext refresh failed', { error: String(err) });
  } finally {
    contextRefreshing = false;
  }
}

// Synchronous accessor used in hot prompt-building paths. Returns the cached
// context immediately; when stale, kicks off a background refresh (fire-and-
// forget) so the next call picks up fresh facts. Matches the prior TTL-cache
// staleness tolerance.
export function getContext(): string {
  const now = Date.now();
  if (now - contextCacheAt >= CONTEXT_CACHE_TTL_MS) {
    void refreshContext();
  }
  return contextCache;
}
