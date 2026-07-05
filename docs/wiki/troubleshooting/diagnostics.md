---
title: Diagnostics
order: 20
---

# Diagnostics

NeuroClaw includes built-in diagnostic scripts to verify system health.

## Memory diagnostics

Run the memory system check:

```bash
npm run check:memory
```

This runs 10 tests covering:

1. **Database connection** — SQLite opens successfully
2. **Memory extraction** — LLM can extract memories from exchanges
3. **Memory scoring** — Importance scoring produces valid scores
4. **Memory storage** — Writes to `memory_index` succeed
5. **Hybrid retrieval** — Lexical search returns results
6. **Vector retrieval** — Embedding search works (if enabled)
7. **NeuroVault connection** — MCP server responds (if configured)
8. **Vault mirroring** — Notes sync to vault correctly
9. **Context compaction** — Summarizer produces valid output
10. **Rate cap enforcement** — Hourly/session limits work

Example output:

```
=== Memory System Diagnostics ===

[1/10] Database connection... ✓ (12ms)
[2/10] Memory extraction... ✓ (1,234ms)
[3/10] Memory scoring... ✓ (45ms)
[4/10] Memory storage... ✓ (23ms)
[5/10] Hybrid retrieval... ✓ (156ms)
[6/10] Vector retrieval... ⊘ skipped (embeddings disabled)
[7/10] NeuroVault connection... ✓ (89ms)
[8/10] Vault mirroring... ✓ (234ms)
[9/10] Context compaction... ✓ (1,567ms)
[10/10] Rate cap enforcement... ✓ (12ms)

9/10 passed, 1 skipped
```

## Claude backend diagnostics

Run the Claude CLI backend check:

```bash
npm run check:claude
```

This verifies:

1. **Claude CLI installed** — `claude` command exists
2. **Claude authenticated** — Session is active
3. **Model availability** — Requested models are accessible
4. **Concurrency limits** — Parallel requests work within limits
5. **Tool integration** — MCP server connection works

## Manual health checks

### API health

```bash
curl http://localhost:3141/health
# {"status":"ok"}
```

### Agent status

```bash
curl "http://localhost:3141/api/agents?token=YOUR_TOKEN" | jq '.[] | {name, provider, active}'
```

### Memory stats

```bash
curl "http://localhost:3141/api/memory/index/stats?token=YOUR_TOKEN" | jq
```

Output:
```json
{
  "total": 1234,
  "byType": {
    "episodic": { "count": 456, "avgImportance": 0.72 },
    "procedural": { "count": 123, "avgImportance": 0.81 },
    ...
  },
  "lastHour": 45,
  "lastDay": 312,
  "vaultCapsLastHour": 0,
  "autoCompactsLastDay": 8
}
```

### Hive Mind events

```bash
curl "http://localhost:3141/api/memory/hive?token=YOUR_TOKEN&limit=20" | jq
```

Shows recent memory-related events:
- `memory_extracted` — Successful memory writes
- `memory_skipped` — Below threshold, dedupe, etc.
- `memory_capped` — Rate limit hit

## Log analysis

### View recent logs

```bash
# If running via systemd
journalctl -u neuroclaw -n 100

# If running directly
tail -f logs/neuroclaw.log
```

### Filter by severity

```bash
# Errors only
journalctl -u neuroclaw -p err

# Warnings and above
journalctl -u neuroclaw -p warning
```

### Search for specific issues

```bash
# Memory extraction failures
journalctl -u neuroclaw | grep "memory extraction failed"

# MCP connection issues
journalctl -u neuroclaw | grep "MCP"

# Rate limiting
journalctl -u neuroclaw | grep "rate limit\|429"
```

## Database inspection

### Check table sizes

```bash
sqlite3 neuroclaw.db "
SELECT 
  name,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=m.name) as row_count
FROM sqlite_master m 
WHERE type='table';
"
```

### Check memory distribution

```bash
sqlite3 neuroclaw.db "
SELECT type, COUNT(*) as count, AVG(importance) as avg_importance
FROM memory_index
GROUP BY type
ORDER BY count DESC;
"
```

### Find recent memories

```bash
sqlite3 neuroclaw.db "
SELECT id, type, title, importance, created_at
FROM memory_index
ORDER BY created_at DESC
LIMIT 10;
"
```

### Check for database issues

```bash
sqlite3 neuroclaw.db "PRAGMA integrity_check;"
sqlite3 neuroclaw.db "PRAGMA foreign_key_check;"
```

## Performance profiling

### Measure API response times

```bash
# Chat endpoint
time curl -X POST "http://localhost:3141/api/chat?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","agentId":"alfred"}'

# Memory search
time curl "http://localhost:3141/api/memory/search?token=YOUR_TOKEN&q=test"
```

### Monitor resource usage

```bash
# Process stats
ps aux | grep node

# Memory usage over time
watch -n 5 'ps -o pid,rss,vsz,comm -p $(pgrep -f "node.*neuroclaw")'
```
