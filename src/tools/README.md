# Tools Module

Centralized tool registry with multi-adapter support.

## Overview

All agent tools are defined once in the registry and automatically exposed through multiple adapters:
- OpenAI-compatible function calling
- Claude Agent SDK MCP
- HTTP MCP protocol
- Composio external tools

## Architecture

```
┌─────────────────────────────────────┐
│         Tool Registry               │
│    (schemas, handlers, gates)       │
└───────────────┬─────────────────────┘
                │
    ┌───────────┼───────────┬─────────────────┐
    │           │           │                 │
    ▼           ▼           ▼                 ▼
┌─────────┐ ┌─────────┐ ┌─────────┐     ┌─────────────┐
│ OpenAI  │ │ Claude  │ │  HTTP   │     │  Composio   │
│ Adapter │ │ Adapter │ │  MCP    │     │  Adapter    │
└─────────┘ └─────────┘ └─────────┘     └─────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `registry.ts` | Tool definitions, gates, handlers |
| `schemas.ts` | Zod schemas for input validation |
| `context.ts` | ToolContext interface |
| `adapters/openai.ts` | OpenAI function calling format |
| `adapters/claude-sdk.ts` | Claude SDK MCP server |
| `adapters/http-mcp.ts` | Streamable HTTP MCP |
| `adapters/composio.ts` | Composio integration |
| `adapters/mcp-registry-adapter.ts` | Dynamic MCP tool synthesis |

## Tool Definition

```typescript
interface ToolDef<Schema extends z.ZodType = z.ZodType> {
  name:        string;           // Unique identifier
  description: string;           // For LLM understanding
  schema:      Schema;           // Zod validation schema
  shape:       z.ZodRawShape;    // Raw shape for Claude SDK
  gate?:       (ctx: ToolContext) => GateResult;  // Access control
  handler:     (args: z.infer<Schema>, ctx: ToolContext) => Promise<unknown>;
}
```

## Adding a Tool

1. Define schema in `schemas.ts`:
```typescript
export const myToolShape = {
  input: z.string().describe('What to process'),
};
export const myToolSchema = z.object(myToolShape);
```

2. Add to registry in `registry.ts`:
```typescript
{
  name: 'my_tool',
  description: 'Does something useful',
  schema: S.myToolSchema,
  shape: S.myToolShape,
  handler: async (args, ctx) => {
    return { result: process(args.input) };
  },
},
```

## Access Gates

Gates control tool visibility:

| Gate | Condition |
|------|-----------|
| `gateMcp` | `MCP_ENABLED=true` |
| `gateSpawn` | Agent has spawn_enabled, depth < 3 |
| `gateExec` | Agent has exec_enabled |
| `gateBrowser` | `BROWSER_ENABLED=true` |

## Usage

```typescript
import { findTool, visibleTools, dispatchOpenAiTool } from './tools';

// Find a specific tool
const tool = findTool('search_memory');

// Get tools visible to an agent
const tools = visibleTools({ agentId: 'alfred' });

// Execute a tool
const result = await dispatchOpenAiTool(
  'search_memory',
  JSON.stringify({ query: 'rate limiting' }),
  { agentId: 'alfred', sessionId: 'sess-123' }
);
```
