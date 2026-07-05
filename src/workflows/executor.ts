import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

import { getClient } from '../agent/openai-client';
import { config } from '../config';
import {
  createWorkflowRun, getWorkflowRun, updateWorkflowRun,
  addWorkflowEvent, type WorkflowRunRow,
} from '../db';
import { logger } from '../utils/logger';

import type {
  WorkflowDefinition, WorkflowNode,
  PromptNode, BashNode, ScriptNode, LoopNode, ApprovalNode, CommandNode,
} from './schema';
import {
  interpolate, evaluateWhen, type NodeContextMap, type NodeOutput, type InterpolateBuiltins,
} from './context';
import { topoSort } from './topo';

const log = logger;

// ── Approval pause sentinel ────────────────────────────────────────────────

export class ApprovalPausedError extends Error {
  constructor(public readonly approvalMessage: string) {
    super('workflow paused: awaiting approval');
  }
}

// ── Execution options ──────────────────────────────────────────────────────

export interface ExecuteOptions {
  resumeRunId?: string;
  onEvent?: (type: string, nodeId: string | null, data?: Record<string, unknown>) => void;
  cwd?: string;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function executeWorkflow(
  workflow: WorkflowDefinition,
  input: string,
  opts: ExecuteOptions = {},
): Promise<WorkflowRunRow> {
  const context: NodeContextMap = new Map();

  // Load or create run
  let run: WorkflowRunRow;
  if (opts.resumeRunId) {
    const existing = getWorkflowRun(opts.resumeRunId);
    if (!existing) throw new Error(`Workflow run ${opts.resumeRunId} not found`);
    run = existing;
    // Seed context from persisted outputs
    const savedOutputs = JSON.parse(run.outputs) as Record<string, NodeOutput>;
    for (const [nodeId, nodeOut] of Object.entries(savedOutputs)) {
      context.set(nodeId, nodeOut);
    }
  } else {
    run = createWorkflowRun(workflow.name, input);
  }

  const workflowId = run.id;
  const artifactsDir = path.join(os.homedir(), '.nclaw', 'artifacts', workflowId);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const builtins: InterpolateBuiltins = {
    WORKFLOW_ID: workflowId,
    ARTIFACTS_DIR: artifactsDir,
  };

  updateWorkflowRun(run.id, { status: 'running', started_at: Date.now() });
  addWorkflowEvent(run.id, null, 'run_started', { workflow: workflow.name });
  opts.onEvent?.('run_started', null, { workflow: workflow.name });

  const ordered = topoSort(workflow.nodes);
  const completedNodes: string[] = JSON.parse(run.completed_nodes) as string[];
  const outputs: Record<string, NodeOutput> = JSON.parse(run.outputs) as Record<string, NodeOutput>;

  for (const node of ordered) {
    if (completedNodes.includes(node.id)) continue; // skip on resume

    // Evaluate when condition
    if (node.when && !evaluateWhen(node.when, context)) {
      log.debug('workflow.node.skipped', { runId: run.id, nodeId: node.id });
      addWorkflowEvent(run.id, node.id, 'node_skipped', {});
      continue;
    }

    addWorkflowEvent(run.id, node.id, 'node_started', {});
    opts.onEvent?.('node_started', node.id);
    log.debug('workflow.node.started', { runId: run.id, nodeId: node.id, type: node.type });

    try {
      let nodeOut: NodeOutput;
      const execCtx = { context, builtins, workflow, run, cwd: opts.cwd };

      switch (node.type) {
        case 'prompt':   nodeOut = await runPromptNode(node, execCtx);   break;
        case 'bash':     nodeOut = await runBashNode(node, execCtx);     break;
        case 'script':   nodeOut = await runScriptNode(node, execCtx);   break;
        case 'loop':     nodeOut = await runLoopNode(node, execCtx);     break;
        case 'approval': nodeOut = await runApprovalNode(node, execCtx); break;
        case 'command':  nodeOut = await runCommandNode(node, execCtx);  break;
        default:
          throw new Error(`Unknown node type: ${(node as WorkflowNode).type}`);
      }

      context.set(node.id, nodeOut);
      completedNodes.push(node.id);
      outputs[node.id] = nodeOut;

      updateWorkflowRun(run.id, {
        completed_nodes: JSON.stringify(completedNodes),
        outputs: JSON.stringify(outputs),
      });
      addWorkflowEvent(run.id, node.id, 'node_completed', { output: nodeOut.output.slice(0, 500) });
      opts.onEvent?.('node_completed', node.id, { output: nodeOut.output });

    } catch (err) {
      if (err instanceof ApprovalPausedError) {
        updateWorkflowRun(run.id, {
          status: 'paused',
          paused_at_node: node.id,
          completed_nodes: JSON.stringify(completedNodes),
          outputs: JSON.stringify(outputs),
        });
        addWorkflowEvent(run.id, node.id, 'approval_requested', { message: err.approvalMessage });
        opts.onEvent?.('approval_requested', node.id, { message: err.approvalMessage });
        return getWorkflowRun(run.id)!;
      }

      const error = err instanceof Error ? err.message : String(err);
      updateWorkflowRun(run.id, { status: 'failed', ended_at: Date.now(), error });
      addWorkflowEvent(run.id, node.id, 'node_failed', { error });
      opts.onEvent?.('node_failed', node.id, { error });
      throw err;
    }
  }

  updateWorkflowRun(run.id, { status: 'succeeded', ended_at: Date.now() });
  addWorkflowEvent(run.id, null, 'run_completed', {});
  opts.onEvent?.('run_completed', null);
  return getWorkflowRun(run.id)!;
}

// ── Node runner context ────────────────────────────────────────────────────

interface ExecCtx {
  context: NodeContextMap;
  builtins: InterpolateBuiltins;
  workflow: WorkflowDefinition;
  run: WorkflowRunRow;
  cwd?: string;
}

// ── Prompt node ────────────────────────────────────────────────────────────

async function runPromptNode(node: PromptNode, ctx: ExecCtx): Promise<NodeOutput> {
  const prompt = interpolate(node.prompt, ctx.context, ctx.builtins);
  const systemPrompt = node.system_prompt
    ? interpolate(node.system_prompt, ctx.context, ctx.builtins)
    : undefined;

  const model = node.model ?? ctx.workflow.model ?? config.voidai.model;
  const client = getClient();

  const messages: { role: 'system' | 'user'; content: string }[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const response = await client.chat.completions.create({
    model,
    messages,
  });

  const text = response.choices[0]?.message?.content ?? '';

  if (node.output_format === 'json') {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      const result = JSON.parse(jsonMatch?.[0] ?? text) as unknown;
      return { output: text, result };
    } catch {
      return { output: text };
    }
  }

  return { output: text };
}

// ── Bash node ──────────────────────────────────────────────────────────────

async function runBashNode(node: BashNode, ctx: ExecCtx): Promise<NodeOutput> {
  const command = interpolate(node.bash, ctx.context, ctx.builtins);
  const cwd = node.cwd ?? ctx.cwd ?? process.cwd();
  const timeoutMs = node.timeout_ms ?? 120_000;

  try {
    const stdout = execSync(command, {
      encoding: 'utf8',
      cwd,
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { output: stdout };
  } catch (err: unknown) {
    // execSync throws on non-zero exit — capture stdout+stderr from the error
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr].filter(Boolean).join('\n') || e.message || String(err);
    return { output };
  }
}

// ── Script node ────────────────────────────────────────────────────────────

async function runScriptNode(node: ScriptNode, _ctx: ExecCtx): Promise<NodeOutput> {
  // MVP: script nodes are not yet supported
  throw new Error(
    `Script node '${node.id}' is not yet supported. ` +
    'Use a bash node with the equivalent shell command instead.'
  );
}

// ── Loop node ─────────────────────────────────────────────────────────────

async function runLoopNode(node: LoopNode, ctx: ExecCtx): Promise<NodeOutput> {
  const { prompt: promptTemplate, until, max_iterations: maxIter, fresh_context: freshCtx } = node.loop;
  const model = node.model ?? ctx.workflow.model ?? config.voidai.model;
  const client = getClient();
  let prevOutput = '';
  let lastOutput = '';

  for (let i = 0; i < maxIter; i++) {
    const loopBuiltins: InterpolateBuiltins = {
      ...ctx.builtins,
      LOOP_PREV_OUTPUT: prevOutput,
    };
    const prompt = interpolate(promptTemplate, ctx.context, loopBuiltins);

    const messages: { role: 'user'; content: string }[] = [{ role: 'user', content: prompt }];
    const response = await client.chat.completions.create({ model, messages });
    const text = response.choices[0]?.message?.content ?? '';
    lastOutput = text;

    if (text.includes(until)) {
      return { output: text };
    }

    prevOutput = text;
  }

  return { output: lastOutput };
}

// ── Approval node ─────────────────────────────────────────────────────────

async function runApprovalNode(node: ApprovalNode, ctx: ExecCtx): Promise<NodeOutput> {
  const message = interpolate(node.approval.message, ctx.context, ctx.builtins);
  throw new ApprovalPausedError(message);
}

// ── Command node ──────────────────────────────────────────────────────────

async function runCommandNode(node: CommandNode, ctx: ExecCtx): Promise<NodeOutput> {
  const commandPaths = [
    path.join(os.homedir(), '.nclaw', 'commands', `${node.command}.md`),
    path.join(os.homedir(), '.nclaw', 'commands', node.command),
  ];

  let commandContent = '';
  for (const p of commandPaths) {
    if (fs.existsSync(p)) { commandContent = fs.readFileSync(p, 'utf-8'); break; }
  }
  if (!commandContent) {
    throw new Error(`Command '${node.command}' not found in ~/.nclaw/commands/`);
  }

  // Substitute positional args ($1, $2) and $ARGUMENTS
  const args = node.args ?? [];
  let prompt = commandContent;
  args.forEach((arg, i) => { prompt = prompt.split(`$${i + 1}`).join(arg); });
  prompt = prompt.split('$ARGUMENTS').join(args.join(' '));

  // Interpolate node references
  prompt = interpolate(prompt, ctx.context, ctx.builtins);

  const model = node.model ?? ctx.workflow.model ?? config.voidai.model;
  const client = getClient();
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
  });

  return { output: response.choices[0]?.message?.content ?? '' };
}
