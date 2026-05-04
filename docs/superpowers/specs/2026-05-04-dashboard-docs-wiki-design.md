# NeuroClaw Wiki — Design Spec

**Date:** 2026-05-04
**Status:** Approved by user
**Implementation plan:** `docs/superpowers/plans/2026-05-04-dashboard-docs-wiki.md` (to be written)

## Goal

Add a dedicated `Docs` page to the NeuroClaw dashboard that renders a sidebar-driven wiki of every NeuroClaw feature, including the Pydantic AI bridge and curated links into the external Pydantic AI framework documentation. v1 ships a skeleton — sidebar nav + a small set of seeded articles + stubs for everything not yet written. Authors add new pages by dropping markdown files into `docs/wiki/`.

## Non-goals (explicitly out of scope for v1)

- Wiki search
- Editing articles from the dashboard UI
- Versioning / per-release docs
- iframe embeds of external docs (Pydantic AI framework docs are linked out, not embedded)
- Mermaid diagrams (defer until a page actually needs one)
- Auth beyond the existing dashboard token (no per-page ACLs)

## Architecture

### Source of truth

All wiki content lives in `docs/wiki/<section>/<slug>.md` at the repo root. Each `.md` file is one article. A YAML frontmatter block at the top controls how it appears in the sidebar:

```markdown
---
title: Quickstart
order: 10
external_url: https://ai.pydantic.dev/agents   # optional — when present, sidebar entry opens externally instead of loading article body
---

# Quickstart

The article body is markdown.
```

Sections are derived from directory names. A section's display name and order come from an optional `_section.yml` file at the section root:

```yaml
title: Getting Started
order: 10
```

If `_section.yml` is absent, the section uses its directory name (title-cased) and is sorted alphabetically after explicitly-ordered sections.

### Backend

Two new endpoints in `src/dashboard/routes.ts`, both token-protected like the rest of `/api/*`:

- **`GET /api/docs/tree`** — returns the sidebar tree. Walks `docs/wiki/`, parses frontmatter for each `.md` and the optional `_section.yml`s, and returns:
  ```json
  {
    "ok": true,
    "sections": [
      {
        "slug": "getting-started",
        "title": "Getting Started",
        "order": 10,
        "articles": [
          { "slug": "quickstart", "title": "Quickstart", "order": 10, "external_url": null },
          ...
        ]
      },
      ...
    ]
  }
  ```
- **`GET /api/docs/article/:section/:slug`** — returns one article's frontmatter + raw markdown:
  ```json
  {
    "ok": true,
    "article": {
      "section": "getting-started",
      "slug": "quickstart",
      "title": "Quickstart",
      "external_url": null,
      "markdown": "# Quickstart\n\n..."
    }
  }
  ```

Both endpoints validate `section` and `slug` against `^[a-z0-9-]+$` to prevent path traversal. Path resolution: `path.join(WIKI_ROOT, section, slug + '.md')` followed by an `assert` that the resolved real path still starts with `WIKI_ROOT` (defense-in-depth against symlink trickery).

A small in-process cache invalidates on file mtime change so editing markdown without restarting the server still picks up. (Same pattern as `config-watcher.ts` polls `.env` mtime — see `src/system/config-watcher.ts`.)

### Frontend

New file: `src/dashboard/v2/src/page-docs.jsx`. Two-column layout matching the existing `nc-*` design tokens used by sibling pages:

- **Left sidebar** (~280px wide):
  - Each section is a collapsible group (open by default for v1, expand/collapse state held in local state).
  - Articles inside are clickable rows; the active article is highlighted.
  - Articles whose frontmatter has `external_url` render as outbound links (open in new tab) rather than loading the article body.
- **Main pane** (flex-1):
  - Header: section title › article title breadcrumb.
  - Body: markdown rendered to HTML.
  - Loading state while fetching, error state if 404.
  - Empty state when no article is selected (the page boots showing the first article).

Add `Docs` to the existing dashboard nav alongside `Agents`/`Chat`/etc. (see `src/dashboard/v2/src/app.jsx` for the nav definition.)

### Markdown rendering

Use the `marked` package (~30kb minified, no dependencies, MIT). Rationale:

- Standard tool, well-known security posture (sanitizes HTML by default in modern versions; we'll explicitly use the `mangle: false, headerIds: true` config and pass output through a tiny `DOMPurify`-equivalent or rely on `marked`'s built-in escaping).
- Plugin ecosystem if we later want syntax highlighting (`marked-highlight` + `highlight.js`).
- Already a transitive dependency of multiple packages in this tree — adding it as a direct dep is cheap.

For v1: `marked` only, no syntax highlighter — code blocks render as `<pre><code>` with the existing dashboard's CSS for `pre` blocks. Add `highlight.js` later if/when desired.

### Dependencies

- New runtime dep: `marked` (>=12).
- No new dev deps.

## Skeleton content (v1 ships these articles)

Seeded by either a one-shot copy from existing repo docs or by writing fresh short articles. Each item below maps to a future `docs/wiki/<section>/<slug>.md`:

- **`getting-started/`**
  - `quickstart.md` — install, configure `.env`, run dashboard. Adapted from README setup section.
  - `architecture-overview.md` — the architecture summary from CLAUDE.md, lightly edited for end-user audience.
