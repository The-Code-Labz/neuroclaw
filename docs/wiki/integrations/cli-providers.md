---
title: CLI providers (Claude, Codex & Gemini)
order: 60
---

# CLI providers (Claude, Codex & Gemini)

NeuroClaw supports local CLI backends — **Claude CLI**, **Codex CLI**, and **Gemini CLI** — in addition to its default API-key backends. These paths use the logged-in CLI account where the upstream CLI supports it, keeping key management local to the machine.

## Claude CLI provider

### Activating

Set `CLAUDE_BACKEND=claude-cli` (the default) in your `.env`. When this backend is active, agents that are assigned to the Claude provider route their chat calls through `streamClaudeCliChat()` in `src/providers/claude-cli.ts`.

### How it works

Each call goes through the `@anthropic-ai/claude-agent-sdk` `query()` function — the same SDK that the `claude` binary uses internally. NeuroClaw passes the system prompt, user prompt, model, and tool list directly into the SDK rather than re-spawning the binary on every message. The SDK manages the subprocess under the hood.

`ANTHROPIC_API_KEY` is stripped from the child process environment before each call so the SDK falls back to OAuth subscription credentials and never accidentally bills an API key.

### Binary discovery

The provider tries to locate the binary in this order:

1. The configured command (`CLAUDE_CLI_COMMAND`) — if it is an absolute path and exists on disk, that path is used directly.
2. `which <command>` — honors the current `PATH`.
3. A hardcoded list of common install locations: `~/.local/bin/`, `~/.claude/local/`, `/usr/local/bin/`, `/opt/homebrew/bin/`.

The fallback list exists because NeuroClaw's server process is often started without the user's full shell environment, so `~/.local/bin` may not be in `PATH` even when the binary is installed there.

### Tool access

By default, Claude CLI agents are text-only — the built-in Claude Code file tools (Bash, Read, Write, Edit, Grep, Glob) are disabled. If you enable exec via the agent's `exec_enabled` flag, all six tools are added to the call.

When `MCP_ENABLED=true`, an in-process NeuroClaw MCP server is mounted automatically. This gives the agent native access to memory, vault, agent-messaging, spawn, and checkpoint tools without any extra configuration. User-registered MCP servers (added in the dashboard) are also mounted at call time, and all their tools are pre-approved so the conversation does not stall on permission prompts.

Composio is supported per-agent: if the agent has `composio_enabled=true` and a `composio_user_id`, the provider mints a Composio session and mounts it as a second MCP server alongside the NeuroClaw server.

### Retry logic

The provider does not retry internally — retries are the caller's responsibility. Two structured error types are exported for callers to branch on:

- `ClaudeCliRateLimitError` — the SDK returned a `rate_limit` error message.
- `ClaudeCliAuthError` — the SDK returned `authentication_failed`.

The upstream caller (`src/agent/alfred.ts`) uses `CLAUDE_RETRY_MAX` and `CLAUDE_RETRY_BASE_MS` to implement exponential-backoff retries on `ClaudeCliRateLimitError`.

### Concurrency gate

Subscription accounts have tight rate windows. The provider serializes calls with an internal semaphore. At most `CLAUDE_CONCURRENCY_LIMIT` (default: 1) calls run simultaneously; additional calls queue and wait. You can inspect the queue depth at runtime via `getClaudeCliQueueLength()`.

---

## Codex CLI provider

### Activating

Set `CODEX_BACKEND=cli` (the default) in your `.env`. Calls are handled by `streamCodexCliChat()` in `src/providers/codex-cli.ts`.

### How it works

Unlike the Claude CLI provider, Codex does not have an SDK — NeuroClaw spawns the `codex` binary directly as a subprocess and communicates via stdio. The binary is run with `codex exec --json --skip-git-repo-check`, which causes it to emit newline-delimited JSON (JSONL) on stdout:

```
{"type":"thread.started","thread_id":"..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"type":"agent_message","text":"..."}}
{"type":"turn.completed","usage":{"input_tokens":...,"output_tokens":...}}
```

NeuroClaw reads stdout line by line, JSON-parses each event, and yields `item.completed` events where `item.type === "agent_message"` as text chunks. Codex does not stream character-by-character in this mode — it emits whole messages — so the UI receives complete paragraphs rather than incremental tokens.

`OPENAI_API_KEY` is stripped from the child environment so the binary is forced to use ChatGPT subscription credentials from `~/.codex/auth.json`.

### System prompt

Codex has no `--system` flag. When a system prompt is provided, the provider prepends it to the user prompt wrapped in `[SYSTEM]...[/SYSTEM]` markers before writing to stdin. The full prompt is passed via stdin (not as a CLI argument) to avoid hitting shell command-line length limits.

### Tools and skills

When `MCP_ENABLED=true`, NeuroClaw writes a `neuroclaw` Streamable-HTTP MCP server into `~/.codex/config.toml` before each Codex turn. That server exposes the same unified tool registry used by the OpenAI-compatible and Claude SDK paths: memory, hive-mind messaging, task assignment, spawning, skills, user-registered MCP tools, and MCP-backed agents.

The merged skill catalog is also mirrored to `.codex/skills/` by `npm run skills:sync` and by dashboard startup. Skills can originate from `.claude/skills/`, `~/.claude/skills/`, `.agents/skills/`, installed Claude plugins, or marketplace bundles.

### Sandbox modes

