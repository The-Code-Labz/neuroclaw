---
title: Heartbeat
order: 45
---

# Heartbeat

The heartbeat is a periodic background process that sends a minimal 1-token LLM ping to every active, non-temporary agent. Its purpose is connection warmth: cold MCP sockets and provider connections add 500ms–1s of latency to the first message in a new session. Keeping those connections alive means the first turn costs the same as the tenth.

## What it checks

Each heartbeat cycle pings every agent that is `active` and not `temporary`. The ping is a single-message completion request (`"ping"`, `max_tokens: 1`) routed through the agent's provider:

- **VoidAI / OpenAI-compatible agents** — pinged via the OpenAI client.
- **Anthropic API agents** (`CLAUDE_BACKEND=anthropic-api`) — pinged via the Anthropic SDK.
- **Claude CLI agents** (`CLAUDE_BACKEND=claude-cli`) — **skipped by default.** Each ping would consume subscription quota on every interval. Set `HEARTBEAT_SKIP_CLAUDE_CLI=false` to override.
- **Codex/Gemini CLI agents** — also skipped by default for the same subscription-quota reason.

Rather than using each agent's configured model (which can be slow or expensive on heavyweight models), the heartbeat selects the cheapest available model for the agent's provider from the local `model_catalog` table. For VoidAI the preference order is `gpt-4o-mini → gpt-4-turbo → gemini-2.5-flash → …`; for Anthropic it prefers `claude-haiku-4-5-20251001`. The `HEARTBEAT_MODEL` override sets a single model for all agents regardless of provider.

Each ping has a 30-second hard timeout to prevent a slow provider from stalling the scheduler.

### Failure dampening

A single transient timeout does not produce a Hive Mind event. NeuroClaw waits for three consecutive failures from the same agent before writing a `agent_heartbeat` FAIL entry to `hive_mind`. If the agent later succeeds and was in a failing streak, a "recovered" event is written and the streak counter resets. This keeps Hive Mind clean during brief provider hiccups.

### Agent row updates

After each ping, `last_heartbeat_at`, `heartbeat_status` (`ok` / `fail` / `skipped`), and `heartbeat_latency_ms` are written back to the `agents` table. These fields are visible on the status endpoint and in the dashboard.

## Schedule

On startup the scheduler fires a first-pass heartbeat 5 seconds after boot (enough time for other initialization to complete), then runs every `HEARTBEAT_INTERVAL_SEC` seconds. The minimum enforced interval is 15 seconds regardless of what the env var is set to.

All agents in a cycle are pinged in parallel, so total wall time is roughly equal to the slowest single ping rather than the sum of all pings.

### Pre-warm on first message

When a user sends the first message of a new session, `prewarmAgentAsync()` checks whether the target agent's `last_heartbeat_at` is older than twice the configured interval. If so, it fires a background ping for that agent immediately, without blocking the chat response. This closes the gap for agents that haven't been pinged recently.

## Manual trigger

```
POST /api/heartbeat/run
```

Requires the `x-dashboard-token` header or `?token=` query parameter.

Run a full cycle across all active agents:

```json
POST /api/heartbeat/run

{
  "ok": true,
  "results": [
    { "agentId": "...", "agentName": "Alfred", "status": "ok", "latencyMs": 312, "model": "gpt-4o-mini" },
    { "agentId": "...", "agentName": "Researcher", "status": "ok", "latencyMs": 287, "model": "gpt-4o-mini" },
    { "agentId": "...", "agentName": "ClaudeAgent", "status": "skipped", "latencyMs": 0, "reason": "claude-cli backend (subscription quota)" }
  ]
}
```

Ping a single agent by ID:

```
POST /api/heartbeat/run?agentId=<agent-id>
```

Returns a single `HeartbeatResult` object directly (not wrapped in `results`).

Each result has the shape:

| Field | Type | Description |
|---|---|---|
| `agentId` | string | Agent UUID |
| `agentName` | string | Agent display name |
| `status` | `ok` / `fail` / `skipped` | Outcome of the ping |
| `latencyMs` | number | Round-trip time in milliseconds |
| `model` | string | Model used for the ping (absent on skip) |
| `reason` | string | Why the ping failed or was skipped (absent on success) |

## Status endpoint

```
GET /api/heartbeat/status
```

Returns the current heartbeat configuration and the last-known ping state for every active agent:

```json
{
  "enabled": true,
  "intervalSec": 60,
  "model": "gpt-4.1",
  "skipClaudeCli": true,
  "agents": [
    {
      "id": "...",
      "name": "Alfred",
      "role": "orchestrator",
      "provider": "voidai",
      "status": "active",
      "temporary": 0,
      "last_heartbeat_at": "2026-05-05T14:32:01",
      "heartbeat_status": "ok",
      "heartbeat_latency_ms": 312
    }
  ]
}
```

`agents` is sorted alphabetically by name and includes only agents with `status = 'active'`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `HEARTBEAT_ENABLED` | `true` | Set to `false` to disable the scheduler entirely. Manual `/api/heartbeat/run` calls are also suppressed. |
| `HEARTBEAT_INTERVAL_SEC` | `60` | Seconds between automatic heartbeat cycles. Minimum enforced value is 15. |
| `HEARTBEAT_MODEL` | `gpt-4.1` | Fixed model to use for all pings. When set, overrides the automatic cheap-model selection logic. |
| `HEARTBEAT_SKIP_CLAUDE_CLI` | `true` | Skip heartbeat pings for agents using `CLAUDE_BACKEND=claude-cli`. Set to `false` only if you are comfortable consuming subscription quota every interval. |
