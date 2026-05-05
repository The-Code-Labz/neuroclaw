# Compaction Working-State Injection

**Date:** 2026-05-05
**Status:** Approved

## Problem

When the context compactor fires, it summarizes old ("cold") turns and replaces them with a synthetic block. The summary prompt captures conversational context — decisions, preferences, constraints — but not the agent's active working state. Agents that were mid-task lose their goal entirely and respond to the next message as if starting fresh (option A: completely forgets the task).

## Solution

Add a dedicated `extractWorkingState` call inside `maybeCompactHistory` that looks at the full history's warm tail and produces a short structured block injected at the top of the replacement text, before the compacted summary. The agent's first visible context after compaction explicitly tells it what it was doing and what to do next.

## Architecture & Data Flow

Everything lives in `src/memory/context-compactor.ts`. One new function, one new config flag.

```
maybeCompactHistory()
  ├── summarizeRange(cold)                   ← existing, unchanged
  ├── extractWorkingState(history, keep)     ← NEW
  │     slices: warm tail + 4 turns before splice point
  │     runs: focused LLM call (max 150 tokens, temp 0)
  │     returns: structured block or '' on failure/NO_ACTIVE_TASK
  ├── buildRelevantMemoryBlock()             ← existing, unchanged
  └── builds replacementText:
        [Active Task — resumption state]     ← NEW (omitted if no active task)
        {workingState}
        [Prior context ...]                  ← existing
        {summary}
        [Relevant memories]                  ← existing
        {memories}
```

**Why warm tail + 4 prior turns (not full history)?** Current working state lives at the end of the conversation. Sending the full history to a second LLM call would duplicate the cost of `summarizeRange`. The warm tail (the `keepRecent` turns not being compacted) plus 4 turns just before the splice point captures where the task currently is without redundant context.

## LLM Prompt

**System:**
```
You are extracting the active working state from a conversation so an agent can
resume without losing its place. Output ONLY this block (no prose, no explanation):

Task: <what the agent is currently working on — one sentence>
Last completed: <most recent step finished — one sentence, or "none">
Next action: <the immediate next step — one sentence>
Blockers: <anything blocking progress, or "none">

If there is no active task in progress, output exactly: NO_ACTIVE_TASK
```

**Parameters:** `max_tokens: 150`, `temperature: 0`, inherits `config.compaction.model`.

**`NO_ACTIVE_TASK` sentinel:** When returned, `extractWorkingState` returns `''` and the block is omitted. No noise for idle/conversational sessions.

**Structured output rationale:** The working-state block is injected into the system prompt. Structured fields (`Next action: X`) act as a directive to the agent, not a historical narrative — this is what prevents the agent from treating the summary as background info and ignoring it.

## Configuration

One new env var added to `config.ts` `compaction` getter:

| Variable | Default | Notes |
|---|---|---|
| `COMPACT_EXTRACT_WORKING_STATE` | `true` | Set to `false` to skip the working-state LLM call |

Inherits `COMPACT_MODEL`. No new thresholds or limits.

## Error Handling

- `extractWorkingState` is wrapped in try/catch, identical pattern to `buildRelevantMemoryBlock`
- On failure: logs a warn, returns `''` — compaction continues normally without the block
- `extractWorkingState` is never called if `summarizeRange` returns too little content and compaction is already aborted
- The existing `logHive('memory_extracted', ...)` call's metadata object gains a new field: `working_state_extracted: boolean`

## What Does Not Change

- `CompactionPlan` interface — replacement text is a string, callers are unaffected
- `compactOpenAi` and `compactAnthropic` adapter functions in `alfred.ts`
- All existing thresholds, turn counts, memory reinjection behavior
- Anthropic and OpenAI chat paths call `maybeCompactHistory` identically

## Files Changed

| File | Change |
|---|---|
| `src/memory/context-compactor.ts` | Add `extractWorkingState`, update `maybeCompactHistory`, update `replacementText` assembly |
| `src/config.ts` | Add `COMPACT_EXTRACT_WORKING_STATE` to `compaction` getter |
