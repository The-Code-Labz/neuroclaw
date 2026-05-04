# Pydantic AI Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users register Pydantic AI agents (Python) as first-class NeuroClaw agents — routable from Discord/CLI/dashboard as `@AgentName` AND auto-exposed as tools every local agent can call mid-task. Ship two ready-to-run examples (deep-research, web-research) inside the repo.

**Architecture:** Pydantic AI agents run as standalone Python processes that expose themselves as MCP servers (HTTP transport via `fastmcp`). NeuroClaw's existing `mcp_servers` registry probes them and caches their tools. A new `provider='mcp'` value on the `agents` table marks an agent as MCP-backed; `chatStream` branches on this and proxies the user message directly to a chosen MCP tool (no local LLM hop). The same backed agent is auto-synthesized as a `ToolDef` in the unified tool registry, so any local agent can call it as a tool. Streaming returns the final result (no token-by-token streaming for v1, per spec).

**Tech Stack:** TypeScript (NeuroClaw side), Python 3.11+ with `pydantic-ai` and `fastmcp` (Python agent side), existing `@modelcontextprotocol/sdk` MCP client, SQLite, Hono (dashboard), discord.js.

**Verification model:** This codebase has no automated test suite. Each task ends with `npx tsc --noEmit` + a concrete manual verification step (curl the dashboard API, hit an endpoint, send a Discord message). Treat the typecheck and the manual smoke as the gate. Commit after each task.

---

## File Structure

**Created:**
- `src/agent/mcp-backed-agent.ts` — `chatStreamMcp()` dispatcher: persists user message, calls remote MCP tool, streams final result back as a single chunk, persists assistant response.
- `src/tools/adapters/mcp-backed-agent-adapter.ts` — synthesizes a `ToolDef` for every active `provider='mcp'` agent so other agents can call it as `agent__<name>(input)`.
- `pydantic-agents/README.md` — how to install and run the example agents.
- `pydantic-agents/requirements.txt` — Python deps.
- `pydantic-agents/.env.example` — Tavily / search API keys etc.
- `pydantic-agents/run-all.sh` — starts both example agents on distinct ports.
- `pydantic-agents/deep-research/agent.py` — Pydantic AI agent with Tavily-backed deep research, exposed as MCP via `fastmcp`.
- `pydantic-agents/web-research/agent.py` — lighter single-shot web search + summarize.

**Modified:**
- `src/db.ts` — three additive `ALTER TABLE agents` statements (`mcp_server_id`, `mcp_tool_name`, `mcp_input_field`); extend `AgentRecord` interface; extend `createAgent()` / `updateAgentRecord()` to accept the new fields.
- `src/agent/alfred.ts` — add `if (agentRecord?.provider === 'mcp') return chatStreamMcp(...)` branch inside `chatStream()` (next to anthropic/codex branches).
- `src/tools/adapters/openai.ts`, `src/tools/adapters/claude-sdk.ts`, `src/tools/adapters/http-mcp.ts` — merge `getMcpBackedAgentTools()` into the synthesized tool list at lookup time (mirrors existing `getMcpRegistryTools()` pattern).
- `src/dashboard/routes.ts` — `POST /api/agents` and `PATCH /api/agents/:id` accept `mcp_server_id`, `mcp_tool_name`, `mcp_input_field` when `provider === 'mcp'`.
- `src/dashboard/v2/src/page-agents.jsx` — new "Backed by MCP server" form section visible when provider dropdown is `mcp`.
- `package.json` — add `pydantic:install` and `pydantic:run` scripts.
- `.env.example` — document `PYDANTIC_DEEP_RESEARCH_PORT`, `PYDANTIC_WEB_RESEARCH_PORT`.
- `CLAUDE.md` — add "Pydantic AI Bridge" section explaining the new provider.
- `README.md` — quick-start blurb pointing to `pydantic-agents/README.md`.

---

## Task 1: DB schema for MCP-backed agents

**Files:**
- Modify: `src/db.ts:241-265` (the `alters` array inside `runMigrations()`), `:635-680` (the `AgentRecord` interface), and `createAgent()` / `updateAgentRecord()` helpers further down.

- [ ] **Step 1: Add the three ALTER statements**

In `src/db.ts`, inside the `alters: string[]` array (around line 250 where existing `provider` ALTER lives), append:

```ts
"ALTER TABLE agents ADD COLUMN mcp_server_id TEXT REFERENCES mcp_servers(id)",
"ALTER TABLE agents ADD COLUMN mcp_tool_name TEXT",
"ALTER TABLE agents ADD COLUMN mcp_input_field TEXT DEFAULT 'query'",
```

(`try { database.exec(sql); } catch { ... }` already wraps each — these are additive and safe to re-run.)

- [ ] **Step 2: Extend the `AgentRecord` interface**

In `src/db.ts` at the `export interface AgentRecord` block (around line 635), add three new fields just after `vision_mode`:

