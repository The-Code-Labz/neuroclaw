# MCP Module

Model Context Protocol client and server implementations.

## Overview

NeuroClaw integrates with MCP (Model Context Protocol) in two ways:
1. **As a client** — Connects to external MCP servers (NeuroVault, etc.)
2. **As a server** — Exposes NeuroClaw tools via MCP for external clients

## Architecture

```
External MCP Servers              NeuroClaw                External Clients
    │                                 │                          │
    │   ┌───────────────────┐         │                          │
    │◄──│   MCP Client      │         │                          │
    │   │ (vault-client.ts) │         │                          │
    │   └───────────────────┘         │                          │
    │                                 │                          │
    │   ┌───────────────────┐         │    ┌───────────────────┐ │
    │   │   MCP Registry    │─────────│────│  HTTP MCP Server  │─┤►
    │   │ (user-managed)    │         │    │ (Streamable-HTTP) │ │
    │   └───────────────────┘         │    └───────────────────┘ │
    │                                 │                          │
    │                                 │    ┌───────────────────┐ │
    │                                 │    │  Claude SDK MCP   │─┤►
    │                                 │    │  (in-process)     │ │
    │                                 │    └───────────────────┘ │
```

## Key Files

| File | Purpose |
|------|---------|
| `client.ts` | Generic MCP client (list tools, call tools) |
| `registry.ts` | User-managed MCP server registry |
| `in-process-server.ts` | In-process MCP server for Claude SDK |
| `vault-client.ts` | NeuroVault-specific client |

## MCP Registry

Users can register external MCP servers via the dashboard. Tools from these servers are automatically synthesized into the tool registry with namespaced names:

```
mcp__github__create_issue
mcp__slack__send_message
```

## Usage

### As Client

```typescript
import { mcpListTools, mcpCallTool } from './client';

// List available tools
const tools = await mcpListTools('http://localhost:8080');

// Call a tool
const result = await mcpCallTool(
  'http://localhost:8080',
  'search_vault',
  { query: 'rate limiting' }
);
```

### As Server

```typescript
import { createNeuroclawHttpMcpServer } from '../tools/adapters/http-mcp';

// Create Streamable-HTTP MCP server
const server = createNeuroclawHttpMcpServer({
  agentId: 'alfred',
  sessionId: 'session-123',
});
```

## Configuration

| Variable | Description |
|----------|-------------|
| `MCP_ENABLED` | Enable MCP integrations |
| `NEUROVAULT_MCP_URL` | NeuroVault server URL |
| `NEUROVAULT_DEFAULT_VAULT` | Default vault name |

## Protocol Support

NeuroClaw implements MCP 2024-11-05 with:
- Streamable HTTP transport (server)
- HTTP transport (client)
- Tool listing and calling
- Server info exchange