Codex runs inside a sandboxed execution harness. `CODEX_SANDBOX_MODE` controls what the binary's shell tools can do:

| Mode | What it allows |
|---|---|
| `read-only` | Default. Agents can read files but not write them. |
| `workspace-write` | Agents can write files inside the working directory. |
| `danger-full-access` | No restrictions. Use only in isolated environments. |

The safe default is `read-only`. For agents that genuinely need to write files, prefer the Claude CLI exec path or NeuroClaw's own `bash_run` tool instead.

### Binary discovery

Same strategy as the Claude CLI provider, minus the `~/.claude/local/` fallback: absolute path check, then `which`, then `~/.local/bin/`, `/usr/local/bin/`, `/opt/homebrew/bin/`.

### Error classification

Non-zero exit codes are caught and classified by pattern-matching stderr and stdout error events. Auth-related messages throw `CodexCliAuthError`; rate-limit messages throw `CodexCliRateLimitError`. The rest surface as generic `Error` with the raw output included for debugging.

### Concurrency gate

Same pattern as the Claude CLI provider. Default `CODEX_CONCURRENCY_LIMIT=1` serializes all calls. The concurrency-limit-1 default also means NeuroClaw never races a running codex process against a config write, which matters for Composio integration: the provider syncs `~/.codex/config.toml` before spawning the process.

---

## Gemini CLI provider

### Activating

Create or edit an agent with provider `gemini`. Calls are handled by `streamGeminiCliChat()` in `src/providers/gemini-cli.ts`.

### How it works

NeuroClaw spawns the local `gemini` binary in headless mode with `--output-format stream-json`. The prompt is sent through stdin, and stdout is parsed as JSONL events. Assistant message chunks are streamed into the normal chat path; final usage stats are captured when the CLI emits them.

### Tool access

When `MCP_ENABLED=true`, NeuroClaw writes a trusted `neuroclaw` Streamable HTTP MCP server entry to `~/.gemini/settings.json`, pointing at the dashboard `/mcp` endpoint. Per-agent Composio sessions are written into the same settings file before the Gemini process starts, matching the Codex config-sync pattern.

### Concurrency gate

Default `GEMINI_CONCURRENCY_LIMIT=1` serializes Gemini CLI calls. This avoids racing per-turn MCP header writes and stays conservative with account-level quotas.

---

## When to use CLI providers

Use a CLI provider when:

- You have a Claude, ChatGPT, or Google account CLI login and no API key (or you prefer to keep key management out of the server environment).
- You want to offload inference costs to a flat-rate subscription.
- You are running NeuroClaw locally for personal use and latency is acceptable.

Trade-offs to be aware of:

- **Latency**: Codex spawns a subprocess per call, which adds startup overhead. Claude CLI avoids this by using the SDK directly but still goes through the subscription's OAuth path.
- **Concurrency**: CLI providers default to `concurrencyLimit=1`. Multi-agent or parallel task scenarios will queue up rather than run in parallel. Increase the limit only if your account's rate window supports it.
- **No heartbeat pings**: `HEARTBEAT_SKIP_CLAUDE_CLI=true` by default, so the system skips liveness checks for Claude CLI agents to avoid burning subscription quota.

---

## Binary installation

- **Claude Code CLI**: See the official install guide at [claude.ai/code](https://claude.ai/code). After install, verify with `claude --version`.
- **OpenAI Codex CLI**: See the [Codex CLI repository](https://github.com/openai/codex) for install instructions. After install, authenticate with `codex login`, then verify with `codex --version`.
- **Google Gemini CLI**: Install `@google/gemini-cli` or use the official Gemini CLI repository. After install, authenticate by running `gemini`, then verify with `gemini --version`.

---

## Configuration reference

| Variable | Default | Notes |
|---|---|---|
| `CLAUDE_BACKEND` | `claude-cli` | Set to `anthropic-api` to use a direct API key instead |
| `CLAUDE_CLI_COMMAND` | `claude` | Binary name or absolute path |
| `CLAUDE_MAX_TURNS` | `20` | Maximum agentic turns per call |
| `CLAUDE_TIMEOUT_MS` | `900000` | Milliseconds before the call is aborted (15 minutes) |
| `CLAUDE_CONCURRENCY_LIMIT` | `1` | Max simultaneous Claude CLI calls |
| `CLAUDE_RETRY_MAX` | `2` | Max retries on rate-limit errors |
| `CLAUDE_RETRY_BASE_MS` | `3000` | Base delay for exponential backoff (ms) |
| `CODEX_BACKEND` | `cli` | Set to `api` to use a direct API key instead |
| `CODEX_CLI_COMMAND` | `codex` | Binary name or absolute path |
| `CODEX_TIMEOUT_MS` | `900000` | Milliseconds before the subprocess is killed (15 minutes) |
| `CODEX_CONCURRENCY_LIMIT` | `1` | Max simultaneous Codex CLI calls |
| `CODEX_SANDBOX_MODE` | `read-only` | `read-only`, `workspace-write`, or `danger-full-access` |
| `GEMINI_CLI_COMMAND` | `gemini` | Binary name or absolute path |
| `GEMINI_MODEL` | `gemini-2.5-pro` | Default Gemini model for new Gemini agents |
| `GEMINI_TIMEOUT_MS` | `900000` | Milliseconds before the subprocess is killed (15 minutes) |
| `GEMINI_CONCURRENCY_LIMIT` | `1` | Max simultaneous Gemini CLI calls |