- **`agents/`**
  - `creating-agents.md` — stub: "Coming soon" + link to repo.
  - `routing-and-mentions.md` — stub.
  - `temporary-agents-and-spawning.md` — stub.
- **`integrations/`**
  - `mcp-servers.md` — stub.
  - `discord-bot.md` — stub.
  - `pydantic-ai-bridge.md` — **full article** adapted from `pydantic-agents/README.md` and the CLAUDE.md "Pydantic AI bridge" paragraph. The headline article for v1 since this is the feature that prompted the wiki.
- **`pydantic-ai-framework/`** (external links section)
  - `agents-overview.md` — 1-paragraph summary, `external_url: https://ai.pydantic.dev/agents/`.
  - `tools.md` — `external_url: https://ai.pydantic.dev/tools/`.
  - `dependencies.md` — `external_url: https://ai.pydantic.dev/dependencies/`.
  - `mcp-servers.md` — `external_url: https://ai.pydantic.dev/mcp/`.
  - `evals.md` — `external_url: https://ai.pydantic.dev/evals/`.
- **`reference/`**
  - `env-vars.md` — pulled from CLAUDE.md env table.
  - `api-endpoints.md` — pulled from CLAUDE.md endpoints table.
  - `hive-mind-actions.md` — pulled from CLAUDE.md actions list.

Stubs use a one-line placeholder body: `> Coming soon. See [the repo](https://github.com/...) for now.`

## Data flow

1. User clicks `Docs` in the dashboard nav → `page-docs.jsx` mounts.
2. Page calls `GET /api/docs/tree` → caches the tree in component state. Auto-selects the first article (Quickstart) and fetches it.
3. User clicks a sidebar article → `GET /api/docs/article/:section/:slug` → markdown rendered into the main pane.
4. User clicks an external article (frontmatter has `external_url`) → `window.open(external_url, '_blank', 'noopener,noreferrer')` instead.
5. URL state: query param `?article=<section>/<slug>` so deep links work and refresh preserves the open article.

## Error handling

- **`/api/docs/tree`** never 404s — returns `{ok: true, sections: []}` if the directory is empty.
- **`/api/docs/article/:section/:slug`** returns HTTP 404 with `{error: 'Article not found'}` for missing files. Frontend shows an inline "Article not found — pick another from the sidebar" message and stays on the page.
- **Path traversal:** Backend validates section/slug against `^[a-z0-9-]+$`. Any string failing the regex returns HTTP 400.
- **Frontmatter parse error:** `/api/docs/tree` skips offending files and logs a warning; `/api/docs/article/...` returns the file with empty frontmatter rather than 500.
- **Markdown render error:** Frontend catches and shows the raw markdown with a banner: "Couldn't render this article. Showing raw source."

## Testing

Per CLAUDE.md, this codebase has no test suite. Verification gates:

1. `npx tsc --noEmit` — clean after every change.
2. Manual smoke test (per task in the implementation plan):
   - `curl /api/docs/tree` returns at least the sections seeded in v1.
   - `curl /api/docs/article/getting-started/quickstart` returns the article body.
   - `curl /api/docs/article/foo/bar` returns 404.
   - `curl /api/docs/article/../etc/passwd` (URL-encoded) returns 400.
3. Browser smoke (in Task 9-equivalent):
   - Dashboard `Docs` tab loads, sidebar renders all sections, clicking articles loads their content, external links open in new tab.

## Implementation file plan

This is a preview — the implementation plan (writing-plans next step) breaks each into bite-sized tasks.

- **Backend**
  - `src/dashboard/wiki-loader.ts` (new) — directory walker, frontmatter parser, mtime cache.
  - `src/dashboard/routes.ts` — register the two new endpoints.
- **Frontend**
  - `src/dashboard/v2/src/page-docs.jsx` (new) — the page component.
  - `src/dashboard/v2/src/app.jsx` — add `Docs` to nav.
  - `src/dashboard/v2/NeuroClaw.html` (or wherever the JSX bundler config lives) — ensure `marked` is bundled if the dashboard is served via a build step, OR loaded via CDN script tag if the dashboard is served as a single inline HTML.
- **Content**
  - `docs/wiki/_section.yml` files for each section (5).
  - `docs/wiki/<section>/<slug>.md` for each article (~17 files for v1).
- **Deps**
  - `package.json` — add `marked` to `dependencies`.
- **Docs about the wiki itself**
  - `CLAUDE.md` — short paragraph about the wiki and how to author new pages.

## Open questions / future work (logged, not v1)

- **Search.** When the wiki crosses ~50 articles, add a sidebar search box backed by either a tiny client-side Lunr index built from the tree, or a SQLite FTS5 table. Today the sidebar is browseable enough.
- **Edit-from-UI.** Adding a "Edit this page" button that opens an inline editor and writes back via `PUT /api/docs/article/:section/:slug` is a clean follow-up; backed by the existing token auth, it's safe.
- **Versioning / per-release.** Out of scope for solo dev; revisit if the project ever takes contributors.
- **Cross-references.** Link checker that walks all `.md` files and flags broken `[text](other-article)` links — useful once content density grows.
- **Mermaid / GraphViz.** Add as a `marked` extension when a page actually wants a diagram.
