---
title: Agent roles
order: 5
---

# Agent roles

Every NeuroClaw agent has a **role** that shapes its behavior, tool access, and routing priority. Roles are not cosmetic — they drive real differences in how an agent thinks, what it can do, and when it gets picked by the auto-router.

## The four roles

### Orchestrator

Reserved for **Alfred** only. Alfred gets the full strategic routing prompt, complete visibility into every active agent, and all coordination tools (`message_agent`, `assign_task_to_agent`, `spawn_agent`). Alfred is protected from deactivation and renaming.

You cannot assign this role to a user-created agent.

### Specialist

Built-in agents (Researcher, Coder, Planner) use this role. Specialists are domain experts.

**Behavior preamble injected at runtime:**
> Be precise, structured, and actionable in your domain. Skip meta-commentary. Ask one targeted clarifying question when context is missing rather than guessing.

**Tools:** Memory, inter-agent communication (`message_agent`), task assignment, sub-agent spawning. Exec and browser tools require `exec_enabled` / `BROWSERLESS_URL` as usual.

**Routing:** Auto-router prefers specialists **first** when classifying incoming messages.

### Assistant

General-purpose conversational agents. Assistants handle broad questions and softer interactions.

**Behavior preamble injected at runtime:**
> Be warm, thorough, and context-aware. Meet the user where they are. Reach other agents via `message_agent` when a specialist is needed, but handle general questions yourself.

**Tools:** Memory, inter-agent communication, task management. **Assistants cannot spawn sub-agents** — spawning is gated away from this role by design.

**Routing:** Auto-router picks assistants after specialists but before generic agents.

### Agent

The default for user-created agents. Maximum flexibility — the role preamble tells the agent it is "configurable" and defers to whatever system prompt the user wrote.

**Behavior preamble injected at runtime:**
> Your behavior is primarily defined by your system prompt. You have access to memory tools, inter-agent communication, and sub-agent spawning. Additional capabilities (exec, browser, etc.) are enabled per your configuration.

**Tools:** Memory, inter-agent communication, sub-agent spawning. Exec, browser, Discord, and other advanced tools are unlocked via the same flags they always used (`exec_enabled`, `BROWSERLESS_URL`, etc.) — the agent role leaves those decisions entirely to you.

**Routing:** Lowest routing priority — the auto-router picks these last.

## Summary table

| Role | Prompt flavor | Can spawn? | Routing priority |
|---|---|---|---|
| `orchestrator` | Strategic manager | Yes | N/A (Alfred only) |
| `specialist` | Domain expert, task-focused | Yes | 1st |
| `assistant` | Conversational, warm | **No** | 2nd |
| `agent` | User-defined | Yes | 3rd |

## Setting a role

When creating an agent via the dashboard, choose the role from the dropdown. When using the API directly:

```json
POST /api/agents
{
  "name": "MyAgent",
  "role": "specialist",
  "system_prompt": "You are a security specialist..."
}
```

The default role for new agents is `agent`.
