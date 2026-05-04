# Dashboard Docs Wiki Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated `Docs` page to the NeuroClaw dashboard (`/dashboard-v2`) that renders a sidebar-driven wiki of NeuroClaw features. v1 ships a skeleton — sidebar nav + a small set of seeded articles + stubs for everything else. Authors add pages by dropping markdown files into `docs/wiki/`.

**Architecture:** Markdown source files in `docs/wiki/<section>/<slug>.md` are served by two new token-protected Hono routes: `/api/docs/tree` (directory + frontmatter walk, returns the sidebar tree) and `/api/docs/article/:section/:slug` (returns one article's frontmatter + raw markdown). A new React page `page-docs.jsx` renders the sidebar + main pane and uses `marked` (loaded via CDN, since the dashboard has no build step) to render markdown to HTML. External-link articles (frontmatter `external_url`) open in new tab instead of loading inline.

**Tech Stack:** TypeScript (Hono backend), React 18 with Babel Standalone (dashboard, no build step), `marked` v12 (markdown rendering, loaded via CDN), markdown + YAML frontmatter for content.

**Verification model:** This codebase has no automated test suite. Each task ends with `npx tsc --noEmit` clean + concrete manual verification (curl the new API, sanity-check the rendered page in the dashboard). Treat that as the gate. Atomic commit per task.

**Spec:** `docs/superpowers/specs/2026-05-04-dashboard-docs-wiki-design.md`

---

## File Structure

**Created:**

- `src/dashboard/wiki-loader.ts` — directory walker + custom YAML-frontmatter parser + per-file mtime cache. One file, one responsibility: read `docs/wiki/` from disk and return structured data.
- `src/dashboard/v2/src/page-docs.jsx` — React page component. Sidebar tree on the left, article body on the right. Loads tree on mount, loads article on click, opens external links in new tab.
- `docs/wiki/` (root) plus the section subdirectories below, each with a `_section.yml` and one or more `.md` articles.

**Modified:**

- `src/dashboard/routes.ts` — register `GET /api/docs/tree` and `GET /api/docs/article/:section/:slug` (token-protected like all other `/api/*` routes).
- `src/dashboard/v2/NeuroClaw.html` — add `<script>` tag for `marked` from CDN + the new `<script type="text/babel" src="src/page-docs.jsx">` entry.
- `src/dashboard/v2/src/app.jsx` — add `docs: { label: 'Docs', cmp: () => <Docs/> }` to the `PAGES` constant.
- `src/dashboard/v2/src/data.jsx` — add `{ id: 'docs', label: 'Docs', icon: 'docs' }` to the appropriate `NAV` group.
- `src/dashboard/v2/src/icons.jsx` — add `case 'docs':` returning a book/page SVG.
- `CLAUDE.md` — short paragraph documenting the wiki location and the "drop a markdown file" authoring workflow.

---

## Task 1: Wiki loader module

**Files:**
- Create: `src/dashboard/wiki-loader.ts`

- [ ] **Step 1: Sketch the public surface (no impl yet)**

Open a new file at `src/dashboard/wiki-loader.ts`. The module exports two functions and two types — define the surface first so the routes consumer (Task 2) sees a stable contract:

```ts
export interface WikiArticleSummary {
  slug:          string;
  title:         string;
  order:         number;
  external_url:  string | null;
}
export interface WikiSection {
  slug:          string;
  title:         string;
  order:         number;
  articles:      WikiArticleSummary[];
}
export interface WikiArticle extends WikiArticleSummary {
  section:       string;
  markdown:      string;
}

/** Returns the sorted directory tree of all sections + articles. Cached by mtime. */
export function getWikiTree(): WikiSection[] { /* impl in step 2 */ throw new Error('not implemented'); }

/** Returns one article. Returns null when the file doesn't exist. Throws on path-traversal attempts. */
export function getWikiArticle(section: string, slug: string): WikiArticle | null { /* impl in step 2 */ throw new Error('not implemented'); }
```

- [ ] **Step 2: Write the full module**

Replace the stubs with the full implementation:

```ts
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
const TREE_CACHE_TTL_MS = 2_000;  // re-walk at most every 2s

function isValidSlug(s: string): boolean {
  return typeof s === 'string' && SLUG_RE.test(s) && s.length <= 64;
}

/** Defense-in-depth: reject anything that resolves outside WIKI_ROOT. */
function safePath(...parts: string[]): string | null {
  const joined = path.join(WIKI_ROOT, ...parts);
  const resolved = path.resolve(joined);
  if (!resolved.startsWith(WIKI_ROOT + path.sep) && resolved !== WIKI_ROOT) return null;
  return resolved;
}

/** Tiny YAML parser. Handles only what frontmatter actually uses:
 *  - key: value pairs (string, integer, true/false/null)
 *  - quoted strings ("..." or '...')
 *  - empty values become null
 *  No nested objects, no arrays, no multi-line. Keep it boring. */
function parseTinyYaml(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of src.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();  // strip comments
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

function titleCase(slug: string): string {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function getWikiTree(): WikiSection[] {
  const now = Date.now();
  if (treeCache && now - treeCache.stamp < TREE_CACHE_TTL_MS) return treeCache.value;

  let sections: WikiSection[] = [];
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
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Smoke-verify the loader handles "no wiki dir yet" gracefully**

Use a tiny inline check (no test framework — just confirm at the REPL):

```bash
cd /home/neuroclaw-v1
node -e "require('tsx/cjs'); const {getWikiTree, getWikiArticle} = require('./src/dashboard/wiki-loader.ts'); console.log(JSON.stringify(getWikiTree())); console.log(getWikiArticle('foo','bar'));"
```

Expected: `[]` printed first (empty tree because `docs/wiki/` doesn't exist yet), then `null`.

If `tsx/cjs` isn't installed, fall back to `npx tsx -e "...same code..."`. The point is to confirm `getWikiTree` returns `[]` when the directory is missing instead of throwing.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/wiki-loader.ts
git commit -m "feat(wiki): markdown wiki loader (tree + article + frontmatter)"
```

---

## Task 2: Wiki API routes

**Files:**
- Modify: `src/dashboard/routes.ts`

- [ ] **Step 1: Find the existing route registration pattern**

```bash
grep -nE "app\.get\(.*'/api/" /home/neuroclaw-v1/src/dashboard/routes.ts | head -5
```

Note the auth pattern — every `/api/*` route is token-protected by middleware registered before the routes. The new ones inherit it automatically; you just write the handlers.

- [ ] **Step 2: Add the imports**

At the top of `src/dashboard/routes.ts`, add:

```ts
import { getWikiTree, getWikiArticle } from './wiki-loader';
```

- [ ] **Step 3: Add the tree route**

In the section of `routes.ts` where other `app.get('/api/...', ...)` handlers live, add:

```ts
app.get('/api/docs/tree', (c) => {
  return c.json({ ok: true, sections: getWikiTree() });
});
```

- [ ] **Step 4: Add the article route**

Right after the tree route:

```ts
app.get('/api/docs/article/:section/:slug', (c) => {
  const section = c.req.param('section');
  const slug    = c.req.param('slug');
  let article;
  try {
    article = getWikiArticle(section, slug);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  if (!article) {
    return c.json({ error: 'Article not found' }, 404);
  }
  return c.json({ ok: true, article });
});
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Smoke-verify the routes respond**

```bash
cd /home/neuroclaw-v1
npm run dashboard &
sleep 4
TOKEN=$(grep -E '^DASHBOARD_TOKEN=' .env | cut -d= -f2)

# tree should return empty (no wiki content yet)
curl -sS "http://127.0.0.1:3141/api/docs/tree?token=$TOKEN" | head -c 200
echo

# article 404 for missing
curl -sS -o /dev/null -w "tree-missing: %{http_code}\n" \
  "http://127.0.0.1:3141/api/docs/article/foo/bar?token=$TOKEN"

# 400 for invalid slug
curl -sS -o /dev/null -w "invalid-slug: %{http_code}\n" \
  "http://127.0.0.1:3141/api/docs/article/foo/..%2Fetc%2Fpasswd?token=$TOKEN"

kill %1 2>/dev/null || true
```

Expected:
- Tree returns `{"ok":true,"sections":[]}`.
- Missing article → 404.
- Invalid slug → 400.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/routes.ts
git commit -m "feat(api): /api/docs/tree and /api/docs/article/:section/:slug"
```

---

## Task 3: Seed wiki content

**Files:**
- Create: `docs/wiki/_section.yml` files (5 — one per section)
- Create: `docs/wiki/<section>/<slug>.md` files (17 articles)

This task is pure content — no TS to typecheck. Just `git add` + commit at the end.

- [ ] **Step 1: Create directories + section meta files**

```bash
cd /home/neuroclaw-v1
mkdir -p docs/wiki/{getting-started,agents,integrations,pydantic-ai-framework,reference}
```

Then create `docs/wiki/getting-started/_section.yml`:
```yaml
title: Getting Started
order: 10
```

`docs/wiki/agents/_section.yml`:
```yaml
title: Agents
order: 20
```

`docs/wiki/integrations/_section.yml`:
```yaml
title: Integrations
order: 30
```

`docs/wiki/pydantic-ai-framework/_section.yml`:
```yaml
title: Pydantic AI Framework
order: 40
```

`docs/wiki/reference/_section.yml`:
```yaml
title: Reference
order: 50
```

- [ ] **Step 2: Stub article template**

For all stub articles (those marked "stub" below), the body is identical:

```markdown
> Coming soon. See [the repo on GitHub](https://github.com/) for current documentation while this article is written.
```

- [ ] **Step 3: Write Getting Started → Quickstart (`docs/wiki/getting-started/quickstart.md`)**

```markdown
---
title: Quickstart
order: 10
---

# Quickstart

NeuroClaw is a TypeScript multi-agent orchestrator with a CLI and a dashboard.

## Install

```bash
git clone <repo>
cd neuroclaw-v1
npm install
cp .env.example .env
```

Fill in at minimum:
- `VOIDAI_API_KEY` — your VoidAI key (or any OpenAI-compatible endpoint).
- `DASHBOARD_TOKEN` — picks any string; protects the dashboard.

## Run

```bash
npm run dashboard   # http://localhost:3141/dashboard?token=<your token>
npm run dev         # CLI chat loop
```

## Next steps

- Open the dashboard and try chatting in the **Chat** tab — Alfred (the orchestrator) replies by default.
- Visit **Agents** to see the seeded agents (Alfred, Researcher, Coder, Planner) and create your own.
- Read **Architecture overview** for how the orchestration works under the hood.
```

- [ ] **Step 4: Write Getting Started → Architecture overview (`docs/wiki/getting-started/architecture-overview.md`)**

```markdown
---
title: Architecture overview
order: 20
---

# Architecture overview

NeuroClaw has two entry points sharing one SQLite database and one agent registry.

## CLI

`src/index.ts` reads stdin, enqueues messages via a FIFO message queue (preventing race conditions), calls `chat()` in `alfred.ts`, streams tokens to stdout, and persists the turn in SQLite.

## Dashboard

`src/dashboard/server.ts` runs a Hono app on `localhost:3141`. The token-protected `/dashboard-v2` route serves a single-page React app loaded from `src/dashboard/v2/`. All data APIs live under `/api/*`. `/api/chat` uses Server-Sent Events for streaming.

## Agent registry

The `agents` table is the source of truth. Alfred (orchestrator), Researcher, Coder, and Planner are seeded on every cold start (idempotent). System prompts are always rewritten at seed time, so spawn guidance stays current as you upgrade.

## Routing

For each user message, `resolveAgent()` walks this priority chain:

1. `@AgentName` prefix — routes directly, strips the mention.
2. LLM auto-classifier (when `AUTO_DELEGATION_ENABLED=true`).
3. Explicit `agentId` from the dashboard agent dropdown.
4. Alfred as the final fallback.

## Multi-agent orchestration

When Alfred handles a message, `decomposeTask()` makes an LLM call to decide whether multiple specialists are needed. Complex tasks run as a chain of steps, each step's output piped as context into the next, with `mergeResults()` producing a unified final response.

## Hive Mind

Every routing decision, spawn, task change, and lifecycle event lands in the `hive_mind` table. The Dashboard's **Hive Mind** tab streams these in real time.

## Where things live

See **Reference → API endpoints** and **Reference → Env vars** for the complete inventory.
```

- [ ] **Step 5: Write the Agents stubs**

`docs/wiki/agents/creating-agents.md`:
```markdown
---
title: Creating agents
order: 10
---

# Creating agents

> Coming soon. See [the repo on GitHub](https://github.com/) for current documentation while this article is written.
```

`docs/wiki/agents/routing-and-mentions.md`:
```markdown
---
title: Routing and mentions
order: 20
---

# Routing and mentions

> Coming soon. See [the repo on GitHub](https://github.com/) for current documentation while this article is written.
```

`docs/wiki/agents/temporary-agents-and-spawning.md`:
```markdown
---
title: Temporary agents and spawning
order: 30
---

# Temporary agents and spawning

> Coming soon. See [the repo on GitHub](https://github.com/) for current documentation while this article is written.
```

- [ ] **Step 6: Write the Integrations stubs + Pydantic AI Bridge full article**

`docs/wiki/integrations/mcp-servers.md`:
```markdown
---
title: MCP servers
order: 10
---

# MCP servers

> Coming soon. See [the repo on GitHub](https://github.com/) for current documentation while this article is written.
```

`docs/wiki/integrations/discord-bot.md`:
```markdown
---
title: Discord bot
order: 20
---

# Discord bot

> Coming soon. See [the repo on GitHub](https://github.com/) for current documentation while this article is written.
```

`docs/wiki/integrations/pydantic-ai-bridge.md`:
```markdown
---
title: Pydantic AI bridge
order: 30
---

# Pydantic AI bridge

NeuroClaw can register external Pydantic AI agents (Python) as first-class agents — routable from Discord/CLI/dashboard as `@AgentName` AND auto-exposed as tools every local agent can call mid-task.

## How it works

Pydantic AI agents run as standalone Python processes that expose themselves as MCP HTTP servers (via `fastmcp`). NeuroClaw's MCP server registry probes them and caches their tools. A `provider='mcp'` value on the `agents` table marks an agent as MCP-backed; `chatStreamMcp()` proxies the user message directly to a chosen MCP tool — no local LLM hop. The same backed agent is auto-synthesized as an `agent__<name>` tool in the unified tool registry, so any local agent can delegate to it mid-turn.

## Quick setup

Two example agents ship in `pydantic-agents/` (deep-research, web-research). To run them:

```bash
cd pydantic-agents
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in OPENAI_API_KEY and TAVILY_API_KEY
cd .. && npm run pydantic:run
```

Both agents bind to `localhost:7100` (deep-research) and `localhost:7101` (web-research).

## Register in the dashboard

1. **MCP Servers** tab → add server
   - Deep Research: `http://localhost:7100/mcp`, transport `http`
   - Web Research:  `http://localhost:7101/mcp`, transport `http`
   Probe each — both should reach status `ready` with 1 tool cached.
2. **Agents** tab → create agent
   - Provider: `mcp`
   - MCP Server: pick one
   - Tool: `deep_research_tool` or `web_search_summarize_tool`
   - Input field: `query`

The agent now appears as `@DeepResearch` (or whatever you named it) in CLI/Discord and as `agent__deepresearch(query)` in every other agent's tool list.

## Bring your own Pydantic agent

Anything that exposes itself as an MCP HTTP server works — not just the two examples. Drop a Python module in `pydantic-agents/<your_agent>/`, register it in `run-all.sh`, point the dashboard at the URL, done.

For framework patterns (tools, dependencies, evals), see the **Pydantic AI Framework** section in this wiki.
```

- [ ] **Step 7: Write the Pydantic AI Framework outbound-link articles**

`docs/wiki/pydantic-ai-framework/agents-overview.md`:
```markdown
---
title: Agents — overview
order: 10
external_url: https://ai.pydantic.dev/agents/
---

# Pydantic AI — Agents (external)

The `Agent` is the core construct in Pydantic AI. It binds an LLM to a system prompt, tools, and a typed output schema. Pydantic enforces the output shape and retries on validation failure.

Use this when you want strict structured outputs from the LLM (extraction, classification, form-filling) or when you need a typed handle around tool-using behavior.

→ Read the official docs at ai.pydantic.dev/agents/
```

`docs/wiki/pydantic-ai-framework/tools.md`:
```markdown
---
title: Tools
order: 20
external_url: https://ai.pydantic.dev/tools/
---

# Pydantic AI — Tools (external)

Define tools as ordinary Python functions with type hints. Pydantic AI introspects the signature, generates a JSON schema, and exposes the tool to the LLM. Validation happens automatically on the way in.

Use this for any deterministic action you want the agent to be able to take (database queries, API calls, file reads, computation).

→ Read the official docs at ai.pydantic.dev/tools/
```

`docs/wiki/pydantic-ai-framework/dependencies.md`:
```markdown
---
title: Dependencies
order: 30
external_url: https://ai.pydantic.dev/dependencies/
---

# Pydantic AI — Dependencies (external)

Dependency injection lets you pass typed runtime objects (DB connections, API clients, request context) into your agent's tools and system prompt without globals. Defined per agent, supplied per `run()`.

Use this to keep tool implementations testable and to thread per-request context through cleanly.

→ Read the official docs at ai.pydantic.dev/dependencies/
```

`docs/wiki/pydantic-ai-framework/mcp-servers.md`:
```markdown
---
title: MCP servers (Pydantic side)
order: 40
external_url: https://ai.pydantic.dev/mcp/
---

# Pydantic AI — MCP servers (external)

Pydantic AI agents can both **consume** MCP servers (calling remote tools) and **expose themselves** as MCP servers (so other agents — including NeuroClaw — can call them).

The example agents in `pydantic-agents/` use `fastmcp` to expose themselves over HTTP. NeuroClaw's MCP server registry then registers them and the bridge wires them up as first-class agents.

→ Read the official docs at ai.pydantic.dev/mcp/
```

`docs/wiki/pydantic-ai-framework/evals.md`:
```markdown
---
title: Evals
order: 50
external_url: https://ai.pydantic.dev/evals/
---

# Pydantic AI — Evals (external)

Pydantic AI ships an evaluation harness for measuring agent quality across a dataset. Define evals once, run them in CI, and prevent regressions when you swap models or change prompts.

→ Read the official docs at ai.pydantic.dev/evals/
```

- [ ] **Step 8: Write the Reference articles**

`docs/wiki/reference/env-vars.md`:
```markdown
---
title: Environment variables
order: 10
---

# Environment variables

Copy `.env.example` to `.env` and fill in.

| Variable | Default | Notes |
|---|---|---|
| `VOIDAI_API_KEY` | — | Required |
| `VOIDAI_BASE_URL` | `https://api.voidai.app/v1` | OpenAI-compatible endpoint |
| `VOIDAI_MODEL` | `gpt-5.1` | Default model for all agents |
| `DASHBOARD_PORT` | `3141` | |
| `DASHBOARD_TOKEN` | `change-me` | Protects all dashboard routes |
| `DB_PATH` | `./neuroclaw.db` | SQLite file path |
| `AUTO_DELEGATION_ENABLED` | `false` | LLM classifier auto-routes messages |
| `AUTO_DELEGATION_MIN_CONFIDENCE` | `0.65` | Minimum confidence to act on classifier |
| `ROUTER_MODEL` | *(same as VOIDAI_MODEL)* | Override model for the classifier |
| `SPAWN_AGENTS_ENABLED` | `false` | Allow agents to spawn temp sub-agents |
| `TEMP_AGENTS_AUTO_APPROVE` | `true` | Auto-approve all spawn requests |
| `TEMP_AGENT_TTL_HOURS` | `6` | Hours before temp agent expires |
| `TEMP_AGENT_SOFT_LIMIT` | `10` | Log warning above this many active temp agents |
| `TEMP_AGENT_HARD_LIMIT` | `25` | Block spawns above this many active temp agents |
| `LANGFUSE_SECRET_KEY` | — | Enables Langfuse tracing (with public key) |
| `LANGFUSE_PUBLIC_KEY` | — | |
| `LANGFUSE_HOST` | `https://cloud.langfuse.com` | |
```

`docs/wiki/reference/api-endpoints.md`:
```markdown
---
title: API endpoints
order: 20
---

# API endpoints

All `/api/*` routes require `?token=<DASHBOARD_TOKEN>` (or `x-dashboard-token` header).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/status` | Active agents, temp agents, session/message counts |
| GET | `/api/agents` | All agents (including temp) |
| POST | `/api/agents` | Create agent (`name` required) |
| PATCH | `/api/agents/:id` | Update agent fields |
| DELETE | `/api/agents/:id` | Soft-deactivate (Alfred protected) |
| POST | `/api/agents/:id/activate` | Re-activate an inactive agent |
| POST | `/api/agents/spawn` | Manually spawn a temp agent |
| GET | `/api/tasks` | List tasks (`?status=` optional filter) |
| POST | `/api/tasks` | Create task; auto-assigns if AUTO_DELEGATION_ENABLED |
| PATCH | `/api/tasks/:id` | Update status, agent, or fields |
| GET | `/api/hive` | Hive Mind events (`?limit=` default 100) |
| POST | `/api/chat` | SSE stream — `chunk`, `done`, `error`, `mcp_call_*` events |
| GET | `/api/tasks/watch` | SSE stream for background task completions |
| GET | `/api/config/watch` | SSE stream for `.env` change notifications |
| GET | `/api/docs/tree` | Wiki sidebar tree |
| GET | `/api/docs/article/:section/:slug` | One wiki article |
| GET | `/api/mcp/servers` | Registered MCP servers + their cached tools |
```

`docs/wiki/reference/hive-mind-actions.md`:
```markdown
---
title: Hive Mind actions
order: 30
---

# Hive Mind actions

Every notable lifecycle event lands in the `hive_mind` table with one of these `action` values:

- `auto_route`
- `route_fallback`
- `manual_delegation`
- `spawn_request`
- `spawn_success`
- `spawn_denied`
- `agent_spawned`
- `agent_expired`
- `task_created`
- `task_updated`
- `agent_activated`
- `agent_deactivated`
- `mcp_agent_call_ok`
- `mcp_agent_call_failed`

Read the live stream from the dashboard's **Hive Mind** tab, or query `GET /api/hive?limit=N` programmatically.
```

- [ ] **Step 9: Commit the content**

```bash
cd /home/neuroclaw-v1
git add docs/wiki/
git commit -m "docs(wiki): seed initial content for getting-started, agents, integrations, pydantic-ai-framework, reference"
```

---

## Task 4: Frontend infrastructure — `marked` + docs icon

**Files:**
- Modify: `src/dashboard/v2/NeuroClaw.html`
- Modify: `src/dashboard/v2/src/icons.jsx`

- [ ] **Step 1: Add `marked` from CDN**

Open `src/dashboard/v2/NeuroClaw.html`. Find the existing CDN script tags (lines 414-416 — react, react-dom, babel). Add `marked` immediately after them:

```html
<script src="https://unpkg.com/marked@12.0.2/marked.min.js" integrity="sha384-NLm5/3eMo3eAUsAFf25c1Cgr27WX7ftBlZuVmpODVbbx6QdnNDGlqNPZ7XvDtpGI" crossorigin="anonymous"></script>
```

(Integrity hash: if unpkg has updated the file and the integrity check rejects, regenerate the hash with: `curl -sL https://unpkg.com/marked@12.0.2/marked.min.js | openssl dgst -sha384 -binary | openssl base64 -A` and replace.)

- [ ] **Step 2: Add docs icon**

Open `src/dashboard/v2/src/icons.jsx`. Find any existing `case 'logs':` line (line 24). Add a new case for `docs` somewhere in the switch (alongside the other UI icons):

```jsx
case 'docs': return <svg {...p}><path d="M5 4h11l3 3v13H5z"/><path d="M16 4v3h3"/><path d="M8 10h8M8 14h8M8 18h5"/></svg>;
```

This is a "page with text lines" SVG matching the existing icon style (24x24 viewBox, stroke-only, no fills).

- [ ] **Step 3: Smoke-verify the dashboard still loads**

```bash
cd /home/neuroclaw-v1
npm run dashboard &
sleep 4
TOKEN=$(grep -E '^DASHBOARD_TOKEN=' .env | cut -d= -f2)

# Confirm /dashboard-v2 returns 200 and contains the marked CDN reference
curl -sS "http://127.0.0.1:3141/dashboard-v2?token=$TOKEN" | grep -c "marked@12"
# Expected output: 1
kill %1 2>/dev/null || true
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```
Expected: clean (no TS files were touched, but a sanity check costs nothing).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/v2/NeuroClaw.html src/dashboard/v2/src/icons.jsx
git commit -m "feat(dashboard): load marked CDN + docs icon for wiki page"
```

---

## Task 5: Page component — `page-docs.jsx`

**Files:**
- Create: `src/dashboard/v2/src/page-docs.jsx`

- [ ] **Step 1: Read a sibling page first to absorb the conventions**

```bash
head -60 /home/neuroclaw-v1/src/dashboard/v2/src/page-mcp.jsx
```

Note the patterns: each page is a standalone React component, uses `window.NC_API` for fetches, ends with `window.PageName = PageName;`. Use `nc-*` className tokens. Don't introduce a different state-management style.

- [ ] **Step 2: Write the component**

Create `src/dashboard/v2/src/page-docs.jsx`:

```jsx
/* Docs — wiki-style sidebar + markdown article pane */

const Docs = () => {
  const [tree, setTree] = React.useState(null);     // null = loading; [] = empty
  const [active, setActive] = React.useState(null); // { section, slug } or null
  const [article, setArticle] = React.useState(null);
  const [articleErr, setArticleErr] = React.useState(null);
  const [renderErr, setRenderErr] = React.useState(false);
  const [openSections, setOpenSections] = React.useState({}); // sectionSlug -> bool, default open

  // Initial deep-link: ?article=section/slug from the URL
  React.useEffect(() => {
    const m = (location.search.match(/[?&]article=([^&]+)/) || [])[1];
    if (m) {
      const decoded = decodeURIComponent(m);
      const slash = decoded.indexOf('/');
      if (slash > 0) {
        setActive({ section: decoded.slice(0, slash), slug: decoded.slice(slash + 1) });
      }
    }
  }, []);

  // Load the tree once
  React.useEffect(() => {
    let alive = true;
    window.NC_API.get('/api/docs/tree').then(d => {
      if (!alive) return;
      const sections = d?.sections || [];
      setTree(sections);
      // Default-open every section
      const open = {};
      for (const s of sections) open[s.slug] = true;
      setOpenSections(open);
      // Auto-select first non-external article if none picked yet
      if (!active) {
        for (const s of sections) {
          for (const a of s.articles) {
            if (!a.external_url) { setActive({ section: s.slug, slug: a.slug }); return; }
          }
        }
      }
    }).catch(() => alive && setTree([]));
    return () => { alive = false; };
  }, []);

  // Load the active article whenever it changes
  React.useEffect(() => {
    if (!active) { setArticle(null); return; }
    setArticleErr(null);
    setRenderErr(false);
    window.NC_API.get(`/api/docs/article/${active.section}/${active.slug}`)
      .then(d => setArticle(d?.article || null))
      .catch(e => {
        setArticle(null);
        setArticleErr(String(e?.message || e));
      });
    // Push deep-link to the URL
    const params = new URLSearchParams(location.search);
    params.set('article', `${active.section}/${active.slug}`);
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }, [active?.section, active?.slug]);

  // Render markdown via the global `marked` lib loaded from CDN
  const html = React.useMemo(() => {
    if (!article || !window.marked) return '';
    try {
      const m = window.marked;
      const fn = typeof m.parse === 'function' ? m.parse.bind(m) : (typeof m === 'function' ? m : null);
      if (!fn) return article.markdown;
      return fn(article.markdown, { mangle: false, headerIds: true });
    } catch {
      setRenderErr(true);
      return '';
    }
  }, [article]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* Left sidebar */}
      <aside className="nc-panel" style={{ width: 280, minWidth: 280, overflowY: 'auto', borderRight: '1px solid var(--line-soft)', padding: '12px 0' }}>
        {tree === null && <div className="muted mono" style={{ padding: '8px 16px', fontSize: 11 }}>Loading…</div>}
        {tree && tree.length === 0 && <div className="muted mono" style={{ padding: '8px 16px', fontSize: 11 }}>No articles yet. Drop a markdown file in <code>docs/wiki/&lt;section&gt;/&lt;slug&gt;.md</code>.</div>}
        {tree && tree.map(section => (
          <div key={section.slug} style={{ marginBottom: 8 }}>
            <div
              className="label-tiny"
              style={{ padding: '8px 16px 4px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', userSelect: 'none' }}
              onClick={() => setOpenSections(s => ({ ...s, [section.slug]: !s[section.slug] }))}
            >
              <span>{section.title}</span>
              <span className="muted" style={{ fontSize: 9 }}>{openSections[section.slug] ? '▾' : '▸'}</span>
            </div>
            {openSections[section.slug] && section.articles.map(a => {
              const isActive = active && active.section === section.slug && active.slug === a.slug;
              if (a.external_url) {
                return (
                  <a key={a.slug} href={a.external_url} target="_blank" rel="noopener noreferrer"
                     className="mono"
                     style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 16px', fontSize: 12, color: 'var(--text-soft)', textDecoration: 'none' }}>
                    <span>{a.title}</span>
                    <span className="muted" style={{ fontSize: 9 }}>↗</span>
                  </a>
                );
              }
              return (
                <div key={a.slug}
                     className="mono"
                     onClick={() => setActive({ section: section.slug, slug: a.slug })}
                     style={{
                       padding: '6px 16px', fontSize: 12, cursor: 'pointer',
                       background: isActive ? 'rgba(0,183,255,0.10)' : 'transparent',
                       color: isActive ? 'var(--neon)' : 'var(--text-soft)',
                       borderLeft: isActive ? '2px solid var(--neon)' : '2px solid transparent',
                     }}
                >{a.title}</div>
              );
            })}
          </div>
        ))}
      </aside>

      {/* Main pane */}
      <section style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '20px 32px' }}>
        {!active && tree && tree.length > 0 && (
          <div className="muted mono" style={{ fontSize: 12 }}>Pick an article from the sidebar to begin.</div>
        )}
        {articleErr && (
          <div className="nc-panel" style={{ padding: 16, borderColor: 'var(--danger)' }}>
            <div className="mono" style={{ color: 'var(--danger)' }}>Article not found</div>
            <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>{articleErr}</div>
          </div>
        )}
        {article && (
          <>
            <div className="label-tiny muted" style={{ marginBottom: 8 }}>{tree?.find(s => s.slug === article.section)?.title || article.section}</div>
            {renderErr && (
              <div className="muted mono" style={{ fontSize: 11, marginBottom: 12 }}>Couldn't render this article. Showing raw source.</div>
            )}
            {renderErr ? (
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)', fontSize: 12 }}>{article.markdown}</pre>
            ) : (
              <div className="nc-prose" dangerouslySetInnerHTML={{ __html: html }}/>
            )}
          </>
        )}
      </section>
    </div>
  );
};

