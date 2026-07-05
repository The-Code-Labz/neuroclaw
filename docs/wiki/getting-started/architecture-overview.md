---
title: Architecture overview
order: 20
---

# Architecture overview

NeuroClaw is a multi-agent orchestration system with three main layers.

## System diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Presentation Layer                           │
│                                                                     │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐            │
│   │  Dashboard  │    │ Discord Bot │    │     CLI     │            │
│   │(Hono+React) │    │             │    │             │            │
│   └──────┬──────┘    └──────┬──────┘    └──────┬──────┘            │
└──────────┼──────────────────┼──────────────────┼────────────────────┘
           │                  │                  │
           └──────────────────┼──────────────────┘
                              │
┌─────────────────────────────┴───────────────────────────────────────┐
│                      Orchestration Layer                            │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │   Alfred    │  │   Router    │  │   Spawner   │  │   Triage   │ │
│  │(orchestrator│  │ (@mentions) │  │(temp agents)│  │(model pick)│ │
│  └──────┬──────┘  └─────────────┘  └─────────────┘  └────────────┘ │
│         │                                                           │
│  ┌──────┴──────────────────────────────────────────────────────┐   │
│  │                      Tool Registry                           │   │
│  │  47 native tools + dynamic MCP tools + Composio              │   │
│  │  Memory | Agents | Exec | Discord | Audio | Browser | ...    │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
┌─────────────────────────────┴───────────────────────────────────────┐
│                        Backend Layer                                │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │                    AI Providers                                │ │
│  │  VoidAI (API) | Claude CLI | Anthropic (API) | MCP Servers    │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │                    Memory System                               │ │
│  │  Extractor → Scorer → SQLite → Embeddings → NeuroVault        │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │                    SQLite Database                             │ │
│  │  agents | memory_index | sessions | tasks | discord_bots      │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## Entry points

NeuroClaw has two entry points sharing one SQLite database and one agent registry.

### CLI

`src/index.ts` reads stdin, enqueues messages via a FIFO message queue (preventing race conditions), calls `chat()` in `alfred.ts`, streams tokens to stdout, and persists the turn in SQLite.

### Dashboard

`src/dashboard/server.ts` runs a Hono app on `localhost:3141`. The token-protected `/dashboard` route serves a single-page React app. All data APIs live under `/api/*`. `/api/chat` uses Server-Sent Events for streaming.

## Agent registry

The `agents` table is the source of truth. Alfred (orchestrator), Researcher, Coder, and Planner are seeded on every cold start (idempotent). System prompts are always rewritten at seed time, so spawn guidance stays current as you upgrade.

## Request flow

```
User message
     │
     ▼
┌─────────────────┐
│     Router      │ ── Check @mentions, auto-classify, or use default
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Agent (Alfred) │ ◄── System prompt + pre-injected memories
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│    Provider     │────►│  Tool Registry  │ ── Dispatch tool calls
│ (VoidAI/Claude) │◄────│                 │
└────────┬────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐
│ Memory Pipeline │ ── Extract & store (fire-and-forget)
└─────────────────┘
         │
         ▼
   Response to user
```

## Routing

For each user message, `resolveAgent()` walks this priority chain:

1. `@AgentName` prefix — routes directly, strips the mention
2. LLM auto-classifier (when `AUTO_DELEGATION_ENABLED=true`)
3. Explicit `agentId` from the dashboard agent dropdown
4. Alfred as the final fallback

## Multi-agent orchestration

When Alfred handles a message, `decomposeTask()` makes an LLM call to decide whether multiple specialists are needed. Complex tasks run as a chain of steps, each step's output piped as context into the next, with `mergeResults()` producing a unified final response.

## Tool system

All tools are defined in a single registry (`src/tools/registry.ts`) and exposed through multiple adapters:

- **OpenAI adapter** — Function calling for VoidAI/OpenAI
- **Claude SDK adapter** — In-process MCP for Claude Agent SDK
- **HTTP MCP adapter** — Streamable HTTP for external clients
- **Composio adapter** — External tool integration

Access gates control which tools are visible to each agent based on configuration and permissions.

## Memory system

The memory pipeline runs asynchronously after each chat turn:

1. **Extract** — LLM extracts structured candidate from exchange
2. **Score** — Weighted importance calculation (0-1)
3. **Store** — Write to SQLite `memory_index`
4. **Embed** — Generate vector embedding (if enabled)
5. **Mirror** — Sync to NeuroVault (if configured)

Memory is retrieved at the start of each turn and pre-injected into the agent's context.

## Hive Mind

Every routing decision, spawn, task change, and lifecycle event lands in the `hive_mind` table. The Dashboard's **Hive Mind** tab streams these in real time.

## Where things live

| Component | Location |
|-----------|----------|
| Agent orchestration | `src/agent/` |
| Tool definitions | `src/tools/registry.ts` |
| Memory pipeline | `src/memory/` |
| MCP integration | `src/mcp/` |
| Dashboard server | `src/dashboard/server.ts` |
| Background tasks | `src/system/` |
| Database schema | `src/db.ts` |
| Configuration | `src/config.ts` |

See **Reference → API endpoints** and **Reference → Env vars** for the complete inventory.
