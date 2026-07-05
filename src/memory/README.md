# Memory Module

Long-term memory pipeline: extraction, scoring, storage, and retrieval.

## Overview

The memory system automatically extracts, scores, and persists durable information from agent conversations. It provides both passive pre-injection (memories appear in context automatically) and active retrieval via tools.

## Architecture

```
Exchange (user + assistant)
         │
         ▼
┌──────────────────┐
│ Memory Extractor │ ── LLM extracts structured candidate
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Memory Scorer   │ ── Computes importance (0-1)
└────────┬─────────┘
         │ (if score >= threshold)
         ▼
┌──────────────────┐     ┌──────────────────┐
│ SQLite (local)   │────►│ NeuroVault (MCP) │
│  memory_index    │     │    (mirror)      │
└──────────────────┘     └──────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `memory-pipeline.ts` | Orchestrates extract → score → store flow |
| `memory-extractor.ts` | LLM-based extraction of structured memories |
| `memory-scorer.ts` | Weighted importance scoring |
| `memory-retriever.ts` | Hybrid search (vector + lexical + vault) |
| `context-compactor.ts` | Automatic conversation summarization |
| `embeddings.ts` | Vector embedding generation and storage |
| `vault-client.ts` | NeuroVault MCP client |

## Memory Types

| Type | Description |
|------|-------------|
| `working` | Transient in-session notes |
| `episodic` | Specific events or decisions |
| `semantic` | Facts and knowledge |
| `procedural` | How-to procedures and fixes |
| `preference` | User preferences |
| `session_summary` | Compressed conversation summaries |
| `insight` | Meta-patterns across sessions |
| `project` | Project-specific context |
| `agent` | Agent-specific information |

## Usage

```typescript
import { ingestExchangeAsync } from './memory-pipeline';
import { retrieve } from './memory-retriever';

// Store (fire-and-forget, never blocks chat)
ingestExchangeAsync(userMessage, assistantResponse, agentId, sessionId);

// Retrieve
const hits = await retrieve({
  query: 'how to handle rate limiting',
  agentId: 'alfred',
  limit: 10,
});
```

## Configuration

Key environment variables:
- `MEMORY_EXTRACT_MIN_CHARS` — Minimum response length to extract (200)
- `MEMORY_IMPORTANCE_THRESHOLD` — Minimum score to store (0.6)
- `MEMORY_EMBEDDINGS_ENABLED` — Enable vector search (false)
- `MEMORY_PREINJECT_ENABLED` — Auto-inject memories (true)
- `MEMORY_PREINJECT_MAX` — Memories to inject per turn (5)