window.Docs = Docs;
```

- [ ] **Step 3: Add minimal CSS for the prose area**

The article body needs reasonable typography. Open `src/dashboard/v2/NeuroClaw.html` and find the closing `</style>` tag in the `<head>` (the one wrapping the page-level CSS variables and base styles). Just before it, add:

```css
.nc-prose { color: var(--text); font-size: 14px; line-height: 1.6; max-width: 880px; }
.nc-prose h1 { font-family: var(--display); font-size: 26px; margin: 0 0 16px; color: var(--text); border-bottom: 1px solid var(--line-soft); padding-bottom: 10px; }
.nc-prose h2 { font-family: var(--display); font-size: 18px; margin: 24px 0 10px; color: var(--neon-2); }
.nc-prose h3 { font-family: var(--display); font-size: 15px; margin: 20px 0 8px; color: var(--text-soft); }
.nc-prose p  { margin: 0 0 12px; }
.nc-prose ul, .nc-prose ol { margin: 0 0 12px 20px; padding: 0; }
.nc-prose li { margin: 4px 0; }
.nc-prose a  { color: var(--neon); text-decoration: underline; text-underline-offset: 2px; }
.nc-prose code { background: rgba(0,183,255,0.10); padding: 1px 6px; border-radius: 4px; font-family: var(--mono); font-size: 12px; }
.nc-prose pre { background: var(--panel-2); padding: 12px 14px; border-radius: 6px; border: 1px solid var(--line-soft); overflow-x: auto; }
.nc-prose pre code { background: transparent; padding: 0; font-size: 12px; }
.nc-prose blockquote { border-left: 3px solid var(--neon); padding: 6px 14px; color: var(--text-soft); background: rgba(0,183,255,0.05); margin: 0 0 12px; }
.nc-prose table { border-collapse: collapse; margin: 0 0 12px; font-size: 13px; }
.nc-prose th, .nc-prose td { padding: 6px 12px; border: 1px solid var(--line-soft); text-align: left; }
.nc-prose th { background: var(--panel-2); color: var(--text); }
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```
Expected: clean (.jsx isn't typechecked by tsc here but no TS files moved).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/v2/src/page-docs.jsx src/dashboard/v2/NeuroClaw.html
git commit -m "feat(dashboard): page-docs.jsx renders wiki sidebar + markdown article pane"
```

