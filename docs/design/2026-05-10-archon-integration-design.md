# Archon MCP Deep Integration Design

**Date:** 2026-05-10
**Status:** Approved

## Goal

Make Archon MCP the active knowledge and task backbone for all NeuroClaw agents — not just a tool they can call when prompted, but something they use automatically before implementing and throughout their work lifecycle. Every agent in the fleet participates: Alfred, Researcher, Coder, Planner, user-created agents, and spawned temps.

## Scope

Two features, no new infrastructure:

1. **Auto-RAG** — agents automatically search Archon's knowledge base before implementing
2. **Task lifecycle** — agents automatically update Archon task status as they work, with authority split between Alfred (orchestrator) and all other agents (executors)

Out of scope: Crawl4AI ingestion pipeline (handled separately), dashboard UI changes, new API routes, schema migrations.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  ARCHON MCP SERVER                   │
│  mcp__archon__rag_search_knowledge_base              │
│  mcp__archon__rag_search_code_examples               │
│  mcp__archon__rag_get_available_sources              │
│  mcp__archon__find_tasks / manage_task               │
│  mcp__archon__find_projects / manage_project         │
└──────────┬───────────────────────────────────────────┘
           │ all agents call via existing MCP client
           ▼
┌──────────────────────────────────────────────────────┐
│              chatStream() — alfred.ts                │
│                                                      │
│  history[0] rebuilt every turn (existing pattern)    │
│  + RAG block injected for all agents                 │
│  + Task executor block injected for all agents       │
│  + Task orchestrator block injected for Alfred only  │
│                                                      │
│  archon-lifecycle.ts hooks:                          │
│    onTaskStart()  — before stream begins             │
│    onTaskComplete() — after done event               │
└──────────────────────────────────────────────────────┘
```

## Feature 1: Auto-RAG Injection

### Where

`src/agent/alfred.ts` — in the function that builds/rebuilds `history[0]` for each agent per turn. Alfred already has separate builders for the orchestrator prompt and the sub-agent "Active team members" append. The RAG block appends to both paths.

### Injected text (all agents)

```
## Research Before Implementation

Before writing any code or detailed implementation:
1. Call mcp__archon__rag_search_knowledge_base with a 2-5 keyword query
2. Call mcp__archon__rag_search_code_examples if looking for patterns or examples
3. Use what you find to inform your approach — briefly note findings or confirm nothing was found
Skip this only for conversational replies or simple factual questions.
```

### Behavior

- Transparent and inspectable — the agent explains what it found, not a black-box middleware intercept
- Agent decides when to skip (conversational turns don't need a RAG search)
- Works for all agents because `chatStream()` is the single entry point for the whole fleet

## Feature 2: Task Lifecycle

### Authority split

| Capability | All agents | Alfred only |
|---|---|---|
| Find tasks assigned to self | ✓ | ✓ |
| Update own task status (doing/review/done) | ✓ | ✓ |
| Create new tasks | — | ✓ |
| Assign tasks to agents | — | ✓ |
| Check review queue | — | ✓ |

### Injected text (all agents)

The agent's actual name is interpolated at prompt-build time (same pattern as the existing "Active team members" section). The string `${agent.name}` below is a TypeScript template variable, not a literal.

```
## Task Awareness

At the start of work, check what is assigned to you:
  mcp__archon__find_tasks(filter_by="assignee", filter_value="${agent.name}")

Update your status as you work:
  mcp__archon__manage_task("update", task_id="...", status="doing")   — when you begin
  mcp__archon__manage_task("update", task_id="...", status="review")  — when you finish
  mcp__archon__manage_task("update", task_id="...", status="done")    — when verified complete
```

### Additional injected text (Alfred only)

```
## Task Orchestration

When the user's request represents meaningful work:
  mcp__archon__manage_task("create", title="...", assignee="<agent>", project_id="...")

After specialists report back, check for items needing verification:
  mcp__archon__find_tasks(filter_by="status", filter_value="review")

Assign tasks to the specialist best suited — Researcher for investigation,
Coder for implementation, Planner for decomposition.
```

### Middleware: `src/system/archon-lifecycle.ts`

Handles automatic status updates for task IDs detected in incoming messages, as a safety net alongside the prompt-level guidance.

```typescript
// Exported interface
export async function onTaskStart(message: string, agentId: string): Promise<void>
export async function onTaskComplete(taskIds: string[], agentId: string): Promise<void>
```

**`onTaskStart`:**
1. Extract task IDs from message via regex — verify Archon's actual task ID format (UUID or slug) by calling `mcp__archon__session_info` during implementation before finalizing the pattern
2. For each ID, call `mcp__archon__manage_task("update", status="doing")`
3. Log to hive mind: `action="archon_task_started"`, metadata includes agentId + taskId

**`onTaskComplete`:**
1. For each tracked task ID, call `mcp__archon__manage_task("update", status="review")`
2. Log to hive mind: `action="archon_task_reviewed"`

Both functions are wrapped in try/catch and never throw — same pattern as `logHive()`.

### Hook points in `chatStream()` (`alfred.ts`)

```
chatStream() called
  → onTaskStart(userMessage, agentId)   ← before stream begins
  → [existing: rebuild history[0], resolve agent, stream tokens]
  → onTaskComplete(detectedTaskIds, agentId)  ← after done event emitted
```

## Implementation Files

| File | Change |
|---|---|
| `src/agent/alfred.ts` | Add RAG block + task blocks to history[0] rebuild; call onTaskStart/onTaskComplete |
| `src/system/archon-lifecycle.ts` | New file — onTaskStart, onTaskComplete, task ID extraction |

No other files change. No new routes, no schema migrations, no env vars.

## What Doesn't Change

- CLAUDE.md — Archon tool names already referenced there stay identical
- All existing agent prompts in the DB — the injection is additive at runtime
- Routing, decomposer, hive mind, cleanup scheduler — untouched
- MCP client — already handles Archon connections

## Success Criteria

- Any agent (not just Alfred) that receives a message containing a task ID automatically marks it `doing` before responding and `review` after
- Any agent that is about to write code calls `rag_search_knowledge_base` first, without being manually prompted
- Alfred creates Archon tasks when decomposing complex user requests and assigns them to the right specialist
- No existing behavior regresses — conversational turns don't trigger unnecessary RAG calls
