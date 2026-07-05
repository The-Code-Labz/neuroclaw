# Archon MCP Deep Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Archon MCP the active knowledge and task backbone for all NeuroClaw agents — automatic RAG search before implementing, and automatic task status updates flowing through Archon as agents work.

**Architecture:** Add a `buildArchonSection()` prompt builder injected into every agent's dynamic system message, and an `archon-lifecycle.ts` middleware hooked into `chatStream()`'s single dispatcher entry point. The lifecycle middleware calls `callRegisteredTool('archon', ...)` directly so status updates happen without agent intervention.

**Tech Stack:** TypeScript, existing `callRegisteredTool` from `src/mcp/mcp-registry.ts`, existing `logHive` pattern from `src/system/hive-mind.ts`, existing dynamic prompt builder pattern in `src/agent/alfred.ts`.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/system/archon-lifecycle.ts` | Create | Extract task IDs from messages; call Archon MCP to update status; log to hive mind |
| `src/system/hive-mind.ts` | Modify | Add `archon_task_started` and `archon_task_reviewed` to `HiveAction` union type |
| `src/agent/alfred.ts` | Modify | Add `buildArchonSection()`; append it to `buildOrchestratorPrompt()` and `buildTeamSection()`; call lifecycle hooks in `chatStream()` |

---

## Task 1: Extend HiveAction with Archon lifecycle events

**Files:**
- Modify: `src/system/hive-mind.ts:95`

- [ ] **Step 1: Add two new actions to the HiveAction union**

Open `src/system/hive-mind.ts`. Find line 95 (the last line of the `HiveAction` union):

```typescript
  | 'orphaned_doing_task_requeued';
```

Replace it with:

```typescript
  | 'orphaned_doing_task_requeued'
  | 'archon_task_started'
  | 'archon_task_reviewed';
```

- [ ] **Step 2: Type-check the change**

```bash
npx tsc --noEmit 2>&1 | grep hive-mind
```

Expected: no output (no errors in hive-mind.ts).

- [ ] **Step 3: Commit**

```bash
git add src/system/hive-mind.ts
git commit -m "feat(hive-mind): add archon_task_started and archon_task_reviewed actions"
```

---

## Task 2: Create `src/system/archon-lifecycle.ts`

**Files:**
- Create: `src/system/archon-lifecycle.ts`

- [ ] **Step 1: Verify Archon task ID format**

Before writing the regex, confirm what Archon task IDs look like in your running instance:

```bash
# In a separate terminal with the dashboard running, or via curl:
# Check the MCP registry to find the Archon server name
npx tsx -e "
  import { listMcpServers } from './src/db';
  console.log(listMcpServers().map(s => ({ name: s.name, url: s.url, status: s.status })));
"
```

Note the exact server name (e.g. `"archon"`, `"Archon"`, `"archon-mcp"`) — you will use it as the first argument to `callRegisteredTool` in the next step. Archon uses Supabase UUIDs (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). If your instance uses a different format, update `ARCHON_TASK_ID_RE` below.

- [ ] **Step 2: Write the file**

Create `src/system/archon-lifecycle.ts`:

```typescript
import { callRegisteredTool } from '../mcp/mcp-registry';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';

// Archon (coleam00/Archon + Supabase) uses UUID primary keys.
// Update this pattern if your Archon instance uses a different ID format
// (verify with: listMcpServers() + a sample find_tasks call).
const ARCHON_TASK_ID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

// The registered MCP server name for Archon in NeuroClaw's MCP registry.
// Must match exactly what appears in the dashboard's MCP Servers tab.
const ARCHON_SERVER_NAME = 'archon';

export function extractArchonTaskIds(text: string): string[] {
  return [...new Set([...(text.matchAll(ARCHON_TASK_ID_RE))].map(m => m[1].toLowerCase()))];
}

/**
 * Call at the start of chatStream() — before the provider dispatch.
 * Marks any Archon task IDs found in the message as "doing".
 * Returns the list of task IDs found, to be passed to onTaskComplete().
 * Never throws.
 */
export async function onTaskStart(
  message:   string,
  agentId:   string,
  sessionId: string,
): Promise<string[]> {
  const taskIds = extractArchonTaskIds(message);
  if (taskIds.length === 0) return [];

  for (const taskId of taskIds) {
    try {
      await callRegisteredTool(ARCHON_SERVER_NAME, 'manage_task', {
        action:  'update',
        task_id: taskId,
        status:  'doing',
      });
      logHive(
        'archon_task_started',
        `Archon task ${taskId} marked doing`,
        agentId || undefined,
        { taskId },
        undefined,
        sessionId,
      );
    } catch (err) {
      logger.warn('archon-lifecycle: onTaskStart failed', {
        taskId,
        err: (err as Error).message,
      });
    }
  }
  return taskIds;
}

/**
 * Call after chatStream() completes — in the finally block.
 * Marks Archon tasks as "review" so a human or Alfred can verify the output.
 * Never throws.
 */