---

## Task 6: Wire the Docs page into the dashboard nav

**Files:**
- Modify: `src/dashboard/v2/NeuroClaw.html` (add page-docs.jsx script tag)
- Modify: `src/dashboard/v2/src/app.jsx` (add to `PAGES`)
- Modify: `src/dashboard/v2/src/data.jsx` (add to `NAV`)

- [ ] **Step 1: Add the page-docs.jsx script tag**

Open `src/dashboard/v2/NeuroClaw.html`. Find the existing `<script type="text/babel" src="src/page-settings.jsx"></script>` line (around line 442) and add a new line right after it:

```html
<script type="text/babel" src="src/page-docs.jsx"></script>
```

- [ ] **Step 2: Add the page to PAGES**

Open `src/dashboard/v2/src/app.jsx`. The `PAGES` constant lives at lines 3-22. Add `docs` as the last entry before the closing `}`:

```jsx
docs: { label: 'Docs', cmp: () => <Docs/> },
```

The whole entry block should now look like (showing just the last few entries):
```jsx
  logs: { label: 'Logs', cmp: () => <Logs/> },
  settings: { label: 'Settings', cmp: () => <Settings/> },
  docs: { label: 'Docs', cmp: () => <Docs/> },
};
```

- [ ] **Step 3: Add the nav entry**

