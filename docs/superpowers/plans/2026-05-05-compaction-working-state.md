# Compaction Working-State Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject an "Active Task — resumption state" block at the top of the compaction replacement text so agents know what they were doing after context is compacted.

**Architecture:** A new `extractWorkingState` function in `src/memory/context-compactor.ts` makes a focused LLM call on the warm tail of the history (recent kept turns + 4 turns before the splice point) and returns a short structured block. `maybeCompactHistory` calls it after `summarizeRange` and prepends the result to `replacementText` if non-empty.

**Tech Stack:** TypeScript, OpenAI-compatible client (`getClient()`), existing compactor patterns. No test suite — TypeScript type checking (`npx tsc --noEmit`) is the correctness gate.

---

### Task 1: Add `extractWorkingState` config flag

**Files:**
- Modify: `src/config.ts:101-109`

- [ ] **Step 1: Add the flag to the compaction getter**

In `src/config.ts`, find the `get compaction()` block (lines 101–109) and add `extractWorkingState` as the last property:

```typescript
  get compaction() {
    return {
      enabled:              (process.env.COMPACT_ENABLED ?? 'true').toLowerCase() !== 'false',
      tokenThreshold:       parseInt(process.env.COMPACT_TOKEN_THRESHOLD ?? '100000', 10),
      turnThreshold:        parseInt(process.env.COMPACT_TURN_THRESHOLD  ?? '30',   10),
      keepRecent:           parseInt(process.env.COMPACT_KEEP_RECENT     ?? '6',    10),
      reinjectMemories:     parseInt(process.env.COMPACT_REINJECT_MEMORIES ?? '3',  10),
      model:                process.env.COMPACT_MODEL?.trim() || undefined,
      extractWorkingState:  (process.env.COMPACT_EXTRACT_WORKING_STATE ?? 'true').toLowerCase() !== 'false',
    };
  },
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): add COMPACT_EXTRACT_WORKING_STATE flag"
```

---

### Task 2: Implement `extractWorkingState` function

**Files:**
- Modify: `src/memory/context-compactor.ts`

- [ ] **Step 1: Add the function after `buildRelevantMemoryBlock`**

In `src/memory/context-compactor.ts`, insert this function after the closing `}` of `buildRelevantMemoryBlock` (around line 191):

```typescript
async function extractWorkingState(history: HistoryTurn[], keep: number): Promise<string> {
  if (!config.compaction.extractWorkingState) return '';

  // Warm tail + 4 turns before the splice point — where current state lives.
  const to          = history.length - 1 - keep;
  const windowStart = Math.max(1, to - 3);
  const window      = history.slice(windowStart);
  if (window.length === 0) return '';

  const transcript = window
    .map(t => `[${t.role}] ${t.text}`)
    .join('\n\n')
    .slice(0, 6000);

  const model = config.compaction.model ?? config.voidai.model;
  try {
    const resp = await getClient().chat.completions.create({
      model,
      max_tokens:  150,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You are extracting the active working state from a conversation so an agent can ' +
            'resume without losing its place. Output ONLY this block (no prose, no explanation):\n\n' +
            'Task: <what the agent is currently working on — one sentence>\n' +
            'Last completed: <most recent step finished — one sentence, or "none">\n' +
            'Next action: <the immediate next step — one sentence>\n' +
            'Blockers: <anything blocking progress, or "none">\n\n' +
            'If there is no active task in progress, output exactly: NO_ACTIVE_TASK',
        },
        { role: 'user', content: transcript },
      ],
    });
    const raw = resp.choices[0]?.message?.content?.trim() ?? '';
    if (!raw || raw === 'NO_ACTIVE_TASK') return '';
    return `\n[Active Task — resumption state]\n${raw}\n`;
  } catch (err) {
    logger.warn('compactor: extractWorkingState failed', { error: (err as Error).message });
    return '';
  }
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors. The function references `config`, `getClient`, `logger`, and `HistoryTurn` — all already imported at the top of the file.

- [ ] **Step 3: Commit**

```bash
git add src/memory/context-compactor.ts
git commit -m "feat(compactor): add extractWorkingState function"
```

---

### Task 3: Wire `extractWorkingState` into `maybeCompactHistory`

**Files:**
- Modify: `src/memory/context-compactor.ts:75-128`

- [ ] **Step 1: Call `extractWorkingState` after `summarizeRange`**

In `maybeCompactHistory`, find these lines (around line 75–81):

```typescript
  const cold = history.slice(from, to + 1);
  const summary = await summarizeRange(cold);
  if (!summary || summary.trim().length < 20) {
    logger.warn('compactor: summarizer returned too little content; skipping');
    return null;
  }

  const relevantBlock = await buildRelevantMemoryBlock(input.newUserText ?? '', input.agentId ?? null);
