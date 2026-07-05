---
title: Docker deployment
order: 20
---

# Docker deployment

NeuroClaw can be containerized for deployment. This guide covers building and running with Docker.

## Dockerfile

Create `Dockerfile` in the project root:

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build

FROM node:20-alpine

WORKDIR /app

# Install runtime dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++ sqlite

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/docs ./docs

# Create data directory
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3141
ENV HOST=0.0.0.0

EXPOSE 3141

CMD ["node", "dist/dashboard/server.js"]
```

## Build and run

```bash
# Build image
docker build -t neuroclaw:latest .

# Run with environment file
docker run -d \
  --name neuroclaw \
  --restart unless-stopped \
  -p 3141:3141 \
  -v neuroclaw-data:/data \
  -v $(pwd)/.env:/app/.env:ro \
  neuroclaw:latest
```

## Docker Compose

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  neuroclaw:
    build: .
    container_name: neuroclaw
    restart: unless-stopped
    ports:
      - "3141:3141"
    volumes:
      - neuroclaw-data:/data
      - ./.env:/app/.env:ro
    environment:
      - NODE_ENV=production
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3141/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  neuroclaw-data:
```

Run with:

```bash
docker compose up -d
```

## Environment variables

Pass environment variables via:

1. **Mount .env file** (recommended for secrets):
   ```yaml
   volumes:
     - ./.env:/app/.env:ro
   ```

2. **Environment section** (for non-secrets):
   ```yaml
   environment:
     - NODE_ENV=production
     - MEMORY_EMBEDDINGS_ENABLED=true
   ```

3. **External secrets manager** (production):
   Use Docker secrets or external secret management.

## Database persistence

The SQLite database must persist across container restarts:

```yaml
volumes:
  - neuroclaw-data:/app  # Persists neuroclaw.db in /app
```

Or mount a specific directory:

```yaml
volumes:
  - ./data:/data
environment:
  - DATABASE_PATH=/data/neuroclaw.db
```

## Multi-container setup

For production with NeuroVault and other services:

```yaml
version: '3.8'

services:
  neuroclaw:
    build: .
    ports:
      - "3141:3141"
    volumes:
      - neuroclaw-data:/data
      - ./.env:/app/.env:ro
    depends_on:
      - neurovault
    environment:
      - MCP_ENABLED=true
      - NEUROVAULT_MCP_URL=http://neurovault:8080

  neurovault:
    image: neurovault:latest
    volumes:
      - vault-data:/vault
    environment:
      - VAULT_PATH=/vault

volumes:
  neuroclaw-data:
  vault-data:
```

## Resource limits

Set resource limits for production:

```yaml
services:
  neuroclaw:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '0.5'
          memory: 512M
```

## Logging

Configure logging driver:

```yaml
services:
  neuroclaw:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

Or use external logging:

```yaml
services:
  neuroclaw:
    logging:
      driver: "fluentd"
      options:
        fluentd-address: "localhost:24224"
```
