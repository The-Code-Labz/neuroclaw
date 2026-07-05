---
name: delegate-to-agent
description: "Delegate work to NeuroClaw agents and coordinate multi-agent work. Use whenever the user names an agent (Alfred, Coder, Researcher, Designer), says to ask, have, or delegate to a specific agent, wants parallel work across specialists, or needs a task routed to domain expertise."
triggers: [delegate to, ask alfred, assign a task, hand off, route to an agent, multi-agent work]
---

# Delegate to NeuroClaw Agents

Use this skill when the user wants to delegate work to another agent, assign tasks, or coordinate multi-agent work.

## When to use

- User says "ask Alfred", "have Coder do this", "delegate to Researcher"
- User wants parallel work across multiple specialists
- Task requires domain expertise from a named agent
- User explicitly mentions agent names (Alfred, Coder, Researcher, etc.)

## Available tools

- `ask_alfred` — Send a message to the agent team and get a response
- `list_neuroclaw_agents` — Discover available agents
- `delegate_to_neuroclaw` — Assign a task to a specific agent

## Workflow

1. If unsure which agent to use, call `list_neuroclaw_agents` first
2. For quick questions: use `ask_alfred` with the message
3. For tasks that need tracking: use `delegate_to_neuroclaw`
4. Set `execute_now: true` if you want the result immediately

## Agent roster (typical)

- **Alfred** — Orchestrator, routes requests to specialists
- **Coder** — Software engineering, code review, debugging
- **Researcher** — Information gathering, analysis, documentation
- **Designer** — UI/UX, visual design, mockups

## Example

User: "Have Coder review the auth module"

```
delegate_to_neuroclaw({
  to: "Coder",
  title: "Review auth module for security issues",
  description: "Focus on authentication flow, session management, and input validation",
  execute_now: true
})
```