Open `src/dashboard/v2/src/data.jsx`. The `NAV` constant lives at lines 2-32. Add a Docs entry — place it inside the existing `OBSERVE` group right after `settings`:

```jsx
  { group: 'OBSERVE', items: [
    { id: 'analytics',label: 'Analytics',  icon: 'analytics' },
    { id: 'logs',     label: 'Logs',       icon: 'logs' },
    { id: 'settings', label: 'Settings',   icon: 'settings' },
    { id: 'docs',     label: 'Docs',       icon: 'docs' },
  ]},
```

(Keeping it in OBSERVE keeps it discoverable without inventing a new group. If you'd prefer a HELP group, that's a future polish.)

- [ ] **Step 4: Smoke-verify in the dashboard**

```bash
cd /home/neuroclaw-v1
npm run dashboard &
sleep 4
TOKEN=$(grep -E '^DASHBOARD_TOKEN=' .env | cut -d= -f2)

# Confirm the new script tag is in the HTML
curl -sS "http://127.0.0.1:3141/dashboard-v2?token=$TOKEN" | grep -c "page-docs.jsx"
# Expected: 1

# Confirm the script file itself is fetchable
curl -sS -o /dev/null -w "page-docs.jsx: %{http_code}\n" "http://127.0.0.1:3141/dashboard-v2/src/page-docs.jsx?token=$TOKEN"
# Expected: 200

kill %1 2>/dev/null || true
```

