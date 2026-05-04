// Single source of truth for every NeuroClaw tool. Adapters wrap these in
// each runtime's expected shape (OpenAI function-calling, Claude Agent SDK,
// Streamable-HTTP MCP for Codex).
//
// Each ToolDef:
//   - schema:  zod object — used directly by Claude SDK, JSON-Schema-derived
//              for OpenAI + MCP HTTP shapes.
//   - gate:    optional pre-flight check; returns {allowed, reason?}. Used to
//              filter tool listings (e.g. spawn_agent only at depth < 3) AND
//              short-circuit dispatch with a clear error.
//   - handler: pure async function (args, ctx) → result. No I/O assumptions
//              beyond what the imported helpers already do.
//
// New tool? Add it here. All three adapters pick it up automatically.

import { z } from 'zod';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  searchMemoryTool, searchVaultTool,
  writeVaultNoteTool, saveSessionSummaryTool, compactContextTool,
} from '../memory/memory-tools';
import { vaultGetContextPack, vaultLogHandoff, vaultCreateCheckpoint } from '../memory/vault-client';
import {
  getAllAgents, getAgentByName, getAgentById, getDb,
  createSession, saveMessage,
  createAgentMessage, updateAgentMessageResponse,
  listDiscordBots, listDiscordRoutes,
  createDiscordBot, updateDiscordBot, deleteDiscordBot,
  upsertDiscordRoute, getDiscordBot,
  setDiscordVoicePref, getDiscordVoicePref,
  parseAutoReplyGuilds,
  updateAgentRecord,
  listProjects, getProject, getDefaultProject,
  createProject, updateProject, archiveProject, deleteProjectHard,
  type AgentRecord, type DiscordBotRow, type ProjectRecord,
} from '../db';
import { listVoidAIVoices, listElevenLabsVoices } from '../audio/voices';
import {
  listSkills, getSkill, createSkill, updateSkill, deleteSkill,
  writeSkillScript, deleteSkillScript, getSkillScriptPath,
} from '../skills/skill-loader';
import { runSkillScript } from '../system/skill-runner';
import { createTask, updateTask, getTasks, archiveTask, type AppTask, type PriorityLevel, type TaskStatus } from '../system/task-manager';
import { spawnAgentAsync, countActiveTempAgents } from '../system/spawner';
import { evaluateSpawn } from '../system/decomposer';
import { logHive } from '../system/hive-mind';
import {
  createBackgroundTask, completeBackgroundTask, failBackgroundTask, taskEvents,
} from '../system/background-tasks';
import { bashRun, fsRead, fsWrite, fsList, fsSearch } from '../system/exec-tools';
import * as S from './schemas';
import type { ToolContext } from './context';
import { getMcpRegistryTools, findMcpRegistryTool } from './adapters/mcp-registry-adapter';

export interface GateResult { allowed: boolean; reason?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDef<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  name:        string;
  description: string;
  /** Used directly by Claude SDK; converted to JSON Schema for OpenAI / MCP. */
  schema:      Schema;
  /** Same shape as Zod's `.shape` for Claude SDK's tool() helper. */
  shape:       z.ZodRawShape;
  gate?:       (ctx: ToolContext) => GateResult;
  handler:     (args: z.infer<Schema>, ctx: ToolContext) => Promise<unknown>;
}

const ALLOW: GateResult = { allowed: true };

// ── Gate helpers ───────────────────────────────────────────────────────────
function gateMcp(): GateResult {
  return config.mcp.enabled ? ALLOW : { allowed: false, reason: 'MCP tools disabled (MCP_ENABLED=false)' };
}
function gateSpawn(ctx: ToolContext): GateResult {
  if (!config.spawning.enabled) return { allowed: false, reason: 'spawning is disabled (SPAWN_AGENTS_ENABLED=false)' };
  if (!ctx.agentId) return { allowed: false, reason: 'cannot spawn without a parent agent context' };
  const agent = getAgentById(ctx.agentId);
  if ((agent?.spawn_depth ?? 0) >= 3) return { allowed: false, reason: 'spawn depth limit reached' };
  return ALLOW;
}
function gateExec(ctx: ToolContext): GateResult {
  if (!ctx.agentId) return { allowed: false, reason: 'exec requires an agent context' };
  const agent = getAgentById(ctx.agentId);
  if (!agent?.exec_enabled) return { allowed: false, reason: 'exec is not enabled for this agent' };
  return ALLOW;
}

// Tools that recursively run another agent through alfred.chatStream require
// dynamic import to avoid the registry → alfred → registry circular dep.
async function runAgentTurn(
  message: string,
  recipient: AgentRecord,
  sessionLabel: string,
): Promise<{ sessionId: string; response: string }> {
  const { chatStream } = await import('../agent/alfred');
  const sessId = createSession(recipient.id, sessionLabel);
  let response = '';
  await chatStream(message, sessId, (c) => { response += c; }, recipient.system_prompt ?? '', recipient.id);
  saveMessage(sessId, 'assistant', response, recipient.id);
  return { sessionId: sessId, response };
}

// ── The registry ──────────────────────────────────────────────────────────

