---
title: API endpoints
order: 20
---

# API endpoints

All `/api/*` routes require `?token=<DASHBOARD_TOKEN>` (or `x-dashboard-token` header).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/status` | Active agents, temp agents, session/message counts |
| GET | `/api/agents` | All agents (including temp) |
| POST | `/api/agents` | Create agent (`name` required) |
| PATCH | `/api/agents/:id` | Update agent fields |
| DELETE | `/api/agents/:id` | Soft-deactivate (Alfred protected) |
| POST | `/api/agents/:id/activate` | Re-activate an inactive agent |
| POST | `/api/agents/spawn` | Manually spawn a temp agent |
| GET | `/api/tasks` | List tasks (`?status=` optional filter) |
| POST | `/api/tasks` | Create task; auto-assigns if AUTO_DELEGATION_ENABLED |
| PATCH | `/api/tasks/:id` | Update status, agent, or fields |
| GET | `/api/hive` | Hive Mind events (`?limit=` default 100) |
| POST | `/api/chat` | SSE stream — `chunk`, `done`, `error`, `mcp_call_*` events |
| GET | `/api/tasks/watch` | SSE stream for background task completions |
| GET | `/api/config/watch` | SSE stream for `.env` change notifications |
| GET | `/api/docs/tree` | Wiki sidebar tree |
| GET | `/api/docs/article/:section/:slug` | One wiki article |
| GET | `/api/mcp/servers` | Registered MCP servers + their cached tools |
