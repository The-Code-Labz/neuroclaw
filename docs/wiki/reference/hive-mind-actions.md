---
title: Hive Mind actions
order: 30
---

# Hive Mind actions

Every notable lifecycle event lands in the `hive_mind` table with one of these `action` values:

- `auto_route`
- `route_fallback`
- `manual_delegation`
- `spawn_request`
- `spawn_success`
- `spawn_denied`
- `agent_spawned`
- `agent_expired`
- `task_created`
- `task_updated`
- `agent_activated`
- `agent_deactivated`
- `mcp_agent_call_ok`
- `mcp_agent_call_failed`

Read the live stream from the dashboard's **Hive Mind** tab, or query `GET /api/hive?limit=N` programmatically.
