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
