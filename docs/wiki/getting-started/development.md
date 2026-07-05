---
title: Development
order: 40
---

<!-- generated-by: gsd-doc-writer -->

# Development

This guide covers everything you need to know to make changes to the NeuroClaw codebase — from running the dev servers to adding new tools, endpoints, and wiki pages.

## npm Scripts

All commands are run from the project root.

### Primary Entry Points

| Command | Description |
|---|---|
| `npm run dev` | Run the CLI chat loop with hot-reload (`tsx watch src/index.ts`) |
| `npm run dashboard` | Run the dashboard server with hot-reload — kills any existing instance first via `scripts/dashboard.sh`, then runs `tsx watch src/dashboard/server.ts` |
| `npm run dashboard:once` | Run the dashboard server once without the kill-before-start wrapper |
| `npm run dev:cli` | Run the CLI once without watch mode |
| `npm run code` | Run the code-mode CLI (`src/cli-code.ts`) |

### Build and Production

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` and copy workflow YAML defaults to `dist/workflows/defaults/` |
| `npm start` | Run the compiled `dist/index.js` (requires a prior `npm run build`) |

### Diagnostics and Health

| Command | Description |
|---|---|
| `npm run doctor` | Run the project health checker |
| `npm run doctor:fix` | Run the health checker in auto-fix mode |
| `npm run check:claude` | Check Claude API connectivity (`src/diagnostics/claude-check.ts`) |
| `npm run check:memory` | Check memory subsystem health (`src/diagnostics/memory-check.ts`) |

### Broker (Secret Keyring)

| Command | Description |
|---|---|
| `npm run broker:bootstrap` | Initialize the broker secret keyring (`bin/nc-broker bootstrap`) |
| `npm run broker:status` | Show keyring status (`bin/nc-broker keyring-status`) |
| `npm test:broker` | Run broker integration tests (`tests/broker/run-all.ts`) |

### Discord Bot

| Command | Description |
|---|---|
| `npm run bot:discord` | Start the Discord bot once |
| `npm run bot:discord:watch` | Start the Discord bot with hot-reload |

### Pydantic AI Agents (Python)

| Command | Description |
|---|---|
| `npm run pydantic:install` | Create a Python venv in `pydantic-agents/` and install dependencies |
| `npm run pydantic:run` | Start all Python MCP agent servers via `pydantic-agents/run-all.sh` |

### Skills

| Command | Description |
|---|---|
| `npm run skills:sync` | Re-generate skill export indexes after adding or editing a skill |
| `npm run skills:add` | Add a new skill and sync exports (wraps `npx skills add`) |

### MCP Server

| Command | Description |
|---|---|
| `npm run mcp:stdio` | Run the stdio MCP server (development) |
| `npm run mcp:stdio:built` | Run the compiled stdio MCP server from `dist/` |

### Documentation

| Command | Description |
|---|---|
| `npm run docs` | Generate TypeDoc API documentation |
| `npm run docs:check` | Check for stale doc freshness markers (`scripts/docs-freshness.ts`) |

## Hot-Reload Behavior

Both `npm run dev` and `npm run dashboard` use `tsx watch`, which restarts the process whenever a TypeScript source file changes. There is no manual restart needed during development.

The dashboard also has a config hot-reload layer independent of `tsx watch`: `src/system/config-watcher.ts` polls `.env` every 2 seconds for `mtime` changes. When a change is detected it calls `dotenv.config()` again and resets the OpenAI client — environment variable changes take effect without restarting the server. The dashboard frontend receives a notification via the `GET /api/config/watch` SSE stream.

## Type Checking

There is no test suite. TypeScript type checking is the primary correctness gate:

```bash
npx tsc --noEmit
```

Run this before submitting any change. The `npm run build` command also performs a full type check as part of compilation (`tsc && mkdir -p dist/workflows/defaults && cp ...`), so a failed build indicates a type error.

## Key Files

| File | When to edit |
|---|---|
| `src/db.ts` | Add tables, columns, or CRUD helpers. Schema in `initSchema()`, migrations in `runMigrations()`, default data in `seedDefaultData()`. |
| `src/config.ts` | Expose a new environment variable. Uses getter properties (not cached values) so live `process.env` changes propagate without a restart. |
| `src/tools/registry.ts` | Add, edit, or remove agent tools. All three adapters (OpenAI, Claude SDK, MCP HTTP) pick up changes here automatically. |
| `src/dashboard/routes.ts` | Add or modify API endpoints. All `/api/*` routes are registered inside `registerApiRoutes()`. |
| `src/agent/alfred.ts` | Modify the orchestrator, routing priority chain, or multi-agent logic. |
| `src/system/decomposer.ts` | Modify task decomposition, spawn evaluation, or result merging. |

## Schema Migrations

SQLite does not support `ADD COLUMN IF NOT EXISTS`. Additive schema changes go in the `runMigrations()` function in `src/db.ts` using a `try/catch` pattern:

```typescript
function runMigrations(database: Database.Database): void {
  const alters = [
    "ALTER TABLE agents ADD COLUMN my_new_column TEXT DEFAULT 'default'",
    // ... existing alters
  ];

  for (const sql of alters) {
    try {
      database.exec(sql);
    } catch {
      // Column already exists — safe to ignore
    }
  }
}
```

Each `ALTER TABLE` statement is attempted on every startup. If the column already exists, SQLite throws and the catch block silently continues. This makes migrations idempotent.

New tables go in `initSchema()` using `CREATE TABLE IF NOT EXISTS`, which is natively idempotent.

## Adding a New API Endpoint

All API routes live in `src/dashboard/routes.ts` inside the `registerApiRoutes(app: Hono)` function. Add your route there:

```typescript
// src/dashboard/routes.ts
export function registerApiRoutes(app: Hono<any>): void {
  // ... existing routes ...

  app.get('/api/my-resource', async (c) => {
    const data = getMyData();
    return c.json(data);
  });

  app.post('/api/my-resource', async (c) => {
    const body = await c.req.json();
    const result = createMyResource(body);
    return c.json(result, 201);
  });
}
```

All routes under `/api/*` are automatically protected by the token guard (requires `?token=` query param or `x-dashboard-token` header). Public webhook routes go under `/webhooks/:slug` and are declared before the guard.

## Adding a New Tool

Tools are defined in `src/tools/registry.ts`. Each tool is a `ToolDef` object with a `name`, `description`, Zod `schema`, `shape`, optional `gate`, and `handler`. Adding a tool here makes it available automatically in all three adapters (OpenAI function-calling, Claude Agent SDK, and MCP HTTP).

```typescript
// src/tools/registry.ts
import { z } from 'zod';

// Define the tool
const myToolDef: ToolDef = {
  name: 'my_tool',
  description: 'Does something useful.',
  schema: z.object({
    input: z.string().describe('The input to process'),
  }),
  shape: {
    input: z.string().describe('The input to process'),
  },
  // Optional: gate controls whether the tool is offered to this agent
  // gate: (ctx) => ctx.agentId ? ALLOW : { allowed: false, reason: 'requires agent context' },
  handler: async ({ input }, ctx) => {
    return { result: `Processed: ${input}` };
  },
};

// Add it to the exported TOOLS array
export const TOOLS: ToolDef[] = [
  // ... existing tools ...
  myToolDef,
];
```

If the tool should appear in the external MCP surface (Cursor, Claude Desktop), set `externalSurface: true` on the definition.

## Adding a New Wiki Page

Wiki pages live under `docs/wiki/<section>/<slug>.md`. The wiki loader (`src/dashboard/wiki-loader.ts`) picks up file changes within about 2 seconds without a server restart.

1. Drop a Markdown file with frontmatter into the appropriate section directory:

```markdown
---
title: My New Article
order: 50
---

# My New Article

Article body here.
```

2. The `order` field controls the sidebar sort position within the section. Lower numbers appear first.

3. To link to external documentation instead of inline content, add `external_url` to the frontmatter:

```markdown
---
title: External Reference
order: 90
external_url: https://docs.example.com/reference
---
```

The sidebar entry will open in a new tab.

To add a new section, create `docs/wiki/<new-section>/` and add a `_section.yml` file:

```yaml
title: My Section
order: 5
```

## Dashboard v2 Frontend

The dashboard frontend lives in `src/dashboard/v2/`. The entry HTML is `src/dashboard/v2/NeuroClaw.html`. JSX files are served as raw JavaScript by the Hono static file handler with `Content-Type: application/javascript` — Babel is loaded from CDN and transpiles them in the browser at runtime. No build step is needed for frontend changes.

### Directory layout

```
src/dashboard/v2/
  NeuroClaw.html        # Entry point HTML
  src/
    app.jsx             # Root component — PAGES registry and navigation
    page-*.jsx          # One file per dashboard page (31 pages total)
    data.jsx            # Shared data-fetching hooks
    live-data.jsx       # SSE-based live data subscriptions
    icons.jsx           # Icon components
    shell.jsx           # Layout shell
```

### Adding a new dashboard page

1. Create `src/dashboard/v2/src/page-mypage.jsx` with a default export component:

```jsx
const MyPage = () => {
  return (
    <div className="page-content">
      <h1>My Page</h1>
    </div>
  );
};
```

2. Register it in the `PAGES` object in `src/dashboard/v2/src/app.jsx`:

```javascript
const PAGES = {
  // ... existing pages ...
  mypage: { label: 'My Page', cmp: () => <MyPage/> },
};
```

3. Add a `<script>` tag in `NeuroClaw.html` to load the new file (follow the pattern of existing page script tags).

4. Refresh the browser — no server restart or build step required.

### Event handling conventions

All `onclick` handlers in dashboard JSX use `data-*` attributes and `this.dataset.*` to pass parameters rather than inline string parameters. This avoids JavaScript string escaping issues inside TypeScript template literals (where `\'` is not a valid escape and becomes a bare `'`).
