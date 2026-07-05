/**
 * Zod schemas for NeuroClaw YAML workflows
 *
 * Workflow = declarative DAG of typed nodes:
 *   - prompt: AI step
 *   - bash: shell command (stdout captured)
 *   - script: inline TS/Python or named script
 *   - loop: iterate until signal
 *   - approval: human gate (pauses run)
 *
 * Inspired by Archon's workflow engine but simplified for single-user.
 */

import { z } from 'zod';

// -----------------------------------------------------------------------------
// Node base (shared by all node types)
// -----------------------------------------------------------------------------

export const nodeBaseSchema = z.object({
  /** Unique node identifier within the workflow */
  id: z.string().min(1),

  /** IDs of nodes that must complete before this one runs */
  depends_on: z.array(z.string()).optional(),

  /**
   * Condition expression evaluated at runtime.
   * If falsy, node is skipped. Supports $nodeId.output substitutions.
   * Example: "$approval-gate.approved == true"
   */
  when: z.string().optional(),

  /** Override the workflow-level provider for this node */
  provider: z.enum(['claude', 'openai', 'openrouter', 'anthropic']).optional(),

  /** Override the workflow-level model for this node */
  model: z.string().optional(),

  /** Timeout in milliseconds (default: 5 minutes for AI, 2 minutes for bash/script) */
  timeout_ms: z.number().int().positive().optional(),
});

// -----------------------------------------------------------------------------
// Prompt node — AI step
// -----------------------------------------------------------------------------

export const promptNodeSchema = nodeBaseSchema.extend({
  /**
   * The prompt to send to the AI.
   * Supports $nodeId.output substitutions.
   */
  prompt: z.string().min(1),

  /**
   * Expected output format.
   * - 'text': raw response (default)
   * - 'json': parse response as JSON; for Claude uses structured output mode
   */
  output_format: z.enum(['text', 'json']).default('text'),

  /**
   * JSON schema for output_format: 'json'.
   * If provided, passed to AI SDK for structured output enforcement.
   */
  output_schema: z.record(z.string(), z.unknown()).optional(),

  /**
   * System prompt override for this node.
   */
  system_prompt: z.string().optional(),
});

// -----------------------------------------------------------------------------
// Bash node — shell command (deterministic, no AI)
// -----------------------------------------------------------------------------

export const bashNodeSchema = nodeBaseSchema.extend({
  /**
   * Shell command to execute.
   * Stdout is captured as $nodeId.output.
   * Supports $nodeId.output substitutions in the command.
   */
  bash: z.string().min(1),

  /**
   * Working directory for the command.
   * Defaults to the workflow's cwd (typically the worktree root).
   */
  cwd: z.string().optional(),
});

// -----------------------------------------------------------------------------
// Script node — inline code or named script (deterministic, no AI)
// -----------------------------------------------------------------------------

export const scriptNodeSchema = nodeBaseSchema.extend({
  /**
   * Inline script code OR name of a script in .nclaw/scripts/
   */
  script: z.string().min(1),

  /** Runtime: 'bun' for TS/JS, 'python' for Python */
  runtime: z.enum(['bun', 'python']).default('bun'),

  /** Dependencies to install before running (npm packages or pip packages) */
  deps: z.array(z.string()).optional(),
});

// -----------------------------------------------------------------------------
// Loop node — iterate until a signal is emitted
// -----------------------------------------------------------------------------

export const loopNodeSchema = nodeBaseSchema.extend({
  loop: z.object({
    /**
     * Prompt executed each iteration.
     * Should instruct the AI to emit completion signal when done.
     */
    prompt: z.string().min(1),

    /**
     * Signal that terminates the loop.
     * AI emits this via a tool call or structured output.
     * Examples: 'ALL_TASKS_COMPLETE', 'APPROVED', 'TESTS_PASSING'
     */
    until: z.string().min(1),

    /**
     * If true, each iteration starts with a fresh context (no prior messages).
     * Use $LOOP_PREV_OUTPUT to reference previous iteration's output.
     * Prevents context bloat on long loops.
     */
    fresh_context: z.boolean().default(false),

    /** Maximum iterations before forced termination */
    max_iterations: z.number().int().positive().default(10),

    /**
     * If true, loop pauses after each iteration for human review.
     * Continues on /workflow approve, aborts on /workflow reject.
     */
    interactive: z.boolean().default(false),
  }),
});

// -----------------------------------------------------------------------------
// Approval node — human gate (pauses workflow)
// -----------------------------------------------------------------------------

export const approvalNodeSchema = nodeBaseSchema.extend({
  approval: z.object({
    /**
     * Message shown to the human when requesting approval.
     * Supports $nodeId.output substitutions.
     */
    message: z.string().min(1),

    /**
     * If true, the human's response text is captured as $nodeId.output.
     * Useful for passing feedback to downstream nodes.
     */
    capture_response: z.boolean().default(false),

    /**
     * Timeout in milliseconds before auto-rejecting.
     * Default: no timeout (waits indefinitely).
     */
    timeout_ms: z.number().int().positive().optional(),
  }),
});

