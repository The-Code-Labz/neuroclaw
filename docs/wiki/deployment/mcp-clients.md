---
title: MCP Clients (Cursor & Claude Desktop)
order: 30
---

# Connect Cursor or Claude Desktop to NeuroClaw

NeuroClaw exposes a curated MCP surface with four tools:

| Tool | What it does |
|------|--------------|
| `ask_alfred` | Send a message to the agent team and get a response |
| `list_agents` | See all active agents |
| `search_memory` | Query the memory vault |
| `find_tasks` | Look up tasks |

---

## Cursor (HTTP)

Add to `~/.cursor/mcp.json` (or your project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "neuroclaw": {
      "url": "http://localhost:3141/mcp",
      "headers": {
        "x-dashboard-token": "your-DASHBOARD_TOKEN-value",
        "x-neuroclaw-client": "external"
      }
    }
  }
}
```

Replace `your-DASHBOARD_TOKEN-value` with the value of `DASHBOARD_TOKEN` from your `.env`.

---

## Claude Desktop (stdio)

Build the project first:

```bash
npm run build
```

Then add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "neuroclaw": {
      "command": "node",
      "args": ["/absolute/path/to/neuroclaw-v1/dist/mcp/stdio-server.js"]
    }
  }
}
```

Restart Claude Desktop after editing the config.

---

## Verify the connection

In Cursor or Claude Desktop, ask:

> "List the available NeuroClaw agents"

The `list_agents` tool should fire and return the agent registry.
