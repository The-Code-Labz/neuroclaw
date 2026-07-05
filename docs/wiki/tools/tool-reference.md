---
title: Tool reference
order: 20
---

# Tool reference

Complete reference of all built-in tools available to NeuroClaw agents.

## Memory & Vault tools

These tools require `MCP_ENABLED=true` to be visible.

| Tool | Description |
|---|---|
| `search_memory` | Hybrid search across memory_index and NeuroVault. Returns categorized hits (memory, procedures, insights, preferences) ranked by salience, importance, and recency. |
| `search_vault` | Direct search against NeuroVault MCP, bypassing local SQLite index. Useful when looking for externally-written notes. |
| `write_vault_note` | Persist a structured memory to the local index and optionally mirror to NeuroVault. Requires `title`, `type`, and `summary`. |
| `save_session_summary` | Convenience wrapper for creating `session_summary` type memories. Used by the context compactor. |
| `compact_context` | Manually trigger conversation compaction. Takes a serialized conversation excerpt and produces a session summary. |
| `get_context_pack` | Fetch the most recent context pack from NeuroVault for session restoration. |

### search_memory

```typescript
{
  query: string,     // What to look up (2-8 keywords)
  limit?: number     // Max hits (1-50, default 20)
}
```

Returns:
```json
{
  "memory": [...],      // episodic, working, project, agent, session_summary
  "procedures": [...],  // procedural type
  "insights": [...],    // insight, semantic type
  "preferences": [...]  // preference type
}
```

---

## Agent communication tools

| Tool | Description |
|---|---|
| `message_agent` | Send a direct message to another agent and receive a synchronous response. |
| `assign_task_to_agent` | Create a task assigned to an agent. Optionally execute immediately. |
| `list_agents` | List all agents in the registry for discovery purposes. |

### message_agent

```typescript
{
  agentName: string,  // Name of target agent
  message: string,    // Message to send
  context?: string    // Optional additional context
}
```

### assign_task_to_agent

```typescript
{
  agentName: string,
  task: string,
  priority?: "low" | "medium" | "high",
  executeNow?: boolean  // If true, runs immediately
}
```

---

## Spawning tools

Spawning requires the calling agent to have `spawn_enabled=true` and `spawn_depth < 3`.

| Tool | Description |
|---|---|
| `spawn_agent` | Create a temporary specialized sub-agent that inherits from a template. |
| `list_temp_agents` | List all active temporary agents and their status. |

### spawn_agent

```typescript
{
  name: string,           // Unique name for the spawned agent
  systemPrompt: string,   // Instructions for the agent
  model?: string,         // Override model (defaults to parent's)
  parentAgentId?: string  // Parent for spawn chain tracking
}
```

Spawned agents are ephemeral and cleaned up after inactivity.

---

## Exec tools

Exec tools are disabled by default. Each agent must have `exec_enabled=true` to use them.

| Tool | Description |
|---|---|
| `bash_run` | Execute a shell command on the host. Returns stdout, stderr, and exit code. |
| `fs_read` | Read file contents from the host filesystem. |
| `fs_write` | Write to a file (create, overwrite, or append). |
| `fs_list` | List directory contents with file metadata. |
| `fs_search` | Recursively search for a regex pattern using ripgrep or grep. |

### bash_run

```typescript
{
  command: string,
  cwd?: string,       // Working directory
  timeout?: number    // Timeout in ms (default 30000)
}
```

Returns:
```json
{
  "stdout": "...",
  "stderr": "...",
  "exitCode": 0
}
```

### fs_write

```typescript
{
  path: string,
  content: string,
  mode?: "create" | "overwrite" | "append"  // default: overwrite
}
```

---

## Discord tools

| Tool | Description |
|---|---|
| `discord_register_bot` | Register a new Discord bot configuration with token. |
| `discord_add_channel_route` | Map a Discord channel to a NeuroClaw agent. |
| `discord_list_bots` | List all configured Discord bots with connection status. |
| `discord_remove_bot` | Delete a Discord bot configuration. |
| `discord_list_guilds` | List all servers a bot is a member of. |
| `discord_react` | Add an emoji reaction to a Discord message. |
| `discord_set_auto_reply_guilds` | Configure which servers have auto-reply enabled. |
| `discord_set_user_voice` | Set per-user TTS voice preference override. |

---

## Audio tools

| Tool | Description |
|---|---|
| `audio_list_voices` | List available TTS voices from VoidAI and ElevenLabs. |
| `audio_status` | Get current voice configuration for an agent or bot. |
| `audio_configure_agent` | Set an agent's TTS provider, voice ID, and settings. |
| `audio_configure_discord_bot` | Toggle a Discord bot's voice_enabled setting. |

---

## Projects & Tasks tools

Archon-compatible task management.

| Tool | Description |
|---|---|
| `find_projects` | List, search, or fetch projects by ID. |
| `manage_project` | Create, update, or delete projects. |
| `find_tasks` | List, search, or fetch tasks with filters (status, priority, project). |
| `manage_task` | Create, update, or delete tasks. |

### find_tasks

```typescript
{
  action: "list" | "search" | "get",
  task_id?: string,
  query?: string,
  filter_by?: "status" | "priority" | "project_id",
  filter_value?: string
}
```

---

## Skills tools

| Tool | Description |
|---|---|
| `list_skills` | List all registered skills with their descriptions. |
| `run_skill_script` | Execute a script bundled with a skill. |
| `manage_skill` | Create, update, or delete skills. |
| `manage_skill_script` | Add, update, or delete skill scripts. |

---

## Browser tools

Require `BROWSER_ENABLED=true` and a Browserless instance.

| Tool | Description |
|---|---|
| `browser_fetch` | Fetch a fully-rendered web page (post-JavaScript HTML). |
| `browser_screenshot` | Capture a screenshot of a web page. |
| `browser_pdf` | Render a web page to PDF. |
| `browser_run_js` | Run arbitrary JavaScript in a Puppeteer context. |

### browser_fetch

```typescript
{
  url: string,
  waitFor?: string,   // CSS selector to wait for
  timeout?: number    // Timeout in ms
}
```

---

## Automation tools

| Tool | Description |
|---|---|
| `schedule_job` | Create a scheduled automation job (cron expression). |
| `list_jobs` | List all scheduled jobs with next run time. |
| `update_job` | Update an existing job's schedule or handler. |
| `delete_job` | Delete a scheduled job. |
| `get_job_runs` | Get execution history for a job. |

### schedule_job

```typescript
{
  name: string,
  cron: string,           // Cron expression (e.g., "0 9 * * 1")
  agentName: string,      // Agent to execute the job
  prompt: string,         // Message to send to the agent
  enabled?: boolean       // default: true
}
```
