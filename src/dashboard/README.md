# Dashboard Module

Web server and UI for NeuroClaw management.

## Overview

The dashboard provides:
- Real-time chat interface with streaming
- Agent management (create, edit, configure)
- Memory inspection and search
- MCP server management
- Wiki documentation viewer

## Architecture

```
┌─────────────────────────────────────────┐
│              Hono Server                │
│           (server.ts)                   │
├─────────────────────────────────────────┤
│  API Routes          │  Static Assets   │
│  /api/chat           │  /dashboard      │
│  /api/agents         │  /v2/*           │
│  /api/memory         │                  │
│  /api/wiki           │                  │
│  /mcp (MCP server)   │                  │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│           React SPA (v2/)               │
│  - Chat component                       │
│  - Agent manager                        │
│  - Memory browser                       │
│  - Docs viewer                          │
└─────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `server.ts` | Hono HTTP server, all API routes |
| `wiki-loader.ts` | Markdown wiki file loader |
| `v2/` | React SPA dashboard UI |

## API Endpoints

### Chat

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chat` | Send message, receive streaming response |
| `GET` | `/api/chat/history` | Get session history |

### Agents

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents` | List all agents |
| `POST` | `/api/agents` | Create agent |
| `PUT` | `/api/agents/:id` | Update agent |
| `DELETE` | `/api/agents/:id` | Delete agent |

### Memory

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/memory/index` | List memory_index rows |
| `GET` | `/api/memory/index/stats` | Memory statistics |
| `DELETE` | `/api/memory/index/:id` | Delete memory |

### Wiki

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/wiki/tree` | Get wiki structure |
| `GET` | `/api/wiki/:section/:slug` | Get article content |

## Authentication

All API endpoints require authentication via:
- Query parameter: `?token=YOUR_TOKEN`
- Header: `x-dashboard-token: YOUR_TOKEN`

The token is set via `DASHBOARD_TOKEN` environment variable.

## Running

```bash
# Production (with auto-restart)
npm run dashboard

# Development (single run)
npm run dashboard:once

# Access
open http://localhost:3141/dashboard?token=YOUR_TOKEN
```

## Configuration

| Variable | Description |
|----------|-------------|
| `DASHBOARD_TOKEN` | Auth token for dashboard access |
| `PORT` | HTTP server port (3141) |
| `HOST` | Bind address (0.0.0.0) |