export const registry: ToolDef[] = [
  // ── memory / vault ───────────────────────────────────────────────────────
  {
    name:        'search_memory',
    description: 'Search across memory_index + NeuroVault (and ResearchLM/InsightsLM if configured). Returns categorized hits ranked by salience, importance, recency. Call this BEFORE answering when the user references prior work or expects continuity.',
    schema:      S.searchMemorySchema,
    shape:       S.searchMemoryShape,
    gate:        gateMcp,
    handler: async (args, ctx) =>
      searchMemoryTool({ query: args.query, limit: args.limit, agentId: ctx.agentId ?? null }),
  },
  {
    name:        'search_vault',
    description: 'Search the NeuroVault MCP directly (no SQLite). Useful when you specifically want vault-stored notes.',
    schema:      S.searchVaultSchema,
    shape:       S.searchVaultShape,
    gate:        gateMcp,
    handler: async (args) => searchVaultTool(args),
  },
  {
    name:        'write_vault_note',
    description: 'Persist a structured memory: indexes locally and mirrors to NeuroVault. Use for procedures, insights, decisions, or preferences worth keeping. Do NOT save raw chat — write the distilled lesson.',
    schema:      S.writeVaultNoteSchema,
    shape:       S.writeVaultNoteShape,
    gate:        gateMcp,
    handler: async (args, ctx) => {
      const agent = ctx.agentId ? getAgentById(ctx.agentId) : undefined;
      return writeVaultNoteTool({
        ...args,
        agent_id:   ctx.agentId   ?? null,
        agent_name: agent?.name,
        session_id: ctx.sessionId ?? null,
      });
    },
  },
  {
    name:        'save_session_summary',
    description: 'Save a summary of the current session as a long-term memory. Call before context pressure forces a compaction.',
    schema:      S.saveSessionSummarySchema,
    shape:       S.saveSessionSummaryShape,
    gate:        gateMcp,
    handler: async (args, ctx) => {
      const agent = ctx.agentId ? getAgentById(ctx.agentId) : undefined;
      return saveSessionSummaryTool({
        ...args,
        agent_id:   ctx.agentId   ?? null,
        agent_name: agent?.name,
        session_id: ctx.sessionId ?? null,
      });
    },
  },
  {
    name:        'compact_context',
    description: 'Compact a long conversation: provide a summary of prior turns; the system stores it as a session_summary memory.',
    schema:      S.compactContextSchema,
    shape:       S.compactContextShape,
    gate:        gateMcp,
    handler: async (args, ctx) => {
      const agent = ctx.agentId ? getAgentById(ctx.agentId) : undefined;
      return compactContextTool({
        conversation: args.conversation,
        agent_id:     ctx.agentId   ?? null,
        agent_name:   agent?.name,
        session_id:   ctx.sessionId ?? null,
      });
    },
  },

  // ── agent comms / orchestration ──────────────────────────────────────────
  {
    name:        'message_agent',
    description: 'Send a direct message to another agent and receive their response synchronously.',
    schema:      S.messageAgentSchema,
    shape:       S.messageAgentShape,
    handler: async (args, ctx) => {
      const sender    = ctx.agentId ? getAgentById(ctx.agentId) : undefined;
      const recipient = getAgentByName(args.to);
      if (!recipient || recipient.status !== 'active') return { ok: false, error: `agent "${args.to}" not found or inactive` };
      const senderName = sender?.name ?? ctx.agentId ?? 'agent';

      const fullMessage = args.context ? `[Context: ${args.context}]\n\n${args.message}` : args.message;
      const msgRecord = sender
        ? createAgentMessage(sender.id, sender.name, recipient.id, recipient.name, args.message, ctx.sessionId ?? undefined)
        : null;

      await ctx.onMeta?.({ type: 'agent_message', fromName: senderName, toName: recipient.name, preview: args.message.slice(0, 80) });
      logHive('agent_message_sent', `${senderName} → ${recipient.name}: "${args.message.slice(0, 60)}"`, sender?.id, { toAgentId: recipient.id, preview: args.message.slice(0, 80) });

      try {
        const { sessionId, response } = await runAgentTurn(fullMessage, recipient, `Comms: ${senderName} → ${recipient.name}`);
        if (msgRecord) updateAgentMessageResponse(msgRecord.id, response, 'responded');
        return { ok: true, from: recipient.name, response, sessionId };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (msgRecord) updateAgentMessageResponse(msgRecord.id, errMsg, 'failed');
        return { ok: false, error: `Agent "${args.to}" failed to respond: ${errMsg}` };
      }
    },
  },
  {
    name:        'assign_task_to_agent',
    description: 'Create a task and assign it to a specific agent; optionally execute it immediately.',
    schema:      S.assignTaskSchema,
    shape:       S.assignTaskShape,
    handler: async (args, ctx) => {
      const sender    = ctx.agentId ? getAgentById(ctx.agentId) : undefined;
      const recipient = getAgentByName(args.to);
      if (!recipient || recipient.status !== 'active') return { ok: false, error: `agent "${args.to}" not found or inactive` };

      const task = await createTask(args.title, args.description, ctx.sessionId ?? undefined, recipient.id, args.priority ?? 50);
      const senderName = sender?.name ?? 'system';

      await ctx.onMeta?.({ type: 'agent_task_assigned', fromName: senderName, toName: recipient.name, title: args.title, taskId: task.id, executing: !!args.execute_now });
      logHive('agent_task_assigned', `${senderName} assigned task "${args.title}" to ${recipient.name}`, recipient.id, { taskId: task.id, executeNow: !!args.execute_now });
      taskEvents.emit('task_created', { taskId: task.id, title: task.title, toName: recipient.name, fromName: senderName, status: task.status });

      if (args.execute_now) {
        try {
          const taskMsg = args.description ? `${args.title}\n\n${args.description}` : args.title;
          const { response } = await runAgentTurn(taskMsg, recipient, `Task: ${args.title.slice(0, 50)}`);
          updateAgentMessageResponse(task.id, response);
          return { ok: true, task_id: task.id, assigned_to: recipient.name, status: 'completed', result: response };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return { ok: false, task_id: task.id, assigned_to: recipient.name, status: 'failed', error: errMsg };
        }
      }
      return { ok: true, task_id: task.id, assigned_to: recipient.name, status: 'queued', title: args.title };
    },
  },
  {
    name:        'list_agents',
    description: 'List all agents in the registry. Use to discover who you can message or delegate to.',
    schema:      S.listAgentsSchema,
    shape:       S.listAgentsShape,
    handler: async (args) => {
      const all = getAllAgents();
      return all
        .filter(a => (args.include_inactive ? true : a.status === 'active') && (args.include_temp ? true : !a.temporary))
        .map(a => ({ id: a.id, name: a.name, role: a.role, description: a.description, model: a.model, status: a.status, temporary: !!a.temporary }));
    },
  },

  // ── spawning ────────────────────────────────────────────────────────────
  {
    name:        'spawn_agent',
    description: 'Create a temporary specialized sub-agent. Honors cascade-depth, spawn budget, SPAWN_AGENTS_ENABLED. Prefer message_agent / assign_task_to_agent on existing agents first.',
    schema:      S.spawnAgentSchema,
    shape:       S.spawnAgentShape,
    gate:        gateSpawn,
    handler: async (args, ctx) => {
      // Spawn evaluation — only spawn if no existing agent fits
      const existing   = getAllAgents().filter(a => a.status === 'active' && !a.temporary);
      const evaluation = await evaluateSpawn(args.taskDescription ?? args.description, existing);
      await ctx.onMeta?.({ type: 'spawn_eval', task: args.name, shouldSpawn: evaluation.shouldSpawn, benefit: evaluation.expectedBenefit, reason: evaluation.reason });
      logHive('spawn_evaluated', `Spawn evaluation for "${args.name}": ${evaluation.shouldSpawn ? 'APPROVED' : 'DENIED'} (benefit ${evaluation.expectedBenefit}) — ${evaluation.reason}`, ctx.agentId ?? undefined, evaluation);
      if (!evaluation.shouldSpawn) {
        return {
          spawn_blocked: true,
          reason:        evaluation.reason,
          suggestion:    'Use an existing agent instead. Available: ' + existing.map(a => a.name).join(', '),
        };
      }

      const result = await spawnAgentAsync({ ...args, parentAgentId: ctx.agentId! });
      if (!result.ok || !result.agent) return { ok: false, error: result.reason ?? 'spawn failed' };
      const spawned = result.agent;
      await ctx.onMeta?.({ type: 'spawn', event: { agentName: spawned.name, agentId: spawned.id } });

      // Background-execute the task if provided (matches the OpenAI path)
      if (args.taskDescription) {
        const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const spawnSessionId = createSession(spawned.id, `Spawn: ${spawned.name}`);
        createBackgroundTask(taskId, spawned.id, spawned.name, spawnSessionId);
        await ctx.onMeta?.({ type: 'spawn_started', agentName: spawned.name, taskId });

        (async () => {
          let subResponse = '';
          try {
            const { chatStream } = await import('../agent/alfred');
            await chatStream(args.taskDescription!, spawnSessionId, (c) => { subResponse += c; }, spawned.system_prompt ?? '', spawned.id);
            completeBackgroundTask(taskId, subResponse, true);
            logger.info('Background sub-agent completed', { taskId, agentName: spawned.name, chars: subResponse.length });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            failBackgroundTask(taskId, errMsg);
            logger.error('Background sub-agent failed', { taskId, agentName: spawned.name, error: errMsg });
          }
        })();

        return {
          spawned: spawned.name,
          status:  'running_in_background',
          taskId,
          note:    `Sub-agent "${spawned.name}" is now working in background. DO NOT write the output yourself — the sub-agent will. Tell the user it's running and keep your reply to 1-2 sentences.`,
        };
      }

      return { ok: true, spawned: spawned.name, agent_id: spawned.id, model: spawned.model, expires: spawned.expires_at, depth: spawned.spawn_depth };
    },
  },
  {
    name:        'list_temp_agents',
    description: 'List all currently active temporary (spawned) agents with their parent, depth, model, expiry. Use to see what is running before spawning more.',
    schema:      S.listTempAgentsSchema,
    shape:       S.listTempAgentsShape,
    handler: async () => {
      const rows = getDb().prepare(`
        SELECT id, name, description, model, role, parent_agent_id, spawn_depth, expires_at, created_at
        FROM agents
        WHERE temporary = 1 AND status = 'active'
        ORDER BY created_at DESC
      `).all();
      return {
        ok:    true,
        count: rows.length,
        limit: config.spawning.hardLimit,
        soft:  config.spawning.softLimit,
        active_count: countActiveTempAgents(),
        agents: rows,
      };
    },
  },

  // ── vault auxiliaries (Claude-only today; promoted to all surfaces) ──────
  {
    name:        'log_handoff',
    description: 'Record an agent-to-agent handoff in NeuroVault.',
    schema:      S.logHandoffSchema,
    shape:       S.logHandoffShape,
    gate:        gateMcp,
    handler: async (args) => vaultLogHandoff(args),
  },
  {
    name:        'create_checkpoint',
    description: 'Create a vault checkpoint for the current session.',
    schema:      S.createCheckpointSchema,
    shape:       S.createCheckpointShape,
    gate:        gateMcp,
    handler: async (args) => vaultCreateCheckpoint(args),
  },
  {
    name:        'get_context_pack',
    description: 'Fetch the most recent NeuroVault context pack — a curated handoff bundle of recent insights/procedures/preferences.',
    schema:      S.getContextPackSchema,
    shape:       S.getContextPackShape,
    gate:        gateMcp,
    handler: async () => vaultGetContextPack(),
  },

  // ── exec (gated per-agent) ──────────────────────────────────────────────
  {
    name:        'bash_run',
    description: 'Run a shell command on the host. Returns stdout, stderr, exit code, duration. Output is byte-capped; some destructive patterns are hard-blocked.',
    schema:      S.bashRunSchema,
    shape:       S.bashRunShape,
    gate:        gateExec,
    handler: async (args, ctx) =>
      bashRun({ command: args.command, cwd: args.cwd, timeout_ms: args.timeout_ms, agentId: ctx.agentId ?? undefined }),
  },
  {
    name:        'fs_read',
    description: 'Read the contents of a file on the host. Output is byte-capped; truncated if too large.',
    schema:      S.fsReadSchema,
    shape:       S.fsReadShape,
    gate:        gateExec,
    handler: async (args, ctx) => fsRead({ path: args.path, agentId: ctx.agentId ?? undefined }),
  },
  {
    name:        'fs_write',
    description: 'Write to a file on the host. mode=overwrite (default), append, or create (fails if exists). Creates parent dirs.',
    schema:      S.fsWriteSchema,
    shape:       S.fsWriteShape,
    gate:        gateExec,
    handler: async (args, ctx) =>
      fsWrite({ path: args.path, content: args.content, mode: args.mode ?? 'overwrite', agentId: ctx.agentId ?? undefined }),
  },
  {
    name:        'fs_list',
    description: 'List the contents of a directory.',
    schema:      S.fsListSchema,
    shape:       S.fsListShape,
    gate:        gateExec,
    handler: async (args, ctx) => fsList({ path: args.path, agentId: ctx.agentId ?? undefined }),
  },
  {
    name:        'fs_search',
    description: 'Recursively search for a regex/pattern across files (uses ripgrep when available, else grep -rn).',
    schema:      S.fsSearchSchema,
    shape:       S.fsSearchShape,
    gate:        gateExec,
    handler: async (args, ctx) =>
      fsSearch({ pattern: args.pattern, path: args.path, max_results: args.max_results, agentId: ctx.agentId ?? undefined }),
  },

  // ── Discord channel setup (agent self-setup, OpenClaw-style) ─────────────
  // Lets agents (Alfred / any specialist) provision Discord bots from a chat
  // turn instead of forcing the user to click through the dashboard. The
  // discord-bot manager polls every 30s and picks up new rows automatically.
  {
    name:        'discord_register_bot',
    description: 'Register a new Discord bot. Creates a row in discord_bots which the bot manager picks up within 30s and connects to the Discord gateway. The user must have already created the bot in the Discord Developer Portal and copied its token. Returns the bot id; pair with discord_add_channel_route to scope which agent handles which channel.',
    schema:      S.discordRegisterBotSchema,
    shape:       S.discordRegisterBotShape,
    handler: async (args, ctx) => {
      const defaultAgent = args.default_agent
        ? (getAgentById(args.default_agent) ?? getAgentByName(args.default_agent))
        : null;
      const row = createDiscordBot({
        name:                args.name,
        token:               args.token,
        application_id:      args.application_id ?? null,
        default_agent_id:    defaultAgent?.id ?? null,
        created_by_agent_id: ctx.agentId ?? null,
      });
      // Trigger an immediate manager reload so the bot connects without the
      // 30s poll wait. Best-effort — manager may not be running in standalone
      // bot processes; that's fine, the next poll picks it up.
      try {
        const { reloadDiscordBots } = await import('../integrations/discord-bot');
        reloadDiscordBots().catch(() => { /* best-effort */ });
      } catch { /* manager not running in this process — fine */ }
      return {
        ok:               true,
        bot_id:           row.id,
        name:             row.name,
        default_agent:    defaultAgent?.name ?? null,
        message:          `Discord bot "${row.name}" registered. It will connect to the Discord gateway within 30 seconds. Use discord_add_channel_route to scope channels to specific agents.`,
      };
    },
  },
  {
    name:        'discord_add_channel_route',
    description: 'Map a Discord channel id to a NeuroClaw agent for a specific bot. When a user @-mentions the bot in that channel, the named agent handles the message. Without a route, mentions fall back to the bot\'s default_agent. Channel ids are 18-19 digit Discord snowflakes (right-click channel → Copy ID with Developer Mode enabled).',
    schema:      S.discordAddRouteSchema,
    shape:       S.discordAddRouteShape,
    handler: async (args) => {
      const bot = getDiscordBot(args.bot_id);
      if (!bot) return { ok: false, error: `bot "${args.bot_id}" not found` };
      const agent = getAgentById(args.agent) ?? getAgentByName(args.agent);
      if (!agent) return { ok: false, error: `agent "${args.agent}" not found` };
      const route = upsertDiscordRoute(args.bot_id, args.channel_id, agent.id, args.require_mention);
      try {
        const { reloadDiscordBots } = await import('../integrations/discord-bot');
        reloadDiscordBots().catch(() => { /* best-effort */ });
      } catch { /* fine */ }
      return {
        ok:              true,
        route_id:        route.id,
        bot:             bot.name,
        channel:         args.channel_id,
        agent:           agent.name,
        require_mention: !!args.require_mention,
      };
    },
  },
  {
    name:        'discord_list_bots',
    description: 'List all Discord bots configured in NeuroClaw, with their connection status and channel routes. Token values are masked.',
    schema:      S.discordListBotsSchema,
    shape:       S.discordListBotsShape,
    handler: async () => {
      const bots = listDiscordBots(true).map(b => ({
        id:                b.id,
        name:              b.name,
        status:            b.status,
        status_detail:     b.status_detail,
        bot_user_tag:      b.bot_user_tag,
        default_agent_id:  b.default_agent_id,
        enabled:           !!b.enabled,
        token_preview:     b.token ? `${b.token.slice(0, 6)}…${b.token.slice(-4)}` : null,
        routes:            listDiscordRoutes(b.id).map(r => ({ channel_id: r.channel_id, agent_id: r.agent_id })),
      }));
      return { ok: true, count: bots.length, bots };
    },
  },
  {
    name:        'discord_remove_bot',
    description: 'Permanently delete a Discord bot configuration (and all its channel routes). The bot disconnects from the Discord gateway within 30 seconds. Use disable=true on PATCH instead if you just want to pause it temporarily.',
    schema:      S.discordRemoveBotSchema,
    shape:       S.discordRemoveBotShape,
    handler: async (args) => {
      const bot = getDiscordBot(args.bot_id);
      if (!bot) return { ok: false, error: `bot "${args.bot_id}" not found` };
      deleteDiscordBot(args.bot_id);
      try {
        const { reloadDiscordBots } = await import('../integrations/discord-bot');
        reloadDiscordBots().catch(() => { /* best-effort */ });
      } catch { /* fine */ }
      return { ok: true, removed: bot.name };
    },
  },
  {
    name:        'discord_list_guilds',
    description: 'List the Discord servers (guilds) a bot is currently a member of, including which ones have auto-reply enabled. Useful for telling the user what their options are before calling discord_set_auto_reply_guilds. Returns an error if the bot is not currently connected to the Discord gateway.',
    schema:      S.discordListGuildsSchema,
    shape:       S.discordListGuildsShape,
    handler: async (args) => {
      const bot = getDiscordBot(args.bot_id);
      if (!bot) return { ok: false, error: `bot "${args.bot_id}" not found` };
      const { listBotGuilds } = await import('../integrations/discord-bot');
      const guilds = listBotGuilds(args.bot_id);
      if (guilds === null) return { ok: false, error: 'bot is not connected to the Discord gateway right now (status: ' + bot.status + ')' };
      const enabled = new Set(parseAutoReplyGuilds(bot.auto_reply_guilds));
      return {
        ok:     true,
        bot:    bot.name,
        guilds: guilds.map(g => ({ id: g.id, name: g.name, member_count: g.member_count, auto_reply: enabled.has(g.id) })),
      };
    },
  },
  {
    name:        'discord_react',
    description: 'Add an emoji reaction to a Discord message. Use to acknowledge, agree, react playfully, etc., without sending a full reply. Pass either message_id (specific message to react to) OR last_user_message=true (the most recent non-bot message in the channel). Emoji can be unicode ("👍" "🔥" "❤️") or a custom guild emoji as <:name:id>.',
    schema:      S.discordReactSchema,
    shape:       S.discordReactShape,
    handler: async (args) => {
      const bot = getDiscordBot(args.bot_id);
      if (!bot) return { ok: false, error: `bot "${args.bot_id}" not found` };
      const { reactToMessage, lastInboundMessage } = await import('../integrations/discord-bot');

      let messageId = args.message_id;
      if (!messageId && args.last_user_message) {
        messageId = lastInboundMessage(args.bot_id, args.channel_id) ?? undefined;
        if (!messageId) return { ok: false, error: 'no recent user message found in channel cache — pass message_id explicitly' };
      }
      if (!messageId) return { ok: false, error: 'either message_id or last_user_message=true is required' };

      const result = await reactToMessage(args.bot_id, args.channel_id, messageId, args.emoji);
      if (!result.ok) return result;
      return { ok: true, bot: bot.name, channel_id: args.channel_id, message_id: messageId, emoji: args.emoji };
    },
  },
  {
    name:        'discord_set_auto_reply_guilds',
    description: 'Configure which Discord servers a bot replies in WITHOUT requiring an @mention. Pass an array of guild ids — only those guilds get auto-reply, all others still require @mention. Pass an empty array to disable auto-reply everywhere. Useful for private "agent servers" where it\'s just the user and the bot. Use discord_list_guilds first to see what guilds the bot is in.',
    schema:      S.discordSetAutoReplySchema,
    shape:       S.discordSetAutoReplyShape,
    handler: async (args) => {
      const bot = getDiscordBot(args.bot_id);
      if (!bot) return { ok: false, error: `bot "${args.bot_id}" not found` };
      updateDiscordBot(args.bot_id, { auto_reply_guilds: args.guild_ids });
      try {
        const { reloadDiscordBots } = await import('../integrations/discord-bot');
        reloadDiscordBots().catch(() => { /* best-effort */ });
      } catch { /* fine */ }
      return {
        ok:                 true,
        bot:                bot.name,
        auto_reply_guilds:  args.guild_ids,
        message:            args.guild_ids.length > 0
          ? `Bot will now reply to every non-bot message in ${args.guild_ids.length} server(s) without needing an @mention. Mentions still work everywhere else.`
          : 'Auto-reply disabled. Bot only responds to @mentions and DMs now.',
      };
    },
  },

  // ── Audio (TTS + STT) self-setup ─────────────────────────────────────────
  // Lets agents wire up voice in conversation. Pair audio_status (read) with
  // audio_configure_agent / audio_configure_discord_bot (write); use
  // audio_list_voices to pick from valid voices before configuring.
  {
    name:        'audio_list_voices',
    description: 'List available TTS voices. VoidAI returns the standard six (alloy/echo/fable/onyx/nova/shimmer). ElevenLabs returns the user\'s entire voice library (premade + cloned) when ELEVENLABS_API_KEY is set; empty otherwise. Pair with audio_configure_agent to save a choice.',
    schema:      S.audioListVoicesSchema,
    shape:       S.audioListVoicesShape,
    handler: async (args) => {
      const wantVoid  = !args.provider || args.provider === 'voidai';
      const wantEleven = !args.provider || args.provider === 'elevenlabs';
      const elevenAvailable = config.audio.elevenlabs.enabled;
      const result: { voidai?: unknown; elevenlabs?: unknown; elevenlabs_available?: boolean; note?: string } = {};
      if (wantVoid)   result.voidai = listVoidAIVoices();
      if (wantEleven) {
        result.elevenlabs_available = elevenAvailable;
        if (elevenAvailable) {
          try { result.elevenlabs = await listElevenLabsVoices(); }
          catch (err) { result.elevenlabs = []; result.note = `ElevenLabs voices fetch failed: ${(err as Error).message}`; }
        } else {
          result.elevenlabs = [];
          if (!args.provider) result.note = 'ElevenLabs is not configured (set ELEVENLABS_API_KEY in .env to enable).';
        }
      }
      return { ok: true, ...result };
    },
  },
  {
    name:        'audio_status',
    description: 'Inspect current voice configuration. With no args, returns every agent that has TTS enabled plus the voice toggle status for each Discord bot. With agent=<name|id>, returns just that agent\'s voice fields.',
    schema:      S.audioStatusSchema,
    shape:       S.audioStatusShape,
    handler: async (args) => {
      if (args.agent) {
        const agent = getAgentById(args.agent) ?? getAgentByName(args.agent);
        if (!agent) return { ok: false, error: `agent "${args.agent}" not found` };
        return {
          ok:    true,
          agent: {
            id:           agent.id,
            name:         agent.name,
            tts_enabled:  !!agent.tts_enabled,
            tts_provider: agent.tts_provider,
            tts_voice:    agent.tts_voice,
          },
        };
      }
      const agents = getAllAgents()
        .filter(a => a.tts_enabled)
        .map(a => ({ id: a.id, name: a.name, tts_provider: a.tts_provider, tts_voice: a.tts_voice }));
      const bots = listDiscordBots(true).map((b: DiscordBotRow) => ({
        id:            b.id,
        name:          b.name,
        voice_enabled: !!b.voice_enabled,
        status:        b.status,
        default_agent_id: b.default_agent_id,
      }));
      return {
        ok:               true,
        elevenlabs_ready: config.audio.elevenlabs.enabled,
        env_defaults: {
          voidai_voice: config.audio.voidai.ttsVoice,
          elevenlabs_default_voice_id: config.audio.elevenlabs.defaultVoiceId || null,
        },
        agents_with_tts: agents,
        discord_bots:    bots,
      };
    },
  },
  {
    name:        'audio_configure_agent',
    description: 'Set an agent\'s TTS configuration. Use this AFTER audio_list_voices so you can pass a real voice id. Pass enabled=false to turn voice off (provider/voice are ignored). When enabling for the first time, you can pass provider+voice in one call. Voice="" clears the voice and falls back to env defaults.',
    schema:      S.audioConfigureAgentSchema,
    shape:       S.audioConfigureAgentShape,
    handler: async (args) => {
      const agent = getAgentById(args.agent) ?? getAgentByName(args.agent);
      if (!agent) return { ok: false, error: `agent "${args.agent}" not found` };

      const fields: Parameters<typeof updateAgentRecord>[1] = { tts_enabled: args.enabled };
      if (args.enabled) {
        if (args.provider) fields.tts_provider = args.provider;
        if (args.voice !== undefined) fields.tts_voice = args.voice.trim() || null;
        if (args.provider === 'elevenlabs' && !config.audio.elevenlabs.enabled) {
          return { ok: false, error: 'ElevenLabs is not configured — set ELEVENLABS_API_KEY in .env or use provider=voidai.' };
        }
      }
      updateAgentRecord(agent.id, fields);
      const updated = getAgentById(agent.id)!;
      return {
        ok:      true,
        agent:   updated.name,
        enabled: !!updated.tts_enabled,
        provider: updated.tts_provider,
        voice:   updated.tts_voice,
        message: updated.tts_enabled
          ? `Voice ON for ${updated.name} via ${updated.tts_provider}${updated.tts_voice ? ` (voice: ${updated.tts_voice})` : ' (env default voice)'}. Remember: a Discord bot also needs voice_enabled=1 to attach .mp3s — use audio_configure_discord_bot if needed.`
          : `Voice OFF for ${updated.name}.`,
      };
    },
  },
  {
    name:        'audio_configure_discord_bot',
    description: 'Flip a Discord bot\'s voice_enabled toggle. When ON, the bot attaches a synthesized .mp3 to every reply where the responding agent has TTS enabled. When OFF, replies stay text-only (transcription of inbound voice notes still works either way). Pair with audio_configure_agent to enable per-agent voice.',
    schema:      S.audioConfigureDiscordBotSchema,
    shape:       S.audioConfigureDiscordBotShape,
    handler: async (args) => {
      const bot = getDiscordBot(args.bot)
                ?? listDiscordBots(true).find(b => b.name.toLowerCase() === args.bot.toLowerCase()) ?? null;
      if (!bot) return { ok: false, error: `bot "${args.bot}" not found` };
      updateDiscordBot(bot.id, { voice_enabled: args.enabled });
      try {
        const { reloadDiscordBots } = await import('../integrations/discord-bot');
        reloadDiscordBots().catch(() => { /* best-effort */ });
      } catch { /* fine */ }
      return {
        ok:      true,
        bot:     bot.name,
        voice_enabled: args.enabled,
        message: args.enabled
          ? `Voice ON for bot "${bot.name}". Replies will now attach .mp3 audio when the responding agent has tts_enabled=1.`
          : `Voice OFF for bot "${bot.name}". Replies are text-only. Inbound voice notes still get transcribed.`,
      };
    },
  },
  {
    name:        'discord_set_user_voice',
    description: 'Per-user voice override for a Discord bot. Call this when the user explicitly asks you to stop (or start) sending .mp3 audio attachments. Pass enabled=false to mute audio replies for THIS user only — bot-wide and agent-wide voice toggles stay untouched and other users are unaffected. The bot reads this preference on every reply, so the change takes effect on the very next message (and the current one if the agent calls this mid-turn). Read bot_id and user_id (the Discord author id) from your Discord context block.',
    schema:      S.discordSetUserVoiceSchema,
    shape:       S.discordSetUserVoiceShape,
    handler: async (args) => {
      const bot = getDiscordBot(args.bot_id);
      if (!bot) return { ok: false, error: `bot_id "${args.bot_id}" not found` };
      setDiscordVoicePref(args.bot_id, args.user_id, args.enabled, args.reason ?? null);
      const pref = getDiscordVoicePref(args.bot_id, args.user_id);
      return {
        ok:      true,
        bot:     bot.name,
        user_id: args.user_id,
        voice_enabled: !!pref?.voice_enabled,
        reason:  pref?.reason ?? null,
        message: args.enabled
          ? `Audio attachments re-enabled for user ${args.user_id} on bot "${bot.name}".`
          : `Audio attachments muted for user ${args.user_id} on bot "${bot.name}". They will receive text-only replies until they ask for audio again.`,
      };
    },
  },

  // ── Archon port (v1.9): projects + tasks find_/manage_ ───────────────────
  // Drop-in compatible with the external Archon MCP that NeuroClaw was using
  // until v1.9. Same tool names, same arg shapes, same response shape — so
  // existing prompts (CLAUDE.md, agent system prompts) keep working after
  // the external Archon MCP is removed from settings.
  {
    name:        'find_projects',
    description: 'List, search, or fetch projects. Use project_id to get a single project (full record). Otherwise returns a paginated list, optionally filtered by query (case-insensitive on title + description). archived projects are hidden by default.',
    schema:      S.findProjectsSchema,
    shape:       S.findProjectsShape,
    handler: async (args) => {
      if (args.project_id) {
        const p = getProject(args.project_id);
        if (!p) return { ok: false, error: `project "${args.project_id}" not found` };
        return { ok: true, project: serializeProject(p) };
      }
      const all = listProjects(args.include_archived ?? false);
      const filtered = args.query
        ? all.filter(p => {
            const q = args.query!.toLowerCase();
            return p.title.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q);
          })
        : all;
      const page = Math.max(1, args.page ?? 1);
      const perPage = Math.min(100, Math.max(1, args.per_page ?? 10));
      const start = (page - 1) * perPage;
      return {
        ok:       true,
        total:    filtered.length,
        page, per_page: perPage,
        projects: filtered.slice(start, start + perPage).map(serializeProject),
      };
    },
  },
  {
    name:        'manage_project',
    description: 'Create, update, or delete a project. action="delete" archives by default — pass hard=true to permanently remove (tasks reassigned to the default NeuroClaw project, which itself cannot be hard-deleted).',
    schema:      S.manageProjectSchema,
    shape:       S.manageProjectShape,
    handler: async (args) => {
      if (args.action === 'create') {
        if (!args.title) return { ok: false, error: 'title is required for create' };
        const p = createProject({
          title:       args.title,
          description: args.description ?? null,
          github_repo: args.github_repo ?? null,
          pinned:      !!args.pinned,
          docs:        args.docs,
          features:    args.features,
          data:        args.data,
        });
        return { ok: true, project: serializeProject(p), message: `Project "${p.title}" created.` };
      }
      if (!args.project_id) return { ok: false, error: 'project_id is required for update/delete' };
      const existing = getProject(args.project_id);
      if (!existing) return { ok: false, error: `project "${args.project_id}" not found` };

      if (args.action === 'update') {
        updateProject(existing.id, {
          title:       args.title,
          description: args.description,
          github_repo: args.github_repo,
          pinned:      args.pinned,
          docs:        args.docs,
          features:    args.features,
          data:        args.data,
        });
        return { ok: true, project: serializeProject(getProject(existing.id)!) };
      }
      // delete
      if (args.hard) {
        const result = deleteProjectHard(existing.id);
        if (!result.ok) return result;
        return { ok: true, deleted: existing.title, hard: true };
      }
      archiveProject(existing.id);
      return { ok: true, archived: existing.title };
    },
  },
  {
    name:        'find_tasks',
    description: 'List, search, or fetch tasks. Use task_id for a single task. Otherwise returns paginated/filtered list. filter_by="status"|"project"|"assignee"|"parent" with filter_value. project_id can be combined with filter_by=status to get one project\'s todo tasks. include_closed defaults to true.',
    schema:      S.findTasksSchema,
    shape:       S.findTasksShape,
    handler: async (args) => {
      if (args.task_id) {
        const t = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(args.task_id) as AppTask | undefined;
        if (!t) return { ok: false, error: `task "${args.task_id}" not found` };
        return { ok: true, task: serializeTask(t) };
      }
      let rows: AppTask[];
      const includeArchived = args.include_closed ?? true;
      if (args.filter_by === 'status' && args.filter_value) {
        rows = getTasks(args.filter_value as TaskStatus, { include_archived: includeArchived, project_id: args.project_id });
      } else if (args.filter_by === 'project' && args.filter_value) {
        rows = getTasks(undefined, { project_id: args.filter_value, include_archived: includeArchived });
      } else if (args.filter_by === 'parent' && args.filter_value) {
        rows = getTasks(undefined, { parent_task_id: args.filter_value, include_archived: includeArchived });
      } else if (args.filter_by === 'assignee' && args.filter_value) {
        const all = getTasks(undefined, { include_archived: includeArchived, project_id: args.project_id });
        rows = all.filter(t => t.assignee.toLowerCase() === args.filter_value!.toLowerCase());
      } else {
        rows = getTasks(undefined, { include_archived: includeArchived, project_id: args.project_id });
      }
      if (args.query) {
        const q = args.query.toLowerCase();
        rows = rows.filter(t =>
          t.title.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q),
        );
      }
      const page = Math.max(1, args.page ?? 1);
      const perPage = Math.min(100, Math.max(1, args.per_page ?? 10));
      const start = (page - 1) * perPage;
      return {
        ok:    true,
        total: rows.length,
        page, per_page: perPage,
        tasks: rows.slice(start, start + perPage).map(serializeTask),
      };
    },
  },
  {
    name:        'manage_task',
    description: 'Create, update, or delete a task. assignee is free text — agent names, "User", "AI IDE Agent", anything. priority_level is "low"|"medium"|"high"|"critical". sources/code_examples are JSON arrays for RAG attachment. action="delete" archives by default; hard=true permanently removes.',
    schema:      S.manageTaskSchema,
    shape:       S.manageTaskShape,
    handler: async (args, ctx) => {
      if (args.action === 'create') {
        if (!args.title) return { ok: false, error: 'title is required for create' };
        const projectId = args.project_id ?? getDefaultProject().id;
        const t = await createTask(args.title, {
          description:    args.description,
          project_id:     projectId,
          parent_task_id: args.parent_task_id,
          assignee:       args.assignee,
          priority_level: args.priority_level,
          task_order:     args.task_order,
          feature:        args.feature,
          sources:        args.sources,
          code_examples:  args.code_examples,
        });
        if (args.status && args.status !== 'todo') {
          updateTask(t.id, { status: args.status });
        }
        return { ok: true, task: serializeTask({ ...t, status: args.status ?? t.status }) };
      }
      if (!args.task_id) return { ok: false, error: 'task_id is required for update/delete' };
      const existing = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(args.task_id) as AppTask | undefined;
      if (!existing) return { ok: false, error: `task "${args.task_id}" not found` };

      if (args.action === 'update') {
        updateTask(existing.id, {
          title:          args.title,
          description:    args.description,
          status:         args.status,
          assignee:       args.assignee,
          priority_level: args.priority_level,
          task_order:     args.task_order,
          feature:        args.feature,
          sources:        args.sources,
          code_examples:  args.code_examples,
          project_id:     args.project_id,
          parent_task_id: args.parent_task_id,
        });
        const updated = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(existing.id) as AppTask;
        return { ok: true, task: serializeTask(updated) };
      }
      // delete
      if (args.hard) {
        getDb().prepare('DELETE FROM tasks WHERE id = ?').run(existing.id);
        return { ok: true, deleted: existing.title, hard: true };
      }
      archiveTask(existing.id, ctx.agentId ?? null);
      return { ok: true, archived: existing.title };
    },
  },

  // ── Skills v2: scripts + agent-authored skills ──────────────────────────
  // Available to every active agent. Path-traversal locked at the skill-loader
  // layer; the runtime is also no-shell (args go straight through to spawn)
  // so an attacker-controlled arg string can't inject more commands.
  {
    name:        'list_skills',
    description: 'List every skill registered on disk (project-local + user-global). Returns name, description, source, and the scripts each skill exposes. Pass include_body=true to also get the markdown body of each skill.',
    schema:      S.listSkillsSchema,
    shape:       S.listSkillsShape,
    handler: async (args) => {
      const skills = listSkills().map(s => ({
        name:        s.name,
        description: s.description,
        source:      s.source,
        triggers:    s.triggers,
        tools:       s.tools,
        scripts:     s.scripts,
        path:        s.path,
        ...(args.include_body ? { body: s.body } : {}),
      }));
      return { ok: true, count: skills.length, skills };
    },
  },
  {
    name:        'run_skill_script',
    description: 'Execute a script bundled with a skill (under .claude/skills/<skill>/scripts/<file>). Interpreter is chosen by extension: .py → python3, .sh → bash, .js/.mjs/.cjs → node, .ts → tsx, otherwise the file itself (must be +x with a shebang). Stdin and timeout are capped. Sensitive env vars (API keys, tokens) are scrubbed before spawn. Use list_skills to discover what\'s available; use manage_skill_script to author new scripts.',
    schema:      S.runSkillScriptSchema,
    shape:       S.runSkillScriptShape,
    handler: async (args, ctx) => {
      let scriptPath: string;
      try { scriptPath = getSkillScriptPath(args.skill_name, args.script); }
      catch (err) { return { ok: false, error: (err as Error).message }; }
      const result = await runSkillScript({
        skillName:  args.skill_name,
        scriptPath,
        args:       args.args,
        stdin:      args.stdin,
        cwd:        args.cwd,
        timeout_ms: args.timeout_ms,
        agentId:    ctx.agentId ?? null,
      });
      logHive('skill_script_run',
        `Skill "${args.skill_name}" ran ${args.script} (exit ${result.exit_code}, ${result.duration_ms}ms)`,
        ctx.agentId ?? undefined,
        { skill: args.skill_name, script: args.script, exit_code: result.exit_code, duration_ms: result.duration_ms, ok: result.ok },
      );
      return result;
    },
  },
  {
    name:        'manage_skill',
    description: 'Create, update, or delete a skill end-to-end. action="create" requires name + body; description, triggers, tools, and scripts are optional. The skill is written to .claude/skills/<name>/SKILL.md (project-local) and is immediately available to every agent. Bundle scripts on create with scripts: [{filename, content}]. action="update" replaces only the fields you pass. action="delete" removes the entire folder. User-global skills (~/.claude/skills/) are read-only — only project skills can be edited or deleted.',
    schema:      S.manageSkillSchema,
    shape:       S.manageSkillShape,
    handler: async (args, ctx) => {
      try {
        if (args.action === 'create') {
          if (!args.body) return { ok: false, error: 'body is required for create' };
          const summary = createSkill({
            name:        args.name,
            description: args.description,
            body:        args.body,
            triggers:    args.triggers,
            tools:       args.tools,
            scripts:     args.scripts,
            authoredBy:  ctx.agentId ?? undefined,
          });
          logHive('skill_created', `Skill "${summary.name}" created with ${summary.scripts.length} script(s)`, ctx.agentId ?? undefined,
            { skill: summary.name, scripts: summary.scripts });
          return { ok: true, skill: summary, message: `Skill "${summary.name}" created. Every agent now has it in their tool catalog (via list_skills + run_skill_script).` };
        }
        if (args.action === 'update') {
          const summary = updateSkill(args.name, {
            description: args.description,
            body:        args.body,
            triggers:    args.triggers,
            tools:       args.tools,
          });
          logHive('skill_updated', `Skill "${summary.name}" updated`, ctx.agentId ?? undefined, { skill: summary.name });
          return { ok: true, skill: summary };
        }
        if (args.action === 'delete') {
          deleteSkill(args.name);
          logHive('skill_deleted', `Skill "${args.name}" deleted`, ctx.agentId ?? undefined, { skill: args.name });
          return { ok: true, deleted: args.name };
        }
        return { ok: false, error: `unknown action "${args.action}"` };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  },
  {
    name:        'manage_skill_script',
    description: 'Add, update, or delete a single script inside an existing skill\'s scripts/ folder. action="create" and "update" both call writeSkillScript (which overwrites if present) — the SKILL.md frontmatter\'s scripts: [...] list is updated automatically so the new file appears in every agent\'s prompt. Filename must be a single segment (no slashes), e.g. "extract.py".',
    schema:      S.manageSkillScriptSchema,
    shape:       S.manageSkillScriptShape,
    handler: async (args, ctx) => {
      try {
        if (args.action === 'create' || args.action === 'update') {
          if (typeof args.content !== 'string') return { ok: false, error: 'content is required for create/update' };
          const result = writeSkillScript(args.skill_name, args.filename, args.content);
          logHive('skill_script_written', `Script ${args.filename} written to skill "${args.skill_name}" (${result.bytes} bytes)`,
            ctx.agentId ?? undefined, { skill: args.skill_name, filename: args.filename, bytes: result.bytes });
          return { ok: true, path: result.path, bytes: result.bytes };
        }
        if (args.action === 'delete') {
          deleteSkillScript(args.skill_name, args.filename);
          logHive('skill_script_deleted', `Script ${args.filename} deleted from skill "${args.skill_name}"`,
            ctx.agentId ?? undefined, { skill: args.skill_name, filename: args.filename });
          return { ok: true, deleted: args.filename };
        }
        return { ok: false, error: `unknown action "${args.action}"` };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  },
];

// Internal serializers — keep the wire shape consistent across find_*/manage_*.
// Parse the JSON columns so MCP clients don't have to JSON.parse a stringified
// stringified array; null/empty stays clean.

function serializeProject(p: ProjectRecord): Record<string, unknown> {
  return {
    id:          p.id,
    title:       p.title,
    description: p.description,
    docs:        safeJsonParse(p.docs,     []),
    features:    safeJsonParse(p.features, []),
    data:        safeJsonParse(p.data,     {}),
    github_repo: p.github_repo,
    pinned:      !!p.pinned,
    archived:    !!p.archived,
    created_at:  p.created_at,
    updated_at:  p.updated_at,
  };
}

function serializeTask(t: AppTask): Record<string, unknown> {
  return {
    id:             t.id,
    title:          t.title,
    description:    t.description,
    status:         t.status,
    priority:       t.priority,
    priority_level: t.priority_level,
    project_id:     t.project_id,
    parent_task_id: t.parent_task_id,
    assignee:       t.assignee,
    task_order:     t.task_order,
    feature:        t.feature,
    sources:        safeJsonParse(t.sources,       []),
    code_examples:  safeJsonParse(t.code_examples, []),
    archived:       !!t.archived,
    archived_at:    t.archived_at,
    archived_by:    t.archived_by,
    session_id:     t.session_id,
    agent_id:       t.agent_id,
    created_at:     t.created_at,
    updated_at:     t.updated_at,
  };
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function findTool(name: string): ToolDef | undefined {
  return registry.find(t => t.name === name) ?? findMcpRegistryTool(name);
}

/** Filter the registry to tools currently allowed in the given context. */
export function visibleTools(ctx: ToolContext): ToolDef[] {
  return [...registry.filter(t => !t.gate || t.gate(ctx).allowed), ...getMcpRegistryTools()];
}

/** Native registry + dynamically synthesized MCP-registry tools. Used by
 *  callers that want the full list without context-gating (e.g. Codex's
 *  HTTP /mcp tools/list endpoint, dashboard introspection). */
export function getAllTools(): ToolDef[] {
  return [...registry, ...getMcpRegistryTools()];
}
