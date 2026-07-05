---
name: memory-recall
description: "Recall prior work, decisions, and context from previous NeuroClaw sessions. Use whenever the user says do you remember, what did we decide, or like we did before, references a past project or conversation, or when answering needs continuity from earlier sessions."
triggers: [do you remember, what did we decide, like before, past project, recall context, previous session]
---

# NeuroClaw Memory Recall

Use this skill when the user references prior work, asks about history, or expects continuity from previous sessions.

## When to use

- User says "do you remember", "what did we decide", "like we did before"
- User references a past project, decision, or conversation
- User asks about procedures, preferences, or patterns established earlier
- Answering requires context from previous sessions

## Available tools

- `search_neuroclaw_memory` — Search across all memory stores

## Memory sources

NeuroClaw memory includes:

1. **NeuroVault** — Structured long-term memory (procedures, decisions, insights)
2. **memory_index** — Indexed exchanges from previous sessions
3. **Session summaries** — Compacted conversation history

## Workflow

1. Extract key terms from the user's question
2. Call `search_neuroclaw_memory` with those terms
3. Review results for relevance
4. Incorporate relevant memories into your response
5. Cite the source when referencing recalled information

## Example

User: "How did we set up the deployment pipeline last month?"

```
search_neuroclaw_memory({
  query: "deployment pipeline setup CI/CD",
  limit: 5
})
```

Then synthesize the results into a coherent answer.

## Tips

- Use specific terms, not generic ones ("React auth flow" not "authentication")
- If first search yields nothing, try related terms
- Memory scores indicate relevance — higher is better
- Recent memories are often more relevant than old ones
