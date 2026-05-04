---
title: Environment variables
order: 10
---

# Environment variables

Copy `.env.example` to `.env` and fill in.

| Variable | Default | Notes |
|---|---|---|
| `VOIDAI_API_KEY` | — | Required |
| `VOIDAI_BASE_URL` | `https://api.voidai.app/v1` | OpenAI-compatible endpoint |
| `VOIDAI_MODEL` | `gpt-5.1` | Default model for all agents |
| `DASHBOARD_PORT` | `3141` | |
| `DASHBOARD_TOKEN` | `change-me` | Protects all dashboard routes |
| `DB_PATH` | `./neuroclaw.db` | SQLite file path |
| `AUTO_DELEGATION_ENABLED` | `false` | LLM classifier auto-routes messages |
| `AUTO_DELEGATION_MIN_CONFIDENCE` | `0.65` | Minimum confidence to act on classifier |
| `ROUTER_MODEL` | *(same as VOIDAI_MODEL)* | Override model for the classifier |
| `SPAWN_AGENTS_ENABLED` | `false` | Allow agents to spawn temp sub-agents |
| `TEMP_AGENTS_AUTO_APPROVE` | `true` | Auto-approve all spawn requests |
| `TEMP_AGENT_TTL_HOURS` | `6` | Hours before temp agent expires |
| `TEMP_AGENT_SOFT_LIMIT` | `10` | Log warning above this many active temp agents |
| `TEMP_AGENT_HARD_LIMIT` | `25` | Block spawns above this many active temp agents |
| `LANGFUSE_SECRET_KEY` | — | Enables Langfuse tracing (with public key) |
| `LANGFUSE_PUBLIC_KEY` | — | |
| `LANGFUSE_HOST` | `https://cloud.langfuse.com` | |
