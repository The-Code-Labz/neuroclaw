# Contributing to NeuroClaw

Thank you for your interest in contributing to NeuroClaw! This guide covers the architecture, development workflow, and contribution process.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [How to Contribute](#how-to-contribute)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Documentation](#documentation)

## Architecture Overview

NeuroClaw is a multi-agent orchestration system with three main layers:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Presentation Layer                           │
│   Dashboard (Hono + React)  │  Discord Bot  │  CLI                  │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────┐
│                      Orchestration Layer                            │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │   Alfred    │  │   Router    │  │   Spawner   │  │   Triage   │ │
│  │(orchestrator│  │(@mentions)  │  │(temp agents)│  │(model pick)│ │
│  └──────┬──────┘  └─────────────┘  └─────────────┘  └────────────┘ │
│         │                                                           │
│  ┌──────┴──────────────────────────────────────────────────────┐   │
│  │                      Tool Registry                           │   │
│  │  Memory | Agents | Exec | Discord | Audio | Browser | ...   │   │
│  └──────────────────────────────────────────────────────────────┘   │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────┐
│                        Backend Layer                                │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │   VoidAI    │  │  Claude CLI │  │  Anthropic  │  │    MCP     │ │
│  │   (API)     │  │  (Process)  │  │   (API)     │  │  (Proto)   │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └────────────┘ │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Memory System                             │   │
│  │  Extractor → Scorer → SQLite → Embeddings → NeuroVault       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    SQLite Database                           │   │
│  │  agents | memory_index | sessions | tasks | discord_bots    │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Request Flow

1. **User sends message** via dashboard, Discord, or CLI
2. **Router** checks for @mentions and routes to appropriate agent
3. **Agent** (default: Alfred) receives message with:
   - System prompt
   - Pre-injected relevant memories
   - Available tools
4. **Provider** (VoidAI, Claude CLI, etc.) processes the chat
5. **Tool calls** are dispatched through the registry
6. **Memory pipeline** extracts and stores durable information
7. **Response** streams back to user

### Key Design Decisions

- **Single tool registry** — Tools defined once, exposed through multiple adapters
- **Fire-and-forget memory** — Memory extraction never blocks chat responses
- **Provider abstraction** — Agents work with any supported backend
- **Gate-based access control** — Tools hidden based on context, not errors

## Development Setup

### Prerequisites

- Node.js 20+ (LTS)
- npm 9+
- SQLite 3.35+
- Optional: Python 3.10+ (for Pydantic agents)

### Quick Start

```bash
git clone <repo>
cd neuroclaw-v1
npm install
cp .env.example .env
# Edit .env with your API keys

npm run dashboard  # Start dashboard
# or
npm run dev        # Start CLI
```

### Useful Commands

```bash
npm run build          # TypeScript compilation
npm run check:memory   # Memory system diagnostics
npm run check:claude   # Claude backend diagnostics
npm run docs           # Generate API documentation
npm run docs:check     # Check documentation freshness
```

## Project Structure

```
src/
├── agent/          # Orchestration clients (Alfred, OpenAI, Anthropic)
├── audio/          # TTS/STT services
├── composio/       # Composio integration
├── dashboard/      # Hono web server + React UI
│   └── v2/         # React SPA
├── diagnostics/    # Health check scripts
├── integrations/   # Discord bot
├── mcp/            # MCP client and registry
├── memory/         # Memory pipeline, retrieval, embeddings
├── providers/      # Claude CLI, Codex CLI, Gemini CLI
├── skills/         # Skill loader
├── system/         # Background tasks, spawner, router, triage
├── tools/          # Tool registry, schemas, adapters
├── utils/          # Logger, helpers
├── vision/         # Image processing
├── config.ts       # Configuration with environment getters
├── db.ts           # SQLite schema + CRUD
└── index.ts        # CLI entry point

docs/
├── wiki/           # In-dashboard documentation
├── api/            # Generated API reference (TypeDoc)
├── design/         # Design documents
└── specs/          # Feature specifications
```

## How to Contribute

### Adding a New Tool

1. **Define the schema** in `src/tools/schemas.ts`:
   ```typescript
   export const myToolShape = {
     input: z.string().describe('Description for LLM'),
   };
   export const myToolSchema = z.object(myToolShape);
   ```

2. **Add to registry** in `src/tools/registry.ts`:
   ```typescript
   {
     name: 'my_tool',
     description: 'What this tool does',
     schema: S.myToolSchema,
     shape: S.myToolShape,
     gate: gateExec,  // optional
     handler: async (args, ctx) => {
       // implementation
       return { result: '...' };
     },
   },
   ```

3. **Document** in `docs/wiki/tools/tool-reference.md`

### Adding a New Provider

1. Create `src/providers/my-provider.ts`
2. Implement the provider interface (see existing providers)
3. Add provider option to `src/agent/alfred.ts`
4. Document in `docs/wiki/integrations/`

### Adding a Memory Type

1. Add type to `MemoryType` union in `src/memory/types.ts`
2. Update extractor prompts in `src/memory/memory-extractor.ts`
3. Update retrieval grouping in `src/memory/memory-retriever.ts`
4. Document in `docs/wiki/reference/memory-system.md`

## Coding Standards

### TypeScript

- Strict mode enabled
- CommonJS modules (`"module": "commonjs"`)
- Two-space indentation
- Single quotes
- Semicolons required
- Explicit return types on exported/async functions

### Naming Conventions

- `camelCase` for variables and functions
- `PascalCase` for classes and types
- `SCREAMING_SNAKE_CASE` for constants

### Error Handling

```typescript
import { logger } from '../utils/logger';

try {
  // risky operation
} catch (err) {
  logger.error('operation failed', { err, context: 'additional info' });
  // Return graceful failure, don't throw to chat path
  return { ok: false, error: (err as Error).message };
}
```

### JSDoc Comments

Document exported functions and interfaces:

```typescript
/**
 * Searches the memory index for relevant entries.
 * @param query - Search keywords (2-8 words recommended)
 * @param limit - Maximum results (default 20)
 * @returns Categorized memory hits
 */
export async function searchMemory(
  query: string,
  limit: number = 20
): Promise<MemorySearchResult> {
  // ...
}
```

## Testing

No formal test framework yet. Before submitting PRs:

1. **Build succeeds:**
   ```bash
   npm run build
   ```

2. **Memory changes work:**
   ```bash
   npm run check:memory
   ```

3. **Claude backend changes work:**
   ```bash
   npm run check:claude
   ```

4. **Manual testing:**
   - Start dashboard, test affected features
   - Check browser console for errors
   - Verify no regressions in related functionality

## Documentation

### Wiki Documentation

Edit markdown files in `docs/wiki/`. Each article has frontmatter:

```yaml
---
title: Article Title
order: 10
---

# Article Title

Content here...
```

### API Documentation

TypeDoc generates API docs from JSDoc comments:

```bash
npm run docs           # Generate to docs/api/
npm run docs:check     # Check for stale docs
```

### Keeping Docs Updated

The freshness checker maps wiki articles to source files:

```bash
npm run docs:check
```

If source files are newer than their docs, update the wiki articles.

## Questions?

- Check existing documentation in `docs/wiki/`
- Review similar code in the codebase
- Open an issue for architectural questions
