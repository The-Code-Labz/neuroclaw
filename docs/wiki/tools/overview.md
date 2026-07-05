---
title: Tool overview
order: 10
---

# Tool overview

NeuroClaw agents interact with the world through a centralized **tool registry**. Every tool is defined once in the registry and automatically exposed through multiple adapters — OpenAI-compatible APIs, Claude Agent SDK, HTTP MCP, and Composio. This means the same tool works regardless of which provider or backend an agent is using.

## How tools work

When an agent decides to call a tool, the request flows through these steps:

1. **Lookup** — The tool name is matched against the registry
2. **Gate check** — If the tool has an access gate, it verifies the calling context is allowed
3. **Validation** — Input arguments are validated against the tool's Zod schema
4. **Execution** — The tool handler runs and returns a result
5. **Serialization** — The result is JSON-serialized back to the agent

Agents never call tools directly — they request tool calls through their chat interface, and the orchestrator dispatches them.

## Tool categories

| Category | Count | Description |
|---|---|---|
| **Memory / Vault** | 6 | Search and persist long-term memory, interact with NeuroVault |
| **Agent communication** | 3 | Message other agents, assign tasks, list available agents |
| **Spawning** | 2 | Create temporary sub-agents for specialized work |
| **Exec** | 5 | Run shell commands, read/write files (gated per-agent) |
| **Discord** | 8 | Bot registration, channel routing, reactions, voice config |
| **Audio** | 4 | TTS voice configuration and status |
| **Projects & Tasks** | 4 | Archon-compatible project/task management |
| **Skills** | 4 | Skill discovery and script execution |
| **Browser** | 4 | Fetch rendered pages, screenshots, PDFs (Browserless) |
| **Automation** | 5 | Schedule and manage cron jobs |

See the [Tool reference](./tool-reference.md) for the complete list with schemas.

## Access gates

Not all tools are available to all agents. **Gates** control which tools are visible and callable:

| Gate | Controls | Condition |
|---|---|---|
| `gateMcp` | Memory, Vault tools | `MCP_ENABLED=true` |
| `gateSpawn` | `spawn_agent` | Agent has `spawn_enabled`, depth < 3 |
| `gateExec` | Shell/filesystem tools | Agent has `exec_enabled=true` |
| `gateBrowser` | Browser tools | `BROWSER_ENABLED=true` and Browserless URL set |

When a gate denies access, the tool is hidden from the agent's tool list — the agent doesn't even know it exists.

## Dynamic MCP tools

Beyond native tools, NeuroClaw can expose tools from external MCP servers:

- **MCP Registry** — User-managed MCP servers registered via the dashboard. Tools appear as `mcp__<server>__<tool>` (e.g., `mcp__github__create_issue`)
- **MCP-backed agents** — Agents whose provider is `mcp` expose a delegation tool `agent__<name>`
- **Composio** — External Composio toolkits expose tools like `GITHUB_CREATE_ISSUE`

These tools are synthesized at runtime and merged into the visible tool list.

## Tool context

Every tool handler receives a `ToolContext` object:

```typescript
interface ToolContext {
  agentId?:   string | null;  // Calling agent
  sessionId?: string | null;  // Chat session
  onMeta?:    (e: MetaEvent) => void;  // Dashboard SSE events
  runId?:     string | null;  // Active run for nested calls
}
```

This context lets tools:
- Check agent permissions (exec, spawn, etc.)
- Associate memory writes with the correct agent
- Send real-time progress to the dashboard

## Adding custom tools

To add a new tool:

1. Define the schema in `src/tools/schemas.ts`:
```typescript
export const myToolShape = {
  query: z.string().describe('What to search for'),
};
export const myToolSchema = z.object(myToolShape);
```

2. Add the tool to the registry in `src/tools/registry.ts`:
```typescript
{
  name: 'my_tool',
  description: 'Does something useful',
  schema: S.myToolSchema,
  shape: S.myToolShape,
  gate: gateExec,  // optional
  handler: async (args, ctx) => {
    // implementation
    return { ok: true, result: '...' };
  },
},
```

The tool is automatically available through all adapters.
