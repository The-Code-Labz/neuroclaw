---
title: Testing
order: 50
---

<!-- generated-by: gsd-doc-writer -->

# Testing

NeuroClaw does not ship an automated test framework for the main application. The primary correctness gate is TypeScript type checking, supplemented by a memory pipeline diagnostic, a broker integration test suite, and manual verification workflows.

---

## Type Checking (primary gate)

TypeScript type checking is the first thing to run after making any code change.

```bash
npx tsc --noEmit
```

This compiles every `.ts` file in the project without emitting output and reports type errors. It catches:

- Wrong argument types passed to functions
- Missing required fields on objects
- Incorrect return types from async functions
- Import/export mismatches across modules
- Breaking changes to shared interfaces in `src/db.ts`, `src/config.ts`, and tool schemas

The project has no `--strict` overrides — all strictness flags come from `tsconfig.json`. If `tsc --noEmit` exits with code 0, the project is type-safe. Any non-zero exit means the change must be fixed before merging.

---

## Memory Pipeline Diagnostic

```bash
npm run check:memory
```

This runs `src/diagnostics/memory-check.ts` — an end-to-end smoke test for the memory subsystem. It does not require a test framework; it uses live database connections and real code paths.

**Tests run (in order):**

| # | Name | What it exercises |
|---|------|--------------------|
| 1 | `memory_index INSERT` | SQLite write via `indexMemory()` |
| 2 | `searchMemoryIndex direct hit` | SQLite FTS retrieval |
| 3 | `retrieve() fan-out` | `retrieve()` spanning SQLite, vault, and LM paths |
| 4 | `buildMemoryContextBlock` | Pre-injection formatting of the retrieved context block |
| 5 | `vault write (MCP)` | NeuroVault MCP write (skipped if `MCP_ENABLED=false`) |
| 6 | `vault search` | NeuroVault search round-trip (skipped if MCP disabled) |
| 7 | `vault read-back` | NeuroVault note read after write (skipped if MCP disabled) |
| 8 | `saveSessionSummaryTool` | Session summary persistence |
| 9 | `maybeCompactHistory` | Compaction trigger logic with a synthetic history |

Each check prints `PASS`, `WARN`, `FAIL`, or `SKIP`. The script cleans up its own test rows from SQLite and from the vault (best-effort). It exits with code 1 if any check fails.

**Interpreting results:**

- `WARN` on vault checks is expected when `MCP_ENABLED=false` or when the NeuroVault n8n indexing pipeline lags behind a fresh write.
- `SKIP` on checks 5–7 is normal in a standard `.env` without `MCP_ENABLED=true`.
- `FAIL` on check 1 (SQLite INSERT) indicates a database schema problem — run `npm run doctor` to diagnose.

---

## Broker Test Suite

```bash
npm run test:broker
```

This runs `tests/broker/run-all.ts` using Node's built-in `assert` module and a minimal `it()`/`suite()` helper — no external test framework required.

**Suites covered:**

| Suite | What it tests |
|-------|---------------|
| `agentToken` | HMAC token mint, verify, replay rejection, expiry, tampered signature |
| `scrubber` | Secret redaction (literal, base64, URL-encoded, hex-encoded) from command output |
| `nameParser` | `parseName`, `normalizeAgentPrefix`, `isValidUpperSnake`, `buildName`, `globMatch` |
| `secretManifest` | Loading and validating `.secrets.yaml` files; `findManifestForEntrypoint` resolution |
| `webhook signature format` | Infisical `t=<ts>;<hex>` signature parsing |
| `agentSecrets — types & errors` | `CredentialDeniedError` and `CredentialMissingError` construction |
| `agentRegistry — prefix derivation` | `deriveCanonicalPrefix` for agent names including reserved words |
| `agentSecrets — resolveCredentialForName` | Precedence: agent-prefix > SHARED > NEUROCLAW; fallback; missing; null-prefix agent |
| `agentSecrets — resolveByNameForName` | In-scope resolution, cross-agent denial (without fetching the value), missing |
| `agentSecrets — listAccessible & envBundle` | Scope filtering, `resolveEnvBundleForName` split output |
| `agentSecrets — public wrappers & concurrency` | Parallel resolution across two agents; cross-talk prevention |
| `agentSecrets — degraded storage` | Graceful fallback when the broker storage throws |
| `subprocessSecrets — buildSubprocessEnv` | Env merging, denied/missing reporting, no-op fast path |
| `bash_run — broker secret injection` | Secret injection into child process env; stdout/stderr scrubbing |
| `bash_run schema` | Zod schema parsing for `secrets` and `purpose` fields |
| `secrets_list schema` | Zod schema for optional `service` filter |
| `secretsBlock — buildSecretsBlock` | Renders scoped secrets awareness block; 30-entry cap with overflow line |
| `runSkillScript — broker secret injection` | Secret injection and scrubbing for skill scripts |
| `run_skill_script schema` | Zod schema for `secrets` and `purpose` on skill scripts |

