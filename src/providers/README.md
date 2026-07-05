# Providers Module

External AI provider backends (Claude CLI, Codex CLI, Gemini CLI).

## Overview

Providers enable agents to use AI backends other than the OpenAI-compatible API:
- **Claude CLI** — Uses the `claude` command-line tool (subscription-based)
- **Codex CLI** — Uses OpenAI's Codex CLI
- **Gemini CLI** — Uses Google's Gemini CLI

## Architecture

```
┌─────────────────────────────────────────┐
│           Agent Orchestrator            │
└───────────────┬─────────────────────────┘
                │
    ┌───────────┼───────────┬─────────────┐
    │           │           │             │
    ▼           ▼           ▼             ▼
┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
│  VoidAI │ │ Claude  │ │  Codex  │ │ Gemini  │
│  (API)  │ │  (CLI)  │ │  (CLI)  │ │  (CLI)  │
└─────────┘ └─────────┘ └─────────┘ └─────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `claude-cli.ts` | Claude CLI backend |
| `codex-cli.ts` | Codex CLI backend |
| `gemini-cli.ts` | Gemini CLI backend |

## Claude CLI Provider

Uses the `claude` command with MCP integration:

```typescript
import { runClaudeCli } from './claude-cli';

const response = await runClaudeCli({
  prompt: 'Explain this code...',
  systemPrompt: 'You are a code reviewer',
  mcpServers: [{ url: 'http://localhost:8080' }],
});
```

### Configuration

| Variable | Description |
|----------|-------------|
| `CLAUDE_CLI_PATH` | Path to claude binary |
| `CLAUDE_CONCURRENCY_LIMIT` | Max parallel requests |
| `CLAUDE_MODEL` | Model to use (claude-3-5-sonnet) |

### Important Notes

- Claude CLI uses subscription quota, not API billing
- Watch concurrency limits to avoid rate limiting
- MCP servers are passed via `--mcp-server` flag

## Provider Selection

Agents specify their provider in the database:

```sql
INSERT INTO agents (name, provider, model)
VALUES ('researcher', 'claude-cli', 'claude-3-5-sonnet');
```

Provider values:
- `voidai` — VoidAI/OpenAI API (default)
- `anthropic` — Direct Anthropic API
- `claude-cli` — Claude CLI tool
- `codex-cli` — Codex CLI tool
- `gemini-cli` — Gemini CLI tool
- `mcp` — External MCP server
