---
title: Configuration
order: 30
---

# Configuration

NeuroClaw is configured entirely through environment variables loaded from a `.env` file.

## Setup

```bash
cp .env.example .env
```

Open `.env` and fill in at least the two required values:

```dotenv
VOIDAI_API_KEY=sk-voidai-your-key
DASHBOARD_TOKEN=a-strong-secret-here
```

The app loads `.env` via `dotenv` on startup. Every other variable has a safe default, so the system starts without them — but read the sections below before going to production.

## How config propagates: the getter pattern

`src/config.ts` exports a single `config` object built entirely from JavaScript getter properties:

```ts
export const config = {
  get voidai() {
    return {
      apiKey:  process.env.VOIDAI_API_KEY  ?? '',
      model:   process.env.VOIDAI_MODEL    ?? 'gpt-5.1',
      // ...
    };
  },
  // ...
};
```

Because each field is a getter — not a cached value computed at import time — every read of `config.voidai.model` goes directly to `process.env`. This means a config reload propagates everywhere instantly, with no restart and no stale references.

## Hot-reload (no restart required)

`src/system/config-watcher.ts` polls `.env` every **2 seconds** by comparing the file's `mtime`. When a change is detected it:

1. Re-runs `dotenv.config({ override: true })` to pick up new values.
2. Calls `resetClient()` and `resetAnthropicClient()` to force fresh LLM clients with the updated keys.
3. Syncs the four most-used keys (`VOIDAI_MODEL`, `VOIDAI_API_KEY`, `DASHBOARD_PORT`, `DASHBOARD_TOKEN`) into the `config_items` SQLite table.
4. Emits on `configEvents`, which triggers the `/api/config/watch` SSE stream.

The **Settings** page in the dashboard subscribes to that SSE stream and shows a live "Config reloaded" indicator each time a change fires.

## Most important variables to tune

| Variable | Default | Why you should set it |
|---|---|---|
| `VOIDAI_API_KEY` | — | Required. All LLM calls fail without it. |
| `VOIDAI_MODEL` | `gpt-5.1` | Controls the model used by every agent unless overridden per-agent. |
| `VOIDAI_BASE_URL` | `https://api.voidai.app/v1` | Change to point at any OpenAI-compatible endpoint. |
| `DASHBOARD_TOKEN` | `change-me` | Must be changed before exposing the dashboard to a network. |
| `AUTO_DELEGATION_ENABLED` | `false` | Set to `true` to let an LLM classifier pick the right agent automatically. |
| `SPAWN_AGENTS_ENABLED` | `false` | Set to `true` to let agents spawn temporary sub-agents for complex tasks. |

## Common configuration patterns

### Minimal production setup
Change only what is unsafe to leave as default:
```dotenv
VOIDAI_API_KEY=sk-...
DASHBOARD_TOKEN=my-secret-token
```

### Enable intelligent routing
The LLM classifier reads each message and routes it to the best-fit agent. Tune `AUTO_DELEGATION_MIN_CONFIDENCE` if routing feels aggressive (raise it) or too conservative (lower it).
```dotenv
AUTO_DELEGATION_ENABLED=true
AUTO_DELEGATION_MIN_CONFIDENCE=0.65
```

### Enable agent spawning
Agents can create short-lived specialist sub-agents. The hard limit prevents runaway spawning.
```dotenv
SPAWN_AGENTS_ENABLED=true
TEMP_AGENT_TTL_HOURS=6
TEMP_AGENT_HARD_LIMIT=25
```

### Enable Langfuse tracing
Both keys are required. Omitting either disables tracing silently.
```dotenv
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://cloud.langfuse.com
```

### Use the Anthropic API directly
Switch Claude-backed agents from the local CLI to the direct Anthropic SDK:
```dotenv
CLAUDE_BACKEND=anthropic-api
ANTHROPIC_API_KEY=sk-ant-...
```

## Watching config changes live

```
GET /api/config/watch?token=<DASHBOARD_TOKEN>
```

This is a long-lived SSE stream. Each time `.env` is saved, it receives a `config_changed` event. The dashboard **Settings** page connects automatically — you can also subscribe from a script or another service.

## Troubleshooting

**HTTP 500 on the first chat message** — VoidAI returns 500 (not 401) for an invalid API key. Double-check `VOIDAI_API_KEY` and confirm the key is active.

**Config change not picked up** — The watcher compares `mtime`. Some editors write atomically (save to temp file then rename), which may not update `mtime` on the original path. If changes are not detected, touch the file: `touch .env`.

**Dashboard returns 401** — The `DASHBOARD_TOKEN` in your request does not match the one in `.env`. If you changed the token while the server was running, the hot-reload should pick it up within 2 seconds — no restart needed.
