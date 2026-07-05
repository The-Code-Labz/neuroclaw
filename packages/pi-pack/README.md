# @neuroclaw/pi-pack

> **STATUS: WIP / NOT PUBLISHED**
> 
> This package is scaffolded but not yet tested or published. See [TODO](#todo) below.

Pi extension pack for [NeuroClaw](https://github.com/neuroclaw/neuroclaw-v1) — multi-agent registry, delegation, persistent memory, and task management exposed as pi tools and commands.

## Installation

```bash
# From npm (when published)
pi install npm:@neuroclaw/pi-pack

# From git
pi install git:github.com/neuroclaw/neuroclaw-v1#packages/pi-pack

# Local development
pi -e ./packages/pi-pack/extensions/neuroclaw.ts
```

## Prerequisites

NeuroClaw must be running with the MCP stdio server available:

```bash
# Build NeuroClaw
npm run build

# The extension connects to dist/mcp/stdio-server.js
```

## Tools

| Tool | Description |
|------|-------------|
| `ask_alfred` | Send a message to the agent team; Alfred routes to specialists |
| `list_neuroclaw_agents` | List all agents in the registry |
| `search_neuroclaw_memory` | Search across NeuroVault + memory_index |
| `find_neuroclaw_tasks` | Query tasks with filters |
| `delegate_to_neuroclaw` | Create and assign tasks to agents |

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | List active NeuroClaw agents |
| `/delegate <agent> <task>` | Quick delegation with immediate execution |
| `/memory <query>` | Search NeuroClaw memory |
| `/ncstatus` | Show system status (agents, tasks in progress) |

## Skills

Auto-loaded skills for natural language triggers:

- **delegate-to-agent** — Activates when user mentions delegation or specific agents
- **memory-recall** — Activates when user references prior work or history
- **task-management** — Activates when user asks about tasks or workload

## Prompts

- `/alfred` — Quick template to route through Alfred

## Example Usage

```
> List my agents
[Uses list_neuroclaw_agents tool]

> Have Coder review the auth module
[Uses delegate_to_neuroclaw with execute_now: true]

> Do you remember how we set up the CI pipeline?
[Uses search_neuroclaw_memory]

> /delegate Researcher "Find best practices for OAuth2 PKCE flow"
[Quick command delegation]
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        pi TUI                           │
│  ┌─────────────────────────────────────────────────┐   │
│  │              @neuroclaw/pi-pack                  │   │
│  │                                                  │   │
│  │  Tools:      Commands:      Skills:             │   │
│  │  ask_alfred  /agents        delegate-to-agent   │   │
│  │  list_*      /delegate      memory-recall       │   │
│  │  search_*    /memory        task-management     │   │
│  │  find_*      /ncstatus                          │   │
│  │  delegate_*                                     │   │
│  └──────────────────┬───────────────────────────────┘   │
│                     │ stdio JSON-RPC                    │
│  ┌──────────────────▼───────────────────────────────┐   │
│  │         neuroclaw-mcp-server (stdio)             │   │
│  │                                                  │   │
│  │  • Agent registry & delegation                  │   │
│  │  • Memory (NeuroVault + SQLite index)           │   │
│  │  • Task manager                                 │   │
│  │  • Discord/LiveKit integrations                 │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Configuration

The extension auto-discovers the MCP server in this order:

1. `../../../dist/mcp/stdio-server.js` (relative to extension)
2. `process.cwd()/dist/mcp/stdio-server.js` (development)
3. `node_modules/@neuroclaw/neuroclaw-v1/dist/mcp/stdio-server.js`

Set `NEUROCLAW_MCP_PATH` environment variable to override.

## TODO

### Before Publishing

- [ ] Test extension actually loads in pi (`pi -e ./packages/pi-pack/extensions/neuroclaw.ts`)
- [ ] Test MCP client connects to stdio-server correctly
- [ ] Verify all 5 tools work end-to-end
- [ ] Verify all 4 commands work
- [ ] Test skills auto-load on relevant prompts
- [ ] Fix any TypeScript/jiti compatibility issues
- [ ] Add proper error handling when MCP server not found

### Enhancements

- [ ] Add `ctx.ui.setWidget()` for live agent activity display above editor
- [ ] Stream `onMeta` events from `chatStream` through `onUpdate` for real-time delegation feedback
- [ ] Add agent autocompletion for `/delegate` command
- [ ] Add `/tasks` command to list active tasks inline
- [ ] Consider HTTP transport option (not just stdio) for remote NeuroClaw instances
- [ ] Add session continuity — pass pi session ID to NeuroClaw for correlation

### Fixes Needed

- [ ] The MCP client uses simple JSON-RPC but NeuroClaw's stdio-server uses MCP protocol — need to align
- [ ] Path resolution for installed package scenario (when not running from neuroclaw-v1 cwd)
- [ ] Graceful degradation when NeuroClaw is offline
- [ ] Timeout handling improvements (currently 30s hard timeout)

### Documentation

- [ ] Add CHANGELOG.md
- [ ] Add examples for each tool
- [ ] Document which NeuroClaw features are NOT exposed (Discord bot setup, etc.)
- [ ] Add troubleshooting section

### Publishing

- [ ] Choose final package name (`@neuroclaw/pi-pack` vs `neuroclaw-pi` vs other)
- [ ] Set up npm publishing workflow
- [ ] Add to pi package registry / Discord showcase

## Development

```bash
# From neuroclaw-v1 root
npm run build

# Test the extension
pi -e ./packages/pi-pack/extensions/neuroclaw.ts

# In another terminal, ensure neuroclaw is available
npm run dev
```

## License

MIT
