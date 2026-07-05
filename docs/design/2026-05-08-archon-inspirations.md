# Archon → NeuroClaw: Inspirations & Recommendations

**Date:** 2026-05-08
**Source:** [coleam00/Archon](https://github.com/coleam00/Archon) @ `dev` (v0.3.10, 21k stars)
**Status:** Note / proposal — not yet planned

## Context

Archon is an open-source "harness builder" that wraps AI coding agents (Claude
Code SDK, Codex SDK, Pi) in deterministic YAML workflows. NeuroClaw and Archon
overlap in the *substrate* (queue, sessions, slash commands, MCP, multi-provider,
dashboard) but diverge in the *execution model*:

- **NeuroClaw** today: imperative TS orchestration (`decomposer`, `hive-mind`,
  `review-council`, `task-manager`) with multi-agent registry + Discord/voice.
- **Archon**: declarative YAML DAGs + git-worktree isolation + run-resume.

The recommendations below pull what we lack, ignore what we already cover, and
prioritize by ROI.

## Recommendations (priority order)

### 1. YAML DAG workflows — **highest ROI**

**What it is.** `.archon/workflows/*.yaml` files describing a graph of typed
nodes:

| Node kind   | Purpose                                                              |
| ----------- | -------------------------------------------------------------------- |
| `prompt:`   | AI step (inline prompt, optional model/provider override)            |
| `bash:`     | Shell command, stdout captured as `$nodeId.output`, no AI            |
| `script:`   | Inline TS/Python or named script, stdout captured, no AI             |
| `command:`  | Reference a named markdown command file                              |
| `loop:`     | Iterate `until: SIGNAL`; supports `fresh_context: true` per iter     |
| `approval:` | Human gate; pauses run until `/workflow approve` or `reject`         |

Plus: `depends_on`, `when:` conditions, `trigger_rule` join semantics,
`$nodeId.output` substitution, `output_format` JSON enforcement, per-node
`allowed_tools`/`denied_tools`/`mcp`/`skills`/`hooks`.

**Why it matters for NeuroClaw.** Today our orchestration is hardcoded TS:
`decomposer.ts → spawner.ts → review-council.ts → sentinel.ts`. To add a step or
re-order, we ship code. YAML lets us:

- Express any agent flow as a graph, version-controlled per repo
- Mix deterministic nodes (bash, script) with AI nodes — AI runs only where it
  adds value
- Get free parallelism: independent nodes in the same topo layer run concurrently
- Drop the workflow into `slash-registry` as `/workflow run <name>`

**Where it slots in.** New `src/workflows/` module:

- `loader.ts` — Zod schema + YAML parse
- `dag-executor.ts` — uses existing `src/queue.ts` for layer-parallel exec
- `router.ts` — name resolution (exact → case-insensitive → suffix → substring)
- Bundled defaults in `src/workflows/defaults/`, repo overrides in
  `.nclaw/workflows/`, user overrides in `~/.nclaw/workflows/` (mirrors our
  existing skills 4-root pattern)

### 2. Git worktree isolation per run

**What it is.** Every workflow run gets a fresh worktree on a generated branch
(e.g. `archon/task-<id>`). Auto-detects base branch, auto-cleans worktrees with
merged branches.

**Why.** Our `cli-code.ts` runs in the live checkout. A second concurrent
coding task today fights the first. Worktrees give us:

- Fire-and-forget parallelism (run 5 tasks at once without conflicts)
- Natural rollback (delete worktree = throw away the attempt)
- Clean diff scope per run
- Use git's own guardrails (refuse to remove worktree with uncommitted changes)

**Where it slots in.** `src/system/worktree-manager.ts` + new SQLite table
`nclaw_worktrees(path, branch, run_id, base_branch, status, created_at)`. Wire
into `job-worker.ts` so spawned coding jobs land in their own worktree.

### 3. Run-resume semantics

**What it is.** `workflow_runs` + `workflow_events` tables track step-level
state. `archon workflow resume <run-id>` re-executes but **skips completed
nodes**. Combined with `fresh_context: true` on loop nodes to prevent context
bloat across iterations.

**Why.** A 30-minute decomposer run that fails on step 7 today restarts at
step 1. With resume:

- Flaky upstream API (VoidAI 500s, Claude rate limits) doesn't burn the whole run
- Long hive-mind flows become safe to interrupt
- Failed runs become diagnosable from the event log instead of stdout scrolling

**Where it slots in.** Extend `db.ts` schema:

```sql
CREATE TABLE nclaw_workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL,  -- pending | running | succeeded | failed | cancelled
  started_at INTEGER,
  ended_at INTEGER,
  worktree_id TEXT,
  base_input TEXT
);
CREATE TABLE nclaw_workflow_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,    -- node_started | node_completed | node_failed | artifact_written
  data TEXT,             -- JSON
  ts INTEGER NOT NULL
);
```

### 4. Bundled defaults + repo + user overrides

**What it is.** Workflow load priority: bundled < `~/.nclaw/workflows/` <
`<repo>/.nclaw/workflows/`. Same-name in higher tier overrides lower.

**Why.** This is exactly the pattern our `skills/` system uses already (per
AGENTS.md: 4 roots, first wins). Extending the same convention to workflows and
commands gives us a single mental model.

**Where it slots in.** `discoverWorkflowsWithConfig(cwd)` in
`src/workflows/discovery.ts`. Reuse the resolution logic from
`src/skills/`.

### 5. "No autonomous lifecycle mutation" discipline

**What it is.** Quoted directly from Archon's CLAUDE.md:

> When a process cannot reliably distinguish "actively running elsewhere" from
> "orphaned by a crash" — it must not autonomously mark that work as
> failed/cancelled/abandoned based on a timer or staleness guess. Surface the
> ambiguous state to the user.

**Why.** We have several heuristic-driven cleanups that risk destructive state
mutation across process boundaries:

- `src/system/session-cleanup.ts`
- `src/system/task-health.ts`
- `src/system/cleanup.ts`
- `src/system/session-queue-manager.ts`

If any of them mark a CLI-initiated session as failed because it looks idle,
that's the same anti-pattern. Worth a one-time audit pass against this rule.

## Lower-priority but interesting

- **`$ARTIFACTS_DIR` per run.** Pre-created scratch dir injected into prompt
  context, served via an API route, never enters git. Clean home for generated
  files. Maps to a `uploads/runs/<id>/` convention.
- **`output_format: { schema: ... }` per node.** SDK-enforced JSON for
  Claude/Codex, prompt-augmented best-effort for OpenRouter/Pi. Could integrate
  with `src/tools/schemas.ts`.
- **Per-node `allowed_tools` / `denied_tools` / `mcp` / `skills`.** Fine-grained
  capability gating. Strictly more powerful than our binary `exec_enabled`
  per-agent flag.
- **Anonymous telemetry pattern.** Single `workflow_invoked` event, no PII,
  honors `DO_NOT_TRACK=1`. Worth copying *if* we ever ship neuroclaw beyond a
  single-user tool.

## Explicitly NOT recommended

- **Bun monorepo with 9 packages.** Overkill for our scope; we're a
  single-developer tool. Stay flat-monolith.
- **Re-implementing platform adapters (Slack/Telegram/GitHub).** Composio
  already covers these for us at lower cost than hand-rolled SDKs.
- **Replacing the dashboard.** Ours runs on `:3141` with watch mode and is
  fine. No reason to swap to Vite/SSE.
- **Multi-provider abstraction rewrite.** Our `agent/{anthropic,openai,openrouter}-client.ts`
  + `cli-code-remote.ts` already cover this. Archon's `IAgentProvider` is the
  same idea, not better enough to justify migration.

## Suggested implementation sequence

If we choose to do this, in order of dependency:

1. **Spike**: `src/workflows/` with YAML loader + Zod schema + linear executor.
   Translate one existing flow (review-council is a good pick) into the first
   YAML.
2. **DAG executor** using `src/queue.ts` for layer-parallel execution.
3. **`workflow_runs` + `workflow_events` tables** + `/workflow resume <id>`.
4. **Worktree manager** + cleanup cron.
5. **Loop nodes with `fresh_context`** — the actual reliability unlock for
   long-running coding tasks.
6. **Approval gates** — wires into Discord bot as human-in-the-loop.

Each step is independently shippable. Steps 1-3 are infrastructure with no
new external dependency. Step 4 needs git worktrees enabled in our repos
(already the case). Steps 5-6 are pure composition on top.

## Design Decisions (2026-05-08)

These were discussed and agreed:

| Question | Decision |
| -------- | -------- |
| **Where do YAMLs live?** | Central in neuroclaw repo only — `src/workflows/defaults/` and `~/.nclaw/workflows/`. No per-target-repo `.nclaw/` dirs. |
| **TS orchestration migration** | Keep TS; add YAML alongside. No rewrite. Translate flows only when useful. |
| **Default worktree isolation?** | Yes — every run gets a worktree by default. Opt out per-workflow with `no_worktree: true`. |
| **First spike workflow** | `review-council` — naturally parallel, clear synthesis step, manageable scope. |
| **Approval gate channel** | Discord bot first (we already run one). Dashboard and CLI are future paths. |

## Open questions (remaining)

- Worktrees vs. our current `~/.agents/` working dirs — do they coexist or
  does worktree replace?
- Exact Zod schema for YAML nodes — mirror Archon's exactly or simplify?
- Does `output_format: json` call Claude's structured output mode or just parse
  the tail of the response?
