---
title: Production deployment
order: 10
---

# Production deployment

This guide covers deploying NeuroClaw to a production server using systemd.

## Prerequisites

- Node.js 20+ (LTS recommended)
- SQLite 3.35+ (for JSON functions)
- Linux server (Ubuntu/Debian tested)
- Reverse proxy (nginx/Caddy) for HTTPS

## Installation

```bash
# Clone and install
git clone <repo> /opt/neuroclaw
cd /opt/neuroclaw
npm install --omit=dev

# Build
npm run build

# Configure
cp .env.example .env
# Edit .env with production values
```

## Environment variables

Critical variables for production:

```bash
# Required
VOIDAI_API_KEY=your-api-key
DASHBOARD_TOKEN=long-random-string

# Production settings
NODE_ENV=production
PORT=3141
HOST=127.0.0.1  # Bind to localhost, proxy handles external

# Memory (tune for your workload)
MEMORY_PER_SESSION_MAX=100
MEMORY_PER_HOUR_MAX=500
```

See [Environment variables](../reference/env-vars.md) for the complete reference.

## Systemd service

Create `/etc/systemd/system/neuroclaw.service`:

```ini
[Unit]
Description=NeuroClaw Multi-Agent System
After=network.target

[Service]
Type=simple
User=neuroclaw
Group=neuroclaw
WorkingDirectory=/opt/neuroclaw
ExecStart=/usr/bin/node dist/dashboard/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# Environment
Environment=NODE_ENV=production
EnvironmentFile=/opt/neuroclaw/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/neuroclaw

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable neuroclaw
sudo systemctl start neuroclaw
sudo systemctl status neuroclaw
```

## Nginx reverse proxy

Example `/etc/nginx/sites-available/neuroclaw`:

```nginx
server {
    listen 443 ssl http2;
    server_name neuroclaw.example.com;

    ssl_certificate /etc/letsencrypt/live/neuroclaw.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/neuroclaw.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3141;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400;
    }
}
```

## Database backup

NeuroClaw uses SQLite. Back up the database file regularly:

```bash
# Manual backup
sqlite3 /opt/neuroclaw/neuroclaw.db ".backup '/backups/neuroclaw-$(date +%Y%m%d).db'"

# Cron job (daily at 3am)
0 3 * * * sqlite3 /opt/neuroclaw/neuroclaw.db ".backup '/backups/neuroclaw-$(date +\%Y\%m\%d).db'"
```

## Monitoring

### Health check endpoint

```bash
curl http://localhost:3141/health
# Returns: {"status":"ok"}
```

### Logs

```bash
# Live logs
journalctl -u neuroclaw -f

# Last 100 lines
journalctl -u neuroclaw -n 100

# Errors only
journalctl -u neuroclaw -p err
```

### Dashboard metrics

The dashboard exposes metrics at `/api/memory/index/stats`:

```json
{
  "total": 1234,
  "byType": {...},
  "lastHour": 45,
  "lastDay": 312,
  "vaultCapsLastHour": 0
}
```

## Scaling considerations

NeuroClaw is designed for single-node deployment. For higher loads:

1. **Memory** — Enable embeddings (`MEMORY_EMBEDDINGS_ENABLED=true`) for semantic search. Consider external vector DB for > 50k memories.

2. **Concurrency** — Tune `CLAUDE_CONCURRENCY_LIMIT` and `VOIDAI_CONCURRENCY_LIMIT` for your API quotas.

3. **MCP servers** — Run external MCP servers (NeuroVault) on separate processes/machines.

4. **Database** — SQLite handles most workloads. For very high write volumes, consider periodic vacuuming:
   ```bash
   sqlite3 neuroclaw.db "VACUUM;"
   ```