For full visual verification (sidebar + article rendering), open the dashboard URL in a browser, navigate to Docs, click around. This is a manual check — confirm at least:
- Docs appears in the OBSERVE nav group with a page-icon glyph.
- Sidebar shows all 5 sections (Getting Started, Agents, Integrations, Pydantic AI Framework, Reference).
- Quickstart loads by default.
- Clicking an external Pydantic AI article opens in a new tab (doesn't navigate the page).
- Stub articles render with the "Coming soon" message.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/v2/NeuroClaw.html src/dashboard/v2/src/app.jsx src/dashboard/v2/src/data.jsx
git commit -m "feat(dashboard): register Docs page in nav, PAGES, and HTML loader"
```

---

## Task 7: End-to-end smoke test

**No files written — verification only.**

- [ ] **Step 1: Boot the dashboard**

```bash
cd /home/neuroclaw-v1
npm run dashboard &
sleep 4
TOKEN=$(grep -E '^DASHBOARD_TOKEN=' .env | cut -d= -f2)
echo "Open: http://127.0.0.1:3141/dashboard-v2?token=$TOKEN"
```

- [ ] **Step 2: Verify the API surface**

```bash
echo "--- tree ---"
curl -sS "http://127.0.0.1:3141/api/docs/tree?token=$TOKEN" | head -c 800
echo
echo
echo "--- Quickstart article ---"
curl -sS "http://127.0.0.1:3141/api/docs/article/getting-started/quickstart?token=$TOKEN" | head -c 400
echo
echo
echo "--- Pydantic AI bridge article ---"
curl -sS "http://127.0.0.1:3141/api/docs/article/integrations/pydantic-ai-bridge?token=$TOKEN" | head -c 200
echo
echo
echo "--- 404 ---"
curl -sS -o /dev/null -w "missing: %{http_code}\n" "http://127.0.0.1:3141/api/docs/article/getting-started/does-not-exist?token=$TOKEN"
echo
echo "--- 400 (path traversal) ---"
curl -sS -o /dev/null -w "traversal: %{http_code}\n" "http://127.0.0.1:3141/api/docs/article/foo/..%2F..%2F.env?token=$TOKEN"
```

Expected:
- Tree returns 5 sections with their articles, ordered by `order` value.
- Quickstart article body present.
- Pydantic AI bridge article body present.
- `does-not-exist` returns 404.
- Path traversal attempt returns 400.

- [ ] **Step 3: Browser walkthrough**

Open the dashboard URL (printed in step 1) in a browser. Confirm:

1. `Docs` appears in the OBSERVE sidebar group with a page-icon glyph.
2. Clicking Docs opens the page; left sidebar shows 5 sections, all open by default.
3. Quickstart article renders by default with proper headings, lists, code blocks, links.
4. Click `Architecture overview` — the URL updates to `?article=getting-started/architecture-overview` and the article loads.
5. Click an external Pydantic AI article (e.g., `Tools`) — opens in a NEW tab to ai.pydantic.dev; doesn't navigate away from the dashboard.
6. Click a stub article (e.g., `Creating agents`) — renders the "Coming soon" message in a styled blockquote.
7. Refresh the page — the article from the URL deep link is still showing.
8. Collapse a section by clicking its header — articles disappear; click again to re-expand.

Tear down: `kill %1 2>/dev/null || true`

- [ ] **Step 4: Commit any incidental fixes**

If anything broke during the browser walkthrough and you fixed it, commit each fix as its own atomic commit.

---

## Task 8: Authoring docs

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a wiki section**

Open `CLAUDE.md`. Add a new top-level section near the bottom (after `## Pydantic AI agents` if that exists, otherwise before the dashboard HTML reference):

```markdown
## Wiki

User-facing docs live in `docs/wiki/<section>/<slug>.md`. The dashboard's **Docs** page (in the OBSERVE nav group) renders them with a sidebar tree on the left and the article body on the right.

To add a page: drop a markdown file with frontmatter into the appropriate section directory. Example:

```markdown
---
title: My new article
order: 50
---

# My new article

Body here.
```

The wiki picks up file changes within ~2s without a restart (`getWikiTree()` mtime cache).

To add a new section: `mkdir docs/wiki/<new-section>/` and add a `_section.yml` with `title` and `order`. To link to external docs instead of inline content, add `external_url: https://...` to the article frontmatter — the sidebar entry will open in a new tab.

Loader: `src/dashboard/wiki-loader.ts`. Routes: `GET /api/docs/tree`, `GET /api/docs/article/:section/:slug`. Page: `src/dashboard/v2/src/page-docs.jsx`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the wiki authoring workflow in CLAUDE.md"
```

---

## Self-Review Notes

**Spec coverage:**

- ✓ Source of truth in `docs/wiki/<section>/<slug>.md` with YAML frontmatter — Task 1 (loader) + Task 3 (content)
- ✓ Two backend endpoints with token auth + path-traversal guard — Task 2
- ✓ Path validation against `^[a-z0-9-]+$` + real-path containment check — Task 1, `safePath()`
- ✓ mtime-based cache — Task 1, `articleCache` + `sectionCache` + `treeCache` with 2s TTL
- ✓ Sidebar with collapsible sections + main pane — Task 5
- ✓ External-link articles open in new tab — Task 5, `<a href external_url target="_blank" rel="noopener noreferrer">`
- ✓ Skeleton seed of ~17 articles — Task 3 (matches the spec list exactly)
- ✓ Markdown rendering via `marked` (CDN, since dashboard has no build step) — Task 4 + Task 5
- ✓ Deep-link via `?article=section/slug` — Task 5, `useEffect` reads + writes `location.search`
- ✓ URL preserved on refresh — Task 5
- ✓ Loading + error + 404 states — Task 5
- ✓ Authoring workflow documented — Task 8

**Type/name consistency check:**

- `WikiSection`, `WikiArticleSummary`, `WikiArticle` — defined in Task 1 step 1, used identically in Task 1 step 2 and (implicitly via JSON) in Task 5.
- Route paths `/api/docs/tree` and `/api/docs/article/:section/:slug` — defined in Task 2, called from Task 5 (`window.NC_API.get('/api/docs/tree')` etc.) and tested in Task 7.
- Frontmatter keys: `title`, `order`, `external_url` — used identically in loader (Task 1), seeded content (Task 3), and rendering logic (Task 5).
- Section slugs: `getting-started`, `agents`, `integrations`, `pydantic-ai-framework`, `reference` — same in Task 3 directory creation and Task 7 smoke URLs.
- Tool names from FastMCP referenced in `pydantic-ai-bridge.md` — `deep_research_tool`, `web_search_summarize_tool` — match the implementation in `pydantic-agents/`.
- `window.Docs = Docs` global registration — declared in Task 5, consumed in Task 6's `PAGES`.
- Icon name `'docs'` — defined in Task 4 (`icons.jsx`), referenced in Task 6 (`data.jsx` NAV).

**Open risks:**

- The integrity hash for the `marked` CDN script was hand-written for this plan; it might be wrong. Task 4 step 1 includes the regeneration command — implementer should run it and replace if the browser's integrity check rejects the script.
- The custom YAML parser in Task 1 only handles the keys the spec uses (`title`, `order`, `external_url`). If a future article uses a more complex frontmatter (lists, nested objects), the parser will silently drop it. Acceptable for v1; revisit when a real article needs more.
- The 2-second tree cache means a freshly-dropped markdown file takes up to 2s to appear in the sidebar. Acceptable for v1; acceptable for any time scale realistically.
- The `.nc-prose` CSS in Task 5 is fairly opinionated — might clash with other styles. If something looks broken in the browser walkthrough, adjust.
