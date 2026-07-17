// KB-backed translation glossary (schema: sql/kb-glossary-schema.sql,
// table neuroclaw_kb.kb_glossary). Deterministic exact-match lookup so an
// approved source-term → per-locale translation is derived ONCE and reused,
// instead of Furina (or any localization pass) re-deriving "the" approved
// wording differently on every run.
//
// Convention: source_term is looked up case/whitespace-insensitively via the
// generated source_term_key column; callers should always check
// glossaryLookup() before finalizing a translation for a term, and call
// glossaryUpsert() once a translation is approved so the next run reuses it.
import { getSupabase } from '../db/supabase';
import { logger } from '../utils/logger';

const TABLE = 'kb_glossary';
const SELECT_COLS = 'id, source_term, source_locale, target_locale, translation, notes, status, updated_by, created_at, updated_at';

export type GlossaryStatus = 'approved' | 'draft' | 'deprecated';

export interface GlossaryEntry {
  id: number;
  source_term: string;
  source_locale: string;
  target_locale: string;
  translation: string;
  notes: string | null;
  status: GlossaryStatus;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function normTerm(term: string): string {
  return term.trim().toLowerCase();
}

/**
 * Deterministic exact-match lookup: does an approved (or draft) translation
 * already exist for this source term + locale pair? Case/whitespace
 * insensitive. Excludes 'deprecated' entries by default.
 */
export async function glossaryLookup(opts: {
  sourceTerm: string;
  targetLocale: string;
  sourceLocale?: string;
  includeDeprecated?: boolean;
}): Promise<{ ok: boolean; found: boolean; entry?: GlossaryEntry; error?: string }> {
  try {
    const key = normTerm(opts.sourceTerm);
    if (!key) return { ok: false, found: false, error: 'sourceTerm is empty' };
    const sb = getSupabase();
    let q = sb.from(TABLE).select(SELECT_COLS)
      .eq('source_term_key', key)
      .eq('target_locale', opts.targetLocale)
      .eq('source_locale', opts.sourceLocale ?? 'en');
    if (!opts.includeDeprecated) q = q.neq('status', 'deprecated');
    const { data, error } = await q.order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (error) return { ok: false, found: false, error: error.message };
    return { ok: true, found: !!data, entry: (data as GlossaryEntry) ?? undefined };
  } catch (err) {
    logger.warn('kb-glossary: lookup failed', { err: (err as Error).message });
    return { ok: false, found: false, error: (err as Error).message };
  }
}

/**
 * Approve (or update) a source term → locale translation. Upserts on
 * (source_term_key, source_locale, target_locale) so re-approving the same
 * term overwrites rather than duplicates.
 */
export async function glossaryUpsert(opts: {
  sourceTerm: string;
  targetLocale: string;
  translation: string;
  sourceLocale?: string;
  notes?: string;
  status?: GlossaryStatus;
  updatedBy?: string | null;
}): Promise<{ ok: boolean; entry?: GlossaryEntry; error?: string }> {
  try {
    const sourceTerm = opts.sourceTerm.trim();
    const translation = opts.translation.trim();
    if (!sourceTerm) return { ok: false, error: 'sourceTerm is empty' };
    if (!translation) return { ok: false, error: 'translation is empty' };
    const sb = getSupabase();
    const row = {
      source_term:   sourceTerm,
      source_locale: opts.sourceLocale ?? 'en',
      target_locale: opts.targetLocale,
      translation,
      notes:         opts.notes ?? null,
      status:        opts.status ?? 'approved',
      updated_by:    opts.updatedBy ?? null,
      updated_at:    new Date().toISOString(),
    };
    const { data, error } = await sb.from(TABLE)
      .upsert(row, { onConflict: 'source_term_key,source_locale,target_locale' })
      .select(SELECT_COLS)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, entry: data as GlossaryEntry };
  } catch (err) {
    logger.warn('kb-glossary: upsert failed', { err: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
}

/** Browse/audit the glossary, optionally filtered by target locale or a term substring. */
export async function glossaryList(opts?: {
  targetLocale?: string;
  sourceTermContains?: string;
  limit?: number;
}): Promise<{ ok: boolean; entries: GlossaryEntry[]; error?: string }> {
  try {
    const sb = getSupabase();
    let q = sb.from(TABLE).select(SELECT_COLS);
    if (opts?.targetLocale) q = q.eq('target_locale', opts.targetLocale);
    if (opts?.sourceTermContains) q = q.ilike('source_term', `%${opts.sourceTermContains}%`);
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const { data, error } = await q.order('updated_at', { ascending: false }).limit(limit);
    if (error) return { ok: false, entries: [], error: error.message };
    return { ok: true, entries: (data ?? []) as GlossaryEntry[] };
  } catch (err) {
    logger.warn('kb-glossary: list failed', { err: (err as Error).message });
    return { ok: false, entries: [], error: (err as Error).message };
  }
}
