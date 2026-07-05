import {
  registerBuiltin, type SlashContext,
} from '../system/slash-registry';
import {
  getWorkflowRun, updateWorkflowRun, listWorkflowRuns, addWorkflowEvent,
} from '../db';
import type { NodeOutput } from './context';
import { findWorkflow, discoverWorkflows } from './discovery';
import { executeWorkflow } from './executor';

registerBuiltin('workflow', {
  description: 'Run and manage YAML workflows. Usage: /workflow <run|list|runs|approve|reject|resume> [args]',
  options: [
    {
      name: 'command',
      description: "e.g. 'run <name> [input]', 'list', 'runs [limit]', 'approve <run-id>', 'resume <run-id>'",
      type: 'string',
      required: true,
    },
  ],
  handler: async (ctx, args) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] ?? '';
    switch (sub) {
      case 'run':    return runWorkflow(ctx, parts.slice(1).join(' '));
      case 'list':   return listWorkflows(ctx);
      case 'runs':   return showRuns(ctx, parseInt(parts[1] ?? '10', 10));
      case 'approve': return approveRun(ctx, parts[1], parts.slice(2).join(' '));
      case 'reject': return rejectRun(ctx, parts[1]);
      case 'resume': return resumeRun(ctx, parts[1]);
      default:
        await ctx.reply(
          '// workflow commands:\n' +
          '//   /workflow run <name> [input]    — execute a workflow\n' +
          '//   /workflow list                   — show available workflows\n' +
          '//   /workflow runs [limit]           — show recent runs\n' +
          '//   /workflow approve <run-id> [msg] — approve a paused run\n' +
          '//   /workflow reject <run-id>        — reject and cancel a paused run\n' +
          '//   /workflow resume <run-id>         — resume a failed run from last checkpoint',
        );
    }
  },
});