The suite exits with code 1 on the first failure and prints a summary of all failures at the end.

---

## Doctor Script

```bash
npm run doctor
npm run doctor:fix   # auto-repair detected issues
```

`src/doctor/index.ts` checks runtime configuration — database schema, required env vars, agent seed state, and port availability. It is not a test suite but is useful before a first run or after a schema migration.

---

## Manual Testing: Dashboard

Start the dashboard server:

```bash
npm run dashboard
```

The dashboard binds to `http://127.0.0.1:3141`. Access it with `?token=<DASHBOARD_TOKEN>` or set the `x-dashboard-token` header.

**Typical verification flow for a new feature:**

1. Open the **Status** panel — confirm active agent count and last heartbeat timestamp are updating.
2. Open the **Chat** panel — send a message and watch SSE events: `session`, `agent`, `route`, `chunk`, `done`.
3. Open the **Hive Mind** panel — confirm the routing decision was logged with the expected `action` value.
4. Open the **Tasks** panel — if the feature creates tasks, verify status transitions (`todo` → `doing` → `done`).

---

## Manual Testing: API Endpoints with curl

All `/api/*` routes require authentication. Substitute your `DASHBOARD_TOKEN` value:

**Check system status:**

```bash
curl -s "http://127.0.0.1:3141/api/status?token=change-me" | jq .
```

**List agents:**

```bash
curl -s "http://127.0.0.1:3141/api/agents?token=change-me" | jq '.[].name'
```

**Create an agent:**

```bash
curl -s -X POST "http://127.0.0.1:3141/api/agents?token=change-me" \
  -H "Content-Type: application/json" \
  -d '{"name":"TestAgent","description":"Smoke test agent","system_prompt":"You are a test agent."}' | jq .
```

**Send a chat message (SSE stream):**

```bash
curl -s -N -X POST "http://127.0.0.1:3141/api/chat?token=change-me" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello, what can you do?"}' 
```

Each SSE line is prefixed with `data:` and contains a JSON object with an `event` field (`session`, `agent`, `route`, `chunk`, `done`, or `error`).

**Watch background task completions:**

```bash
curl -s -N "http://127.0.0.1:3141/api/tasks/watch?token=change-me"
```

This long-lived SSE stream emits `task_complete` and `task_failed` events when background sub-agent tasks finish.

**Fetch Hive Mind events:**

```bash
curl -s "http://127.0.0.1:3141/api/hive?token=change-me&limit=20" | jq '.[].action'
```

---

## Manual Testing: CLI

```bash
npm run dev:cli
```

Type a message and press Enter. Tokens stream directly to stdout. Use `@AgentName` prefix to route to a specific agent. Press `Ctrl+C` to exit.

---

## Pydantic AI Agents

The Python agents in `pydantic-agents/` are standalone MCP servers. They are not tested by `npm run test:broker` — they have their own manual verification workflow.

**Setup (host venv):**

```bash
npm run pydantic:install
# equivalent to:
# cd pydantic-agents && python -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Copy and fill in the required keys:

```bash
cp pydantic-agents/.env.example pydantic-agents/.env
# set OPENAI_API_KEY and TAVILY_API_KEY (and others as needed)
```

**Start all agents:**

```bash
npm run pydantic:run
# equivalent to: cd pydantic-agents && ./run-all.sh
```

**Verify an individual agent is reachable:**

```bash
# Deep Research agent (port 7100)
curl -s http://localhost:7100/mcp | head -5
```

Each agent exposes an HTTP MCP endpoint. After confirming the endpoint responds, register it in the NeuroClaw dashboard (MCP Servers tab) and create an Agent with `provider=mcp` to exercise the full delegation path.

**Docker (recommended for production-like testing):**

```bash
cd pydantic-agents
cp .env.example .env    # fill in keys
make up                 # build and start all 7 agents
make ps                 # check container status
make logs               # tail combined logs
make down               # stop everything
```

| Agent | Container | Port |
|-------|-----------|------|
| deep-research | pa-deep-research | 7100 |
| web-research | pa-web-research | 7101 |
| reviewer-council | pa-reviewer-council | 7102 |
| notebooklm | pa-notebooklm | 7103 |
| github-agent | pa-github-agent | 7104 |
| crawl4ai | pa-crawl4ai | 7105 |
| image-agent | pa-image-agent | 7106 |

---

## Summary

| Command | Purpose |
|---------|---------|
| `npx tsc --noEmit` | Type-check the entire codebase (primary gate) |
| `npm run check:memory` | Memory pipeline smoke test (8 checks) |
| `npm run test:broker` | Broker unit tests (HMAC tokens, secrets, scrubber, name parser) |
| `npm run doctor` | Runtime configuration health check |
| `npm run doctor:fix` | Auto-repair detected configuration issues |
| `npm run check:claude` | Claude backend connectivity diagnostic |