```ts
mcp_server_id:    string | null;
mcp_tool_name:    string | null;
mcp_input_field:  string | null;  // JSON field name to put the user's message into; defaults to 'query'
```

- [ ] **Step 3: Extend `createAgent()` to accept the new fields**

Find `export function createAgent(input: ...)` in `src/db.ts`. Add the three optional fields to its `input` parameter type and to the SQL `INSERT` column list + values. Example shape:

```ts
mcp_server_id?:   string | null;
mcp_tool_name?:   string | null;
mcp_input_field?: string | null;
```

In the INSERT statement, append the columns and bind:
```ts
input.mcp_server_id ?? null,
input.mcp_tool_name ?? null,
input.mcp_input_field ?? 'query',
```

- [ ] **Step 4: Extend `updateAgentRecord()` similarly**

Find `updateAgentRecord()` (used by the dashboard PATCH route). It takes a `Partial<AgentRecord>`-like patch object. Add `mcp_server_id`, `mcp_tool_name`, `mcp_input_field` to the whitelist of patchable columns it iterates. (Look for the existing pattern that handles `vision_mode` or `provider` — copy it.)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. If errors, fix until clean.

- [ ] **Step 6: Smoke-verify the migration ran**

```bash
npm run dashboard &
sleep 3
sqlite3 ./neuroclaw.db "PRAGMA table_info(agents);" | grep -E 'mcp_server_id|mcp_tool_name|mcp_input_field'
```
Expected: three lines listing the new columns. Then kill the background process.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts
git commit -m "feat(db): add mcp-backed agent columns to agents table"
```

---

## Task 2: MCP-backed agent dispatcher

**Files:**
- Create: `src/agent/mcp-backed-agent.ts`

- [ ] **Step 1: Write the dispatcher module**

Create `src/agent/mcp-backed-agent.ts` with this content:

```ts
// MCP-backed agent dispatcher. When an agent has provider='mcp', chatStream
// proxies the user's message directly to a remote MCP tool (no local LLM
// turn). The remote response is streamed back as a single chunk and persisted
// to the session like any normal assistant message. Streaming token-by-token
// is intentionally not supported in v1 — the spec calls for waiting on the
// final result.

import { getAgentById, getMcpServer, saveMessage, type AgentRecord } from '../db';
import { callTool } from '../mcp/mcp-client';
import { parseMcpHeaders } from '../db';
import { logger } from '../utils/logger';
import { logHive } from '../system/hive-mind';
import type { MetaEvent } from './alfred-meta';

export async function chatStreamMcp(
  userMessage: string,
  sessionId: string,
  onChunk: (chunk: string) => void | Promise<void>,
  agentRecord: AgentRecord,
  onMeta?: (e: MetaEvent) => void | Promise<void>,
): Promise<void> {
  if (!agentRecord.mcp_server_id || !agentRecord.mcp_tool_name) {
    const err = `Agent "${agentRecord.name}" has provider=mcp but missing mcp_server_id or mcp_tool_name`;
    logger.error('chatStreamMcp: misconfigured agent', { agentId: agentRecord.id });
    await onMeta?.({ type: 'error', error: err });
    throw new Error(err);
  }

  const server = getMcpServer(agentRecord.mcp_server_id);
  if (!server || !server.enabled) {
    const err = `MCP server for agent "${agentRecord.name}" is missing or disabled`;
    await onMeta?.({ type: 'error', error: err });
    throw new Error(err);
  }

  const inputField = agentRecord.mcp_input_field || 'query';
  const headers = parseMcpHeaders(server.headers);
  const args: Record<string, unknown> = { [inputField]: userMessage };

  // Persist the user message before the call (consistent with chatStreamOpenAI ordering)
  saveMessage(sessionId, 'user', userMessage, agentRecord.id);

  await onMeta?.({ type: 'mcp_call_start', server: server.name, tool: agentRecord.mcp_tool_name });

  let textOut = '';
  try {
    const result = await callTool(
      server.url,
      agentRecord.mcp_tool_name,
      args,
      Object.keys(headers).length > 0 ? headers : undefined,
      (server.transport as 'auto' | 'http' | 'sse' | undefined) ?? 'auto',
    );
    textOut = extractText(result);
  } catch (e) {
    const detail = (e as Error).message || String(e);
    logger.error('chatStreamMcp: remote call failed', { agentId: agentRecord.id, server: server.name, tool: agentRecord.mcp_tool_name, error: detail });
    logHive('mcp_agent_call_failed', `${agentRecord.name} -> ${server.name}/${agentRecord.mcp_tool_name}: ${detail.slice(0, 120)}`, agentRecord.id, { error: detail });
    await onMeta?.({ type: 'error', error: detail });
    throw e;
  }

  await onChunk(textOut);
  saveMessage(sessionId, 'assistant', textOut, agentRecord.id);
  await onMeta?.({ type: 'mcp_call_done', server: server.name, tool: agentRecord.mcp_tool_name, length: textOut.length });
  logHive('mcp_agent_call_ok', `${agentRecord.name} -> ${server.name}/${agentRecord.mcp_tool_name}: ${textOut.length} chars`, agentRecord.id);
}

