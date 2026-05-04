// Reads docs/wiki/<section>/<slug>.md from disk and serves them to the
// dashboard's Docs page. Sections come from directory names; sidebar
// titles/order come from per-file YAML frontmatter (or _section.yml for
// sections themselves). All disk reads are cached by mtime so editing
// markdown without restarting still picks up.

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

const WIKI_ROOT = path.resolve(process.cwd(), 'docs/wiki');
const SLUG_RE = /^[a-z0-9-]+$/;

export interface WikiArticleSummary {
  slug:         string;
  title:        string;
  order:        number;
  external_url: string | null;
}
export interface WikiSection {
  slug:     string;
  title:    string;
  order:    number;
  articles: WikiArticleSummary[];
}
export interface WikiArticle extends WikiArticleSummary {
  section:  string;
  markdown: string;
}

interface CachedFile<T> { mtimeMs: number; value: T }
const articleCache = new Map<string, CachedFile<{ frontmatter: Record<string, unknown>; body: string }>>();
const sectionCache = new Map<string, CachedFile<{ title: string; order: number }>>();
let treeCache: { stamp: number; value: WikiSection[] } | null = null;
const TREE_CACHE_TTL_MS = 2_000;

function isValidSlug(s: string): boolean {
  return typeof s === 'string' && SLUG_RE.test(s) && s.length <= 64;
}

function safePath(...parts: string[]): string | null {
  const joined = path.join(WIKI_ROOT, ...parts);
  const resolved = path.resolve(joined);
  if (!resolved.startsWith(WIKI_ROOT + path.sep) && resolved !== WIKI_ROOT) return null;
  return resolved;
}

function parseTinyYaml(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of src.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let raw = m[2].trim();
    if (raw === '') { out[key] = null; continue; }
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      out[key] = raw.slice(1, -1);
      continue;
    }
    if (raw === 'true')  { out[key] = true;  continue; }
    if (raw === 'false') { out[key] = false; continue; }
    if (raw === 'null')  { out[key] = null;  continue; }
    if (/^-?\d+$/.test(raw)) { out[key] = parseInt(raw, 10); continue; }
    out[key] = raw;
  }
  return out;
}

function splitFrontmatter(src: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!src.startsWith('---')) return { frontmatter: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end < 0) return { frontmatter: {}, body: src };
  const fmText = src.slice(3, end).trim();
  const body = src.slice(end + 4).replace(/^\r?\n/, '');
  return { frontmatter: parseTinyYaml(fmText), body };
}

function loadArticleFile(absPath: string): { frontmatter: Record<string, unknown>; body: string } | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(absPath); } catch { return null; }
  const cached = articleCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;
  const raw = fs.readFileSync(absPath, 'utf-8');
  const value = splitFrontmatter(raw);
  articleCache.set(absPath, { mtimeMs: stat.mtimeMs, value });
  return value;
}

function titleCase(slug: string): string {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function loadSectionMeta(sectionSlug: string): { title: string; order: number } {
  const ymlPath = safePath(sectionSlug, '_section.yml');
  let stat: fs.Stats | null = null;
  if (ymlPath) {
    try { stat = fs.statSync(ymlPath); } catch { stat = null; }
  }
  if (!ymlPath || !stat) {
    return { title: titleCase(sectionSlug), order: 9999 };
  }
  const cached = sectionCache.get(ymlPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;
  const raw = fs.readFileSync(ymlPath, 'utf-8');
  const fm = parseTinyYaml(raw);
  const value = {
    title: typeof fm.title === 'string' ? fm.title : titleCase(sectionSlug),
    order: typeof fm.order === 'number' ? fm.order : 9999,
  };
  sectionCache.set(ymlPath, { mtimeMs: stat.mtimeMs, value });
  return value;
}

/** Returns the sorted directory tree of all sections + articles. Cached by mtime. */
export function getWikiTree(): WikiSection[] {
  const now = Date.now();
  if (treeCache && now - treeCache.stamp < TREE_CACHE_TTL_MS) return treeCache.value;

  const sections: WikiSection[] = [];
  if (!fs.existsSync(WIKI_ROOT)) {
    treeCache = { stamp: now, value: [] };
    return [];
  }

  for (const entry of fs.readdirSync(WIKI_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isValidSlug(entry.name)) continue;
    const sectionSlug = entry.name;
    const sectionMeta = loadSectionMeta(sectionSlug);
    const articles: WikiArticleSummary[] = [];
    const sectionDir = safePath(sectionSlug);
    if (!sectionDir) continue;
    for (const f of fs.readdirSync(sectionDir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      if (!f.name.endsWith('.md')) continue;
      const slug = f.name.slice(0, -3);
      if (!isValidSlug(slug)) continue;
      const abs = safePath(sectionSlug, f.name);
      if (!abs) continue;
      let parsed;
      try {
        parsed = loadArticleFile(abs);
      } catch (e) {
        logger.warn('wiki: failed to read article', { file: abs, err: (e as Error).message });
        continue;
      }
      if (!parsed) continue;
      const fm = parsed.frontmatter;
      articles.push({
        slug,
        title:        typeof fm.title === 'string' ? fm.title : titleCase(slug),
        order:        typeof fm.order === 'number' ? fm.order : 9999,
        external_url: typeof fm.external_url === 'string' ? fm.external_url : null,
      });
    }
    articles.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    sections.push({ slug: sectionSlug, ...sectionMeta, articles });
  }
  sections.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  treeCache = { stamp: now, value: sections };
  return sections;
}

/** Returns one article. Returns null when the file doesn't exist. Throws on path-traversal attempts. */
export function getWikiArticle(section: string, slug: string): WikiArticle | null {
  if (!isValidSlug(section) || !isValidSlug(slug)) {
    throw new Error('invalid section or slug');
  }
  const abs = safePath(section, slug + '.md');
  if (!abs) return null;
  const parsed = loadArticleFile(abs);
  if (!parsed) return null;
  const fm = parsed.frontmatter;
  return {
    section,
    slug,
    title:        typeof fm.title === 'string' ? fm.title : titleCase(slug),
    order:        typeof fm.order === 'number' ? fm.order : 9999,
    external_url: typeof fm.external_url === 'string' ? fm.external_url : null,
    markdown:     parsed.body,
  };
}
