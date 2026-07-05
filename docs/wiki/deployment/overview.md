---
title: Overview
order: 5
---

<!-- generated-by: gsd-doc-writer -->

# Deployment overview

NeuroClaw can be deployed in three ways depending on your environment. Choose the approach that fits your infrastructure, then follow the linked guide for the full walkthrough.

## Deployment options

| Option | Best for | Guide |
|---|---|---|
| **systemd service** | Linux servers — runs as a managed service with journald logging, automatic restarts, and boot persistence | [systemd service](systemd.md) |
| **Docker / Docker Compose** | Containerized environments — build a portable image, mount `.env` as a read-only file, and persist the database via a named volume | [Docker deployment](docker.md) |
| **Direct Node** | Development or quick deploys — run `npm run dashboard` (tsx) or `node dist/dashboard/server.js` (compiled) directly in a terminal or tmux session | [Production deployment](production.md) |

## Production checklist

Before going live, confirm each item:

- [ ] `DASHBOARD_TOKEN` changed from the default `change-me` to a long random string
- [ ] `VOIDAI_API_KEY` set to a valid API key
- [ ] `DB_PATH` points to a location on a persistent volume or disk (not an ephemeral temp directory)
- [ ] Port `3141` is **not** exposed directly to the internet — traffic must go through a reverse proxy (see below)
- [ ] `.env` file is not world-readable (`chmod 600 .env`)
- [ ] A daily database backup is scheduled (see [Production deployment](production.md) for a cron example)

## What persists across restarts

**Persists (stored in SQLite):**

- All agents, system prompts, and agent configuration (`agents` table)
- All session and message history (`sessions`, `messages` tables)
- Tasks, memories, audit logs, hive mind events
- Config items and analytics events

The SQLite file is `neuroclaw.db` (or the path set by `DB_PATH`). Back up this file to preserve everything.

**Does not persist (in-memory only):**

- Active conversation histories (`sessionHistories` Map in `alfred.ts`) — these are rebuilt from the database on the next message in a session, so no conversation content is lost; only the in-memory cache is cleared
- Active SSE connections (dashboard clients reconnect automatically)
- Background task state for tasks that were mid-execution at shutdown

## Dashboard binding and reverse proxy

The dashboard server binds exclusively to `127.0.0.1:3141` (hardcoded in `src/dashboard/server.ts`). It is not reachable from other hosts without a reverse proxy.

For external access, place nginx or Caddy in front:

```nginx
location / {
    proxy_pass http://127.0.0.1:3141;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;   # Required for SSE streams
    proxy_read_timeout 86400;
}
```

A full nginx server block with TLS is in [Production deployment](production.md).

> All `/dashboard` and `/api/*` routes require the `DASHBOARD_TOKEN` regardless of how the server is accessed. The reverse proxy does not bypass authentication.

## MCP clients

If you use external MCP clients (Claude Desktop, Cursor, etc.) to connect to NeuroClaw's built-in MCP server, see [MCP clients](mcp-clients.md) for connection configuration.