/** MCP `callTool` returns `{ content: Array<{type, text?, ...}>, isError? }`.
 *  Concatenate every text part into a single string. Non-text parts are
 *  serialized to JSON so the user at least sees something. */
function extractText(result: unknown): string {
  if (!result || typeof result !== 'object') return JSON.stringify(result);
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  if (!Array.isArray(r.content)) return JSON.stringify(result);
  const parts: string[] = [];
  for (const c of r.content) {
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else parts.push(JSON.stringify(c));
  }
  const out = parts.join('\n').trim();
  if (r.isError) return `MCP tool error:\n${out}`;
  return out;
}
```

- [ ] **Step 2: Confirm `MetaEvent` type and `callTool` signature exist**

```bash
grep -nE 'export type MetaEvent|export interface MetaEvent' src/agent/alfred*.ts
grep -nE 'export (async )?function callTool' src/mcp/mcp-client.ts
```
Expected: both grep hits return at least one line. If `MetaEvent` lives somewhere else (e.g. inline in `alfred.ts`), import it from the actual location and create `src/agent/alfred-meta.ts` to re-export it, OR change the import path in the new file to wherever `MetaEvent` is defined.

- [ ] **Step 3: Add the two new MetaEvent variants**

If `MetaEvent` is a discriminated union, add two new variants where it lives:

```ts
| { type: 'mcp_call_start'; server: string; tool: string }
| { type: 'mcp_call_done'; server: string; tool: string; length: number }
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/agent/mcp-backed-agent.ts src/agent/alfred*.ts
git commit -m "feat(agent): mcp-backed agent dispatcher (chatStreamMcp)"
```

---

## Task 3: Wire the `mcp` provider branch into chatStream

**Files:**
- Modify: `src/agent/alfred.ts:1006-1027`

- [ ] **Step 1: Add the branch**

In `src/agent/alfred.ts`, inside `chatStream()`, immediately after the `agentRecord?.provider === 'codex'` branch (around line 1024), insert:

```ts
if (agentRecord?.provider === 'mcp') {
  if (attachments && attachments.length > 0) {
    logger.warn('chatStream: native attachments dropped on mcp path', { agentId, count: attachments.length });
  }
  // extraSystemContext is intentionally ignored — MCP-backed agents have no
  // local system prompt; their behavior is fully owned by the remote process.
  const { chatStreamMcp } = await import('./mcp-backed-agent');
  return chatStreamMcp(userMessage, sessionId, onChunk, agentRecord, onMeta);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/agent/alfred.ts
git commit -m "feat(agent): route provider=mcp to chatStreamMcp"
```

---

## Task 4: Auto-expose backed agents as tools

**Files:**
- Create: `src/tools/adapters/mcp-backed-agent-adapter.ts`
- Modify: each adapter that consumes `getMcpRegistryTools()` — `src/tools/adapters/openai.ts`, `src/tools/adapters/claude-sdk.ts`, `src/tools/adapters/http-mcp.ts`

- [ ] **Step 1: Confirm which adapters merge `getMcpRegistryTools()` today**

```bash
grep -n 'getMcpRegistryTools' src/tools/adapters/*.ts
```
Expected: at least one hit per adapter. Note the call sites — the new `getMcpBackedAgentTools()` will be merged at the same point.

- [ ] **Step 2: Write the adapter**

Create `src/tools/adapters/mcp-backed-agent-adapter.ts`:

```ts
// Synthesizes a ToolDef for every active provider='mcp' agent so other
// (local) agents can call them mid-turn as `agent__<sanitized_name>`. The
// handler proxies to the same MCP tool the agent itself is backed by — so
// calling an agent as a tool produces identical results to addressing it
// directly via @-mention.

import { z } from 'zod';
import type { ToolDef } from '../registry';
import { getAllAgents, getMcpServer, parseMcpHeaders } from '../../db';
import { callTool } from '../../mcp/mcp-client';

const passthroughShape = {} as z.ZodRawShape;
const passthroughSchema = z.object(passthroughShape).passthrough();

function sanitizeAgentName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'agent';
}

export interface SynthesizedBackedAgentTool extends ToolDef {
  agentId: string;
  agentName: string;
  rawInputSchema: unknown;
}

export function getMcpBackedAgentTools(): SynthesizedBackedAgentTool[] {
  const out: SynthesizedBackedAgentTool[] = [];
  for (const a of getAllAgents()) {
    if (a.status !== 'active') continue;
    if (a.provider !== 'mcp') continue;
    if (!a.mcp_server_id || !a.mcp_tool_name) continue;
    const server = getMcpServer(a.mcp_server_id);
    if (!server || !server.enabled) continue;

    const inputField = a.mcp_input_field || 'query';
    const toolName = `agent__${sanitizeAgentName(a.name)}`;
    const description = a.description
      ? `Delegate to the ${a.name} agent: ${a.description}`
      : `Delegate to the ${a.name} agent (MCP-backed).`;

    out.push({
      name:        toolName,
      description,
      schema:      passthroughSchema,
      shape:       passthroughShape,
      agentId:     a.id,
      agentName:   a.name,
      rawInputSchema: {
        type: 'object',
        properties: { [inputField]: { type: 'string', description: `Input for ${a.name}` } },
        required: [inputField],
        additionalProperties: false,
      },
      handler: async (args) => {
        const input = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
        const value = input[inputField];
        const message = typeof value === 'string' ? value : JSON.stringify(value);
        const headers = parseMcpHeaders(server.headers);
        const result = await callTool(
          server.url,
          a.mcp_tool_name!,
          { [inputField]: message },
          Object.keys(headers).length > 0 ? headers : undefined,
          (server.transport as 'auto' | 'http' | 'sse' | undefined) ?? 'auto',
        );
        return result;
      },
    });
  }
  return out;
}
```

- [ ] **Step 3: Merge into each adapter at the same call site as the registry adapter**

For each file in `src/tools/adapters/openai.ts`, `claude-sdk.ts`, `http-mcp.ts`:

Find the line that calls `getMcpRegistryTools()`. Immediately after collecting those, also collect:

```ts
import { getMcpBackedAgentTools } from './mcp-backed-agent-adapter';
// ...inside the function that builds the tool list:
const backedAgentTools = getMcpBackedAgentTools();
```

Then merge `backedAgentTools` into the array that already merges `mcpTools`. Each adapter's merge shape is slightly different (one converts to OpenAI function schema, one to Claude tool block, one to MCP tool descriptor) — follow whatever the existing `getMcpRegistryTools()` line does in that same file. The shape of `SynthesizedBackedAgentTool` is intentionally identical to `SynthesizedMcpTool` (both have `rawInputSchema`), so the conversion logic should drop in unchanged.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools/adapters/mcp-backed-agent-adapter.ts src/tools/adapters/openai.ts src/tools/adapters/claude-sdk.ts src/tools/adapters/http-mcp.ts
git commit -m "feat(tools): auto-expose mcp-backed agents as agent__<name> tools"
```

---

## Task 5: Dashboard CRUD for MCP-backed agents

**Files:**
- Modify: `src/dashboard/routes.ts` (the `POST /api/agents` and `PATCH /api/agents/:id` handlers)
- Modify: `src/dashboard/v2/src/page-agents.jsx`

- [ ] **Step 1: Locate the agent CRUD handlers**

```bash
grep -n "/api/agents" src/dashboard/routes.ts | head
```
Note the handler for `POST /api/agents` (creates) and `PATCH /api/agents/:id` (updates).

- [ ] **Step 2: Pass the new fields through on POST**

In the POST handler, where the body is unpacked into `createAgent({...})`, add:

```ts
mcp_server_id:   body.mcp_server_id ?? null,
mcp_tool_name:   body.mcp_tool_name ?? null,
mcp_input_field: body.mcp_input_field ?? null,
```

Also add a guard before `createAgent`:

```ts
if (body.provider === 'mcp' && (!body.mcp_server_id || !body.mcp_tool_name)) {
  return c.json({ ok: false, error: 'provider=mcp requires mcp_server_id and mcp_tool_name' }, 400);
}
```

- [ ] **Step 3: Pass the new fields through on PATCH**

In the PATCH handler, where the body is forwarded to `updateAgentRecord()`, ensure `mcp_server_id`, `mcp_tool_name`, `mcp_input_field` are in the allow-list of patch keys (mirror how `vision_mode` is handled).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Smoke-verify CRUD via curl**

Start the dashboard (`npm run dashboard &`, sleep 3). Create a stub MCP server row directly in SQLite to use as a foreign key target:

```bash
TOKEN=$(grep DASHBOARD_TOKEN .env | cut -d= -f2)
sqlite3 ./neuroclaw.db "INSERT INTO mcp_servers (id, name, url, transport, enabled, status) VALUES ('stub-1', 'stub', 'http://localhost:9999', 'http', 1, 'unknown');"

curl -sS -X POST "http://127.0.0.1:3141/api/agents?token=$TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"TestBacked","provider":"mcp","mcp_server_id":"stub-1","mcp_tool_name":"do_thing","mcp_input_field":"query"}' | jq .
```
Expected: `{ok: true, agent: {... provider: "mcp", mcp_server_id: "stub-1" ...}}`. Then clean up:
```bash
sqlite3 ./neuroclaw.db "DELETE FROM agents WHERE name='TestBacked'; DELETE FROM mcp_servers WHERE id='stub-1';"
```
Kill the dashboard.

- [ ] **Step 6: Add the UI form section**

Open `src/dashboard/v2/src/page-agents.jsx`. Find the agent-create/edit form (search for the existing `provider` select). Below the `provider` select, add (using the existing JSX patterns in that file):

```jsx
{form.provider === 'mcp' && (
  <div className="nc-field-group">
    <label className="nc-label">MCP Server</label>
    <select
      className="nc-input"
      value={form.mcp_server_id || ''}
      onChange={e => setForm(f => ({ ...f, mcp_server_id: e.target.value, mcp_tool_name: '' }))}
    >
      <option value="">-- select server --</option>
      {mcpServers.filter(s => s.enabled && s.status === 'ready').map(s => (
        <option key={s.id} value={s.id}>{s.name} ({s.tools_count} tools)</option>
      ))}
    </select>

    <label className="nc-label">Tool</label>
    <select
      className="nc-input"
      value={form.mcp_tool_name || ''}
      onChange={e => setForm(f => ({ ...f, mcp_tool_name: e.target.value }))}
      disabled={!form.mcp_server_id}
    >
      <option value="">-- select tool --</option>
      {(mcpServers.find(s => s.id === form.mcp_server_id)?.tools_cached || []).map(t => (
        <option key={t.name} value={t.name}>{t.name}</option>
      ))}
    </select>

    <label className="nc-label">Input field name</label>
    <input
      className="nc-input"
      placeholder="query"
      value={form.mcp_input_field || ''}
      onChange={e => setForm(f => ({ ...f, mcp_input_field: e.target.value }))}
    />
    <p className="nc-help">JSON field name to put the user's message into when calling the tool. Defaults to "query".</p>
  </div>
)}
```

You will also need to ensure `mcpServers` is fetched alongside the existing data load in this page — search for where `agents` is fetched and add a parallel fetch of `/api/mcp/servers` (or whatever the existing endpoint is — check `routes.ts`). If no MCP server list endpoint exists yet, add one in `routes.ts`:

```ts
app.get('/api/mcp/servers', requireAuth, c => {
  return c.json({ ok: true, servers: listMcpServers() });
});
```

- [ ] **Step 7: Add `mcp` as an option in the provider `<select>`**

In the same file, find the existing provider `<select>` and add:
```jsx
<option value="mcp">MCP-backed (Pydantic AI / external)</option>
```

- [ ] **Step 8: Smoke-verify the UI**

Start the dashboard, open `http://127.0.0.1:3141/dashboard?token=...`, go to Agents tab, click Create, change provider to `mcp` — confirm the new fields appear. (You won't be able to fully test until Task 7 ships a real server.)

- [ ] **Step 9: Commit**

```bash
git add src/dashboard/routes.ts src/dashboard/v2/src/page-agents.jsx
git commit -m "feat(dashboard): create/edit mcp-backed agents from the UI"
```

---

## Task 6: Pydantic-agents directory scaffold

**Files:**
- Create: `pydantic-agents/README.md`
- Create: `pydantic-agents/requirements.txt`
- Create: `pydantic-agents/.env.example`
- Create: `pydantic-agents/run-all.sh`
- Modify: `package.json`
- Modify: `.env.example` (root)

- [ ] **Step 1: Create the requirements file**

`pydantic-agents/requirements.txt`:
```
pydantic-ai-slim[openai]>=0.0.20
fastmcp>=0.4.0
uvicorn>=0.30
python-dotenv>=1.0
httpx>=0.27
tavily-python>=0.5
```

- [ ] **Step 2: Create the env template**

`pydantic-agents/.env.example`:
```
# Shared LLM key — these agents call OpenAI-compatible endpoints just like NeuroClaw.
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.voidai.app/v1
PYDANTIC_AGENT_MODEL=gpt-5.1

# Per-agent ports — must match what NeuroClaw registers in mcp_servers
PYDANTIC_DEEP_RESEARCH_PORT=7100
PYDANTIC_WEB_RESEARCH_PORT=7101

# Tool API keys
TAVILY_API_KEY=
```

- [ ] **Step 3: Create the run script**

`pydantic-agents/run-all.sh`:
```bash
#!/usr/bin/env bash
# Starts every Pydantic AI agent in pydantic-agents/. Each agent runs in
# its own python process and exposes itself as an MCP server on its own
# port (see .env). Foreground; Ctrl+C kills both.

set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then set -a; source .env; set +a; fi

python -m deep_research.agent &
DR_PID=$!
python -m web_research.agent &
WR_PID=$!

trap "kill $DR_PID $WR_PID 2>/dev/null || true" EXIT INT TERM
wait
```
Then `chmod +x pydantic-agents/run-all.sh`.

- [ ] **Step 4: Create the README**

`pydantic-agents/README.md`:
```markdown
# Pydantic AI Agents

External Python agents NeuroClaw can talk to over MCP. Each agent is a standalone
process that exposes itself as an MCP HTTP server. Register the URL in NeuroClaw's
dashboard (MCP Servers tab), then create an Agent with provider=`mcp` pointing
at one of the server's tools.

## Install

```bash
cd pydantic-agents
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # fill in OPENAI_API_KEY and TAVILY_API_KEY
```

## Run

From the repo root:
```bash
npm run pydantic:run
```

Or directly:
```bash
cd pydantic-agents && ./run-all.sh
```

## Register in NeuroClaw

1. Open the dashboard → MCP Servers → Add server
   - Deep Research: `http://localhost:7100/mcp`
   - Web Research:  `http://localhost:7101/mcp`
   - Transport: `http`
2. Probe — confirm tool list appears.
3. Open Agents → Create agent
   - Provider: `mcp`
   - MCP Server: pick one
   - Tool: `deep_research` or `web_search_summarize`
   - Input field: `query`

The agent now appears as `@DeepResearch` in Discord/CLI and as `agent__deepresearch(query)` in every other agent's tool list.
```

- [ ] **Step 5: Add npm scripts**

In `package.json`, add to the `scripts` block:
```json
"pydantic:install": "cd pydantic-agents && python -m venv .venv && .venv/bin/pip install -r requirements.txt",
"pydantic:run": "cd pydantic-agents && ./run-all.sh"
```

- [ ] **Step 6: Update root `.env.example`**

Append to `.env.example`:
```
# Pydantic AI bridge — see pydantic-agents/README.md
PYDANTIC_DEEP_RESEARCH_URL=http://localhost:7100/mcp
PYDANTIC_WEB_RESEARCH_URL=http://localhost:7101/mcp
```

- [ ] **Step 7: Commit**

```bash
git add pydantic-agents/ package.json .env.example
git commit -m "feat(pydantic): scaffold pydantic-agents directory and run scripts"
```

---

## Task 7: Example agent — deep-research

**Files:**
- Create: `pydantic-agents/deep_research/__init__.py` (empty)
- Create: `pydantic-agents/deep_research/agent.py`

- [ ] **Step 1: Create the package init**

```bash
mkdir -p pydantic-agents/deep_research
touch pydantic-agents/deep_research/__init__.py
```

- [ ] **Step 2: Write the agent**

`pydantic-agents/deep_research/agent.py`:

```python
"""Deep Research agent — multi-pass Tavily search + synthesis, exposed as an MCP server.

Tool: deep_research(query: str) -> str
  1. Decomposes the query into 3 sub-questions.
  2. Runs Tavily search for each sub-question in parallel.
  3. Asks the LLM to synthesize a comprehensive markdown report citing sources.
"""

from __future__ import annotations

import asyncio
import os
from dotenv import load_dotenv
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider
from tavily import TavilyClient
from fastmcp import FastMCP

load_dotenv()

MODEL_NAME = os.getenv("PYDANTIC_AGENT_MODEL", "gpt-5.1")
PORT = int(os.getenv("PYDANTIC_DEEP_RESEARCH_PORT", "7100"))

provider = OpenAIProvider(
    base_url=os.getenv("OPENAI_BASE_URL", "https://api.voidai.app/v1"),
    api_key=os.environ["OPENAI_API_KEY"],
)
model = OpenAIModel(MODEL_NAME, provider=provider)
tavily = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])

planner = Agent(
    model=model,
    system_prompt=(
        "You break a research question into exactly 3 focused sub-questions that, "
        "when answered together, would give a complete picture. Reply with a JSON "
        "array of 3 strings and nothing else."
    ),
)

synthesizer = Agent(
    model=model,
    system_prompt=(
        "You write comprehensive markdown research reports. You will be given a "
        "user query and a list of web-search results (title, url, snippet). "
        "Produce a well-structured report with section headers, key findings, "
        "and a Sources section that cites every URL you used."
    ),
)


async def _search(question: str) -> list[dict]:
    res = await asyncio.to_thread(tavily.search, query=question, max_results=5, search_depth="advanced")
    return res.get("results", [])


async def deep_research(query: str) -> str:
    plan_result = await planner.run(query)
    raw = plan_result.output.strip()
    # Tolerate code-fenced JSON
    if raw.startswith("```"):
        raw = raw.strip("`").lstrip("json").strip()
    import json
    try:
        sub_questions = json.loads(raw)
        if not isinstance(sub_questions, list) or len(sub_questions) == 0:
            sub_questions = [query]
    except json.JSONDecodeError:
        sub_questions = [query]

    search_results = await asyncio.gather(*(_search(q) for q in sub_questions))
    flat: list[dict] = []
    for q, results in zip(sub_questions, search_results):
        for r in results:
            flat.append({"sub_question": q, "title": r.get("title"), "url": r.get("url"), "content": r.get("content")})

    synthesis_input = (
        f"User query: {query}\n\n"
        f"Sub-questions explored:\n" + "\n".join(f"- {q}" for q in sub_questions) + "\n\n"
        f"Search results:\n{json.dumps(flat, indent=2)}"
    )
    report = await synthesizer.run(synthesis_input)
    return report.output


mcp = FastMCP("deep-research")


@mcp.tool()
async def deep_research_tool(query: str) -> str:
    """Run a multi-pass deep research investigation. Returns a markdown report with cited sources."""
    return await deep_research(query)


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=PORT)
```

Note: the FastMCP `@mcp.tool` registers the function as a tool whose name comes from the function name. So in NeuroClaw's dashboard, the tool will be called `deep_research_tool`. Document this in the README so users know which tool name to pick.

- [ ] **Step 3: Smoke-verify the agent starts**

```bash
cd pydantic-agents
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # then edit to fill OPENAI_API_KEY + TAVILY_API_KEY
python -m deep_research.agent &
sleep 2
curl -sS http://127.0.0.1:7100/mcp -H 'Accept: text/event-stream' --max-time 1 || true  # just confirm a connection lands
kill %1 2>/dev/null || true
```
Expected: the curl either prints SSE headers or hits a normal MCP handshake error — both confirm the port is bound. If you get connection refused, the agent didn't start; check logs.

- [ ] **Step 4: Commit**

```bash
git add pydantic-agents/deep_research/
git commit -m "feat(pydantic): add deep-research example agent"
```

---

## Task 8: Example agent — web-research

**Files:**
- Create: `pydantic-agents/web_research/__init__.py` (empty)
- Create: `pydantic-agents/web_research/agent.py`

- [ ] **Step 1: Create the package init**

```bash
mkdir -p pydantic-agents/web_research
touch pydantic-agents/web_research/__init__.py
```

- [ ] **Step 2: Write the agent**

`pydantic-agents/web_research/agent.py`:

```python
"""Web Research agent — single-pass Tavily search + summary, exposed as MCP.

Tool: web_search_summarize(query: str) -> str
  Runs one Tavily search (5 results), asks the LLM to produce a tight
  paragraph + bullet list summary with inline source links.
"""

from __future__ import annotations

import asyncio
import json
import os

from dotenv import load_dotenv
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider
from tavily import TavilyClient
from fastmcp import FastMCP

load_dotenv()

MODEL_NAME = os.getenv("PYDANTIC_AGENT_MODEL", "gpt-5.1")
PORT = int(os.getenv("PYDANTIC_WEB_RESEARCH_PORT", "7101"))

provider = OpenAIProvider(
    base_url=os.getenv("OPENAI_BASE_URL", "https://api.voidai.app/v1"),
    api_key=os.environ["OPENAI_API_KEY"],
)
model = OpenAIModel(MODEL_NAME, provider=provider)
tavily = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])

summarizer = Agent(
    model=model,
    system_prompt=(
        "You produce tight web-research summaries. Given a query and a list of "
        "search results, write a 2-3 sentence overview followed by 3-6 bullet "
        "points of key findings. Embed source URLs inline as markdown links."
    ),
)


async def _search(query: str) -> list[dict]:
    return (await asyncio.to_thread(tavily.search, query=query, max_results=5)).get("results", [])


async def web_search_summarize(query: str) -> str:
    results = await _search(query)
    summary = await summarizer.run(
        f"Query: {query}\n\nResults:\n{json.dumps(results, indent=2)}"
    )
    return summary.output


mcp = FastMCP("web-research")


@mcp.tool()
async def web_search_summarize_tool(query: str) -> str:
    """Search the web and return a concise summary with cited sources."""
    return await web_search_summarize(query)


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=PORT)
```

- [ ] **Step 3: Smoke-verify**

```bash
cd pydantic-agents && source .venv/bin/activate
python -m web_research.agent &
sleep 2
curl -sS http://127.0.0.1:7101/mcp -H 'Accept: text/event-stream' --max-time 1 || true
kill %1 2>/dev/null || true
```
Expected: port 7101 bound.

- [ ] **Step 4: Commit**

```bash
git add pydantic-agents/web_research/
git commit -m "feat(pydantic): add web-research example agent"
```

---

## Task 9: End-to-end smoke test (CLI + Discord)

**No files written — this is verification only.**

- [ ] **Step 1: Boot everything**

In three terminals:
```bash
# Terminal A: NeuroClaw dashboard
npm run dashboard

# Terminal B: Pydantic agents
npm run pydantic:run

# Terminal C: NeuroClaw CLI (later)
```

- [ ] **Step 2: Register both MCP servers**

In the dashboard (MCP Servers tab), add:
- Name: `deep-research`, URL: `http://localhost:7100/mcp`, Transport: `http`
- Name: `web-research`,  URL: `http://localhost:7101/mcp`, Transport: `http`

Click Probe on each. Both should reach `status=ready` with 1 tool cached.

- [ ] **Step 3: Create two backed agents**

In the Agents tab → Create:
- Name: `DeepResearch`,  Provider: `mcp`, MCP Server: `deep-research`, Tool: `deep_research_tool`,        Input field: `query`
- Name: `WebResearch`,   Provider: `mcp`, MCP Server: `web-research`,  Tool: `web_search_summarize_tool`, Input field: `query`

- [ ] **Step 4: Test CLI direct mention**

In Terminal C:
```bash
npm run dev
# At the prompt:
> @WebResearch what are the latest features in pydantic-ai?
```
Expected: a markdown summary with cited sources comes back. Check `Hive Mind` events in the dashboard for `mcp_call_start` and `mcp_call_ok`.

- [ ] **Step 5: Test tool-call usage**

```bash
> ask Researcher to use the web_research agent tool to find recent llm benchmark results
```
The local `Researcher` agent should pick up the `agent__webresearch` tool from its tool list and call it. Verify in Hive Mind that the tool call ran.

- [ ] **Step 6: Test Discord routing**

If a Discord bot is configured: in any channel mapped to Alfred (or to no specific agent), send `@DeepResearch what's the latest on multi-agent frameworks`. Confirm a reply lands. Then in the dashboard's Channels tab, route a specific channel directly to `DeepResearch`. Send a plain message in that channel — it should go to DeepResearch without needing the @-mention.

- [ ] **Step 7: Commit any incidental fixes**

If any of steps 4–6 surfaced bugs and you fixed them, commit each fix as its own atomic commit with a clear message.

---

## Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Add a "Pydantic AI Bridge" section to CLAUDE.md**

Insert into `CLAUDE.md` after the "Spawn intelligence" architecture paragraph:

```markdown
**Pydantic AI bridge** (`src/agent/mcp-backed-agent.ts`, `src/tools/adapters/mcp-backed-agent-adapter.ts`): Agents with `provider='mcp'` are not local LLM agents — they proxy directly to a registered MCP server's tool. `chatStreamMcp()` calls the tool with the user's message in the configured input field (default `query`) and returns the tool's text output as the assistant message. The same agent is auto-synthesized as an `agent__<sanitized_name>` tool in every local agent's tool list, so any local agent can delegate to it mid-turn. Example Python agents live in `pydantic-agents/` and are run with `npm run pydantic:run`.
```

- [ ] **Step 2: Add a "Pydantic AI agents" section near the bottom of CLAUDE.md**

```markdown
## Pydantic AI agents

External Python agents lives in `pydantic-agents/`. Each is a standalone Python process exposing a `fastmcp` HTTP MCP server. Register them in the dashboard (MCP Servers tab), then create a NeuroClaw agent with `provider='mcp'` pointing at the server + tool name. See `pydantic-agents/README.md` for the full setup.
```

- [ ] **Step 3: Add a quick-start blurb to README.md**

In `README.md`, find the existing setup/quickstart section and add:
```markdown
### Optional: Pydantic AI agents

NeuroClaw can talk to external Python (Pydantic AI) agents. Two example agents
ship in `pydantic-agents/` (deep-research, web-research). See
[`pydantic-agents/README.md`](./pydantic-agents/README.md) for setup.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document the pydantic ai bridge and example agents"
```

---

## Self-Review Notes

- **Spec coverage:**
  - Bridge as routable agent → Tasks 1–3
  - Bridge as shared tool → Task 4
  - Pydantic agents shipped in repo → Tasks 6–8
  - Discord routing works (basic + per-channel) → already free; verified in Task 9 step 6
  - End result returned (no streaming) → Task 2 step 1 returns the entire output as one chunk

- **Type/name consistency check:**
  - DB columns: `mcp_server_id`, `mcp_tool_name`, `mcp_input_field` — used identically in DB (Task 1), dispatcher (Task 2), tool adapter (Task 4), dashboard routes (Task 5).
  - Tool name convention: `agent__<sanitized_name>` — defined in Task 4.
  - MCP tool names from FastMCP: function names with `_tool` suffix as written (`deep_research_tool`, `web_search_summarize_tool`) — referenced in Task 9 step 3.
  - `chatStreamMcp` signature matches the call site in Task 3 (positional args: userMessage, sessionId, onChunk, agentRecord, onMeta).
  - `MetaEvent` variants `mcp_call_start` / `mcp_call_done` / `error` — added in Task 2 step 3, emitted in Task 2 step 1.

- **Open risks:**
  - `extractText()` in Task 2 assumes MCP `content` shape — if Pydantic's FastMCP returns a different envelope, the smoke test in Task 9 will surface it; fix there.
  - Task 4's adapter merge depends on the exact code shape of each adapter — implementer must follow the existing `getMcpRegistryTools()` call pattern in each file rather than copy a generic snippet.
  - The Discord channel route from Task 9 step 6 assumes a route can target any agent ID — confirmed by the existing `discord_channel_routes(bot_id, channel_id, agent_id)` schema.