async function runWorkflow(ctx: SlashContext, args: string): Promise<void> {
  const parts = args.match(/^(\S+)\s*(.*)?$/s);
  if (!parts) { await ctx.reply('// usage: /workflow run <name> [input]'); return; }
  const [, name, input = ''] = parts;

  const found = findWorkflow(name);
  if (!found) {
    await ctx.reply(`// workflow '${name}' not found. Use /workflow list to see available workflows.`);
    return;
  }

  await ctx.reply(`// running workflow: ${found.workflow.name} (${found.source})`);

  try {
    const run = await executeWorkflow(found.workflow, input, {
      onEvent: async (type, nodeId, data) => {
        if (type === 'node_started') {
          await ctx.reply(`// node: ${nodeId} — started`);
        } else if (type === 'node_completed') {
          const out = (data?.output as string | undefined) ?? '';
          await ctx.reply(`// node: ${nodeId} — done\n${out.slice(0, 800)}`);
        } else if (type === 'node_failed') {
          await ctx.reply(`// node: ${nodeId} — FAILED: ${(data?.error as string | undefined) ?? ''}`);
        } else if (type === 'approval_requested') {
          const msg = (data?.message as string | undefined) ?? 'Approval requested.';
          await ctx.reply(`// ⏸  approval required — waiting for approval\n${msg}`);
        }
      },
    });

    if (run.status === 'succeeded') {
      await ctx.reply(`// workflow complete: ${run.id}`);
    } else if (run.status === 'paused') {
      await ctx.reply(
        `// workflow paused at node: ${run.paused_at_node}\n` +
        `// run-id: ${run.id}\n` +
        `// approve: /workflow approve ${run.id} [your response]\n` +
        `// reject:  /workflow reject ${run.id}`,
      );
    }
  } catch (err) {
    await ctx.reply(`// workflow failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function listWorkflows(ctx: SlashContext): Promise<void> {
  const all = discoverWorkflows();
  if (all.size === 0) { await ctx.reply('// no workflows found'); return; }
  const lines = Array.from(all.values()).map(
    r => `  ${r.workflow.name.padEnd(20)} [${r.source}]  ${r.workflow.description ?? ''}`
  );
  await ctx.reply(`// available workflows:\n${lines.join('\n')}`);
}

async function showRuns(ctx: SlashContext, limit: number): Promise<void> {
  const runs = listWorkflowRuns(Math.min(limit, 50));
  if (runs.length === 0) { await ctx.reply('// no workflow runs found'); return; }
  const lines = runs.map(r => {
    const ts = r.started_at ? new Date(r.started_at).toLocaleTimeString() : '—';
    return `  ${r.id.slice(0, 8)}  ${r.status.padEnd(10)} ${r.workflow_name.padEnd(20)} ${ts}`;
  });
  await ctx.reply(`// recent runs:\n  ID        STATUS     WORKFLOW             TIME\n${lines.join('\n')}`);
}

async function approveRun(ctx: SlashContext, runId: string, response: string): Promise<void> {
  if (!runId) { await ctx.reply('// usage: /workflow approve <run-id> [message]'); return; }

  const all = listWorkflowRuns(100);
  const exactRun = all.find(r => r.id === runId || r.id.startsWith(runId)) ?? null;

  if (!exactRun) { await ctx.reply(`// run '${runId}' not found`); return; }
  if (exactRun.status !== 'paused') {
    await ctx.reply(`// run ${exactRun.id.slice(0, 8)} is not paused (status: ${exactRun.status})`);
    return;
  }

  const nodeId = exactRun.paused_at_node!;
  const approvalOutput: NodeOutput = { output: response };

  const outputs = JSON.parse(exactRun.outputs) as Record<string, NodeOutput>;
  outputs[nodeId] = approvalOutput;
  const completedNodes = JSON.parse(exactRun.completed_nodes) as string[];
  completedNodes.push(nodeId);

  updateWorkflowRun(exactRun.id, {
    outputs: JSON.stringify(outputs),
    completed_nodes: JSON.stringify(completedNodes),
    paused_at_node: null,
    status: 'running',
  });
  addWorkflowEvent(exactRun.id, nodeId, 'approval_received', { response });

  await ctx.reply(`// approved — resuming run ${exactRun.id.slice(0, 8)}...`);

  const found = findWorkflow(exactRun.workflow_name);
  if (!found) { await ctx.reply(`// workflow '${exactRun.workflow_name}' not found — cannot resume`); return; }

  try {
    const resumed = await executeWorkflow(found.workflow, exactRun.input, {
      resumeRunId: exactRun.id,
      onEvent: async (type, nId, data) => {
        if (type === 'node_completed') {
          const out = (data?.output as string | undefined) ?? '';
          await ctx.reply(`// node: ${nId} — done\n${out.slice(0, 800)}`);
        } else if (type === 'node_failed') {
          await ctx.reply(`// node: ${nId} — FAILED: ${(data?.error as string | undefined) ?? ''}`);
        } else if (type === 'approval_requested') {
          const msg = (data?.message as string | undefined) ?? '';
          await ctx.reply(
            `// ⏸  approval required for node: ${nId}\n${msg}\n\n` +
            `// /workflow approve ${exactRun.id} [response]`,
          );
        }
      },
    });
    if (resumed.status === 'succeeded') await ctx.reply('// workflow complete');
    else if (resumed.status === 'paused') await ctx.reply(`// workflow paused again at: ${resumed.paused_at_node}`);
  } catch (err) {
    await ctx.reply(`// workflow failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function rejectRun(ctx: SlashContext, runId: string): Promise<void> {
  if (!runId) { await ctx.reply('// usage: /workflow reject <run-id>'); return; }
  const all = listWorkflowRuns(100);
  const run = all.find(r => r.id === runId || r.id.startsWith(runId));
  if (!run) { await ctx.reply(`// run '${runId}' not found`); return; }
  if (run.status !== 'paused') {
    await ctx.reply(`// run ${run.id.slice(0, 8)} is not paused`);
    return;
  }
  updateWorkflowRun(run.id, { status: 'failed', ended_at: Date.now(), error: 'rejected by user' });
  addWorkflowEvent(run.id, run.paused_at_node, 'approval_received', { response: 'rejected' });
  await ctx.reply(`// run ${run.id.slice(0, 8)} rejected and cancelled`);
}

async function resumeRun(ctx: SlashContext, runId: string): Promise<void> {
  if (!runId) { await ctx.reply('// usage: /workflow resume <run-id>'); return; }
  const all = listWorkflowRuns(100);
  const run = all.find(r => r.id === runId || r.id.startsWith(runId));
  if (!run) { await ctx.reply(`// run '${runId}' not found`); return; }
  if (run.status === 'paused') {
    await ctx.reply(`// run ${run.id.slice(0, 8)} is paused — use /workflow approve or /workflow reject`);
    return;
  }

  const found = findWorkflow(run.workflow_name);
  if (!found) { await ctx.reply(`// workflow '${run.workflow_name}' not found`); return; }

  await ctx.reply(`// resuming run ${run.id.slice(0, 8)}...`);
  updateWorkflowRun(run.id, { status: 'running' });

  try {
    const resumed = await executeWorkflow(found.workflow, run.input, {
      resumeRunId: run.id,
      onEvent: async (type, nodeId, data) => {
        if (type === 'node_completed') {
          await ctx.reply(`// node: ${nodeId} — done\n${((data?.output as string | undefined) ?? '').slice(0, 800)}`);
        } else if (type === 'node_failed') {
          await ctx.reply(`// node: ${nodeId} — FAILED: ${(data?.error as string | undefined) ?? ''}`);
        }
      },
    });
    if (resumed.status === 'succeeded') await ctx.reply('// workflow complete');
  } catch (err) {
    await ctx.reply(`// workflow failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