export async function onTaskComplete(
  taskIds:   string[],
  agentId:   string,
  sessionId: string,
): Promise<void> {
  for (const taskId of taskIds) {
    try {
      await callRegisteredTool(ARCHON_SERVER_NAME, 'manage_task', {
        action:  'update',
        task_id: taskId,
        status:  'review',
      });
      logHive(
        'archon_task_reviewed',
        `Archon task ${taskId} marked review`,
        agentId || undefined,
        { taskId },
        undefined,
        sessionId,
      );
    } catch (err) {
      logger.warn('archon-lifecycle: onTaskComplete failed', {
        taskId,
        err: (err as Error).message,
      });
    }
  }
}
```

- [ ] **Step 3: Type-check the new file**

```bash
npx tsc --noEmit 2>&1 | grep archon-lifecycle
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/system/archon-lifecycle.ts
git commit -m "feat(archon): add lifecycle middleware for automatic task status updates"
```

---

## Task 3: Add `buildArchonSection()` to `alfred.ts`

**Files:**
- Modify: `src/agent/alfred.ts` (prompt builders section, ~line 84–218)

- [ ] **Step 1: Add the import for archon-lifecycle**

At the top of `src/agent/alfred.ts`, after the existing imports (after line ~48 `import { isAbortError } from '../system/stream-control';`), add:

```typescript
import { onTaskStart, onTaskComplete } from '../system/archon-lifecycle';
```

- [ ] **Step 2: Add `buildArchonSection()` function**

In `src/agent/alfred.ts`, after the closing `}` of `buildTeamSection()` (after line ~218) and before the `// ── History ──` comment, add:

```typescript
function buildArchonSection(agentName: string, isOrchestrator: boolean): string {
  const ragBlock =
    '\n\n---\n## Archon Knowledge Base — Research Before Implementation\n\n' +
    'Before writing any code or detailed implementation:\n' +
    '1. Call `mcp__archon__rag_search_knowledge_base` with a 2-5 keyword query relevant to the task\n' +
    '2. Call `mcp__archon__rag_search_code_examples` if you need patterns or working examples\n' +
    '3. Briefly note what you found — or confirm nothing was found — before proceeding\n\n' +
    'Skip only for conversational replies or simple factual questions with no implementation component.\n';

  const taskBlock =
    '\n## Archon Task Awareness\n\n' +
    `At the start of work, check tasks assigned to you: \`mcp__archon__find_tasks(filter_by="assignee", filter_value="${agentName}")\`\n` +
    '- When you begin a task: `mcp__archon__manage_task("update", task_id="<id>", status="doing")`\n' +
    '- When your work is ready for review: `mcp__archon__manage_task("update", task_id="<id>", status="review")`\n' +
    '- When a task is fully verified complete: `mcp__archon__manage_task("update", task_id="<id>", status="done")`\n';

  const orchestratorBlock = isOrchestrator
    ? '\n## Archon Task Orchestration\n\n' +
      'When decomposing a complex request, create Archon tasks for each specialist:\n' +
      '`mcp__archon__manage_task("create", title="...", assignee="<AgentName>", project_id="...")`\n\n' +
      'After specialists complete their work, verify the review queue before closing:\n' +
      '`mcp__archon__find_tasks(filter_by="status", filter_value="review")`\n'
    : '';

  return ragBlock + taskBlock + orchestratorBlock;
}
```

- [ ] **Step 3: Append Archon section to `buildOrchestratorPrompt()`**

Find the `return (` block inside `buildOrchestratorPrompt()` (around line 124–138). It currently ends with:

```typescript
    buildBrowserlessSection() +
    buildTaskSection('Alfred') +
    buildMemorySection()
  );
```

Change it to:

```typescript
    buildBrowserlessSection() +
    buildTaskSection('Alfred') +
    buildMemorySection() +
    buildArchonSection('Alfred', true)
  );
```

- [ ] **Step 4: Append Archon section to `buildTeamSection()`**

Find the `return` statement at the end of `buildTeamSection()` (around line 217). It currently reads:

```typescript
  return teamSection + buildBrowserlessSection() + buildTaskSection(currentAgent?.name ?? 'this agent') + buildMemorySection();
```

Change it to:

```typescript
  return teamSection + buildBrowserlessSection() + buildTaskSection(currentAgent?.name ?? 'this agent') + buildMemorySection() + buildArchonSection(currentAgent?.name ?? 'this agent', false);
```

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit 2>&1 | grep alfred
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/agent/alfred.ts
git commit -m "feat(alfred): inject Archon RAG and task awareness into all agent system prompts"
```

---

## Task 4: Hook lifecycle into `chatStream()` dispatcher

**Files:**
- Modify: `src/agent/alfred.ts` (the `chatStream()` dispatcher, ~line 2094–2148)

- [ ] **Step 1: Wrap the dispatcher in try/finally with lifecycle calls**

Find the `chatStream()` function body (around line 2094). It currently reads:

```typescript
export async function chatStream(
  userMessage: string,
  sessionId: string,
  onChunk: (chunk: string) => void | Promise<void>,
  systemPrompt: string,
  agentId?: string,
  onMeta?: (e: MetaEvent) => void | Promise<void>,
  attachments?: ChatImageAttachment[],
  extraSystemContext?: string,
  runId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const agentRecord = agentId ? getAgentById(agentId) : undefined;
  if (agentRecord) prewarmAgentAsync(agentRecord);
  if (agentRecord?.provider === 'anthropic') {
```

Replace the body (everything after `prewarmAgentAsync(agentRecord);`) with:

```typescript
  const archonTaskIds = await onTaskStart(userMessage, agentId ?? '', sessionId);
  try {
    if (agentRecord?.provider === 'anthropic') {
      if (attachments && attachments.length > 0) {
        logger.warn('chatStream: native attachments dropped on anthropic path; agent\'s vision_mode should resolve to preprocess', { agentId, count: attachments.length });
      }
      return await chatStreamAnthropic(userMessage, sessionId, onChunk, systemPrompt, agentId, onMeta, extraSystemContext, runId, signal);
    }
    if (agentRecord?.provider === 'codex') {
      if (attachments && attachments.length > 0) {
        logger.warn('chatStream: native attachments dropped on codex path; agent\'s vision_mode should resolve to preprocess', { agentId, count: attachments.length });
      }
      return await chatStreamCodexCli(userMessage, sessionId, onChunk, systemPrompt, agentId, onMeta, extraSystemContext, runId, signal);
    }
    if (agentRecord?.provider === 'gemini') {
      if (attachments && attachments.length > 0) {
        logger.warn('chatStream: native attachments dropped on gemini path; agent\'s vision_mode should resolve to preprocess', { agentId, count: attachments.length });
      }
      return await chatStreamGeminiCli(userMessage, sessionId, onChunk, systemPrompt, agentId, onMeta, extraSystemContext, runId, signal);
    }
    if (agentRecord?.provider === 'openrouter') {
      return await chatStreamOpenRouter(userMessage, sessionId, onChunk, systemPrompt, agentId, onMeta, attachments, extraSystemContext, runId, signal);
    }
    if (agentRecord?.provider === 'ollama') {
      return await chatStreamOllama(userMessage, sessionId, onChunk, systemPrompt, agentId, onMeta, attachments, extraSystemContext, runId, signal);
    }
    if (agentRecord?.provider === 'mcp') {
      if (attachments && attachments.length > 0) {
        logger.warn('chatStream: native attachments dropped on mcp path', { agentId, count: attachments.length });
      }
      return await chatStreamMcp(userMessage, sessionId, onChunk, agentRecord, onMeta, runId, signal);
    }
    return await chatStreamOpenAI(userMessage, sessionId, onChunk, systemPrompt, agentId, onMeta, attachments, extraSystemContext, runId, signal);
  } finally {
    if (archonTaskIds.length > 0) {
      await onTaskComplete(archonTaskIds, agentId ?? '', sessionId);
    }
  }
}
```

Note: The provider-specific calls now use `return await` (not bare `return`) so the `finally` block fires after the stream completes, not before.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Smoke test — start the dashboard and send a message containing an Archon task ID**

```bash
npm run dashboard
```

In another terminal, send a chat message that includes an Archon task UUID (copy one from your Archon dashboard). Check the hive mind log for `archon_task_started` and `archon_task_reviewed` entries:

```bash
npx tsx -e "
  import { getDb } from './src/db';
  const db = getDb();
  const rows = db.prepare(\"SELECT action, summary, created_at FROM hive_mind WHERE action LIKE 'archon%' ORDER BY created_at DESC LIMIT 5\").all();
  console.log(rows);
"
```

Expected: rows with `archon_task_started` and `archon_task_reviewed` actions.

- [ ] **Step 4: Commit**

```bash
git add src/agent/alfred.ts
git commit -m "feat(alfred): hook Archon task lifecycle into chatStream dispatcher"
```

---

## Task 5: Final type-check and verification

- [ ] **Step 1: Full type check**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 2: Verify prompt injection is working for all agents**

```bash
npx tsx -e "
  // Quick sanity check — build a team section and confirm Archon block appears
  import { getAllAgents } from './src/db';
  // (inspect alfred.ts exports if needed, or just grep the running dashboard logs)
  console.log('Check dashboard logs for Archon section in agent system prompts');
"
```

Start the dashboard (`npm run dashboard`) and send a message. In the dashboard's agent detail view or via hive mind logs, confirm the agent's system prompt includes the `## Archon Knowledge Base` and `## Archon Task Awareness` sections.

- [ ] **Step 3: Verify a RAG call happens before a code response**

Ask any agent to implement something: `"Write a function to parse JWT tokens"`. Confirm in the conversation that the agent calls `mcp__archon__rag_search_knowledge_base` or `mcp__archon__rag_search_code_examples` before producing code.

- [ ] **Step 4: Final commit if any fixups were needed**

```bash
git add -p
git commit -m "fix(archon): address type-check and smoke test findings"
```