```

Replace with:

```typescript
  const cold = history.slice(from, to + 1);
  const summary = await summarizeRange(cold);
  if (!summary || summary.trim().length < 20) {
    logger.warn('compactor: summarizer returned too little content; skipping');
    return null;
  }

  const workingState  = await extractWorkingState(history, keep);
  const relevantBlock = await buildRelevantMemoryBlock(input.newUserText ?? '', input.agentId ?? null);
```

- [ ] **Step 2: Prepend `workingState` to `replacementText`**

Find these lines (around line 103–106):

```typescript
  const replacementText =
    `[Prior context (auto-compacted ${cold.length} turns, ~${estimateRangeTokens(cold)} tokens)]\n` +
    summary +
    relevantBlock;
```

Replace with:

```typescript
  const replacementText =
    (workingState ? workingState + '\n' : '') +
    `[Prior context (auto-compacted ${cold.length} turns, ~${estimateRangeTokens(cold)} tokens)]\n` +
    summary +
    relevantBlock;
```

- [ ] **Step 3: Add `working_state_extracted` to the hive log**

Find the `logHive` call (around line 108–119):

```typescript
      {
        source:        'auto_compact',
        turns:         cold.length,
        tokens_before: totalTokens,
        memory_id:     summaryRef.memory_id,
        vault_path:    summaryRef.vault_path,
        session_id:    input.sessionId ?? null,
      });
```

Replace with:

```typescript
      {
        source:                  'auto_compact',
        turns:                   cold.length,
        tokens_before:           totalTokens,
        memory_id:               summaryRef.memory_id,
        vault_path:              summaryRef.vault_path,
        session_id:              input.sessionId ?? null,
        working_state_extracted: workingState.length > 0,
      });
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/memory/context-compactor.ts
git commit -m "feat(compactor): inject working-state block at top of compaction replacement"
```

---

### Task 4: Verify end-to-end behavior

- [ ] **Step 1: Start the dashboard server**

```bash
npm run dashboard
```

Expected: server starts on port 3141 with no errors.

- [ ] **Step 2: Manually trigger compaction**

Lower the thresholds temporarily in `.env` to force compaction on a short session:

```
COMPACT_TURN_THRESHOLD=4
COMPACT_TOKEN_THRESHOLD=500
COMPACT_KEEP_RECENT=2
```

Restart the server, then send 5+ messages to any agent via `/api/chat` or the CLI.

- [ ] **Step 3: Confirm the replacement block in logs**

Watch stdout for a line matching:

```
compactor: OpenAI history compacted
```

or

```
compactor: Anthropic history compacted
```

Then send one more message. The agent's response should reference its prior task rather than responding as if starting fresh.

- [ ] **Step 4: Confirm hive mind entry**

```bash
curl -s "http://localhost:3141/api/hive?limit=10&token=<YOUR_TOKEN>" | grep working_state_extracted
```

Expected: a `memory_extracted` event with `"working_state_extracted": true` or `false`.

- [ ] **Step 5: Restore `.env` thresholds**

Remove the temporary threshold overrides from `.env`.

- [ ] **Step 6: Final type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.
