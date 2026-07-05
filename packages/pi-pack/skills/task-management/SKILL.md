---
name: task-management
description: "Track, organize, and query tasks across the NeuroClaw agent team. Use whenever the user asks what tasks are open, what's on the backlog, the status of delegated work, or wants to check progress, priorities, or assignments across multiple agents."
triggers: [open tasks, backlog, task status, delegated work, track progress, agent workload]
---

# NeuroClaw Task Management

Use this skill when the user wants to track, organize, or query tasks across the agent team.

## When to use

- User asks "what tasks are open", "what's on the backlog"
- User wants to check on delegated work
- User needs to track progress across multiple agents
- User asks about task status, priorities, or assignments

## Available tools

- `find_neuroclaw_tasks` — Query tasks with filters
- `delegate_to_neuroclaw` — Create and assign new tasks

## Filter options

Filter by:
- `status` — todo, doing, review, done
- `assignee` — Agent name or "unassigned"
- `project` — Project ID
- `parent` — Parent task ID (for subtasks)

## Workflow

### Check open tasks
```
find_neuroclaw_tasks({
  filter_by: "status",
  filter_value: "doing"
})
```

### Check agent workload
```
find_neuroclaw_tasks({
  filter_by: "assignee", 
  filter_value: "Coder"
})
```

### Search tasks
```
find_neuroclaw_tasks({
  query: "authentication refactor"
})
```

### Create task
```
delegate_to_neuroclaw({
  to: "Coder",
  title: "Implement OAuth flow",
  description: "Add Google and GitHub OAuth providers",
  priority: "high"
})
```

## Task statuses

- **todo** — Not started
- **doing** — In progress
- **review** — Awaiting review
- **done** — Completed

## Tips

- Check `doing` tasks to see what's actively being worked on
- Use `query` for text search across title and description
- Combine filters: query with project_id for scoped searches
