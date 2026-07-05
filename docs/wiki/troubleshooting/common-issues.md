---
title: Common issues
order: 10
---

# Common issues

Solutions to frequently encountered problems.

## API errors

### VoidAI returns HTTP 500 for invalid API keys

Unlike most providers, VoidAI returns a 500 error (not 401) when the API key is invalid or expired.

**Solution:** Verify your `VOIDAI_API_KEY` is correct and active:
```bash
curl -H "Authorization: Bearer $VOIDAI_API_KEY" https://api.voidai.com/v1/models
```

### Rate limiting

If you see `429 Too Many Requests` errors:

1. Check your rate limits in the provider dashboard
2. Reduce concurrency limits:
   ```bash
   VOIDAI_CONCURRENCY_LIMIT=2
   CLAUDE_CONCURRENCY_LIMIT=1
   ```
3. Enable memory rate caps:
   ```bash
   MEMORY_PER_HOUR_MAX=100
   ```

## Memory issues

### Memories not being stored

1. Check minimum length threshold:
   ```bash
   MEMORY_EXTRACT_MIN_CHARS=200  # Responses shorter than this skip extraction
   ```

2. Check importance threshold:
   ```bash
   MEMORY_IMPORTANCE_THRESHOLD=0.6  # Lower to store more, raise to be selective
   ```

3. Run the memory diagnostic:
   ```bash
   npm run check:memory
   ```

### Vault rate caps hit

When `memory_capped` events appear in Hive Mind:

```bash
# Increase per-session limit
MEMORY_PER_SESSION_MAX=100

# Increase hourly limit
MEMORY_PER_HOUR_MAX=500
```

Local SQLite writes are never capped — only NeuroVault mirroring.

### Embeddings not working

If semantic search returns poor results:

1. Ensure embeddings are enabled:
   ```bash
   MEMORY_EMBEDDINGS_ENABLED=true
   ```

2. Check the embedding model is accessible:
   ```bash
   MEMORY_EMBEDDING_MODEL=text-embedding-3-small
   ```

3. Verify the minimum character threshold isn't filtering content:
   ```bash
   MEMORY_EMBEDDING_MIN_CHARS=30
   ```

## Dashboard issues

### Dashboard not loading

1. Check the server is running:
   ```bash
   curl http://localhost:3141/health
   ```

2. Verify the token in the URL matches `DASHBOARD_TOKEN`:
   ```
   http://localhost:3141/dashboard?token=YOUR_TOKEN
   ```

3. Check for port conflicts:
   ```bash
   lsof -i :3141
   ```

### SSE events not streaming

If chat responses don't stream in real-time:

1. Check your reverse proxy configuration allows SSE:
   ```nginx
   proxy_buffering off;
   proxy_cache off;
   ```

2. Ensure no CDN is buffering responses

## Agent issues

### Agent not responding

1. Check the agent exists and is active:
   ```bash
   curl "http://localhost:3141/api/agents?token=YOUR_TOKEN"
   ```

2. Verify the agent's model is available:
   - For Claude CLI agents, ensure `claude` is authenticated
   - For VoidAI agents, ensure the model ID is valid

3. Check the agent's system prompt isn't empty

### Spawned agents disappear

Temporary agents are automatically cleaned up after inactivity. To keep them longer:

1. Interact with them regularly
2. Convert important spawned agents to permanent via the dashboard

### Tools not visible to agent

1. Check the tool's gate conditions:
   - `MCP_ENABLED=true` for memory tools
   - `exec_enabled=true` on the agent for exec tools
   - `spawn_enabled=true` and depth < 3 for spawning

2. Verify the agent context is passed correctly

## MCP issues

### MCP server not connecting

1. Test the connection directly:
   ```bash
   curl http://localhost:8080/health  # Replace with your MCP URL
   ```

2. Check `MCP_ENABLED=true` is set

3. Verify the URL format (no trailing slash):
   ```bash
   NEUROVAULT_MCP_URL=http://localhost:8080
   ```

### External MCP tools not appearing

1. Refresh the tool list in the dashboard
2. Check the MCP server's `/tools` endpoint returns valid tools
3. Verify the MCP server is registered in the dashboard's MCP section

## Database issues

### Database locked

SQLite can lock during high write concurrency:

1. Ensure only one NeuroClaw instance is running
2. Enable WAL mode (default in recent versions):
   ```sql
   PRAGMA journal_mode=WAL;
   ```

3. Reduce concurrent memory writes

### Database corrupted

If you see "database disk image is malformed":

1. Stop NeuroClaw
2. Run integrity check:
   ```bash
   sqlite3 neuroclaw.db "PRAGMA integrity_check;"
   ```

3. If corrupted, restore from backup or rebuild:
   ```bash
   sqlite3 neuroclaw.db ".dump" | sqlite3 neuroclaw-new.db
   ```

## Performance issues

### Slow response times

1. **Check embedding overhead:** Disable if not needed:
   ```bash
   MEMORY_EMBEDDINGS_ENABLED=false
   ```

2. **Reduce pre-injection:** Lower the count:
   ```bash
   MEMORY_PREINJECT_MAX=3
   ```

3. **Check MCP latency:** External MCP servers add round-trip time

4. **Profile with diagnostics:**
   ```bash
   npm run check:memory
   npm run check:claude
   ```

### High memory usage

1. Reduce tool concurrency
2. Enable context compaction (default):
   ```bash
   COMPACT_ENABLED=true
   COMPACT_TOKEN_THRESHOLD=8000
   ```

3. Restart periodically to clear caches
