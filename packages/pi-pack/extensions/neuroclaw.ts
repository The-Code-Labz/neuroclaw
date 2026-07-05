/**
 * @neuroclaw/pi-pack — Pi extension for NeuroClaw
 *
 * Exposes the NeuroClaw agent registry, delegation, memory, and status
 * as pi tools and commands. Connects to neuroclaw-mcp-server over stdio.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// ── MCP Client (stdio JSON-RPC over neuroclaw-mcp-server) ─────────────────────

interface McpRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class NeuroclawMcpClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private ready = false;
  private serverPath: string;

  constructor(serverPath: string) {
    this.serverPath = serverPath;
  }

  async connect(): Promise<void> {
    if (this.process) return;

    // Spawn the neuroclaw MCP stdio server
    this.process = spawn('node', [this.serverPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env },
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.process.on('error', (err) => {
      console.error('[neuroclaw-mcp] Process error:', err.message);
      this.cleanup();
    });

    this.process.on('close', (code) => {
      if (code !== 0) console.error(`[neuroclaw-mcp] Process exited with code ${code}`);
      this.cleanup();
    });

    // Wait for server ready
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    this.ready = true;
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as McpResponse;
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // Skip non-JSON lines (server logs, etc.)
      }
    }
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.process || !this.ready) {
      await this.connect();
    }

    const id = ++this.requestId;
    const request: McpRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.process?.stdin?.write(JSON.stringify(request) + '\n');

      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP call timed out: ${method}`));
        }
      }, 30000);
    });
  }

  private cleanup(): void {
    this.ready = false;
    this.process = null;
    for (const [, pending] of this.pending) {
      pending.reject(new Error('MCP connection closed'));
    }
    this.pending.clear();
  }

  disconnect(): void {
    this.process?.kill();
    this.cleanup();
  }
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default async function neuroclaw(pi: ExtensionAPI): Promise<void> {
  // Resolve path to the neuroclaw MCP server
  // Environment variable takes precedence, then try common paths
  const envPath = process.env.NEUROCLAW_MCP_PATH;

  // Try multiple possible paths for the MCP server
  const possiblePaths = [
    envPath,
    resolve(process.cwd(), 'dist/mcp/stdio-server.js'),       // From cwd (most common)
    resolve(process.cwd(), 'node_modules/@neuroclaw/neuroclaw-v1/dist/mcp/stdio-server.js'),
  ].filter(Boolean) as string[];

  let serverPath = possiblePaths[0];
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      serverPath = p;
      break;
    }
  }

  if (!serverPath || !existsSync(serverPath)) {
    console.warn('[neuroclaw] MCP server not found. Set NEUROCLAW_MCP_PATH or run from neuroclaw-v1 directory.');
  }

  const client = new NeuroclawMcpClient(serverPath);

  // ── Tools ─────────────────────────────────────────────────────────────────

  // ask_alfred — main entry point for external clients
  pi.registerTool({
    name: 'ask_alfred',
    label: 'Ask Alfred',
    description: 'Send a message to the NeuroClaw agent team. Alfred (the orchestrator) receives the message, routes to the right specialist if needed, and returns the full response.',
    parameters: Type.Object({
      message: Type.String({ description: 'The message or question to send' }),
      agent_name: Type.Optional(Type.String({ description: 'Route directly to a named agent instead of Alfred' })),
      session_id: Type.Optional(Type.String({ description: 'Continue an existing conversation session' })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
      onUpdate?.({ content: [{ type: 'text', text: 'Sending to NeuroClaw agents...' }] });
      try {
        const result = await client.call<{ response: string; session_id: string; agent: string }>(
          'tools/call',
          { name: 'ask_alfred', arguments: params },
        );
        return {
          content: [{ type: 'text', text: result.response }],
          details: { session_id: result.session_id, agent: result.agent },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // list_agents — discover available agents
  pi.registerTool({
    name: 'list_neuroclaw_agents',
    label: 'List NeuroClaw Agents',
    description: 'List all agents in the NeuroClaw registry. Use to discover who you can delegate to.',
    parameters: Type.Object({
      include_inactive: Type.Optional(Type.Boolean({ description: 'Include inactive agents' })),
      include_temp: Type.Optional(Type.Boolean({ description: 'Include temporary spawned agents' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await client.call<Array<{
          id: string; name: string; role: string; description: string;
          model: string; status: string; temporary: boolean;
        }>>(
          'tools/call',
          { name: 'list_agents', arguments: params },
        );
        const summary = result.map(a => `- ${a.name} (${a.role}): ${a.description || 'No description'}`).join('\n');
        return {
          content: [{ type: 'text', text: `NeuroClaw Agents:\n${summary}` }],
          details: { agents: result },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // search_memory — recall from persistent memory
  pi.registerTool({
    name: 'search_neuroclaw_memory',
    label: 'Search NeuroClaw Memory',
    description: 'Search across NeuroClaw memory (NeuroVault + memory_index). Returns categorized hits ranked by salience, importance, recency.',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      limit: Type.Optional(Type.Number({ description: 'Max results (default 10)' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await client.call<{
          total: number;
          results: Array<{ source: string; content: string; score: number }>;
        }>(
          'tools/call',
          { name: 'search_memory', arguments: params },
        );
        const summary = result.results.map(r =>
          `[${r.source}] (score: ${r.score.toFixed(2)}) ${r.content.slice(0, 100)}...`
        ).join('\n');
        return {
          content: [{ type: 'text', text: `Found ${result.total} memories:\n${summary}` }],
          details: result,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // find_tasks — query the task manager
  pi.registerTool({
    name: 'find_neuroclaw_tasks',
    label: 'Find NeuroClaw Tasks',
    description: 'List or search tasks in NeuroClaw. Filter by status, project, assignee.',
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: 'Get a specific task by ID' })),
      filter_by: Type.Optional(Type.String({ description: 'Filter field: status, project, assignee, parent' })),
      filter_value: Type.Optional(Type.String({ description: 'Value to filter by' })),
      query: Type.Optional(Type.String({ description: 'Text search in title/description' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await client.call<{
          total: number;
          tasks: Array<{ id: string; title: string; status: string; assignee: string }>;
        }>(
          'tools/call',
          { name: 'find_tasks', arguments: params },
        );
        const summary = result.tasks.map(t =>
          `- [${t.status}] ${t.title} (assigned: ${t.assignee || 'unassigned'})`
        ).join('\n');
        return {
          content: [{ type: 'text', text: `Found ${result.total} tasks:\n${summary}` }],
          details: result,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // delegate_task — assign a task to a NeuroClaw agent
  pi.registerTool({
    name: 'delegate_to_neuroclaw',
    label: 'Delegate to NeuroClaw',
    description: 'Create a task and assign it to a NeuroClaw agent. Optionally execute immediately.',
    parameters: Type.Object({
      to: Type.String({ description: 'Agent name to assign the task to' }),
      title: Type.String({ description: 'Task title' }),
      description: Type.Optional(Type.String({ description: 'Task description' })),
      execute_now: Type.Optional(Type.Boolean({ description: 'Run immediately and return result' })),
      priority: Type.Optional(Type.String({ description: 'Priority: low, medium, high, critical' })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
      onUpdate?.({ content: [{ type: 'text', text: `Delegating to ${params.to}...` }] });
      try {
        const result = await client.call<{
          ok: boolean;
          task_id: string;
          assigned_to: string;
          status: string;
          result?: string;
          error?: string;
        }>(
          'tools/call',
          { name: 'assign_task_to_agent', arguments: params },
        );
        if (!result.ok) {
          return {
            content: [{ type: 'text', text: `Delegation failed: ${result.error}` }],
            details: result,
          };
        }
        const msg = result.result
          ? `Task completed by ${result.assigned_to}:\n${result.result}`
          : `Task ${result.task_id} assigned to ${result.assigned_to} (status: ${result.status})`;
        return {
          content: [{ type: 'text', text: msg }],
          details: result,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          details: { error: true },
        };
      }
    },
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  pi.registerCommand('agents', {
    description: 'List NeuroClaw agents',
    handler: async (_args, ctx) => {
      try {
        const result = await client.call<Array<{
          name: string; role: string; status: string; description: string;
        }>>(
          'tools/call',
          { name: 'list_agents', arguments: {} },
        );
        const active = result.filter(a => a.status === 'active');
        const msg = active.map(a => `${a.name} (${a.role})`).join(', ');
        ctx.ui.notify(`Active agents: ${msg}`, 'info');
      } catch (err) {
        ctx.ui.notify(`Failed to list agents: ${(err as Error).message}`, 'error');
      }
    },
  });

  pi.registerCommand('delegate', {
    description: 'Delegate a task to a NeuroClaw agent: /delegate <agent> <task>',
    handler: async (args, ctx) => {
      const parts = args.split(/\s+/);
      const agentName = parts[0];
      const task = parts.slice(1).join(' ');

      if (!agentName || !task) {
        ctx.ui.notify('Usage: /delegate <agent> <task>', 'warn');
        return;
      }

      ctx.ui.notify(`Delegating to ${agentName}...`, 'info');

      try {
        const result = await client.call<{
          ok: boolean; task_id: string; status: string; result?: string;
        }>(
          'tools/call',
          {
            name: 'assign_task_to_agent',
            arguments: { to: agentName, title: task, execute_now: true },
          },
        );

        if (result.ok && result.result) {
          ctx.ui.notify(`${agentName}: ${result.result.slice(0, 100)}...`, 'success');
        } else {
          ctx.ui.notify(`Task queued: ${result.task_id}`, 'info');
        }
      } catch (err) {
        ctx.ui.notify(`Delegation failed: ${(err as Error).message}`, 'error');
      }
    },
  });

  pi.registerCommand('memory', {
    description: 'Search NeuroClaw memory: /memory <query>',
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify('Usage: /memory <query>', 'warn');
        return;
      }

      try {
        const result = await client.call<{
          total: number;
          results: Array<{ source: string; content: string }>;
        }>(
          'tools/call',
          { name: 'search_memory', arguments: { query: args, limit: 5 } },
        );

        if (result.total === 0) {
          ctx.ui.notify('No memories found', 'info');
        } else {
          ctx.ui.notify(`Found ${result.total} memories. Top result: ${result.results[0]?.content.slice(0, 80)}...`, 'info');
        }
      } catch (err) {
        ctx.ui.notify(`Memory search failed: ${(err as Error).message}`, 'error');
      }
    },
  });

  pi.registerCommand('ncstatus', {
    description: 'Show NeuroClaw system status',
    handler: async (_args, ctx) => {
      try {
        // Get agent count
        const agents = await client.call<Array<{ status: string }>>(
          'tools/call',
          { name: 'list_agents', arguments: { include_temp: true } },
        );
        const active = agents.filter(a => a.status === 'active').length;

        // Get task count
        const tasks = await client.call<{ total: number }>(
          'tools/call',
          { name: 'find_tasks', arguments: { filter_by: 'status', filter_value: 'doing' } },
        );

        ctx.ui.notify(`NeuroClaw: ${active} agents active, ${tasks.total} tasks in progress`, 'info');
      } catch (err) {
        ctx.ui.notify(`Status check failed: ${(err as Error).message}`, 'error');
      }
    },
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    try {
      await client.connect();
      ctx.ui.setStatus('neuroclaw', 'NC connected');
    } catch (err) {
      ctx.ui.setStatus('neuroclaw', 'NC offline');
    }
  });

  pi.on('session_shutdown', async () => {
    client.disconnect();
  });
}
