---
title: Composio integration
order: 55
---

# Composio integration

Composio is a tool-router that gives agents access to hundreds of SaaS integrations — GitHub, Discord, Slack, Google Workspace, Notion, Linear, and many more — without you writing any connector code. NeuroClaw wraps Composio's hosted MCP server so each agent can call external-app tools the same way it calls built-in tools.

## How it works

When an agent with Composio enabled starts a turn, NeuroClaw calls `getComposioMcp(userId, toolkits)` in `src/composio/client.ts`. Composio returns a hosted MCP endpoint URL and auth headers. That endpoint is mounted alongside the agent's other MCP tools so the LLM sees all Composio tool definitions in its tool list and can invoke them mid-response.

The integration is gated twice:

1. **Globally** — `COMPOSIO_API_KEY` must be set. Without it the client refuses to initialize and all `/api/composio/*` routes return 400.
2. **Per-agent** — the agent's `composio_enabled` column must be `1`. An agent with Composio disabled never receives Composio tools even when the key is present.

Both conditions must be true for an agent to receive Composio tools.

## Per-agent identity

Every agent row has a `composio_user_id` column (added via migration, nullable). Composio scopes OAuth-connected accounts to a user ID, so different agents can act on behalf of different identities:

- Your personal Discord agent uses your Composio user ID and can post to your personal server.
- The team's announcement agent uses the team's user ID and can post to the shared workspace.

If several agents share the same external account they can share a `composio_user_id`. The user ID is set when you create or edit an agent — either through the dashboard agent-edit modal or the API:

```json
PATCH /api/agents/:id
{
  "composio_enabled": true,
  "composio_user_id": "user_abc123"
}
```

A `null` or blank `composio_user_id` means no Composio identity is assigned, and the agent will error if Composio tools are requested.

## Toolkit allowlists

By default a Composio session exposes every toolkit the user has connected. You can restrict an agent to a subset by setting `composio_toolkits` to a JSON array of toolkit slugs:

```json
PATCH /api/agents/:id
{
  "composio_toolkits": ["github", "notion"]
}
```

A `null` value (the default) means all connected toolkits are available. The dashboard agent-edit modal includes a chip picker populated from `GET /api/composio/toolkits` so you can choose slugs without looking them up manually.

The toolkits array is normalized before it reaches Composio: entries are lowercased, trimmed, and empty values are dropped. An empty array is treated the same as `null` (all toolkits).

## Session caching

Creating a Composio session has network overhead. The client caches sessions keyed by `(userId, sorted-toolkit-list)` so a single chat turn does not mint a fresh session per tool call. Sessions are reused until they expire.

TTL is controlled by `COMPOSIO_SESSION_TTL_SEC` (default 900 seconds / 15 minutes). After expiry the next call transparently creates a new session and replaces the cache entry.

To force immediate expiry of all cached sessions — for example after an OAuth revocation — call `clearComposioSessionCache()` from application code. There is no dashboard button for this today; a server restart has the same effect.

## API routes

All routes require the standard dashboard token.

| Method | Path | Description |
|---|---|---|
| GET | `/api/composio/status` | Returns `{ enabled, apiKeySet, sessionTtlSec }`. Safe to call when Composio is not configured — returns `enabled: false`. |
| GET | `/api/composio/toolkits` | Returns the full Composio toolkit catalog `{ ok, toolkits: [{ slug, name, logo }] }`. Requires `COMPOSIO_API_KEY`. |
| GET | `/api/composio/connected/:userId` | Returns connected accounts for the given Composio user ID `{ ok, accounts: [{ toolkit, status, id }] }`. Use this to see which apps an agent can already act on vs. which still need OAuth setup. |

## Setup

1. **Create a Composio account** at [composio.dev](https://composio.dev) and generate an API key.

2. **Set the environment variable:**
   ```
   COMPOSIO_API_KEY=your_key_here
   ```

3. **Connect accounts in the Composio dashboard.** For each external app you want agents to use (GitHub, Slack, etc.), complete the OAuth flow under your Composio user ID.

4. **Assign `composio_user_id` to agents** via the dashboard or the API. Use the Composio user ID that has the accounts connected in step 3.

5. **Enable Composio on the agent** by toggling `composio_enabled` to true in the agent-edit modal or via `PATCH /api/agents/:id`.

6. **Optionally restrict toolkits** using the chip picker in the agent-edit modal to limit which apps the agent can reach.

After setup, the agent sees Composio tools in its tool list on the next turn. Use `GET /api/composio/connected/:userId` to confirm which accounts are active.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `COMPOSIO_API_KEY` | — | Required. Absence disables the integration globally. |
| `COMPOSIO_BASE_URL` | *(Composio default)* | Override the Composio API base URL (useful for on-prem or proxied deployments). |
| `COMPOSIO_SESSION_TTL_SEC` | `900` | Seconds before a cached MCP session is considered stale and replaced. |
