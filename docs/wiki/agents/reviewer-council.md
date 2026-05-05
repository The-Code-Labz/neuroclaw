---
title: Reviewer council
order: 40
---

# Reviewer council

The reviewer council is an optional quality gate that runs after Alfred's multi-agent orchestration produces a merged result. When `REVIEW_LOOP_ENABLED=true`, three narrow Pydantic AI reviewer agents fan out in parallel to critique the merged output before it is delivered to the user. Single-agent responses are never affected.

## The three reviewers

Each reviewer evaluates exactly one dimension and returns a structured JSON verdict (`passed`, `severity`, `issues`, `summary`). They are backed by `pydantic-agents/reviewer_council/agent.py` and exposed as MCP tools.

| Reviewer | MCP tool | What it checks |
|---|---|---|
| `code_quality` | `review_code_quality` | Bugs, weak typing, duplication, unsafe patterns, missing error handling |
| `runtime` | `review_runtime` | Undefined references, broken imports, unhandled async errors, resource leaks |
| `completion` | `review_completion` | Whether every explicit and implicit requirement in the original request was met |

## The review loop

1. Alfred completes multi-agent orchestration and calls `mergeResults()` to produce a draft.
2. `reviewArtifact()` calls all three MCP tools via `Promise.allSettled` — they run in parallel, keeping added latency low.
3. Each reviewer returns a verdict. An issue rated `high` or `critical` is treated as blocking regardless of the `passed` flag.
4. If all three reviewers pass and no blocking issues exist, the draft ships immediately.
5. If any reviewer fails, the structured feedback is injected back into the merge context and Alfred re-merges with the issues as guidance.
6. Steps 2–5 repeat up to `REVIEW_LOOP_MAX_ITERATIONS` times (default `3`).
7. After the iteration limit is reached, the latest draft ships with any remaining reviewer feedback noted inline.

**Fail-open guarantee**: if a reviewer's MCP call fails (network error, process down), that reviewer is treated as passing so a broken reviewer can never block a response on its own.

## Hive Mind events

Every review cycle emits one of:

- `review_passed` — all reviewers passed; includes pass count, timing, and per-reviewer issue counts.
- `review_failed` — at least one reviewer failed; blocking issue count included.

Both events are visible on the **Hive Mind** tab of the dashboard.

## Setup

1. Start the reviewer council process:

   ```bash
   cd pydantic-agents
   python -m reviewer_council.agent
   ```

   The process binds to `127.0.0.1` on port `7102` by default (controlled by `PYDANTIC_REVIEWER_COUNCIL_PORT`).

2. Add the following to your `.env`:

   ```env
   REVIEW_LOOP_ENABLED=true
   REVIEWER_COUNCIL_URL=http://127.0.0.1:7102/mcp
   REVIEW_LOOP_MAX_ITERATIONS=3        # optional, default 3
   PYDANTIC_REVIEWER_COUNCIL_PORT=7102 # optional, default 7102
   ```

3. Restart the NeuroClaw server. No dashboard registration is required — `review-council.ts` calls the MCP endpoint directly.

## When to enable this

Enable the reviewer council when response quality matters more than latency — for example, when agents are producing code, technical plans, or detailed structured output. Because reviewers run in parallel and the loop only fires on the multi-agent path, the overhead for simple single-agent chat is zero. For quick conversational use keep `REVIEW_LOOP_ENABLED=false`.
