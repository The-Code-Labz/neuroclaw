# System Module

Background services, routing, and orchestration infrastructure.

## Overview

The system module contains infrastructure that coordinates agent behavior:
- **Spawner** — Creates and manages temporary agents
- **Router** — Routes messages to appropriate agents based on mentions
- **Triage** — Model selection and capability routing
- **Background tasks** — Scheduled jobs, heartbeat, cleanup

## Key Files

| File | Purpose |
|------|---------|
| `spawner.ts` | Temporary agent creation and lifecycle |
| `router.ts` | Message routing based on @mentions |
| `triage.ts` | Model selection for agent capabilities |
| `background.ts` | Scheduled background tasks |
| `exec-tools.ts` | Shell/filesystem tool implementations |

## Spawner

The spawner allows agents to create specialized sub-agents on demand:

```typescript
import { spawnAgent, listTempAgents } from './spawner';

const agent = await spawnAgent({
  name: 'data-analyst',
  systemPrompt: 'You are a data analysis specialist...',
  parentAgentId: 'alfred',
});

const temps = listTempAgents();
```

### Spawn Limits

- Maximum spawn depth: 3 (prevents infinite recursion)
- `spawn_enabled` must be true on parent agent
- Temporary agents are cleaned up after inactivity

## Router

Routes messages to agents based on @mentions:

```typescript
import { routeMessage } from './router';

const result = await routeMessage({
  message: '@researcher Find info about MCP protocol',
  sessionId: 'session-123',
});
// Routes to 'researcher' agent
```

### Routing Rules

1. Explicit @mention → Route to named agent
2. No mention → Route to default agent (Alfred)
3. Unknown agent → Return error

## Triage

Selects appropriate models based on task complexity:

```typescript
import { selectModel } from './triage';

const model = selectModel({
  task: 'complex reasoning',
  preferFast: false,
});
```

## Background Tasks

Scheduled tasks that run independently:

| Task | Interval | Purpose |
|------|----------|---------|
| Heartbeat | 1 min | Health monitoring |
| Cleanup | 1 hour | Remove stale temp agents |
| Memory vacuum | 1 day | Database maintenance |

## Configuration

| Variable | Description |
|----------|-------------|
| `SPAWNING_ENABLED` | Enable agent spawning |
| `SPAWN_DEPTH_LIMIT` | Max spawn chain depth (3) |
| `CLEANUP_INTERVAL_MS` | Temp agent cleanup interval |