// -----------------------------------------------------------------------------
// Command node — reference a named command file
// -----------------------------------------------------------------------------

export const commandNodeSchema = nodeBaseSchema.extend({
  /**
   * Name of a command file (without extension) from .nclaw/commands/
   * The command's content becomes the prompt.
   */
  command: z.string().min(1),

  /** Arguments passed to the command (substituted as $1, $2, $ARGUMENTS) */
  args: z.array(z.string()).optional(),
});

// -----------------------------------------------------------------------------
// Union of all node types
// -----------------------------------------------------------------------------

export const workflowNodeSchema = z.discriminatedUnion('type', [
  promptNodeSchema.extend({ type: z.literal('prompt') }),
  bashNodeSchema.extend({ type: z.literal('bash') }),
  scriptNodeSchema.extend({ type: z.literal('script') }),
  loopNodeSchema.extend({ type: z.literal('loop') }),
  approvalNodeSchema.extend({ type: z.literal('approval') }),
  commandNodeSchema.extend({ type: z.literal('command') }),
]);

/**
 * Infer node type from the YAML structure (no explicit 'type' field needed).
 * Looks for the distinguishing key: prompt, bash, script, loop, approval, command.
 */
export const inferredNodeSchema = nodeBaseSchema.and(
  z.union([
    z.object({ prompt: z.string() }).transform((n) => ({ ...n, type: 'prompt' as const })),
    z.object({ bash: z.string() }).transform((n) => ({ ...n, type: 'bash' as const })),
    z.object({ script: z.string() }).transform((n) => ({ ...n, type: 'script' as const })),
    z.object({ loop: z.object({}) }).transform((n) => ({ ...n, type: 'loop' as const })),
    z.object({ approval: z.object({}) }).transform((n) => ({ ...n, type: 'approval' as const })),
    z.object({ command: z.string() }).transform((n) => ({ ...n, type: 'command' as const })),
  ])
);

// -----------------------------------------------------------------------------
// Workflow definition
// -----------------------------------------------------------------------------

export const workflowSchema = z.object({
  /** Workflow name (used for invocation) */
  name: z.string().min(1),

  /** Human-readable description */
  description: z.string().optional(),

  /** Default AI provider for prompt/loop nodes */
  provider: z.enum(['claude', 'openai', 'openrouter', 'anthropic']).default('claude'),

  /** Default model for prompt/loop nodes */
  model: z.string().optional(),

  /**
   * If true, workflow runs in the current checkout instead of a worktree.
   * Default: false (each run gets its own worktree).
   */
  no_worktree: z.boolean().default(false),

  /**
   * If true, workflow requires foreground execution with human interaction.
   * Approval nodes will block until human responds.
   */
  interactive: z.boolean().default(false),

  /** The DAG nodes */
  nodes: z.array(z.unknown()), // Validated separately with inference
});

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type PromptNode = z.infer<typeof promptNodeSchema> & { type: 'prompt' };
export type BashNode = z.infer<typeof bashNodeSchema> & { type: 'bash' };
export type ScriptNode = z.infer<typeof scriptNodeSchema> & { type: 'script' };
export type LoopNode = z.infer<typeof loopNodeSchema> & { type: 'loop' };
export type ApprovalNode = z.infer<typeof approvalNodeSchema> & { type: 'approval' };
export type CommandNode = z.infer<typeof commandNodeSchema> & { type: 'command' };

export type WorkflowNode =
  | PromptNode
  | BashNode
  | ScriptNode
  | LoopNode
  | ApprovalNode
  | CommandNode;

export type WorkflowDefinition = Omit<z.infer<typeof workflowSchema>, 'nodes'> & {
  nodes: WorkflowNode[];
};

// -----------------------------------------------------------------------------
// Run state types (for persistence)
// -----------------------------------------------------------------------------

export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'paused'      // waiting for approval
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface WorkflowRun {
  id: string;
  workflow_name: string;
  status: WorkflowRunStatus;
  started_at: number | null;
  ended_at: number | null;
  worktree_path: string | null;
  branch_name: string | null;
  input: string;
  error: string | null;
  /** Node outputs keyed by node ID */
  outputs: Record<string, { output: string; result?: unknown }>;
  /** IDs of completed nodes (for resume) */
  completed_nodes: string[];
  /** ID of node currently waiting for approval */
  paused_at_node: string | null;
}

export type WorkflowEventType =
  | 'run_started'
  | 'node_started'
  | 'node_completed'
  | 'node_failed'
  | 'node_skipped'
  | 'approval_requested'
  | 'approval_received'
  | 'run_completed'
  | 'run_failed';

export interface WorkflowEvent {
  id: number;
  run_id: string;
  node_id: string | null;
  type: WorkflowEventType;
  data: Record<string, unknown> | null;
  timestamp: number;
}
