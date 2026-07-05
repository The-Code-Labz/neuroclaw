// KB ingestion: raw text and crawl4ai-driven. Writes content rows to Supabase,
// then enqueues embedding_generate jobs (target = kb_pages/kb_code_examples).
import { getSupabase } from '../db/supabase';
import { chunkMarkdown } from './kb-chunker';
import { enqueueJob } from '../db';
import { callTool } from '../mcp/mcp-client';
import { logHive } from '../system/hive-mind';
import { config } from '../config';
import { logger } from '../utils/logger';

/** Derive a stable text source_id from a URL host (matches kb_sources PK = text). */
export function deriveSourceId(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}

export async function ingestKbContent(opts: {
  text: string; sourceId: string; url: string; title?: string;
  callerAgentId?: string | null; kind?: 'page' | 'code'; summary?: string;
}): Promise<{ ok: boolean; chunks: number; error?: string }> {
  const sb = getSupabase();
  const table = opts.kind === 'code' ? 'kb_code_examples' : 'kb_pages';
  try {
    // Upsert the source row.
    const { error: srcErr } = await sb.from('kb_sources')
      .upsert({ source_id: opts.sourceId, title: opts.title ?? opts.sourceId, updated_at: new Date().toISOString() },
              { onConflict: 'source_id' });
    if (srcErr) return { ok: false, chunks: 0, error: srcErr.message };

    const chunks = chunkMarkdown(opts.text);
    if (!chunks.length) return { ok: true, chunks: 0 };

    const rows = chunks.map((content, i) => ({
      source_id: opts.sourceId, url: opts.url, chunk_number: i, content,
      ...(opts.kind === 'code' && opts.summary ? { summary: opts.summary } : {}),
    }));
    const { data, error } = await sb.from(table)
      .upsert(rows, { onConflict: 'url,chunk_number' })
      .select('id, content');
    if (error) return { ok: false, chunks: 0, error: error.message };

    for (const r of data ?? []) {
      enqueueJob('embedding_generate', { text: r.content as string, target: table, rowId: r.id as number });
    }
    logHive('kb_ingested', `kb: ingested ${rows.length} chunk(s) from ${opts.url}`, opts.callerAgentId ?? undefined,
            { url: opts.url, sourceId: opts.sourceId, table, chunks: rows.length });
    return { ok: true, chunks: rows.length };
  } catch (err) {
    logger.warn('kb: ingestKbContent failed', { url: opts.url, err: (err as Error).message });
    return { ok: false, chunks: 0, error: (err as Error).message };
  }
}

/**
 * Many docs platforms (Mintlify, Docusaurus md output, etc.) serve a clean
 * Markdown-native version of a page at `<path>.md`. That variant contains EVERY
 * tabbed code sample (curl/python/typescript) as separate fenced blocks, whereas
 * a rendered-HTML crawl only captures the default-visible tab. Returns the
 * markdown if the variant genuinely exists (200 + markdown content-type + not an
 * HTML body), otherwise null so the caller falls back to the HTML crawler.
 */
export async function fetchMarkdownVariant(pageUrl: string): Promise<string | null> {
  let candidate: string;
  try {
    const u = new URL(pageUrl);
    let path = u.pathname.replace(/\/+$/, ''); // strip trailing slash(es)
    if (path === '') path = '/index';          // bare origin → /index.md
    if (path.endsWith('.md')) candidate = `${u.origin}${path}`;
    else candidate = `${u.origin}${path}.md`;  // drop query/hash — .md is path-addressed
  } catch { return null; }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(candidate, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    // Accept declared markdown, or text/plain that isn't actually HTML.
    if (!ct.includes('markdown') && !ct.includes('text/plain')) return null;
    const body = await res.text();
    const head = body.slice(0, 256).trimStart().toLowerCase();
    if (!body.trim() || head.startsWith('<!doctype') || head.startsWith('<html')) return null;
    return body;
  } catch { return null; }
}

export async function crawlAndIndex(opts: {
  url: string; deep?: boolean; callerAgentId?: string | null;
}): Promise<{ ok: boolean; sourceId: string; pages: number; chunks: number; error?: string }> {
  const sourceId = deriveSourceId(opts.url);
  try {
    let markdown = '';
    let via = 'crawl4ai';

    // Single-page crawls: try the Markdown-native variant first (captures all
    // code tabs). Deep/BFS crawls stay on crawl4ai (it aggregates many pages).
    if (!opts.deep && config.kb.preferMarkdown) {
      const md = await fetchMarkdownVariant(opts.url);
      if (md && md.trim()) { markdown = md; via = 'markdown-variant'; }
    }

    if (!markdown.trim()) {
      const toolName = opts.deep ? 'deep_crawl' : 'crawl_page';
      const args = opts.deep ? { url: opts.url } : { url: opts.url, format: 'markdown' };
      // callTool unwraps content[].text; crawl_page returns a markdown string.
      const result = await callTool(config.kb.crawl4aiUrl, toolName, args);
      markdown = typeof result === 'string' ? result
        : (result && typeof result === 'object' && 'markdown' in result ? String((result as Record<string, unknown>).markdown)
        : JSON.stringify(result));
    }
    if (!markdown || !markdown.trim()) return { ok: false, sourceId, pages: 0, chunks: 0, error: 'empty crawl result' };

    const res = await ingestKbContent({ text: markdown, sourceId, url: opts.url, title: sourceId, callerAgentId: opts.callerAgentId, kind: 'page' });
    logger.info('kb: crawlAndIndex', { url: opts.url, via, chunks: res.chunks });
    return { ok: res.ok, sourceId, pages: 1, chunks: res.chunks, error: res.error };
  } catch (err) {
    logger.warn('kb: crawlAndIndex failed', { url: opts.url, err: (err as Error).message });
    return { ok: false, sourceId, pages: 0, chunks: 0, error: (err as Error).message };
  }
}
