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

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  searchMemoryTool,
  writeVaultNoteTool, saveSessionSummaryTool, compactContextTool,
} from '../memory/memory-tools';
import { searchKnowledgeBase, searchCodeExamples, listSources } from '../kb/kb-search';
import { crawlAndIndex, ingestKbContent } from '../kb/kb-ingest';
import {
  getAllAgents, getAgentByName, getAgentById, getDb,
  createSession, saveMessage,
  createAgentMessage, updateAgentMessageResponse, markAgentMessagesDelivered,
  createAgentUserMessage,
  listDiscordBots, listDiscordRoutes,
  createDiscordBot, updateDiscordBot, deleteDiscordBot,
  upsertDiscordRoute, getDiscordBot,
  setDiscordVoicePref, getDiscordVoicePref,
  parseAutoReplyGuilds,
  updateAgentRecord,
  listProjects, getProject, getDefaultProject,
  createProject, updateProject, archiveProject, deleteProjectHard,
  enqueueJob,
  type AgentRecord, type DiscordBotRow, type ProjectRecord, type AgentTaskPayload,
} from '../db';
import { listVoidAIVoices, listElevenLabsVoices, listKokoroVoices } from '../audio/voices';
import {
  listSkills, getSkill, createSkill, updateSkill, deleteSkill,
  writeSkillScript, deleteSkillScript, getSkillScriptPath,
} from '../skills/skill-loader';
import { syncSkillExports } from '../skills/exporters';
import { runSkillScript } from '../system/skill-runner';
import { createTask, updateTask, getTasks, archiveTask, type AppTask, type PriorityLevel, type TaskStatus } from '../system/task-manager';
import { spawnAgentAsync, countActiveTempAgents } from '../system/spawner';
import { evaluateSpawn } from '../system/decomposer';
import { getSpawnConfig } from '../db';
import { logHive } from '../system/hive-mind';
import { runSubAgentAsync } from '../system/sub-agent-runner';
import { type TaskNotifyPolicy } from '../system/task-notify-policy';
import {
  createBackgroundTask, completeBackgroundTask, failBackgroundTask, taskEvents,
} from '../system/background-tasks';
import { bashRun, fsRead, fsWrite, fsList, fsSearch, checkFsBoundary } from '../system/exec-tools';
import { listAccessible } from '../broker/agentSecrets';
import { browserlessRequest, bingSearchViaBrowser, renderViaProxyClearingChallenge } from '../system/browser';
import { braveSearch } from '../system/brave-search';
import { getDowntimeEvents } from '../system/analytics';
import { readFilteredLogLines } from '../utils/logger';
import * as S from './schemas';
import { listUploads, getUpload, recordProcessing } from '../system/session-uploads';
import { describeImage } from '../vision/vision-service';
import { promises as fspUploads } from 'fs';
import { generateImage } from '../image/image-service';
import { generateVoidaiImage } from '../image/voidai-image';
import { generateVoidaiGptImage } from '../image/voidai-gpt-image';
import { generateAbacusMedia, pcmToWav } from '../agent/abacus-media';
import { synthesize } from '../audio/tts';
import type { ToolContext } from './context';
import { getMcpRegistryTools, findMcpRegistryTool } from './adapters/mcp-registry-adapter';
import { callRegisteredTool } from '../mcp/mcp-registry';

export interface GateResult { allowed: boolean; reason?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDef<Schema extends z.ZodType = z.ZodType<any, any>> {
  name:        string;
  description: string;
  /** Used directly by Claude SDK; converted to JSON Schema for OpenAI / MCP. */
  schema:      Schema;
  /** Same shape as Zod's `.shape` for Claude SDK's tool() helper. */
  shape:       z.ZodRawShape;
  gate?:       (ctx: ToolContext) => GateResult;
  handler:     (args: z.infer<Schema>, ctx: ToolContext) => Promise<unknown>;
  /** When true, this tool appears in the curated external MCP surface
   *  (Cursor, Claude Desktop). Omit or false for internal-only tools. */
  externalSurface?: boolean;
  /** When true, this tool is always included in the upfront tool list sent to
   *  the model. When false/omitted, it is only reachable via search_tools +
   *  call_tool. Keep the core set small — every core tool costs tokens on
   *  every single request. */
  core?: boolean;
}

const ALLOW: GateResult = { allowed: true };

const SEND_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;

const DOC_MIME_BY_EXT: Record<string, string> = {
  '.md':       'text/markdown',
  '.markdown': 'text/markdown',
  '.txt':      'text/plain',
  '.csv':      'text/csv',
  '.json':     'application/json',
  '.pdf':      'application/pdf',
  '.docx':     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx':     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.html':     'text/html',
  '.htm':      'text/html',
  '.xml':      'application/xml',
  '.yaml':     'application/yaml',
  '.yml':      'application/yaml',
  '.zip':      'application/zip',
  '.png':      'image/png',
  '.jpg':      'image/jpeg',
  '.jpeg':     'image/jpeg',
  '.gif':      'image/gif',
  '.webp':     'image/webp',
};

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
function gateSubAgent(ctx: ToolContext): GateResult {
  // Sub-agents dispatched via executeSubAgent in sub-agent-runner.ts use direct
  // provider clients (no chatStream, no toolCtx) so they never reach this gate.
  // This check defends against future code paths that might route sub-agents
  // through chatStream, where they would build a toolCtx with spawnDepth from DB.
  if ((ctx.spawnDepth ?? 0) >= 1) return { allowed: false, reason: 'run_subtask not available inside a sub-agent (depth limit)' };
  return ALLOW;
}
function gateExec(ctx: ToolContext): GateResult {
  if (!ctx.agentId) return { allowed: false, reason: 'exec requires an agent context' };
  const agent = getAgentById(ctx.agentId);
  if (!agent?.exec_enabled) return { allowed: false, reason: 'exec is not enabled for this agent' };
  return ALLOW;
}
function gateKb(_ctx: ToolContext): GateResult {
  return config.kb.enabled ? ALLOW : { allowed: false, reason: 'knowledge base disabled (KB_ENABLED=false)' };
}
// Write path: KB is global + agent-writable (poisoning surface). v1 = depth-0 only.
function gateKbWrite(ctx: ToolContext): GateResult {
  const base = gateKb(ctx);
  if (!base.allowed) return base;
  if ((ctx.spawnDepth ?? 0) >= 1) return { allowed: false, reason: 'KB ingest is not available to sub-agents (depth limit)' };
  return ALLOW;
}
function gateBrowser(_ctx: ToolContext): GateResult {
  return config.browser.enabled
    ? ALLOW
    : { allowed: false, reason: 'browser tools disabled (set BROWSERLESS_URL and BROWSERLESS_TOKEN in .env)' };
}
function gateSearch(_ctx: ToolContext): GateResult {
  return config.searxng.enabled && !!config.searxng.baseUrl
    ? ALLOW
    : { allowed: false, reason: 'web search disabled (SEARXNG_ENABLED=false or SEARXNG_BASE_URL unset)' };
}
function gateHermes(ctx: ToolContext): GateResult {
  const agent = ctx.agentId ? getAgentById(ctx.agentId) : null;
  if ((agent?.spawn_depth ?? 0) >= 3) {
    return { allowed: false, reason: 'hermes media tools not available at spawn depth >= 3' };
  }
  return ALLOW;
}

// ── Sub-agent tool lockdown gate ──────────────────────────────────────────
// See specs/sub-agent-tool-lockdown.md Fix 2.
// Returns true if the tool should be blocked in a sub-agent context.
// Top-level agents (spawnDepth 0) are never affected.
export function isToolBlockedForSubAgent(
  toolName: string,
  ctx: ToolContext,
  allowedOverrides?: string[],
): boolean {
  if ((ctx.spawnDepth ?? 0) < 1) return false; // top-level — no restriction
  if (allowedOverrides?.includes(toolName)) return false; // parent explicitly permitted
  // Prefix guards on the broadened sub-agent surface: agent-to-agent delegation
  // (fan-out / recursion risk) and Composio external side effects are off by
  // default. MCP research tools (mcp__server__tool) are intentionally NOT
  // blocked here — sub-agents should reach them.
  if (config.subAgent.blockAgentDelegation && toolName.startsWith('agent__')) return true;
  if (config.subAgent.blockComposio && toolName.startsWith('COMPOSIO_')) return true;
  return config.subAgent.blockedTools.includes(toolName);
}

// Tools that recursively run another agent through alfred.chatStream require
// dynamic import to avoid the registry → alfred → registry circular dep.
async function runAgentTurn(
  message: string,
  recipient: AgentRecord,
  sessionLabel: string,
  runId?: string | null,
  source: string = 'unknown',
): Promise<{ sessionId: string; response: string }> {
  const { chatStream } = await import('../agent/alfred');
  const sessId = createSession(recipient.id, sessionLabel, source);
  let response = '';
  await chatStream(
    message,
    sessId,
    (c) => { response += c; },
    recipient.system_prompt ?? '',
    recipient.id,
    undefined,
    undefined,
    undefined,
    runId ?? undefined,
  );
  // chatStream already saves both the user and assistant messages internally;
  // a second saveMessage here would double-write every agent-to-agent response.
  return { sessionId: sessId, response };
}

// ── Image-wrapper delivery helper ───────────────────────────────────────────
// The curated image wrappers (gpt_image_*, grok_image_*, gemini_image_*) proxy
// to their MCP server via callRegisteredTool. Those servers save the result to
// disk and return a "path: /abs/...\ndescription: ..." text blob. Best-effort:
// if the path is locally readable, deliver it inline via send_image_to_user
// (same UX as abacus_image); otherwise return the raw text so the agent can
// reference the path itself. Never throws into the tool loop.
async function proxyMcpImageTool(
  server: string,
  remoteTool: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
  alt: string,
): Promise<unknown> {
  let raw: unknown;
  try {
    raw = await callRegisteredTool(server, remoteTool, input);
  } catch (err) {
    return { ok: false, error: `${server}/${remoteTool} failed: ${(err as Error).message}` };
  }

  // Flatten the MCP content array to text.
  let text = '';
  if (raw && typeof raw === 'object' && Array.isArray((raw as { content?: unknown[] }).content)) {
    text = ((raw as { content: Array<{ type?: string; text?: string }> }).content)
      .map(c => (c?.type === 'text' ? c.text ?? '' : ''))
      .join('\n')
      .trim();
  } else if (typeof raw === 'string') {
    text = raw.trim();
  }

  // An MCP-level error envelope (isError) — surface it.
  if (raw && typeof raw === 'object' && (raw as { isError?: boolean }).isError) {
    return { ok: false, error: text || `${server}/${remoteTool} returned an error` };
  }

  // Try to extract a local file path and deliver inline.
  const m = text.match(/path:\s*(\S+)/i);
  const filePath = m?.[1];
  if (filePath && fs.existsSync(filePath)) {
    try {
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif'
        : 'image/png';
      const sendTool = registry.find(t => t.name === 'send_image_to_user');
      if (sendTool) {
        const res = await sendTool.handler(
          { base64: buf.toString('base64'), mime_type: mime, alt },
          ctx,
        );
        if ((res as { ok?: boolean }).ok) {
          logHive('tool_result', `${server}/${remoteTool}: delivered inline`, ctx.agentId ?? undefined, { server, remoteTool }, ctx.runId ?? undefined, ctx.sessionId ?? undefined);
          return { ok: true, source: `${server}/${remoteTool}`, url: (res as { url: string }).url,
            instructions: 'Image already delivered inline. Reference it in your reply.' };
        }
      }
    } catch { /* fall through to raw text */ }
  }

  // Path not locally readable (sidecar on another host) — return the raw result.
  return { ok: true, source: `${server}/${remoteTool}`, result: text || raw,
    instructions: 'If a file path was returned, it lives on the image sidecar; use send_image_to_user with a URL/base64 if you need it inline.' };
}

// ── The registry ──────────────────────────────────────────────────────────

export const registry: ToolDef[] = [
  // ── external surface ─────────────────────────────────────────────────────
  {
    name:            'ask_alfred',
    core:            true,
    externalSurface: true,
    description:     'Send a message to the NeuroClaw agent team and get a response. Alfred (the orchestrator) receives the message, routes it to the right specialist if needed, and returns the full response. Use this as the primary way to interact with NeuroClaw from an external client.',
    schema:          z.object({
      message:    z.string().describe('The message or question to send to the agent team.'),
      agent_name: z.string().optional().describe("Route directly to a named agent instead of Alfred. Must match the agent's name exactly (case-insensitive)."),
      session_id: z.string().optional().describe('Continue an existing conversation session. Omit to start a fresh session.'),
    }),
    shape: {
      message:    z.string().describe('The message or question to send to the agent team.'),
      agent_name: z.string().optional().describe("Route directly to a named agent instead of Alfred. Must match the agent's name exactly (case-insensitive)."),
      session_id: z.string().optional().describe('Continue an existing conversation session. Omit to start a fresh session.'),
    },
    handler: async (args, _ctx) => {
      const { chatStream }                    = await import('../agent/alfred');
      const { createSession, getAgentByName } = await import('../db');

      const targetAgent = args.agent_name
        ? getAgentByName(args.agent_name)
        : getAgentByName('Alfred');

      const agentId   = targetAgent?.id ?? null;
      const sysPrompt = targetAgent?.system_prompt ?? 'You are a helpful AI assistant.';
      const sessionId = args.session_id ?? createSession(agentId ?? '', 'mcp-external', 'unknown');

      let response = '';
      await chatStream(
        args.message,
        sessionId,
        (chunk) => { response += chunk; },
        sysPrompt,
        agentId ?? undefined,
      );

      return { response, session_id: sessionId, agent: targetAgent?.name ?? 'Alfred' };
    },
  },
  // ── memory / vault ───────────────────────────────────────────────────────
  {
    name:            'search_memory',
    core:            true,
    externalSurface: true,
    description: 'Search across memory_index + NeuroVault. Returns categorized hits ranked by salience, importance, recency. Call this BEFORE answering when the user references prior work or expects continuity.',
    schema:      S.searchMemorySchema,
    shape:       S.searchMemoryShape,
    gate:        gateMcp,
    handler: async (args, ctx) =>
      searchMemoryTool({ query: args.query, limit: args.limit, agentId: ctx.agentId ?? null }),
  },
  {
    name:        'write_vault_note',
    core:        true,
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

  // ── knowledge base (Supabase RAG) ────────────────────────────────────────
  {
    name:        'search_knowledge_base',
    core:        true,
    externalSurface: true,
    description: 'Semantic search over the crawled documentation knowledge base. Use BEFORE answering questions about external libraries/docs the team has indexed.',
    schema:      S.kbSearchSchema,
    shape:       S.kbSearchShape,
    gate:        gateKb,
    handler: async (args) => searchKnowledgeBase(args.query, { source: args.source, limit: args.limit }),
  },
  {
    name:        'search_code_examples',
    description: 'Semantic search over indexed code examples in the knowledge base.',
    schema:      S.kbSearchSchema,
    shape:       S.kbSearchShape,
    gate:        gateKb,
    handler: async (args) => searchCodeExamples(args.query, { source: args.source, limit: args.limit }),
  },
  {
    name:        'list_knowledge_sources',
    description: 'List the sources currently indexed in the knowledge base (source_id, title, summary).',
    schema:      S.kbListSourcesSchema,
    shape:       S.kbListSourcesShape,
    gate:        gateKb,
    handler: async () => listSources(),
  },
  {
    name:        'crawl_and_index',
    description: 'Crawl a URL with crawl4ai and index it into the knowledge base for future semantic search.',
    schema:      S.kbCrawlSchema,
    shape:       S.kbCrawlShape,
    gate:        gateKbWrite,
    handler: async (args, ctx) => crawlAndIndex({ url: args.url, deep: args.deep, callerAgentId: ctx.agentId ?? null }),
  },
  {
    name:        'index_content',
    description: 'Index raw text/markdown directly into the knowledge base (no crawl).',
    schema:      S.kbIndexContentSchema,
    shape:       S.kbIndexContentShape,
    gate:        gateKbWrite,
    handler: async (args, ctx) => ingestKbContent({
      text: args.text, sourceId: args.label, url: args.url ?? `manual://${args.label}`,
      title: args.label, callerAgentId: ctx.agentId ?? null, kind: 'page',
    }),
  },

  // ── agent comms / orchestration ──────────────────────────────────────────
  {
    name:        'message_agent',
    core:        true,
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

      // Synchronous delivery — mark delivered now so the recipient's own turn
      // does not also surface this message via its inbox (double-surfacing).
      if (msgRecord) markAgentMessagesDelivered([msgRecord.id]);

      await ctx.onMeta?.({ type: 'agent_message', fromName: senderName, toName: recipient.name, preview: args.message.slice(0, 80) });
      logHive('agent_message_sent', `registry: ${senderName} → ${recipient.name}: "${args.message.slice(0, 60)}"`, sender?.id, { toAgentId: recipient.id, preview: args.message.slice(0, 80) });

      try {
        const { sessionId, response } = await runAgentTurn(fullMessage, recipient, `Comms: ${senderName} → ${recipient.name}`, ctx.runId, 'comms');
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
    name:        'notify_user',
    core:        true,
    description: `Send a notification message directly to the human user (Oracle). Use this tool when you need to:
- Request approval before proceeding with a sensitive or irreversible action
- Ask the user a question that requires their input or decision
- Alert them to important issues, errors, or blockers that need attention
- Provide status updates on long-running tasks
- Reach the user when Discord or other channels are unavailable

This is the fallback channel to contact the user — use it proactively when you're blocked, need clarification, or require explicit approval. The user will see the notification in their dashboard's Comms → Notifications tab.`,
    schema:      S.notifyUserSchema,
    shape:       S.notifyUserShape,
    handler: async (args, ctx) => {
      const sender = ctx.agentId ? getAgentById(ctx.agentId) : undefined;
      const senderName = sender?.name ?? ctx.agentId ?? 'agent';
      const kind = args.kind ?? 'info';

      const metadata = args.context ? { context: args.context } : null;
      const msgRecord = createAgentUserMessage({
        fromAgentId: sender?.id ?? ctx.agentId ?? 'unknown',
        fromName: senderName,
        kind,
        body: args.message,
        metadata,
        sessionId: ctx.sessionId ?? null,
      });

      await ctx.onMeta?.({ type: 'agent_notified_user', fromName: senderName, kind, preview: args.message.slice(0, 80) });
      logHive('agent_notified_user', `registry: ${senderName} → User (${kind}): "${args.message.slice(0, 60)}"`, sender?.id, {
        notificationId: msgRecord.id,
        kind,
        preview: args.message.slice(0, 80),
      });

      return { ok: true, notification_id: msgRecord.id, kind, delivered: true };
    },
  },
  {
    name:        'send_image_to_user',
    core:        true,
    description: `Display an image inline in the current chat reply to the human user.

Use this tool when:
- You produced an image via another tool (e.g. browserless_screenshot returned base64) and want the user to actually see it in the chat bubble.
- You want to reference an existing remote image by URL so it renders inline.
- A visual is genuinely more useful than describing the image in text.

Provide EITHER \`base64\` (raw base64, no data: prefix) WITH a matching \`mime_type\`, OR a remote \`url\` — never both. Always include \`alt\` for accessibility. The image renders live in the dashboard chat AND chat-mode bubbles, and is persisted as a markdown image tag in the saved message so it survives reload. Returns the public URL of the rendered image.`,
    schema:      S.sendImageToUserSchema,
    shape:       S.sendImageToUserShape,
    handler: async (args, ctx) => {
      try {
        const hasBase64 = !!args.base64 && args.base64.length > 0;
        const hasUrl    = !!args.url    && args.url.length > 0;
        if (hasBase64 === hasUrl) {
          return { ok: false, error: 'Provide exactly one of base64 or url (not both, not neither).' };
        }

        let publicUrl: string;
        let mime: string;

        if (hasBase64) {
          mime = args.mime_type ?? 'image/png';
          const extFromMime: Record<string, string> = {
            'image/png':  'png',
            'image/jpeg': 'jpg',
            'image/gif':  'gif',
            'image/webp': 'webp',
          };
          const ext = extFromMime[mime] ?? 'png';

          // Strip an accidental data: prefix if the agent passed one anyway.
          const cleaned = args.base64!.replace(/^data:[^;]+;base64,/, '');
          let buf: Buffer;
          try {
            buf = Buffer.from(cleaned, 'base64');
          } catch {
            return { ok: false, error: 'Invalid base64 payload.' };
          }
          if (buf.length === 0) return { ok: false, error: 'Empty base64 payload after decode.' };
          if (buf.length > 25 * 1024 * 1024) return { ok: false, error: `Image too large (${buf.length} bytes, max 25 MB).` };

          const sessionDir = ctx.sessionId ?? 'orphan';
          // Sanity: session ids are uuid-like; still defang any path separators.
          const safeSession = sessionDir.replace(/[^a-zA-Z0-9._-]/g, '_');
          const filename    = `${Date.now()}-${randomUUID()}.${ext}`;
          const absDir      = path.resolve(process.cwd(), 'uploads', 'chat', safeSession);
          fs.mkdirSync(absDir, { recursive: true });
          const absPath = path.join(absDir, filename);
          fs.writeFileSync(absPath, buf);

          publicUrl = `/uploads/chat/${safeSession}/${filename}`;
          logger.info('send_image_to_user: wrote base64 image', {
            agentId: ctx.agentId, sessionId: ctx.sessionId, bytes: buf.length, mime, url: publicUrl,
          });
        } else {
          // URL passthrough — validate http(s) and accept as-is.
          try {
            const u = new URL(args.url!);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
              return { ok: false, error: `Only http(s) URLs are accepted (got ${u.protocol}).` };
            }
            publicUrl = u.toString();
          } catch {
            return { ok: false, error: 'Invalid url.' };
          }
          // Best-effort mime hint from extension.
          const extMime: Record<string, string> = {
            '.png':  'image/png',
            '.jpg':  'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif':  'image/gif',
            '.webp': 'image/webp',
          };
          const ext = path.extname(new URL(publicUrl).pathname).toLowerCase();
          mime = args.mime_type ?? extMime[ext] ?? 'image/*';
          logger.info('send_image_to_user: passthrough url', {
            agentId: ctx.agentId, sessionId: ctx.sessionId, url: publicUrl,
          });
        }

        const sender = ctx.agentId ? getAgentById(ctx.agentId) : undefined;
        const senderName = sender?.name ?? ctx.agentId ?? 'agent';
        const alt     = args.alt ?? 'image';
        const caption = args.caption ?? '';

        // Live SSE display — fires immediately, before the next LLM token.
        await ctx.onMeta?.({
          type: 'agent_image',
          fromName: senderName,
          url: publicUrl,
          alt,
          caption: caption || undefined,
          mime,
        });

        logHive('agent_image_sent', `registry: ${senderName} → User: image ${publicUrl}`, sender?.id, {
          url: publicUrl, mime, alt, hasCaption: !!caption,
        });

        // Returning the markdown tag in the tool result causes the LLM to
        // re-emit it in its assistant reply, which is what gets persisted to
        // messages.content. Both chat surfaces render markdown, so the image
        // survives reload without a new DB column.
        const safeAlt = alt.replace(/[\[\]]/g, '');
        const markdown = caption
          ? `![${safeAlt}](${publicUrl})\n*${caption}*`
          : `![${safeAlt}](${publicUrl})`;

        return {
          ok: true,
          url: publicUrl,
          mime,
          alt,
          caption: caption || null,
          markdown,
          instructions: 'Image has already been delivered to the user inline. Include the markdown verbatim in your text reply so it persists across reload.',
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('send_image_to_user failed', { error: msg });
        return { ok: false, error: msg };
      }
    },
  },
  {
    name:        'generate_image',
    description: `Generate an image using xAI Grok Imagine and display it inline in the chat.

Use this tool when:
- The user asks you to create, draw, generate, or visualize something.
- A visual would communicate better than text.

quality "standard" (default, ~5-10s): everyday generations. quality "hd" (~10-20s): detailed or high-fidelity requests.

Uses xAI credentials from ~/.hermes/auth.json (xai-oauth pool) or the XAI_API_KEY env var. No proxy required.`,
    schema: S.generateImageSchema,
    shape:  S.generateImageShape,
    gate:   gateHermes,
    handler: async (args, ctx) => {
      const prompt = (args.prompt ?? '').trim();
      if (!prompt) return { ok: false, error: 'prompt is required' };

      let result: { url: string };
      try {
        result = await generateImage(prompt, args.quality as 'standard' | 'hd' | undefined);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('connect ECONNREFUSED')) {
          return { ok: false, error: 'Hermes proxy not reachable — run: hermes proxy start --provider xai' };
        }
        return { ok: false, error: msg.slice(0, 240) };
      }

      // Delegate display to send_image_to_user, forwarding ctx for SSE delivery and message persistence.
      const sendTool = registry.find(t => t.name === 'send_image_to_user');
      if (!sendTool) return { ok: false, error: 'send_image_to_user tool not found in registry' };
      return sendTool.handler({ url: result.url, alt: prompt }, ctx);
    },
  },
  {
    name:        'generate_image_venice',
    description: `Generate an image using the Venice AI API and display it inline in the chat.

Use this tool when:
- The user asks you to generate, draw, or visualize something and you want to use Venice (no Hermes proxy required).
- The user explicitly asks for a Venice image.

Default model is flux-2-pro. Venice returns base64 which is saved to /uploads/chat/ and posted inline — the image appears in the chat bubble AND is delivered to Discord automatically.

Requires VENICE_API_KEY in .env.`,
    schema: S.generateImageVeniceSchema,
    shape:  S.generateImageVeniceShape,
    handler: async (args, ctx) => {
      const prompt = (args.prompt ?? '').trim();
      if (!prompt) return { ok: false, error: 'prompt is required' };

      if (!config.venice.enabled) {
        return { ok: false, error: 'VENICE_API_KEY is not configured. Set it in .env to use Venice image generation.' };
      }

      const model  = (args.model ?? 'flux-2-pro').trim();
      const width  = args.width  ?? 1024;
      const height = args.height ?? 1024;

      const reqBody: Record<string, unknown> = { model, prompt, width, height, safe_mode: false };
      if (args.negative_prompt?.trim()) {
        reqBody.negative_prompt = args.negative_prompt.trim();
      }

      let imageB64: string;
      try {
        const resp = await fetch('https://api.venice.ai/api/v1/image/generate', {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${config.venice.apiKey}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify(reqBody),
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          return { ok: false, error: `Venice API error ${resp.status}: ${errText.slice(0, 200)}` };
        }
        const json = await resp.json() as { images?: string[] };
        if (!json.images?.length || !json.images[0]) {
          return { ok: false, error: 'Venice API returned no images.' };
        }
        imageB64 = json.images[0];
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        return { ok: false, error: `Venice fetch failed: ${msg.slice(0, 200)}` };
      }

      // Delegate display + Discord delivery to send_image_to_user.
      const sendTool = registry.find(t => t.name === 'send_image_to_user');
      if (!sendTool) return { ok: false, error: 'send_image_to_user tool not found in registry' };
      return sendTool.handler({
        base64:    imageB64,
        mime_type: 'image/png',
        alt:       args.alt ?? prompt,
        caption:   args.caption,
      }, ctx);
    },
  },
  {
    name:        'gemini_web_generate_image',
    description: `Generate an image using Gemini Web (Imagen 3 / Nano Banana) and display it inline in chat.

⚠️ FALLBACK / SPECIALTY ONLY — this drives the Gemini web UI through a headless browser and REQUIRES a live, logged-in Google session (run gemini_import_cookies first); without one it hangs and times out. For everyday image generation prefer the direct-API tools that need no browser or web session: abacus_image (default), generate_image_venice, or generate_image. Use this tool ONLY when the user specifically asks for Gemini/Imagen/Nano-Banana output.

quality "standard" (default, ~30-45s). Returns the image inline in the current chat reply.`,
    schema: S.generateImageSchema,
    shape:  S.generateImageShape,
    gate:   gateHermes,
    handler: async (args, ctx) => {
      const prompt = (args.prompt ?? '').trim();
      if (!prompt) return { ok: false, error: 'prompt is required' };

      const GEMINI_WEB_URL = 'http://127.0.0.1:7111/mcp';

      // 1. Init MCP session
      let sessionId: string;
      try {
        const initRes = await fetch(GEMINI_WEB_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'neuroclaw', version: '1.0' } } }),
        });
        const sid = initRes.headers.get('mcp-session-id');
        if (!sid) return { ok: false, error: 'gemini-web-agent did not return a session ID — is it running?' };
        sessionId = sid;
      } catch {
        return { ok: false, error: 'gemini-web-agent not reachable on port 7111 — run: python -m gemini_web_agent.agent' };
      }

      // 2. Call gemini_generate_image (up to 90s — Gemini takes ~30-45s)
      let rawText: string;
      try {
        const callRes = await fetch(GEMINI_WEB_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'mcp-session-id': sessionId },
          body:    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gemini_generate_image', arguments: { prompt } } }),
          signal:  AbortSignal.timeout(90_000),
        });
        // SSE stream — read until we see the result event
        const text = await callRes.text();
        // Extract the last data: {...} line
        const lines = text.split('\n').filter(l => l.startsWith('data:'));
        const last  = lines.at(-1);
        if (!last) return { ok: false, error: 'No response from gemini-web-agent' };
        const payload = JSON.parse(last.slice(5).trim());
        const content = payload?.result?.content;
        rawText = Array.isArray(content)
          ? content.map((c: { text?: string }) => c.text ?? '').join('\n')
          : (payload?.result?.structuredContent?.result ?? '');
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (msg.includes('TimeoutError') || msg.includes('timeout')) {
          return { ok: false, error: 'Gemini image generation timed out after 90s — try again' };
        }
        return { ok: false, error: `gemini-web-agent call failed: ${msg.slice(0, 200)}` };
      }

      // 3. Parse "path: /abs/path/image.jpg" from the response
      if (rawText.startsWith('Error:')) return { ok: false, error: rawText };
      const pathMatch = /^path:\s*(.+?\.(png|jpg|jpeg|gif|webp))\s*$/im.exec(rawText);
      if (!pathMatch) return { ok: false, error: `Unexpected response: ${rawText.slice(0, 200)}` };
      const absPath = pathMatch[1].trim();

      // 4. Read file and encode as base64
      let base64: string;
      let mime: string;
      try {
        const buf  = fs.readFileSync(absPath);
        base64     = buf.toString('base64');
        const ext  = path.extname(absPath).slice(1).toLowerCase();
        mime       = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      } catch {
        return { ok: false, error: `Could not read generated image at ${absPath}` };
      }

      // 5. Delegate display to send_image_to_user (SSE + persistence)
      const sendTool = registry.find(t => t.name === 'send_image_to_user');
      if (!sendTool) return { ok: false, error: 'send_image_to_user tool not found' };
      return sendTool.handler({ base64, mime_type: mime, alt: prompt }, ctx);
    },
  },
  {
    name:        'generate_speech',
    description: `Synthesize text into speech using xAI TTS via the Hermes proxy.

Returns a URL to the generated .mp3 file. The URL is absolute and playable in a browser or Discord client. If DASHBOARD_PUBLIC_URL is not set, the URL defaults to http://localhost:<port> and will only work from the same machine.

Requires: hermes proxy running (hermes proxy start --provider xai).`,
    schema: S.generateSpeechSchema,
    shape:  S.generateSpeechShape,
    gate:   gateHermes,
    handler: async (args, ctx) => {
      const text = (args.text ?? '').trim();
      if (!text) return { ok: false, error: 'text is required' };

      let ttsResult: Awaited<ReturnType<typeof synthesize>>;
      try {
        ttsResult = await synthesize({
          provider: 'hermes',
          text,
          voiceId: args.voice?.trim() || undefined,
          agentName: undefined,
        });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('proxy not reachable')) {
          return { ok: false, error: 'Hermes proxy not reachable — run: hermes proxy start --provider xai' };
        }
        return { ok: false, error: msg.slice(0, 240) };
      }

      const tmpDir  = path.resolve(process.cwd(), 'tmp', 'audio');
      fs.mkdirSync(tmpDir, { recursive: true });
      const filename = `${randomUUID()}.mp3`;
      const absPath  = path.join(tmpDir, filename);
      try {
        fs.writeFileSync(absPath, ttsResult.buffer);
      } catch (err) {
        return { ok: false, error: `Failed to write audio file: ${(err as Error).message}` };
      }

      const audioUrl = `${config.dashboard.publicUrl}/api/audio/file/${filename}`;
      logHive('tool_result', `generate_speech: ${ttsResult.buffer.length}B → ${filename}`, ctx.agentId ?? undefined, { bytes: ttsResult.buffer.length }, ctx.runId ?? undefined, ctx.sessionId ?? undefined);
      return { ok: true, audio_url: audioUrl };
    },
  },
  {
    name:        'abacus_image',
    description: `PRIMARY image generator — generate, edit, or upscale an image using Abacus AI's media models and display it inline in chat. Prefer this for image requests: it's a direct API (no browser, no proxy, no web-session login), so it works reliably where the browser-driven web tools (gemini_web_generate_image, ChatGPT/Grok web agents) fail without a live session.

operation: "generate" (default, text→image), "edit" (transform input_image per the prompt), or "upscale" (enhance/re-render input_image at higher fidelity per the prompt). edit/upscale REQUIRE input_image (https URL or base64 data URL).

Default model per operation: generate→flux_pro, edit→flux_kontext_edit, upscale→flux_kontext_edit (the dedicated magnific upscaler is not invocable via the RouteLLM API). Browse models at GET /api/models?provider=abacus (media_type=image). Images are saved to /uploads/chat/ and posted inline (chat bubble + Discord). Metered in Abacus compute points (returned as compute_points_used) — image gen is not free, so don't loop it.

Requires ABACUS_API_KEY in .env.`,
    schema: S.abacusImageSchema,
    shape:  S.abacusImageShape,
    handler: async (args, ctx) => {
      const prompt = (args.prompt ?? '').trim();
      if (!prompt) return { ok: false, error: 'prompt is required' };
      if (!config.abacus.enabled) return { ok: false, error: 'ABACUS_API_KEY is not configured. Set it in .env to use Abacus media tools.' };

      const operation = args.operation ?? 'generate';
      if ((operation === 'edit' || operation === 'upscale') && !args.input_image?.trim()) {
        return { ok: false, error: `operation "${operation}" requires input_image (an https URL or base64 data URL).` };
      }
      const defaults: Record<string, string> = { generate: 'flux_pro', edit: 'flux_kontext_edit', upscale: 'flux_kontext_edit' };
      const model = (args.model ?? defaults[operation]).trim();

      const imageConfig: Record<string, unknown> = {};
      if (operation === 'generate') imageConfig.num_images = args.num_images ?? 1;
      if (args.aspect_ratio?.trim()) imageConfig.aspect_ratio = args.aspect_ratio.trim();
      if (args.resolution?.trim())   imageConfig.resolution   = args.resolution.trim();

      let media: Awaited<ReturnType<typeof generateAbacusMedia>>;
      try {
        media = await generateAbacusMedia({
          model, prompt, modalities: ['image'],
          imageConfig,
          inputImage: args.input_image?.trim() || undefined,
        });
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }

      const sendTool = registry.find(t => t.name === 'send_image_to_user');
      if (!sendTool) return { ok: false, error: 'send_image_to_user tool not found in registry' };

      const delivered: string[] = [];
      for (const item of media.items) {
        const res = await sendTool.handler(
          item.base64
            ? { base64: item.base64, mime_type: item.mime, alt: args.alt ?? prompt, caption: args.caption }
            : { url: item.url, mime_type: item.mime, alt: args.alt ?? prompt, caption: args.caption },
          ctx,
        );
        if ((res as { ok: boolean }).ok) delivered.push((res as { url: string }).url);
      }
      logHive('tool_result', `abacus_image[${operation}] ${model}: ${delivered.length} img, ${media.computePoints} pts`, ctx.agentId ?? undefined, { model, operation, computePoints: media.computePoints }, ctx.runId ?? undefined, ctx.sessionId ?? undefined);
      if (delivered.length === 0) return { ok: false, error: 'Abacus produced media but delivery failed.' };
      return {
        ok: true,
        model,
        operation,
        urls: delivered,
        compute_points_used: media.computePoints,
        instructions: 'Image(s) already delivered inline. Reference them in your reply; the markdown was returned by send_image_to_user.',
      };
    },
  },
  {
    name:        'voidai_image',
    description: `Generate or edit an image via VoidAI's direct API using Gemini "Nano-Banana" (default model gemini-3.1-flash-image) and display it inline in chat.

operation: "generate" (default, text→image) or "edit" (transform input_image per the prompt). edit REQUIRES input_image (an https URL or base64 data URL).

Direct API — no browser and no logged-in web session — so it works reliably where the browser-driven gemini_web_generate_image / gemini_image_generate tools fail. Prefer it (or abacus_image) over those web tools for Gemini/Nano-Banana output. Params: aspect_ratio (default "1:1"), resolution (STANDARD/2K/4K). Images are posted inline (chat bubble + Discord).

Requires VOIDAI_API_KEY in .env.`,
    schema: S.voidaiImageSchema,
    shape:  S.voidaiImageShape,
    handler: async (args, ctx) => {
      const prompt = (args.prompt ?? '').trim();
      if (!prompt) return { ok: false, error: 'prompt is required' };
      if (!config.voidai.apiKey) return { ok: false, error: 'VOIDAI_API_KEY is not configured. Set it in .env to use voidai_image.' };

      const operation = args.operation ?? 'generate';
      if (operation === 'edit' && !args.input_image?.trim()) {
        return { ok: false, error: 'operation "edit" requires input_image (an https URL or base64 data URL).' };
      }

      let result: Awaited<ReturnType<typeof generateVoidaiImage>>;
      try {
        result = await generateVoidaiImage({
          operation,
          prompt,
          inputImage:  args.input_image?.trim() || undefined,
          aspectRatio: args.aspect_ratio?.trim() || undefined,
          resolution:  args.resolution,
          model:       args.model?.trim() || undefined,
        });
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }

      const sendTool = registry.find(t => t.name === 'send_image_to_user');
      if (!sendTool) return { ok: false, error: 'send_image_to_user tool not found in registry' };

      // Coerce the returned mime to the enum send_image_to_user accepts.
      const allowedMimes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
      const normalizeMime = (m: string): string => {
        const lower = (m || '').toLowerCase();
        if (lower === 'image/jpg') return 'image/jpeg';
        return allowedMimes.has(lower) ? lower : 'image/png';
      };

      const delivered: string[] = [];
      for (const item of result.items) {
        const res = await sendTool.handler(
          { base64: item.base64, mime_type: normalizeMime(item.mime), alt: args.alt ?? prompt, caption: args.caption },
          ctx,
        );
        if ((res as { ok: boolean }).ok) delivered.push((res as { url: string }).url);
      }
      logHive('tool_result', `voidai_image[${operation}] ${result.model}: ${delivered.length} img`, ctx.agentId ?? undefined, { model: result.model, operation }, ctx.runId ?? undefined, ctx.sessionId ?? undefined);
      if (delivered.length === 0) return { ok: false, error: 'VoidAI produced image(s) but delivery failed.' };
      return {
        ok: true,
        model: result.model,
        operation,
        urls: delivered,
        usage: result.usage,
        instructions: 'Image(s) already delivered inline. Reference them in your reply; the markdown was returned by send_image_to_user.',
      };
    },
  },
  {
    name:        'voidai_gpt_image',
    description: `Generate or edit an image via VoidAI's direct API using OpenAI's gpt-image models (default gpt-image-2) and display it inline in chat.

operation: "generate" (default, text→image) or "edit" (transform input_image per the prompt). edit REQUIRES input_image (an https URL or base64 data URL) and accepts an optional mask for inpainting.

Direct API (OpenAI Images endpoints) — no browser or logged-in web session. gpt-image-2 has strong prompt adherence and legible text rendering but is slow (often 30-60s per image). Params: size (1024x1024 default, plus 1024x1536 / 1536x1024 / 512x512), model. For Gemini/Nano-Banana output use voidai_image instead. Images are posted inline (chat bubble + Discord).

Requires VOIDAI_API_KEY in .env.`,
    schema: S.voidaiGptImageSchema,
    shape:  S.voidaiGptImageShape,
    handler: async (args, ctx) => {
      const prompt = (args.prompt ?? '').trim();
      if (!prompt) return { ok: false, error: 'prompt is required' };
      if (!config.voidai.apiKey) return { ok: false, error: 'VOIDAI_API_KEY is not configured. Set it in .env to use voidai_gpt_image.' };

      const operation = args.operation ?? 'generate';
      if (operation === 'edit' && !args.input_image?.trim()) {
        return { ok: false, error: 'operation "edit" requires input_image (an https URL or base64 data URL).' };
      }

      let result: Awaited<ReturnType<typeof generateVoidaiGptImage>>;
      try {
        result = await generateVoidaiGptImage({
          operation,
          prompt,
          inputImage: args.input_image?.trim() || undefined,
          mask:       args.mask?.trim() || undefined,
          size:       args.size,
          model:      args.model?.trim() || undefined,
        });
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }

      const sendTool = registry.find(t => t.name === 'send_image_to_user');
      if (!sendTool) return { ok: false, error: 'send_image_to_user tool not found in registry' };

      const allowedMimes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
      const normalizeMime = (m: string): string => {
        const lower = (m || '').toLowerCase();
        if (lower === 'image/jpg') return 'image/jpeg';
        return allowedMimes.has(lower) ? lower : 'image/png';
      };

      const delivered: string[] = [];
      for (const item of result.items) {
        const res = await sendTool.handler(
          { base64: item.base64, mime_type: normalizeMime(item.mime), alt: args.alt ?? prompt, caption: args.caption },
          ctx,
        );
        if ((res as { ok: boolean }).ok) delivered.push((res as { url: string }).url);
      }
      logHive('tool_result', `voidai_gpt_image[${operation}] ${result.model}: ${delivered.length} img`, ctx.agentId ?? undefined, { model: result.model, operation }, ctx.runId ?? undefined, ctx.sessionId ?? undefined);
      if (delivered.length === 0) return { ok: false, error: 'VoidAI produced image(s) but delivery failed.' };
      return {
        ok: true,
        model: result.model,
        operation,
        urls: delivered,
        usage: result.usage,
        instructions: 'Image(s) already delivered inline. Reference them in your reply; the markdown was returned by send_image_to_user.',
      };
    },
  },
  {
    name:        'voidai_gemini_pro_image',
    description: `Generate or edit an image via VoidAI's direct API using Gemini 3 Pro (gemini-3-pro-image) — the higher-fidelity Gemini image model — and display it inline in chat.

operation: "generate" (default, text→image) or "edit" (transform input_image per the prompt). edit REQUIRES input_image (an https URL or base64 data URL).

Direct API — no browser or logged-in web session. Gemini Pro has stronger prompt adherence and finer detail than Nano-Banana (voidai_image / gemini-3.1-flash-image) but is slower; prefer it for hero art, fine detail, or 2K/4K output, and use voidai_image for fast/general images. Params: aspect_ratio (default "1:1"), resolution (STANDARD/2K/4K). Images are posted inline (chat bubble + Discord).

Requires VOIDAI_API_KEY in .env.`,
    schema: S.voidaiGeminiProImageSchema,
    shape:  S.voidaiGeminiProImageShape,
    handler: async (args, ctx) => {
      const prompt = (args.prompt ?? '').trim();
      if (!prompt) return { ok: false, error: 'prompt is required' };
      if (!config.voidai.apiKey) return { ok: false, error: 'VOIDAI_API_KEY is not configured. Set it in .env to use voidai_gemini_pro_image.' };

      const operation = args.operation ?? 'generate';
      if (operation === 'edit' && !args.input_image?.trim()) {
        return { ok: false, error: 'operation "edit" requires input_image (an https URL or base64 data URL).' };
      }

      let result: Awaited<ReturnType<typeof generateVoidaiImage>>;
      try {
        result = await generateVoidaiImage({
          operation,
          prompt,
          inputImage:  args.input_image?.trim() || undefined,
          aspectRatio: args.aspect_ratio?.trim() || undefined,
          resolution:  args.resolution,
          model:       'gemini-3-pro-image',
        });
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }

      const sendTool = registry.find(t => t.name === 'send_image_to_user');
      if (!sendTool) return { ok: false, error: 'send_image_to_user tool not found in registry' };

      const allowedMimes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
      const normalizeMime = (m: string): string => {
        const lower = (m || '').toLowerCase();
        if (lower === 'image/jpg') return 'image/jpeg';
        return allowedMimes.has(lower) ? lower : 'image/png';
      };

      const delivered: string[] = [];
      for (const item of result.items) {
        const res = await sendTool.handler(
          { base64: item.base64, mime_type: normalizeMime(item.mime), alt: args.alt ?? prompt, caption: args.caption },
          ctx,
        );
        if ((res as { ok: boolean }).ok) delivered.push((res as { url: string }).url);
      }
      logHive('tool_result', `voidai_gemini_pro_image[${operation}] ${result.model}: ${delivered.length} img`, ctx.agentId ?? undefined, { model: result.model, operation }, ctx.runId ?? undefined, ctx.sessionId ?? undefined);
      if (delivered.length === 0) return { ok: false, error: 'VoidAI produced image(s) but delivery failed.' };
      return {
        ok: true,
        model: result.model,
        operation,
        urls: delivered,
        usage: result.usage,
        instructions: 'Image(s) already delivered inline. Reference them in your reply; the markdown was returned by send_image_to_user.',
      };
    },
  },
  // ── Curated image wrappers (Option B, per-agent-image-tools-spec.md) ──────
  // First-class native ToolDefs proxying to the MCP image servers. core:false —
  // they ship upfront only for agents whose extra_core_tools allowlist includes
  // them; otherwise reachable via search_tools/call_tool like any registry tool.
  // NOTE: gpt_image / gemini_web / grok web sessions require a provisioned
  // browser cookie/X session to actually generate (see spec Non-Goals); the
  // wrapper is visible+callable regardless and returns a clear error if the
  // sidecar session is missing.
  {
    name:        'gpt_image_generate',
    description: 'Generate an image from a text prompt via ChatGPT (GPT image). Proxies to the gpt_image MCP server. Requires a provisioned ChatGPT browser session.',
    schema:      S.gptImageGenerateSchema,
    shape:       S.gptImageGenerateShape,
    handler: async (args, ctx) =>
      proxyMcpImageTool('gpt_image', 'chatgpt_image_generate',
        { prompt: args.prompt, ...(args.style ? { style: args.style } : {}) }, ctx, args.prompt),
  },
  {
    name:        'gpt_image_edit',
    description: 'Edit an existing image with a prompt via ChatGPT (GPT image). Proxies to the gpt_image MCP server. Requires a provisioned ChatGPT browser session.',
    schema:      S.gptImageEditSchema,
    shape:       S.gptImageEditShape,
    handler: async (args, ctx) =>
      proxyMcpImageTool('gpt_image', 'chatgpt_image_edit',
        { prompt: args.prompt, image_path: args.image_path }, ctx, args.prompt),
  },
  {
    name:        'grok_image_edit',
    description: 'Edit an image using a natural-language prompt via Grok vision + image generation. Proxies to the grok_image_edit MCP server (uses the logged-in X session).',
    schema:      S.grokImageEditSchema,
    shape:       S.grokImageEditShape,
    handler: async (args, ctx) =>
      proxyMcpImageTool('grok_image_edit', 'grok_image_edit',
        { prompt: args.prompt, image_path: args.image_path, ...(args.quality ? { quality: args.quality } : {}) }, ctx, args.prompt),
  },
  {
    name:        'grok_image_compose',
    description: 'Composite or blend multiple images guided by a prompt via Grok. Proxies to the grok_image_edit MCP server (uses the logged-in X session).',
    schema:      S.grokImageComposeSchema,
    shape:       S.grokImageComposeShape,
    handler: async (args, ctx) =>
      proxyMcpImageTool('grok_image_edit', 'grok_image_compose',
        { prompt: args.prompt, image_paths: args.image_paths, ...(args.quality ? { quality: args.quality } : {}) }, ctx, args.prompt),
  },
  {
    name:        'gemini_image_generate',
    description: 'Generate an image from a text prompt via Gemini web (Nano Banana / Imagen). Proxies to the gemini_web MCP server. Requires a provisioned Gemini browser session.',
    schema:      S.geminiImageGenerateSchema,
    shape:       S.geminiImageGenerateShape,
    handler: async (args, ctx) =>
      proxyMcpImageTool('gemini_web', 'gemini_generate_image',
        { prompt: args.prompt }, ctx, args.prompt),
  },
  {
    name:        'gemini_image_edit',
    description: 'Edit an existing image with a prompt via Gemini web. Proxies to the gemini_web MCP server. Requires a provisioned Gemini browser session.',
    schema:      S.geminiImageEditSchema,
    shape:       S.geminiImageEditShape,
    handler: async (args, ctx) =>
      proxyMcpImageTool('gemini_web', 'gemini_edit_image',
        { prompt: args.prompt, image_path: args.image_path }, ctx, args.prompt),
  },
  // NOTE: abacus_video was removed — Abacus's RouteLLM API only supports
  // text/image/audio modalities via /v1/chat/completions. Video model ids
  // (sora, veo3, kling_*) appear in /v1/models but are NOT invocable here
  // (the API 400s: "Must be one of the supported RouteLLM text/audio/image
  // generation models"). Re-add only if Abacus ships a real video endpoint.
  {
    name:        'abacus_speech',
    description: `Synthesize speech (text-to-speech) using Abacus AI's audio models and return a playable .mp3/.wav URL.

Default model is gemini-2.5-flash-preview-tts (verified). Others: gpt-audio-mini, gemini-2.5-pro-preview-tts. (Note: not every id in the model list is invocable — e.g. openai_tts/elevenlabs are rejected by the API.) voice is model-specific (omit for default). Returns an absolute audio URL playable in a browser or Discord. Metered in Abacus compute points (returned as compute_points_used).

Requires ABACUS_API_KEY in .env.`,
    schema: S.abacusSpeechSchema,
    shape:  S.abacusSpeechShape,
    handler: async (args, ctx) => {
      const text = (args.text ?? '').trim();
      if (!text) return { ok: false, error: 'text is required' };
      if (!config.abacus.enabled) return { ok: false, error: 'ABACUS_API_KEY is not configured. Set it in .env to use Abacus media tools.' };

      const model  = (args.model ?? 'gemini-2.5-flash-preview-tts').trim();
      const format = (args.format ?? 'mp3').trim();
      const audio: Record<string, unknown> = { format };
      if (args.voice?.trim()) audio.voice = args.voice.trim();

      let media: Awaited<ReturnType<typeof generateAbacusMedia>>;
      try {
        media = await generateAbacusMedia({ model, prompt: text, modalities: ['text', 'audio'], audio });
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }

      const item = media.items.find(i => i.mime.startsWith('audio/')) ?? media.items[0];
      if (!item?.base64 && !item?.url) return { ok: false, error: 'Abacus returned no audio.' };
      if (item.url) {
        logHive('tool_result', `abacus_speech ${model}: url, ${media.computePoints} pts`, ctx.agentId ?? undefined, { model, computePoints: media.computePoints }, ctx.runId ?? undefined, ctx.sessionId ?? undefined);
        return { ok: true, model, audio_url: item.url, compute_points_used: media.computePoints };
      }

      // Some TTS models (e.g. gemini-2.5-flash-preview-tts) return raw 16-bit PCM
      // (format "L16", 24 kHz mono) which no player understands without a WAV
      // container. Wrap it; pass mp3/wav/etc through untouched.
      let buf: Buffer = Buffer.from(item.base64!, 'base64');
      let ext: string;
      if (item.mime === 'audio/L16') {
        buf = pcmToWav(buf, 24000, 1, 16);
        ext = 'wav';
      } else {
        ext = item.mime === 'audio/mpeg' ? 'mp3' : item.mime === 'audio/wav' ? 'wav' : (item.mime.split('/')[1] || format);
      }
      const tmpDir = path.resolve(process.cwd(), 'tmp', 'audio');
      fs.mkdirSync(tmpDir, { recursive: true });
      const filename = `${randomUUID()}.${ext}`;
      fs.writeFileSync(path.join(tmpDir, filename), buf);
      const audioUrl = `${config.dashboard.publicUrl}/api/audio/file/${filename}`;
      logHive('tool_result', `abacus_speech ${model}: ${media.computePoints} pts → ${filename}`, ctx.agentId ?? undefined, { model, computePoints: media.computePoints }, ctx.runId ?? undefined, ctx.sessionId ?? undefined);
      return { ok: true, model, audio_url: audioUrl, compute_points_used: media.computePoints };
    },
  },
  {
    name:        'assign_task_to_agent',
    core:        true,
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
      logHive('agent_task_assigned', `registry: ${senderName} assigned task "${args.title}" to ${recipient.name}`, recipient.id, { taskId: task.id, executeNow: !!args.execute_now });
      taskEvents.emit('task_created', { taskId: task.id, title: task.title, toName: recipient.name, fromName: senderName, status: task.status });

      if (args.execute_now) {
        updateTask(task.id, { status: 'doing' });
        try {
          const taskMsg = args.description ? `${args.title}\n\n${args.description}` : args.title;
          const { response } = await runAgentTurn(taskMsg, recipient, `Task: ${args.title.slice(0, 50)}`, ctx.runId, 'agent_task');
          // No agent_messages record exists for assign_task_to_agent — result is
          // returned directly to the caller; do NOT call updateAgentMessageResponse
          // here because task.id will never match any agent_messages row.
          updateTask(task.id, { status: 'review' });
          return { ok: true, task_id: task.id, assigned_to: recipient.name, status: 'review', result: response };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const { bumpFailureCount } = await import('../db');
          bumpFailureCount(task.id);   // atomic +1 — never clobber a prior count
          updateTask(task.id, { status: 'failed', last_error: errMsg });
          return { ok: false, task_id: task.id, assigned_to: recipient.name, status: 'failed', error: errMsg };
        }
      }
      enqueueJob('agent_task', {
        taskId:          task.id,
        agentId:         recipient.id,
        agentName:       recipient.name,
        taskTitle:       args.title,
        taskDescription: args.description ?? '',
      } satisfies AgentTaskPayload);
      return { ok: true, task_id: task.id, assigned_to: recipient.name, status: 'queued', title: args.title };
    },
  },
  {
    name:        'autonomous_mode',
    core:        true,
    description: 'Start, stop, or check the autonomous Mission Control loop — it keeps pulling the next todo task off the board, runs each through the agent_task pipeline, and reports back when the board is empty or its budget is hit. Bounded by max tasks / time / failure-streak. Completed tasks are parked at "review".',
    schema:      S.autonomousModeSchema,
    shape:       S.autonomousModeShape,
    handler: async (args) => {
      const { startAutonomousLoop, stopAutonomousLoop, getAutonomousStatus } =
        await import('../system/autonomous-loop');
      if (args.action === 'stop') {
        const r = stopAutonomousLoop();
        return r.ok ? { ok: true, stopping: true } : { ok: false, error: 'no autonomous run is active' };
      }
      if (args.action === 'status') {
        return { ok: true, status: getAutonomousStatus() };
      }
      const r = startAutonomousLoop({
        maxTasks:         args.maxTasks,
        maxMinutes:       args.maxMinutes,
        defaultAgentName: args.defaultAgentName,
        triggeredBy:      'chat',
      });
      if (!r.ok) return { ok: false, error: r.reason === 'already_running' ? 'an autonomous run is already active' : (r.reason ?? 'failed to start') };
      return { ok: true, started: true, status: r.status };
    },
  },
  {
    name:            'list_agents',
    core:            true,
    externalSurface: true,
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
    core:        true,
    description: 'Create a temporary specialized sub-agent. Honors cascade-depth, spawn budget, SPAWN_AGENTS_ENABLED. Prefer message_agent / assign_task_to_agent on existing agents first.',
    schema:      S.spawnAgentSchema,
    shape:       S.spawnAgentShape,
    gate:        gateSpawn,
    handler: async (args, ctx) => {
      // Spawn evaluation — only spawn if no existing agent fits (skipped for exempt agents)
      const existing   = getAllAgents().filter(a => a.status === 'active' && !a.temporary);
      const callingAgent = ctx.agentId ? getAllAgents().find(a => a.id === ctx.agentId) : null;
      const isExempt   = !!(callingAgent?.spawn_exempt);
      const rtCfg      = getSpawnConfig();

      let evaluation: Awaited<ReturnType<typeof evaluateSpawn>>;
      if (isExempt) {
        evaluation = { shouldSpawn: true, reason: 'agent is spawn-exempt', expectedBenefit: 1 };
        logHive('spawn_evaluated', `registry: Spawn evaluation skipped for "${args.name}" (agent "${callingAgent?.name}" is exempt)`, ctx.agentId ?? undefined, evaluation);
      } else {
        evaluation = await evaluateSpawn(args.taskDescription ?? args.description, existing, rtCfg.evalThreshold);
        await ctx.onMeta?.({ type: 'spawn_eval', task: args.name, shouldSpawn: evaluation.shouldSpawn, benefit: evaluation.expectedBenefit, reason: evaluation.reason });
        logHive('spawn_evaluated', `registry: Spawn evaluation for "${args.name}": ${evaluation.shouldSpawn ? 'APPROVED' : 'DENIED'} (benefit ${evaluation.expectedBenefit}) — ${evaluation.reason}`, ctx.agentId ?? undefined, evaluation);
      }

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
        const spawnSessionId = createSession(spawned.id, `Spawn: ${spawned.name}`, 'spawn');
        await createBackgroundTask(taskId, spawned.id, spawned.name, spawnSessionId, args.taskDescription!);
        await ctx.onMeta?.({ type: 'spawn_started', agentName: spawned.name, taskId });

        const { enqueueJob } = await import('../db');
        enqueueJob('background_agent', {
          taskId,
          agentId:         spawned.id,
          agentName:       spawned.name,
          sessionId:       spawnSessionId,
          taskDescription: args.taskDescription!,
          systemPrompt:    spawned.system_prompt ?? '',
          runId:           ctx.runId ?? undefined,
        });
        logger.info('Background sub-agent enqueued', { taskId, agentName: spawned.name });

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

  // ── exec (gated per-agent) ──────────────────────────────────────────────
  // core:true so exec_enabled agents see these upfront on the OpenAI backbone /
  // Codex / in-process-MCP planes (none have native shell tools). The gateExec
  // filter in visibleCoreTools keeps them hidden from non-exec agents, so the
  // common-case tool payload stays small. (Claude agents also get the native
  // Bash/Read/Write/Edit built-ins via claude-cli.ts.)
  {
    name:        'bash_run',
    core:        true,
    description: 'Run a shell command on the host. Returns stdout, stderr, exit code, duration. Output is byte-capped; some destructive patterns are hard-blocked.',
    schema:      S.bashRunSchema,
    shape:       S.bashRunShape,
    gate:        gateExec,
    handler: async (args, ctx) =>
      bashRun({
        command:    args.command,
        cwd:        args.cwd,
        timeout_ms: args.timeout_ms,
        agentId:    ctx.agentId ?? undefined,
        sessionId:  ctx.sessionId ?? undefined,
        secrets:    args.secrets,
        purpose:    args.purpose,
      }),
  },
  {
    // Ungated by design — discovery is available to every agent. Secret NAMES
    // (never values) are not sensitive, and listAccessible() scopes per-agent.
    name:        'secrets_list',
    description: 'List the broker secrets you are scoped to — names and metadata only, never values. To use one, pass its name in the `secrets` argument of bash_run or run_skill_script; credential-aware tools resolve them for you automatically. You never see or handle the secret value. Optionally filter by service.',
    schema:      S.secretsListSchema,
    shape:       S.secretsListShape,
    handler: async (args, ctx) => {
      const metas = await listAccessible(ctx.agentId ?? null);
      const service = args.service?.trim().toUpperCase();
      const filtered = service ? metas.filter((m) => m.service === service) : metas;
      return { count: filtered.length, secrets: filtered };
    },
  },
  {
    name:        'fs_read',
    core:        true,
    description: 'Read the contents of a file on the host. Output is byte-capped; truncated if too large.',
    schema:      S.fsReadSchema,
    shape:       S.fsReadShape,
    gate:        gateExec,
    handler: async (args, ctx) => fsRead({ path: args.path, agentId: ctx.agentId ?? undefined, sessionId: ctx.sessionId ?? undefined }),
  },
  {
    name:        'fs_write',
    core:        true,
    description: 'Write to a file on the host. mode=overwrite (default), append, or create (fails if exists). Creates parent dirs.',
    schema:      S.fsWriteSchema,
    shape:       S.fsWriteShape,
    gate:        gateExec,
    handler: async (args, ctx) =>
      fsWrite({ path: args.path, content: args.content, mode: args.mode ?? 'overwrite', agentId: ctx.agentId ?? undefined, sessionId: ctx.sessionId ?? undefined }),
  },
  {
    name:        'fs_list',
    core:        true,
    description: 'List the contents of a directory.',
    schema:      S.fsListSchema,
    shape:       S.fsListShape,
    gate:        gateExec,
    handler: async (args, ctx) => fsList({ path: args.path, agentId: ctx.agentId ?? undefined, sessionId: ctx.sessionId ?? undefined }),
  },
  {
    name:        'fs_search',
    core:        true,
    description: 'Recursively search for a regex/pattern across files (uses ripgrep when available, else grep -rn).',
    schema:      S.fsSearchSchema,
    shape:       S.fsSearchShape,
    gate:        gateExec,
    handler: async (args, ctx) =>
      fsSearch({ pattern: args.pattern, path: args.path, max_results: args.max_results, agentId: ctx.agentId ?? undefined, sessionId: ctx.sessionId ?? undefined }),
  },

  // ── Session uploads (files the user sent from Discord / web GUI) ──────────
  {
    name:        'list_uploads',
    core:        true,
    description: 'List every file the user uploaded in this session (documents, images, audio, video, or other) — id, name, type, size, on-disk path, and any processing already done (parsed/transcribed/described). Use get_upload to open one, analyze_image to look at a picture, or get_attachment_parsed for a pre-parsed document.',
    schema:      S.listUploadsSchema,
    shape:       S.listUploadsShape,
    handler: async (_args, ctx) => {
      if (!ctx.sessionId) return { ok: true, count: 0, uploads: [] };
      const ups = listUploads(ctx.sessionId).map(u => ({
        id: u.id, name: u.name, kind: u.kind, mime: u.mime, size: u.size,
        path: u.path, processed: u.processed,
      }));
      return { ok: true, count: ups.length, uploads: ups };
    },
  },
  {
    name:        'get_upload',
    core:        true,
    description: 'Get one uploaded file by its id (from list_uploads). Returns its on-disk path inside your workspace plus metadata — read it with fs_read or bash_run. Large/binary files are returned by path only (never inlined).',
    schema:      S.getUploadSchema,
    shape:       S.getUploadShape,
    handler: async (args, ctx) => {
      if (!ctx.sessionId) return { ok: false, error: 'no session context' };
      const u = getUpload(ctx.sessionId, args.id);
      if (!u) return { ok: false, error: `no upload with id ${args.id}` };
      if (!u.path) return { ok: false, error: `upload was not stored: ${JSON.stringify(u.processed)}` };
      return { ok: true, id: u.id, name: u.name, kind: u.kind, mime: u.mime, size: u.size, path: u.path, processed: u.processed };
    },
  },
  {
    name:        'analyze_image',
    core:        true,
    description: 'Look at an uploaded image and describe it. Pass an image upload id from list_uploads and an optional question to focus on. Returns a text description from the vision model and caches it on the upload.',
    schema:      S.analyzeImageSchema,
    shape:       S.analyzeImageShape,
    handler: async (args, ctx) => {
      if (!ctx.sessionId) return { ok: false, error: 'no session context' };
      const u = getUpload(ctx.sessionId, args.id);
      if (!u) return { ok: false, error: `no upload with id ${args.id}` };
      if (u.kind !== 'image') return { ok: false, error: `upload ${args.id} is a ${u.kind}, not an image` };
      if (!u.path) return { ok: false, error: 'image was not stored on disk' };
      try {
        const bytes = await fspUploads.readFile(u.path);
        const mime  = u.mime || 'image/png';
        const dataUri = `data:${mime};base64,${bytes.toString('base64')}`;
        const desc = await describeImage(
          { url: dataUri, mime_type: mime, name: u.name },
          { userPrompt: args.question },
        );
        recordProcessing(ctx.sessionId, u.id, { vision_desc: desc });
        return { ok: true, id: u.id, name: u.name, description: desc };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
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
      const route = upsertDiscordRoute(args.bot_id, args.channel_id, agent.id, args.require_mention, args.auto_reply);
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
        auto_reply:      !!args.auto_reply,
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
      const wantVoid   = !args.provider || args.provider === 'voidai';
      const wantEleven = !args.provider || args.provider === 'elevenlabs';
      const wantKokoro = !args.provider || args.provider === 'kokoro';
      const elevenAvailable = config.audio.elevenlabs.enabled;
      const kokoroAvailable = config.audio.kokoro.enabled;
      const result: { voidai?: unknown; elevenlabs?: unknown; kokoro?: unknown; elevenlabs_available?: boolean; kokoro_available?: boolean; note?: string } = {};
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
      if (wantKokoro) {
        result.kokoro_available = kokoroAvailable;
        if (kokoroAvailable) {
          try { result.kokoro = await listKokoroVoices(); }
          catch (err) { result.kokoro = []; result.note = result.note ? `${result.note} Kokoro voices fetch failed: ${(err as Error).message}` : `Kokoro voices fetch failed: ${(err as Error).message}`; }
        } else {
          result.kokoro = [];
          if (!args.provider) {
            result.note = result.note ? `${result.note} Kokoro is not configured (set KOKORO_API_KEY in .env to enable).` : 'Kokoro is not configured (set KOKORO_API_KEY in .env to enable).';
          }
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
        kokoro_ready:     config.audio.kokoro.enabled,
        elevenlabs_ready: config.audio.elevenlabs.enabled,
        env_defaults: {
          voidai_voice: config.audio.voidai.ttsVoice,
          elevenlabs_default_voice_id: config.audio.elevenlabs.defaultVoiceId || null,
          kokoro_default_voice_id: config.audio.kokoro.defaultVoiceId || null,
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
        if (args.provider === 'kokoro' && !config.audio.kokoro.enabled) {
          return { ok: false, error: 'Kokoro is not configured — set KOKORO_API_KEY in .env or use provider=voidai.' };
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
    name:            'find_tasks',
    externalSurface: true,
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
        if (ctx.agentId && args.status) {
          logHive('task_self_updated', `agent set task "${existing.title}" → ${args.status}`, ctx.agentId, { taskId: existing.id, status: args.status });
        }
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
  {
    name:        'claim_next_task',
    description: 'Claim the next available task from the board for yourself: atomically pulls the highest-priority unclaimed (or already-yours) "todo" task, marks it "doing", and assigns it to you. Optional project_id / feature filters. Returns the task to work on, or {claimed:false} if the board is empty. When you finish, set the task to "review" via manage_task so it goes through review.',
    schema:      S.claimNextTaskSchema,
    shape:       S.claimNextTaskShape,
    handler: async (args, ctx) => {
      if (!ctx.agentId) return { ok: false, error: 'claim_next_task requires an agent context' };
      const { claimNextTaskForAgent } = await import('../db');
      const row = claimNextTaskForAgent(ctx.agentId, {
        projectId: args.project_id,
        feature:   args.feature,
        sessionId: ctx.sessionId ?? undefined,   // bind the live session for crash-resume
      });
      if (!row) return { ok: true, claimed: false, reason: 'board_empty' };
      logHive('task_claimed', `agent claimed task "${(row as { title?: string }).title ?? row.id}" off the board`, ctx.agentId, { taskId: (row as { id: string }).id });
      return { ok: true, claimed: true, task: serializeTask(row as unknown as AppTask) };
    },
  },

  // ── Skills v2: scripts + agent-authored skills ──────────────────────────
  // Available to every active agent. Path-traversal locked at the skill-loader
  // layer; the runtime is also no-shell (args go straight through to spawn)
  // so an attacker-controlled arg string can't inject more commands.
  {
    name:        'list_skills',
    description: 'List every skill registered on disk (project-local, user-global, installed skill packs, plugins, and marketplaces). Returns name, description, source, and the scripts each skill exposes. Pass include_body=true to also get the markdown body of each skill.',
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
    description: 'Execute a script bundled with a skill (under that skill\'s scripts/<file> folder). Interpreter is chosen by extension: .py → python3, .sh → bash, .js/.mjs/.cjs → node, .ts → tsx, otherwise the file itself (must be +x with a shebang). Stdin and timeout are capped. Sensitive env vars (API keys, tokens) are scrubbed before spawn. Use list_skills to discover what\'s available; use manage_skill_script to author new project-local scripts. Requires exec_enabled on the calling agent.',
    gate:        gateExec,
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
        sessionId:  ctx.sessionId ?? null,
        secrets:    args.secrets,
        purpose:    args.purpose,
      });
      logHive('skill_script_run', `registry: Skill "${args.skill_name}" ran ${args.script} (exit ${result.exit_code}, ${result.duration_ms}ms)`, ctx.agentId ?? undefined, { skill: args.skill_name, script: args.script, exit_code: result.exit_code, duration_ms: result.duration_ms, ok: result.ok });
      return result;
    },
  },
  {
    name:        'manage_skill',
    description: 'Create, update, or delete a skill end-to-end. action="create" requires name + body; description, triggers, tools, and scripts are optional. The skill is written to .claude/skills/<name>/SKILL.md (project-local) and is immediately available to every agent. Bundle scripts on create with scripts: [{filename, content}]. action="update" replaces only the fields you pass. action="delete" removes the entire folder. User-global skills (~/.claude/skills/) are read-only — only project skills can be edited or deleted. Requires exec_enabled on the calling agent.',
    gate:        gateExec,
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
          logHive('skill_created', `registry: Skill "${summary.name}" created with ${summary.scripts.length} script(s)`, ctx.agentId ?? undefined, { skill: summary.name, scripts: summary.scripts });
          await syncSkillExports();
          return { ok: true, skill: summary, message: `Skill "${summary.name}" created. Every agent now has it in their tool catalog (via list_skills + run_skill_script).` };
        }
        if (args.action === 'update') {
          const summary = updateSkill(args.name, {
            description: args.description,
            body:        args.body,
            triggers:    args.triggers,
            tools:       args.tools,
          });
          logHive('skill_updated', `registry: Skill "${summary.name}" updated`, ctx.agentId ?? undefined, { skill: summary.name });
          await syncSkillExports();
          return { ok: true, skill: summary };
        }
        if (args.action === 'delete') {
          deleteSkill(args.name);
          logHive('skill_deleted', `registry: Skill "${args.name}" deleted`, ctx.agentId ?? undefined, { skill: args.name });
          await syncSkillExports();
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
    description: 'Add, update, or delete a single script inside an existing skill\'s scripts/ folder. action="create" and "update" both call writeSkillScript (which overwrites if present) — the SKILL.md frontmatter\'s scripts: [...] list is updated automatically so the new file appears in every agent\'s prompt. Filename must be a single segment (no slashes), e.g. "extract.py". Requires exec_enabled on the calling agent.',
    gate:        gateExec,
    schema:      S.manageSkillScriptSchema,
    shape:       S.manageSkillScriptShape,
    handler: async (args, ctx) => {
      try {
        if (args.action === 'create' || args.action === 'update') {
          if (typeof args.content !== 'string') return { ok: false, error: 'content is required for create/update' };
          const result = writeSkillScript(args.skill_name, args.filename, args.content);
          logHive('skill_script_written', `registry: Script ${args.filename} written to skill "${args.skill_name}" (${result.bytes} bytes)`, ctx.agentId ?? undefined, { skill: args.skill_name, filename: args.filename, bytes: result.bytes });
          await syncSkillExports();
          return { ok: true, path: result.path, bytes: result.bytes };
        }
        if (args.action === 'delete') {
          deleteSkillScript(args.skill_name, args.filename);
          logHive('skill_script_deleted', `registry: Script ${args.filename} deleted from skill "${args.skill_name}"`, ctx.agentId ?? undefined, { skill: args.skill_name, filename: args.filename });
          await syncSkillExports();
          return { ok: true, deleted: args.filename };
        }
        return { ok: false, error: `unknown action "${args.action}"` };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  },

  // ── Web search (SearXNG metasearch) ──────────────────────────────────────
  {
    name:        'web_search',
    core:        true,
    description: 'Search the live web via the NeuroClaw SearXNG metasearch instance (aggregates Google, Bing, Brave, DuckDuckGo, Wikipedia, arXiv, GitHub, and more). Returns result list with {title, url, snippet, engine} plus instant answers when available. Use category="it" for programming/dev queries, "science" for academic papers, "news" with time_range="day" for current events. To read the full rendered content of a specific URL, use browserless_fetch instead.',
    schema:      S.webSearchSchema,
    shape:       S.webSearchShape,
    gate:        gateSearch,
    handler: async (args, ctx) => {
      const { baseUrl, timeoutMs, fallbackEngines } = config.searxng;
      const maxResults = args.max_results ?? 8;
      const category   = args.category ?? 'general';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doSearch = async (engines?: string): Promise<any> => {
        const params = new URLSearchParams({ q: args.query, format: 'json', categories: category });
        if (args.time_range) params.set('time_range', args.time_range);
        if (engines) params.set('engines', engines);
        const res = await fetch(`${baseUrl}/search?${params.toString()}`, {
          signal:  AbortSignal.timeout(timeoutMs),
          headers: { 'Accept': 'application/json' },
        });
        if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status}`);
        return res.json();
      };

      try {
        // Tier 0 (primary, when keyed): Brave Search API — an official JSON
        // endpoint that isn't bot-challenged from datacenter IPs, unlike the
        // SearXNG scraper engines below. Falls through to the SearXNG +
        // headless-browser ladder on error or empty result.
        if (config.brave.enabled && ['general', 'news', 'it', 'science'].includes(category)) {
          try {
            const braveRows = await braveSearch(args.query, { count: maxResults, timeRange: args.time_range });
            if (braveRows.length > 0) {
              logHive('web_search', `registry: web_search "${args.query.slice(0, 80)}"`, ctx.agentId ?? undefined, {
                query: args.query, category, count: braveRows.length, engine: 'brave-api',
              });
              return { ok: true, query: args.query, category, count: braveRows.length, results: braveRows };
            }
          } catch (err) {
            logger.warn('web_search: Brave primary failed, falling back to SearXNG', { error: (err as Error).message });
          }
        }

        let data = await doSearch();
        let usedFallback = false;
        // The default general engine set (brave/ddg/startpage/…) is frequently
        // blocked from datacenter IPs (CAPTCHA, timeouts). When general search
        // comes back empty, retry once pinned to known-reachable engines.
        if ((data.results?.length ?? 0) === 0 && category === 'general' && fallbackEngines) {
          data = await doSearch(fallbackEngines);
          usedFallback = true;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let results = (data.results ?? []).slice(0, maxResults).map((r: any) => ({
          title:   r.title ?? '',
          url:     r.url ?? '',
          snippet: typeof r.content === 'string' ? r.content.slice(0, 300) : '',
          engine:  r.engine ?? '',
          ...(r.publishedDate ? { published: r.publishedDate } : {}),
        }));

        // Final tier: when SearXNG's whole engine set is blocked (every engine
        // CAPTCHA'd/timed-out → 0 results), drive a real headless Chromium over
        // Bing's HTML results page, which is not bot-challenged from the same IP.
        // Only for general queries, and only when Browserless is configured.
        let usedBrowserFallback = false;
        if (results.length === 0 && category === 'general' && config.browser.enabled) {
          const browserRows = await bingSearchViaBrowser(args.query, maxResults);
          if (browserRows.length > 0) { results = browserRows; usedBrowserFallback = true; }
        }

        const out: Record<string, unknown> = { ok: true, query: args.query, category, count: results.length, results };
        if (Array.isArray(data.answers) && data.answers.length > 0)         out.answers     = data.answers.slice(0, 3);
        if (Array.isArray(data.suggestions) && data.suggestions.length > 0) out.suggestions = data.suggestions.slice(0, 5);
        if (usedBrowserFallback) out.note = 'SearXNG engines were all blocked; results come from Bing via headless browser';
        else if (usedFallback) out.note = `default engines returned nothing; retried with engines=${fallbackEngines}`;
        if (results.length === 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dead = (data.unresponsive_engines ?? []).map((e: any) => (Array.isArray(e) ? e.join(':') : String(e)));
          out.note = `no results${dead.length > 0 ? ` — unresponsive engines: ${dead.join(', ')}` : ''}. Try category="it"/"science"/"news", different keywords, or browserless_fetch on a known source URL.`;
        }

        logHive('web_search', `registry: web_search "${args.query.slice(0, 80)}"`, ctx.agentId ?? undefined, {
          query: args.query, category, count: results.length, usedFallback, usedBrowserFallback,
        });
        return out;
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  },

  // ── Browserless (hosted Chromium) ──────────────────────────────────────
  // Hosted Chromium over plain HTTP — no local Chrome, no Rust daemon. Enabled
  // by setting BROWSERLESS_URL + BROWSERLESS_TOKEN. Each handler gates on
  // config.browser.enabled, surfaces errors as {ok:false, error}, and logs to
  // hive_mind under the 'browser_action' action for observability.
  // IMPORTANT: these are NOT web search tools. Use for screenshots, rendered
  // HTML, PDFs, and DOM scraping — not for finding information via a search engine.
  {
    name:        'browserless_fetch',
    // core:true — surfaced upfront alongside web_search so every agent sees the
    // "open and read a specific URL" capability without needing search_tools to
    // discover it. Agents were falsely telling users "no browser tool available"
    // because this was discovery-only. gateBrowser still hides it when
    // Browserless is unconfigured (visibleCoreTools filters by gate).
    core:        true,
    description: 'Render a web page through a hosted Chromium (Browserless) and return the post-JS HTML. Use this — NOT web_search — when you need the actual rendered page content, article text, or a screenshot of a specific URL. Works for SPAs. Set include_main_text=true for article extraction via @mozilla/readability. Set include_screenshot=true for a base64 JPEG of the full page. NOTE: some sites (Cloudflare-protected wikis, aggressive bot-walls) block datacenter IPs and return a challenge/near-empty page — if the result looks like "Just a moment" or is suspiciously tiny, fall back to web_search snippets or perplexity_search for the data.',
    schema:      S.browserlessFetchSchema,
    shape:       S.browserlessFetchShape,
    gate:        gateBrowser,
    handler: async (args, ctx) => {
      try {
        const proxyAvailable = !!config.browser.proxyUrl;
        // A result is "blocked" if it's a recognizable bot-wall challenge page.
        // (We don't use a size heuristic: legit pages can be tiny, and the
        // datacenter-IP "bot-empty 200" pages a size check would catch are
        // fingerprint-blocked and don't clear via proxy anyway. Hard errors /
        // connection blocks throw and are handled by the empty-html path below.)
        const isBlocked = (h: string): boolean =>
          /just a moment|attention required|cf-browser-verification|enable javascript and cookies|verifying you are human/i.test(h);

        const fetchContent = async (useProxy: boolean): Promise<string> => {
          const body: Record<string, unknown> = {
            url:         args.url,
            gotoOptions: { waitUntil: 'networkidle2' },
          };
          if (args.wait_for !== undefined) body.waitFor = args.wait_for;
          // The residential proxy path is slow — give it a far longer ceiling.
          const timeoutMs = useProxy ? Math.max(config.browser.timeoutMs, 120_000) : undefined;
          const raw = await browserlessRequest('/content', body, { responseType: 'text', useProxy, timeoutMs });
          return typeof raw === 'string' ? raw : String(raw);
        };

        // 1) Direct fetch (fast). 2) If it's blocked or errors AND a residential
        //    proxy is configured, retry through it (residential egress beats the
        //    datacenter bot-walls). Keep whichever result is usable.
        let html = '';
        let usedProxy = false;
        let proxyNote: string | undefined;
        try {
          html = await fetchContent(false);
        } catch (err) {
          if (!proxyAvailable) throw err;   // no fallback to try
        }

        if (proxyAvailable && (html === '' || isBlocked(html))) {
          try {
            // Retry through the residential proxy, waiting out Cloudflare-style
            // JS interstitials (a plain /content fetch returns the challenge page
            // before it clears). Verified live: this reads Cloudflare-walled
            // Fandom and returns the real page.
            const viaProxy = await renderViaProxyClearingChallenge(args.url, Math.max(config.browser.timeoutMs, 120_000));
            if (viaProxy && !isBlocked(viaProxy)) {
              html = viaProxy; usedProxy = true;
              proxyNote = 'direct fetch was blocked; succeeded via residential proxy';
            } else if (!html && viaProxy) {
              html = viaProxy; usedProxy = true;
              proxyNote = 'page appears bot-walled — even the residential proxy did not clear it; use web_search/perplexity_search for the data';
            } else if (html) {
              proxyNote = 'page appears bot-walled — even the residential proxy did not clear it; use web_search/perplexity_search for the data';
            } else {
              proxyNote = 'both direct and proxy fetch returned nothing';
            }
          } catch (perr) {
            if (!html) throw perr;          // both paths failed → surface the error
            proxyNote = `proxy retry failed (${(perr as Error).message.slice(0, 80)}); returning the blocked direct result`;
          }
        }

        // Cap raw HTML to keep agent contexts sane (browserless can return MBs).
        const HTML_CAP = 500_000;
        let html_truncated = false;
        if (html.length > HTML_CAP) {
          html = html.slice(0, HTML_CAP);
          html_truncated = true;
        }

        const out: Record<string, unknown> = { ok: true, url: args.url, html, bytes: html.length, ...(usedProxy ? { via_proxy: true } : {}) };
        const notes: string[] = [];
        if (html_truncated) { out.html_truncated = true; notes.push(`HTML truncated to ${HTML_CAP} bytes (original was larger).`); }
        if (proxyNote) notes.push(proxyNote);
        if (notes.length) out.note = notes.join(' ');

        if (args.include_main_text) {
          try {
            const { JSDOM } = await import('jsdom');
            const { Readability } = await import('@mozilla/readability');
            const dom     = new JSDOM(html, { url: args.url });
            const reader  = new Readability(dom.window.document);
            const article = reader.parse();
            if (article) {
              out.title    = article.title;
              out.byline   = article.byline;
              out.length   = article.length;
              out.mainText = article.textContent;
            } else {
              out.readability_failed = true;
            }
          } catch (err) {
            out.readability_failed = true;
            out.readability_error  = (err as Error).message;
          }
        }

        if (args.include_screenshot) {
          try {
            const shotBuf = await browserlessRequest('/screenshot', {
              url:     args.url,
              options: { fullPage: true, type: 'jpeg', quality: 70 },
            }, { responseType: 'binary', useProxy: usedProxy, timeoutMs: usedProxy ? 120_000 : undefined }) as Buffer;
            out.screenshot = {
              base64: shotBuf.toString('base64'),
              bytes:  shotBuf.length,
              mime:   'image/jpeg',
            };
          } catch (err) {
            out.screenshot_error = (err as Error).message;
          }
        }

        logHive('browser_action', `registry: browser_fetch ${args.url}`, ctx.agentId ?? undefined, {
          tool: 'browser_fetch', url: args.url, html_bytes: html.length, html_truncated, via_proxy: usedProxy,
          included: { main_text: !!args.include_main_text, screenshot: !!args.include_screenshot },
        });
        return out;
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  },
  {
    name:        'browserless_screenshot',
    description: 'Capture a screenshot of any URL using hosted Chromium (Browserless). Returns {base64, bytes, mime} — feed base64 to a vision model or save it. Use this to visually inspect a page, verify UI state, or archive a web page as an image. Defaults to full-page PNG; pass full_page=false for viewport only, format="jpeg" for smaller files.',
    schema:      S.browserlessScreenshotSchema,
    shape:       S.browserlessScreenshotShape,
    gate:        gateBrowser,
    handler: async (args, ctx) => {
      try {
        const fmt: 'png' | 'jpeg' = args.format ?? 'png';
        const body: Record<string, unknown> = {
          url:     args.url,
          options: { fullPage: args.full_page ?? true, type: fmt },
        };
        if (args.viewport) body.viewport = args.viewport;

        const buf = await browserlessRequest('/screenshot', body, { responseType: 'binary' }) as Buffer;
        const mime = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';

        logHive('browser_action', `registry: browser_screenshot ${args.url}`, ctx.agentId ?? undefined, {
          tool: 'browser_screenshot', url: args.url, bytes: buf.length, format: fmt, full_page: args.full_page ?? true,
        });
        return { ok: true, url: args.url, base64: buf.toString('base64'), bytes: buf.length, mime };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  },
  {
    name:        'browserless_pdf',
    description: 'Render any URL to a PDF using hosted Chromium (Browserless). Returns {base64, bytes, mime:"application/pdf"}. Use for archiving articles, generating printable reports from web pages, or saving dashboards as PDFs. Defaults to A4 portrait with backgrounds.',
    schema:      S.browserlessPdfSchema,
    shape:       S.browserlessPdfShape,
    gate:        gateBrowser,
    handler: async (args, ctx) => {
      try {
        const buf = await browserlessRequest('/pdf', {
          url:     args.url,
          options: {
            format:          args.format ?? 'A4',
            landscape:       !!args.landscape,
            printBackground: true,
          },
        }, { responseType: 'binary' }) as Buffer;

        logHive('browser_action', `registry: browser_pdf ${args.url}`, ctx.agentId ?? undefined, {
          tool: 'browser_pdf', url: args.url, bytes: buf.length,
          format: args.format ?? 'A4', landscape: !!args.landscape,
        });
        return { ok: true, url: args.url, base64: buf.toString('base64'), bytes: buf.length, mime: 'application/pdf' };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  },
  {
    name:        'browserless_run_js',
    description: 'Run an arbitrary async Puppeteer script against a loaded page via Browserless. The page is navigated to `url` (waitUntil domcontentloaded), then `script` runs with `page` and `context` in scope. For content that loads late, `await page.waitForSelector(...)` inside your script. Use `await page.$eval(selector, el => el.innerText)` to extract DOM data, `return ...` to return JSON. Use when browserless_fetch + readability is not enough for complex site-specific scraping.',
    schema:      S.browserlessRunJsSchema,
    shape:       S.browserlessRunJsShape,
    gate:        gateBrowser,
    handler: async (args, ctx) => {
      try {
        // Browserless's /function endpoint runs the code as an ES module —
        // `module.exports` throws "module is not defined". Use `export default`.
        // `domcontentloaded` (not networkidle2) avoids hard timeouts on modern
        // sites that never go network-idle (ads/telemetry keep sockets open);
        // scripts that need late content should `await page.waitForSelector(...)`.
        const wrapped = `export default async function ({page, context}) {
  await page.goto(context.url, {waitUntil: 'domcontentloaded'});
  ${args.script}
}`;
        const resp = await browserlessRequest('/function', {
          code:    wrapped,
          context: { url: args.url },
        }, { responseType: 'json' });

        // Browserless /function returns either {data, type} or a bare value
        // depending on the version. Normalise both.
        let result: unknown = resp;
        if (resp && typeof resp === 'object' && !Array.isArray(resp) && 'data' in (resp as Record<string, unknown>)) {
          result = (resp as Record<string, unknown>).data;
        }

        logHive('browser_action', `registry: browser_run_js ${args.url}`, ctx.agentId ?? undefined, {
          tool: 'browser_run_js', url: args.url, script_chars: args.script.length,
        });
        const wantsValue = args.return_value !== false;
        return wantsValue
          ? { ok: true, url: args.url, result }
          : { ok: true, url: args.url };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  },

  // ── Automation: cron + webhooks ──────────────────────────────────────────
  {
    name:        'schedule_job',
    description: 'Create a scheduled automation job. Supports: agent_message (run an agent on a cron), outbound_webhook (POST to a URL), shell_command (run a shell command), n8n_workflow (trigger an n8n workflow), kestra_flow (trigger a Kestra flow). Logs to Hive Mind.',
    schema:      S.scheduleJobSchema,
    shape:       S.scheduleJobShape,
    handler: async (args, ctx) => {
      const { createCronJob } = await import('../db');
      const { syncJob }       = await import('../system/cron-scheduler');
      const { randomUUID }    = await import('crypto');
      const inbound_slug      = args.enable_inbound ? randomUUID() : null;
      const job = createCronJob({
        name: args.name, description: args.description ?? null,
        schedule: args.schedule ?? null, enabled: 1, job_type: args.job_type,
        config: args.config, inbound_slug,
        on_complete_webhook_url: args.on_complete_webhook_url ?? null,
        created_by: ctx.agentId ?? 'agent',
        last_run_at: null, next_run_at: null,
      });
      syncJob(job.id);
      logHive('cron_job_created', `registry: Agent scheduled job "${args.name}" (${args.job_type})`, ctx.agentId ?? undefined, { jobId: job.id });
      return { ok: true, jobId: job.id, inbound_slug: job.inbound_slug };
    },
  },
  {
    name:        'list_jobs',
    description: 'List all scheduled automation jobs, optionally filtered by type or enabled status.',
    schema:      S.listJobsSchema,
    shape:       S.listJobsShape,
    handler: async (args) => {
      const { listCronJobs } = await import('../db');
      return listCronJobs(args.type, args.enabled);
    },
  },
  {
    name:        'update_job',
    description: 'Update fields on an existing scheduled job. Changes take effect immediately (scheduler is resynced).',
    schema:      S.updateJobSchema,
    shape:       S.updateJobShape,
    handler: async (args, ctx) => {
      const { updateCronJob } = await import('../db');
      const { syncJob }       = await import('../system/cron-scheduler');
      const { job_id, ...fields } = args;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const patch: Record<string, any> = { ...fields };
      if (typeof fields.enabled === 'boolean') patch.enabled = fields.enabled ? 1 : 0;
      const updated = updateCronJob(job_id, patch);
      if (!updated) return { ok: false, error: 'job not found' };
      syncJob(job_id);
      logHive('cron_job_updated', `registry: Agent updated job "${updated.name}"`, ctx.agentId ?? undefined, { jobId: job_id });
      return { ok: true, job: updated };
    },
  },
  {
    name:        'delete_job',
    description: 'Delete a scheduled automation job. The job is immediately unregistered from the scheduler.',
    schema:      S.deleteJobSchema,
    shape:       S.deleteJobShape,
    handler: async (args, ctx) => {
      const { getCronJob, deleteCronJob } = await import('../db');
      const { syncJob }                   = await import('../system/cron-scheduler');
      const job = getCronJob(args.job_id);
      if (!job) return { ok: false, error: 'job not found' };
      deleteCronJob(args.job_id);
      syncJob(args.job_id);
      logHive('cron_job_deleted', `registry: Agent deleted job "${job.name}"`, ctx.agentId ?? undefined, { jobId: args.job_id });
      return { ok: true };
    },
  },
  {
    name:        'get_job_runs',
    description: 'Retrieve run history for a specific automation job, including output, status, and duration.',
    schema:      S.getJobRunsSchema,
    shape:       S.getJobRunsShape,
    handler: async (args) => {
      const { listCronRuns } = await import('../db');
      return listCronRuns(args.job_id, args.limit ?? 20);
    },
  },

  // ── LogAnalyst tools ──────────────────────────────────────────────────────
  {
    name:        'get_recent_errors',
    description: 'Get recent errors and warnings from NeuroClaw analytics. Returns up to 100 events.',
    schema:      S.getRecentErrorsSchema,
    shape:       S.getRecentErrorsShape,
    handler: async ({ hours = 24 }: { hours?: number }) => {
      const db = getDb();
      return db.prepare(`
        SELECT id, event_type,
          json_extract(data, '$.source') as source,
          COALESCE(json_extract(data, '$.message'), json_extract(data, '$.reason'), '') as message,
          COALESCE(json_extract(data, '$.level'), 'error') as level,
          created_at
        FROM analytics_events
        WHERE event_type IN ('log_error', 'server_error', 'discord_error')
          AND created_at >= datetime('now', '-' || ? || ' hours')
        ORDER BY created_at DESC LIMIT 100
      `).all(hours);
    },
  },
  {
    name:        'get_downtime_windows',
    description: 'Get detected downtime windows (heartbeat gaps, error spikes, discord offline, provider failures).',
    schema:      S.getDowntimeWindowsSchema,
    shape:       S.getDowntimeWindowsShape,
    handler: async ({ hours = 168 }: { hours?: number }) => {
      return getDowntimeEvents(Math.ceil(hours / 24));
    },
  },
  {
    name:        'search_log_lines',
    description: 'Search log lines by substring. Returns matching lines from logs/neuroclaw.log.',
    schema:      S.searchLogLinesSchema,
    shape:       S.searchLogLinesShape,
    handler: async ({ query, limit = 50 }: { query: string; limit?: number }) => {
      return readFilteredLogLines(limit, [], query);
    },
  },
  {
    name:        'get_error_timeline',
    description: 'Get hourly error counts for the past N hours.',
    schema:      S.getErrorTimelineSchema,
    shape:       S.getErrorTimelineShape,
    handler: async ({ hours = 24 }: { hours?: number }) => {
      const db = getDb();
      return db.prepare(`
        SELECT strftime('%Y-%m-%d %H:00', created_at) as hour, COUNT(*) as count
        FROM analytics_events
        WHERE event_type IN ('log_error', 'server_error', 'discord_error')
          AND created_at >= datetime('now', '-' || ? || ' hours')
        GROUP BY strftime('%Y-%m-%d %H:00', created_at)
        ORDER BY hour ASC
      `).all(hours);
    },
  },
  {
    name:        'run_workflow',
    description: 'Run a named YAML workflow. Returns the final run status and per-node outputs. If status is "paused", the workflow is awaiting approval — check run_id and action_required for resume instructions.',
    schema:      z.object({
      name:  z.string().describe('Workflow name, e.g. "code-review", "ship"'),
      input: z.string().optional().describe('Optional context string stored with the run record (not interpolated as $INPUT in workflow nodes)'),
    }),
    shape: {
      name:  z.string().describe('Workflow name, e.g. "code-review", "ship"'),
      input: z.string().optional().describe('Optional context string stored with the run record (not interpolated as $INPUT in workflow nodes)'),
    },
    handler: async (args: { name: string; input?: string }, _ctx) => {
      const { findWorkflow }    = await import('../workflows/discovery');
      const { executeWorkflow } = await import('../workflows/executor');
      const found = findWorkflow(args.name);
      if (!found) return { ok: false, error: `Workflow '${args.name}' not found. Use list_workflows to see available workflows.` };
      let run;
      try {
        run = await executeWorkflow(found.workflow, args.input ?? '');
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (run.status === 'paused') {
        return {
          status:          'paused',
          run_id:          run.id,
          paused_at_node:  run.paused_at_node,
          action_required: 'Workflow paused awaiting approval. Use /workflow approve or /workflow reject to resume.',
        };
      }
      let outputs: Record<string, { output: string; result?: unknown }>;
      try {
        outputs = JSON.parse(run.outputs) as Record<string, { output: string; result?: unknown }>;
      } catch {
        return { ok: false, error: 'Failed to parse workflow outputs from database.' };
      }
      const truncated = Object.fromEntries(
        Object.entries(outputs).map(([k, v]) => [k, { ...v, output: v.output.slice(0, 1000) }]),
      );
      return { status: run.status, run_id: run.id, outputs: truncated };
    },
  },
  {
    name:        'list_workflows',
    description: 'List all available YAML workflows with their names and descriptions.',
    schema:      z.object({}),
    shape:       {} as Record<string, never>,
    handler: async (_args, _ctx) => {
      const { discoverWorkflows } = await import('../workflows/discovery');
      const all = discoverWorkflows();
      return Array.from(all.values()).map(r => ({
        name:        r.workflow.name,
        description: r.workflow.description ?? '',
        source:      r.source,
      }));
    },
  },
  // ── n8n workflow management ─────────────────────────────────────────────
  {
    name:        'create_n8n_workflow',
    description: 'Create and activate a new n8n workflow from a JSON definition. Returns the created workflow id. Use list_n8n_workflows first to avoid duplicates.',
    schema: z.object({
      workflow_json: z.string().describe('Complete n8n workflow JSON as a string — must include name, nodes, and connections fields'),
      activate:      z.boolean().optional().describe('Activate immediately after creation (default true)'),
    }),
    shape: {
      workflow_json: z.string().describe('Complete n8n workflow JSON as a string — must include name, nodes, and connections fields'),
      activate:      z.boolean().optional().describe('Activate immediately after creation (default true)'),
    },
    handler: async (args, _ctx) => {
      const { resolveN8nConfig } = await import('../broker/bootstrap');
      const { baseUrl, apiKey } = await resolveN8nConfig();
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-N8N-API-KEY': apiKey };
      let workflow: unknown;
      try { workflow = JSON.parse(args.workflow_json); } catch { return { ok: false, error: 'workflow_json is not valid JSON' }; }
      const createResp = await fetch(`${baseUrl}/api/v1/workflows`, { method: 'POST', headers, body: JSON.stringify(workflow) });
      if (!createResp.ok) return { ok: false, error: `n8n create failed: ${createResp.status} ${await createResp.text()}` };
      const created = await createResp.json() as { id?: string; name?: string };
      const id = created.id;
      if (!id) return { ok: false, error: 'n8n did not return a workflow id' };
      if (args.activate !== false) {
        const actResp = await fetch(`${baseUrl}/api/v1/workflows/${id}/activate`, { method: 'POST', headers });
        if (!actResp.ok) return { ok: true, id, activated: false, warning: `created but activation failed: ${actResp.status}` };
      }
      return { ok: true, id, name: created.name, activated: args.activate !== false };
    },
  },
  {
    name:        'list_n8n_workflows',
    description: 'List all workflows in n8n — returns id, name, active status. Use before creating to avoid duplicates.',
    schema: z.object({
      active: z.boolean().optional().describe('Filter to only active or inactive workflows. Omit to return all.'),
    }),
    shape: {
      active: z.boolean().optional().describe('Filter to only active or inactive workflows. Omit to return all.'),
    },
    handler: async (args, _ctx) => {
      const { resolveN8nConfig } = await import('../broker/bootstrap');
      const { baseUrl, apiKey } = await resolveN8nConfig();
      const headers = { 'X-N8N-API-KEY': apiKey };
      const url = args.active !== undefined
        ? `${baseUrl}/api/v1/workflows?active=${args.active}`
        : `${baseUrl}/api/v1/workflows`;
      const resp = await fetch(url, { headers });
      if (!resp.ok) return { ok: false, error: `n8n list failed: ${resp.status}` };
      const data = await resp.json() as { data?: Array<{ id: string; name: string; active: boolean }> };
      return { ok: true, workflows: (data.data ?? []).map(w => ({ id: w.id, name: w.name, active: w.active })) };
    },
  },
  {
    name:        'get_n8n_workflow',
    description: 'Get the full JSON definition of an n8n workflow by id. Useful for inspecting or modifying an existing workflow.',
    schema: z.object({
      workflow_id: z.string().describe('n8n workflow id'),
    }),
    shape: {
      workflow_id: z.string().describe('n8n workflow id'),
    },
    handler: async (args, _ctx) => {
      const { resolveN8nConfig } = await import('../broker/bootstrap');
      const { baseUrl, apiKey } = await resolveN8nConfig();
      const headers = { 'X-N8N-API-KEY': apiKey };
      const resp = await fetch(`${baseUrl}/api/v1/workflows/${args.workflow_id}`, { headers });
      if (!resp.ok) return { ok: false, error: `n8n get failed: ${resp.status}` };
      return { ok: true, workflow: await resp.json() };
    },
  },
  {
    name:        'run_subtask',
    core:        true,
    description: 'Spawn a sub-agent for a discrete, independent task. CALL THIS in parallel (multiple times per turn) when your task has independent components across different domains. Sub-agents return structured output (JSON, diffs, summaries) — not prose. Only the primary agent may call this; sub-agents cannot spawn further sub-agents. AUTO-CONTINUATION: when the sub-agent(s) finish you are brought back automatically with the results (unless notify_policy is "never") — so end your turn telling the user you will report back, and never ask them to reply or check in to get the result.',
    schema: z.object({
      task:          z.string().describe('What the sub-agent should do — be specific and self-contained'),
      context:       z.string().describe('Relevant context the sub-agent needs (max ~2000 tokens). Do NOT paste the full conversation — summarize what matters.'),
      agent_name:    z.string().optional().describe('Optional specialist persona name for the sub-agent'),
      priority:      z.enum(['simple', 'complex', 'frontier']).optional().describe('Override automatic complexity triage'),
      notify_policy: z.enum(['done_only', 'all_updates', 'never']).optional().describe('Controls when proactive updates are delivered. done_only (default): notify on completion/failure/blocked only. all_updates: also notify on progress heartbeats. never: silent — result queryable only via get_subtask_result.'),
      allow_bash:    z.boolean().optional().describe('Set true to route this sub-agent through the shell-capable executor (supports git, npm, file writes). Off by default — sub-agents use Kimi K2.6/MiniMax and return output as text.'),
      kind:          z.enum(['code', 'prose']).optional().describe("Optional explicit routing hint. 'code' → Kimi K2.6 (coding model). 'prose' → MiniMax 2.7 (research/planning/writing). Omit to let the triage scorer decide based on task content."),
      force:         z.boolean().optional().describe('Bypass the duplicate-task guard and spawn even if an identical subtask recently ran in this session. Only set when the user explicitly wants a re-run.'),
    }),
    shape: {
      task:          z.string().describe('What the sub-agent should do — be specific and self-contained'),
      context:       z.string().describe('Relevant context the sub-agent needs (max ~2000 tokens). Do NOT paste the full conversation — summarize what matters.'),
      agent_name:    z.string().optional().describe('Optional specialist persona name for the sub-agent'),
      priority:      z.enum(['simple', 'complex', 'frontier']).optional().describe('Override automatic complexity triage'),
      notify_policy: z.enum(['done_only', 'all_updates', 'never']).optional().describe('Controls when proactive updates are delivered. done_only (default): notify on completion/failure/blocked only. all_updates: also notify on progress heartbeats. never: silent — result queryable only via get_subtask_result.'),
      allow_bash:    z.boolean().optional().describe('Set true to route this sub-agent through the shell-capable executor (supports git, npm, file writes). Off by default — sub-agents use Kimi K2.6/MiniMax and return output as text.'),
      kind:          z.enum(['code', 'prose']).optional().describe("Optional explicit routing hint. 'code' → Kimi K2.6 (coding model). 'prose' → MiniMax 2.7 (research/planning/writing). Omit to let the triage scorer decide based on task content."),
      force:         z.boolean().optional().describe('Bypass the duplicate-task guard and spawn even if an identical subtask recently ran in this session. Only set when the user explicitly wants a re-run.'),
    },
    gate: gateSubAgent,
    handler: async (args: { task: string; context: string; agent_name?: string; priority?: string; notify_policy?: string; allow_bash?: boolean; kind?: 'code' | 'prose'; force?: boolean }, ctx: ToolContext) => {
      // Dedup backstop: if an IDENTICAL task is already running in this session,
      // return that task instead of spawning a duplicate. Root cause it guards:
      // across turns (esp. Discord, where history is restored from DB as
      // user/assistant text only — tool results, and thus the taskId, are dropped)
      // a parent loses the taskId and re-spawns the same subtask every turn instead
      // of polling it. This makes that behavior return the existing task. Distinct
      // tasks (parallel subtasks in one turn) differ in text and are unaffected.
      if (ctx.sessionId && !args.force) {
        const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
        const active = getDb().prepare(
          `SELECT id, description, created_at FROM tasks
           WHERE session_id = ? AND task_source = 'subtask' AND status = 'doing'
           ORDER BY created_at DESC LIMIT 20`,
        ).all(ctx.sessionId) as Array<{ id: string; description: string | null; created_at: string }>;
        const dup = active.find(r => r.description && norm(r.description) === norm(args.task));
        if (dup) {
          return {
            ok:      true,
            taskId:  dup.id,
            status:  'running',
            message: `An identical subtask is already running in this session [task-id: ${dup.id}] — NOT spawning a duplicate. You'll be brought back automatically when it finishes; just tell the user it's still in progress and you'll report back. Do NOT ask them to reply or poll get_subtask_result in a loop.`,
          };
        }

        // Terminal dedup: an identical task that already FINISHED recently gets
        // its result returned instead of spawning again. This is the second half
        // of the repeat-loop guard — once a subtask completes, the 'doing' check
        // above no longer matches, so a parent that lost the taskId across turns
        // would re-spawn the same task on every user nudge ("did you finish?").
        // julianday() parses both timestamp formats in tasks as UTC, so the age
        // window is immune to the datetime('now') vs strftime-Z format mix.
        const recent = getDb().prepare(
          `SELECT id, description, status, output, terminal_outcome, block_reason,
                  CAST((julianday('now') - julianday(updated_at)) * 1440 AS INTEGER) AS minutes_ago
           FROM tasks
           WHERE session_id = ? AND task_source = 'subtask'
             AND status IN ('done', 'failed', 'blocked')
             AND (julianday('now') - julianday(updated_at)) * 1440 <= 30
           ORDER BY updated_at DESC LIMIT 20`,
        ).all(ctx.sessionId) as Array<{ id: string; description: string | null; status: string; output: string | null; terminal_outcome: string | null; block_reason: string | null; minutes_ago: number }>;
        const dupT = recent.find(r => r.description && norm(r.description) === norm(args.task));
        if (dupT) {
          const isBlocked = dupT.status === 'blocked' || (dupT.status === 'done' && dupT.terminal_outcome === 'blocked');
          if (dupT.status === 'done' && !isBlocked) {
            return {
              ok:      true,
              taskId:  dupT.id,
              status:  'done',
              result:  dupT.output ?? '',
              message: `An identical subtask already completed ${dupT.minutes_ago}m ago — returning its result instead of re-spawning. Use this result to answer NOW. Pass force: true only if the user explicitly asked to run it again.`,
            };
          }
          if (isBlocked) {
            return {
              ok:             true,
              taskId:         dupT.id,
              status:         'blocked',
              reason:         dupT.block_reason ?? 'Sub-agent returned progress-only output — no actionable result was produced',
              partial_output: dupT.output ?? '',
              message:        `An identical subtask finished ${dupT.minutes_ago}m ago but was blocked. Fix the blocker (e.g. allow_bash: true) or pass force: true to retry as-is.`,
            };
          }
          // status === 'failed' — only suppress rapid retries; allow a retry
          // after 10 minutes (transient provider failures are common).
          if (dupT.minutes_ago <= 10) {
            let errText = dupT.output ?? 'unknown error';
            try { errText = (JSON.parse(errText) as { error?: string }).error ?? errText; } catch { /* raw string */ }
            return {
              ok:      false,
              taskId:  dupT.id,
              status:  'failed',
              error:   errText,
              message: `An identical subtask failed ${dupT.minutes_ago}m ago. Change the approach (different task wording, allow_bash, kind) or pass force: true to retry the same task.`,
            };
          }
        }
      }
      const handle = runSubAgentAsync({
        task:                 args.task,
        context:              args.context,
        agentName:            args.agent_name,
        parentAgentId:        ctx.agentId,
        parentSessionId:      ctx.sessionId,
        priorityOverride:     args.priority,
        kind:                 args.kind,
        notifyPolicy:         args.notify_policy as TaskNotifyPolicy | undefined,
        allowedToolOverrides: args.allow_bash ? ['bash_run'] : undefined,
      });
      const SHELL_HINT_RE = /\b(?:curl|wget|git\s+(?:clone|push|pull|commit|log)|npm|pip|gh\s+run|fetch\s+logs?|ci\s+logs?|github\s+actions?|bash|shell|execute|docker|ssh|scp)\b/i;
      const shellWarning = !args.allow_bash && SHELL_HINT_RE.test(args.task)
        ? 'WARNING: This task appears to need shell/git access but allow_bash is not set. If the sub-agent returns blocked status, re-call run_subtask with allow_bash: true.'
        : undefined;
      // Auto-continuation: unless notify_policy is 'never', the system brings
      // this agent back automatically when the sub-agent(s) finish, with the
      // results in hand. The agent must NOT tell the user to reply/check back —
      // that's the behaviour that made reattach look broken and caused the
      // user's reply to race the auto-continuation.
      const autoContinue = (args.notify_policy ?? 'done_only') !== 'never';
      const guidance = autoContinue
        ? `You will be brought back AUTOMATICALLY with the result the moment the sub-agent finishes — you do NOT need the user to do anything. End your turn now by telling the user you'll report back as soon as it's done. Do NOT ask them to "reply", "check back", or "say anything", and do NOT poll get_subtask_result in a loop.`
        : `notify_policy is 'never' — you will NOT be auto-notified. Retrieve the result with get_subtask_result on a later turn.`;
      return {
        ok:       true,
        taskId:   handle.taskId,
        provider: handle.provider,
        model:    handle.model,
        message:  `SubAgent spawned [task-id: ${handle.taskId}] using ${handle.provider}/${handle.model}. ${guidance}`,
        ...(shellWarning ? { warning: shellWarning } : {}),
      };
    },
  },
  {
    name:        'get_subtask_result',
    core:        true,
    description: 'Retrieve the output of a previously spawned run_subtask call. You normally do NOT need to call this — when a sub-agent finishes you are brought back automatically with its result. Use this only to check a specific taskId on a later turn (never poll in a loop). Returns status: running | done | failed. If you have lost the taskId (e.g. after a restart), call list_my_subtasks first to recover it.',
    schema: z.object({
      task_id: z.string().describe('The taskId returned by a prior run_subtask call'),
    }),
    shape: {
      task_id: z.string().describe('The taskId returned by a prior run_subtask call'),
    },
    gate: gateSubAgent,
    handler: async (args: { task_id: string }) => {
      // Read status and output atomically in one query — never read output without
      // confirming status in the same statement (dirty-read guard).
      // The write side (resolveSubAgentTask / failSubAgentTask) writes status+output
      // in a single UPDATE statement, enforcing write-side atomicity.
      // If that write path ever expands beyond one UPDATE, wrap all statements in
      // BEGIN IMMEDIATE … COMMIT to preserve the invariant.
      const row = getDb().prepare(
        `SELECT status, output, terminal_outcome, block_reason FROM tasks WHERE id = ? AND status IN ('done', 'failed', 'doing', 'blocked', 'cancelled')`,
      ).get(args.task_id) as { status: string; output: string | null; terminal_outcome: string | null; block_reason: string | null } | undefined;

      if (!row) return { ok: false, error: 'task not found' };

      if (row.status === 'doing') {
        return {
          ok:      true,
          status:  'running',
          message: "Sub-agent still working. You'll be brought back automatically with the result when it finishes — do NOT poll in a loop and do NOT ask the user to reply. Just tell the user it's still in progress and you'll report back when it's done.",
        };
      }
      if (row.status === 'failed') {
        let error = row.output ?? 'unknown error';
        try { error = (JSON.parse(error) as { error?: string }).error ?? error; } catch { /* raw string */ }
        return { ok: false, status: 'failed', error };
      }
      if (row.status === 'blocked') {
        // Explicit blocked status: sub-agent wrote a block_reason to the row
        return {
          ok:             true,
          status:         'blocked',
          reason:         row.block_reason ?? 'Sub-agent did not produce usable output',
          partial_output: row.output ?? '',
        };
      }
      if (row.status === 'cancelled') {
        return {
          ok:     true,
          status: 'cancelled',
          reason: row.block_reason ?? 'Task was cancelled',
        };
      }
      // status === 'done'
      if (row.terminal_outcome === 'blocked') {
        // Finished with done status but classified as progress-only output
        return {
          ok:             true,
          status:         'blocked',
          reason:         row.block_reason ?? 'Sub-agent returned progress-only output — no actionable result was produced',
          partial_output: row.output ?? '',
        };
      }
      return { ok: true, status: 'done', result: row.output ?? '' };
    },
  },
  {
    name:        'list_my_subtasks',
    core:        true,
    description: 'List background subtasks spawned by run_subtask in this session. Use this when you have lost a task ID across turns or after a restart — it returns the taskId needed for get_subtask_result.',
    schema: z.object({
      status_filter: z.enum(['all', 'active', 'done']).optional().describe("Filter by status group: 'active' = currently running, 'done' = completed/failed/blocked, 'all' = everything (default: 'all')"),
    }),
    shape: {
      status_filter: z.enum(['all', 'active', 'done']).optional().describe("Filter by status group: 'active' = currently running, 'done' = completed/failed/blocked, 'all' = everything (default: 'all')"),
    },
    gate: (ctx: ToolContext): GateResult => {
      if (!ctx.sessionId) return { allowed: false, reason: 'list_my_subtasks requires a session context' };
      return ALLOW;
    },
    handler: async (args: { status_filter?: string }, ctx: ToolContext) => {
      const { getDb } = await import('../db');
      let statusClause: string;
      if (args.status_filter === 'active') {
        statusClause = `status IN ('doing')`;
      } else if (args.status_filter === 'done') {
        statusClause = `status IN ('done', 'failed', 'blocked', 'cancelled')`;
      } else {
        statusClause = `status IN ('doing', 'done', 'failed', 'blocked', 'cancelled')`;
      }
      const rows = getDb().prepare(
        `SELECT id, title, status, terminal_outcome, block_reason, output, created_at
         FROM tasks
         WHERE session_id = ? AND task_source = 'subtask' AND ${statusClause}
         ORDER BY created_at DESC
         LIMIT 20`,
      ).all(ctx.sessionId) as Array<{
        id: string; title: string; status: string;
        terminal_outcome: string | null; block_reason: string | null;
        output: string | null; created_at: string;
      }>;
      if (rows.length === 0) return { ok: true, tasks: [], message: 'No subtasks found for this session.' };
      const tasks = rows.map(r => ({
        taskId:  r.id,
        title:   r.title,
        status:  r.status,
        blocked: r.terminal_outcome === 'blocked' ? (r.block_reason ?? true) : undefined,
        summary: r.status === 'done' && r.output ? r.output.slice(0, 200) + (r.output.length > 200 ? '…' : '') : undefined,
        spawnedAt: r.created_at,
      }));
      return { ok: true, tasks };
    },
  },

  // ── chat attachments (PDF / DOCX / EPUB / HTML uploads) ──────────────────
  {
    name:        'get_attachment',
    core:        true,
    description: 'Retrieve a document the user uploaded in this chat session. Returns base64 + disk_path (if available). For SMALL files: forward base64 to mcp__docuflow__parse_document_base64. For LARGE files (>= 1 MB): use bash_run to POST the disk_path directly to the docuflow REST API — do NOT use base64 for large files as it will be truncated. Do NOT echo the raw base64 back to the user.',
    schema:      S.getAttachmentSchema,
    shape:       S.getAttachmentShape,
    handler: async (args, ctx) => {
      const { getAttachment } = await import('../system/attachment-registry');
      const LARGE_THRESHOLD = parseInt(process.env.DOCUFLOW_LARGE_FILE_THRESHOLD_BYTES ?? String(1 * 1024 * 1024), 10);
      const rec = getAttachment(args.id);
      if (!rec) return { ok: false, error: `no attachment with id "${args.id}" — it may have expired (30 min TTL) or never existed` };
      if (ctx.sessionId && rec.sessionId !== ctx.sessionId) {
        return { ok: false, error: 'attachment belongs to a different session' };
      }
      const isLarge = rec.size >= LARGE_THRESHOLD;
      return {
        ok:        true,
        id:        rec.id,
        name:      rec.name,
        mime:      rec.mime,
        size:      rec.size,
        isLarge,
        disk_path: rec.diskPath ?? null,
        // For large files, base64 will be truncated — use disk_path + REST API instead.
        // For small files, base64 is safe to forward to MCP tools.
        base64:    isLarge ? null : rec.base64,
        _hint:     isLarge
          ? `File is >= ${Math.round(LARGE_THRESHOLD / 1024)} KB — use bash_run to POST disk_path to ${process.env.DOCUFLOW_API_URL ?? 'https://docuflow-api.your-domain.com'}/parse instead of base64`
          : 'Forward base64 to mcp__docuflow__parse_document_base64',
      };
    },
  },
  {
    name:        'list_attachments',
    description: 'List all documents the user has uploaded in the current chat session (descriptors only — no base64). Useful when the agent loses track of which attachment_ids are available.',
    schema:      S.listAttachmentsSchema,
    shape:       S.listAttachmentsShape,
    handler: async (_args, ctx) => {
      const { listAttachments } = await import('../system/attachment-registry');
      if (!ctx.sessionId) return { ok: true, attachments: [] };
      return { ok: true, attachments: listAttachments(ctx.sessionId) };
    },
  },
  {
    name:        'get_attachment_parsed',
    core:        true,
    description: 'Retrieve pre-parsed text from a document the user uploaded. Returns the extracted title, markdown body, and stats from the docuflow parse — no base64 involved. Only works for documents marked "✓ pre-parsed" in the system context block. If the document was not pre-parsed (docuflow was unreachable at upload time), use get_attachment instead.',
    schema:      S.getAttachmentParsedSchema,
    shape:       S.getAttachmentParsedShape,
    handler: async (args, ctx) => {
      const { getAttachment } = await import('../system/attachment-registry');
      const rec = getAttachment(args.id);
      if (!rec) {
        return { ok: false, error: `no attachment with id "${args.id}" — it may have expired (30 min TTL) or never existed` };
      }
      if (ctx.sessionId && rec.sessionId !== ctx.sessionId) {
        return { ok: false, error: 'attachment belongs to a different session' };
      }
      if (rec.parseError) {
        return { ok: false, id: rec.id, name: rec.name, parseError: rec.parseError };
      }
      if (!rec.parsedContent) {
        return {
          ok:   false,
          id:   rec.id,
          name: rec.name,
          error: 'this attachment was not pre-parsed (docuflow may have been unreachable at upload time) — use get_attachment to retrieve base64 and forward to the docuflow MCP tool instead',
        };
      }
      return {
        ok:       true,
        id:       rec.id,
        name:     rec.name,
        mime:     rec.mime,
        size:     rec.size,
        title:    rec.parsedContent.title,
        markdown: rec.parsedContent.markdown,
        stats:    rec.parsedContent.stats,
      };
    },
  },
  {
    name:        'send_document',
    description: `Send a file from disk to the user as a downloadable attachment in dashboard chat and on Discord.
The file must already exist on disk — use fs_write to create it first if needed.
Supports any file type: markdown, PDF, CSV, JSON, txt, images, zip, etc.
Max size 25 MB. Returns an error string if the file is missing, too large, or not a regular file.`,
    schema:  S.sendDocumentSchema,
    shape:   S.sendDocumentShape,
    // send_document is a delivery tool, not a shell-exec tool — it should be
    // available to all agents just like send_image_to_user (which has no gate).
    handler: async (args: { path: string; caption?: string; filename?: string }, ctx: ToolContext) => {
      try {
        let stat: ReturnType<typeof fs.statSync>;
        try { stat = fs.statSync(args.path); } catch {
          return { ok: false, error: `File not found: ${args.path}` };
        }
        if (!stat.isFile()) {
          return { ok: false, error: `Path is not a regular file: ${args.path}` };
        }

        checkFsBoundary(path.resolve(args.path));

        if (stat.size > SEND_DOCUMENT_MAX_BYTES) {
          return { ok: false, error: `File too large: ${(stat.size / 1024 / 1024).toFixed(1)} MB (max 25 MB).` };
        }

        const rawName      = args.filename ?? path.basename(args.path);
        const safeFilename = rawName.replace(/[/\\<>:"|?*\x00-\x1f]/g, '_').slice(0, 200) || 'file';

        const sessionSlug = (ctx.sessionId ?? 'orphan').replace(/[^a-zA-Z0-9._-]/g, '_');
        const destDir     = path.resolve(process.cwd(), 'uploads', 'agent-files', sessionSlug);
        fs.mkdirSync(destDir, { recursive: true });
        const destFilename = `${randomUUID()}__${safeFilename}`;
        const destPath     = path.join(destDir, destFilename);
        fs.copyFileSync(args.path, destPath);

        const ext  = path.extname(safeFilename).toLowerCase();
        const mime = DOC_MIME_BY_EXT[ext] ?? 'application/octet-stream';

        const publicUrl = `/uploads/agent-files/${sessionSlug}/${destFilename}`;
        const sender    = ctx.agentId ? getAgentById(ctx.agentId) : undefined;
        const fromName  = sender?.name ?? ctx.agentId ?? 'agent';

        await ctx.onMeta?.({
          type:     'agent_file',
          fromName,
          url:      publicUrl,
          filename: safeFilename,
          mime,
          size:     stat.size,
          caption:  args.caption,
        });

        logger.info('send_document: staged and delivered', {
          agentId: ctx.agentId, sessionId: ctx.sessionId,
          src: args.path, dest: destPath, bytes: stat.size, mime,
        });
        logHive('agent_file_sent', `registry: ${fromName} sent file ${safeFilename} (${(stat.size / 1024).toFixed(1)} KB) to session ${ctx.sessionId ?? 'unknown'}`, ctx.agentId ?? undefined, { filename: safeFilename, mime, bytes: stat.size, sessionId: ctx.sessionId });

        return {
          ok:       true,
          url:      publicUrl,
          filename: safeFilename,
          mime,
          size:     stat.size,
          instructions: "File delivered to the user. Mention it in your reply (e.g. \"I\'ve sent you the report above.\").",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('send_document failed', { error: msg, path: args.path });
        return { ok: false, error: `Could not stage file: ${msg}` };
      }
    },
  },

  // ── agy webhook: respond tool ─────────────────────────────────────────────
  // agy calls this as its FINAL action each turn to deliver its completed
  // response back to NeuroClaw. The respondBus emits the content so the
  // waiting chatStreamAntigravityCli Promise resolves and streams it out.
  {
    name:            'respond',
    core:            true,
    externalSurface: true,
    description:     'Send your completed response back to NeuroClaw. ALWAYS call this as your final action each turn — pass your full answer as `content`. NeuroClaw will relay it to Discord and any waiting callers.',
    schema: z.object({
      content:    z.string().describe('Your complete response to the user\'s message.'),
      session_id: z.string().optional().describe('Session ID from the system prompt (if provided).'),
      run_id:     z.string().optional().describe('Run ID from the system prompt (if provided).'),
    }),
    shape: {
      content:    z.string().describe('Your complete response to the user\'s message.'),
      session_id: z.string().optional().describe('Session ID from the system prompt (if provided).'),
      run_id:     z.string().optional().describe('Run ID from the system prompt (if provided).'),
    },
    handler: async (args, ctx) => {
      const { emitRespond } = await import('../system/agy-respond-bus');
      const key = ctx.runId ?? (ctx.sessionId && ctx.agentId ? `${ctx.sessionId}::${ctx.agentId}` : null) ?? args.run_id ?? args.session_id ?? 'global';
      logHive('agy_respond', `respond: "${args.content.slice(0, 80)}"`, ctx.agentId ?? undefined, {
        preview:   args.content.slice(0, 400),
        sessionId: args.session_id ?? ctx.sessionId,
        runId:     args.run_id ?? ctx.runId,
      }, args.run_id ?? ctx.runId ?? undefined, args.session_id ?? ctx.sessionId ?? undefined);
      emitRespond(key, {
        content:   args.content,
        sessionId: args.session_id ?? ctx.sessionId ?? null,
        runId:     args.run_id ?? ctx.runId ?? null,
        agentId:   ctx.agentId ?? null,
      });
      return { ok: true, received: true };
    },
  },

  {
    name:            'generate_carbone_document',
    core:            false,
    externalSurface: true,
    description:     'Generate a structured document (PDF, DOCX, XLSX, ODT, ODS) by compiling dynamic data into an Office template (HTML or local path) using Carbone.io.',
    schema:          z.object({
      templateHtml: z.string().optional().describe('Raw HTML template content containing Carbone tags like {d.name}. Optional if templatePath is provided.'),
      templatePath: z.string().optional().describe('Absolute path to a local template file (DOCX, XLSX, ODT, ODS, HTML) on the host. Optional if templateHtml is provided.'),
      data:         z.record(z.string(), z.any()).describe('JSON data payload representing the fields to merge into the template.'),
      convertTo:    z.enum(['pdf', 'html', 'docx', 'xlsx', 'odt', 'ods']).default('pdf').describe('The output document format. Default is pdf.'),
    }),
    shape: {
      templateHtml: z.string().optional().describe('Raw HTML template content containing Carbone tags like {d.name}. Optional if templatePath is provided.'),
      templatePath: z.string().optional().describe('Absolute path to a local template file (DOCX, XLSX, ODT, ODS, HTML) on the host. Optional if templateHtml is provided.'),
      data:         z.record(z.string(), z.any()).describe('JSON data payload representing the fields to merge into the template.'),
      convertTo:    z.enum(['pdf', 'html', 'docx', 'xlsx', 'odt', 'ods']).default('pdf').describe('The output document format. Default is pdf.'),
    },
    handler: async (args, ctx) => {
      if (!args.templateHtml && !args.templatePath) {
        throw new Error('Either templateHtml or templatePath must be provided.');
      }

      if (args.templatePath) {
        checkFsBoundary(path.resolve(args.templatePath));
      }

      let templateBuffer: Buffer;
      let filename = 'template.html';

      if (args.templateHtml) {
        templateBuffer = Buffer.from(args.templateHtml, 'utf8');
      } else {
        const absolutePath = path.resolve(args.templatePath!);
        templateBuffer = fs.readFileSync(absolutePath);
        filename = path.basename(absolutePath);
      }

      try {
        const formData = new FormData();
        const blob = new Blob([new Uint8Array(templateBuffer)], { type: DOC_MIME_BY_EXT[path.extname(filename)] || 'application/octet-stream' });
        formData.append('template', blob, filename);

        const uploadRes = await fetch('http://127.0.0.1:8020/template', {
          method: 'POST',
          body:   formData,
          headers: { 'carbone-version': '5' },
        });

        if (!uploadRes.ok) {
          throw new Error(`Carbone template upload failed: ${uploadRes.statusText} (${await uploadRes.text()})`);
        }

        const uploadJson = await uploadRes.json() as any;
        if (!uploadJson.success || !uploadJson.data?.templateId) {
          throw new Error(`Carbone template upload returned error: ${JSON.stringify(uploadJson)}`);
        }

        const templateId = uploadJson.data.templateId;

        const renderRes = await fetch(`http://127.0.0.1:8020/render/${templateId}`, {
          method:  'POST',
          headers: {
            'Content-Type':    'application/json',
            'carbone-version': '5',
          },
          body: JSON.stringify({
            data:      args.data,
            convertTo: args.convertTo,
          }),
        });

        if (!renderRes.ok) {
          throw new Error(`Carbone render request failed: ${renderRes.statusText} (${await renderRes.text()})`);
        }

        const renderJson = await renderRes.json() as any;
        if (!renderJson.success || !renderJson.data?.renderId) {
          throw new Error(`Carbone render request returned error: ${JSON.stringify(renderJson)}`);
        }

        const renderId = renderJson.data.renderId;

        const downloadRes = await fetch(`http://127.0.0.1:8020/render/${renderId}`);
        if (!downloadRes.ok) {
          throw new Error(`Carbone download failed: ${downloadRes.statusText}`);
        }

        const arrayBuffer = await downloadRes.arrayBuffer();
        const outputBuffer = Buffer.from(arrayBuffer);

        const outDir = path.join('/home/neuroclaw-v1/uploads', 'carbone_renders');
        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
        }

        const baseName = path.parse(filename).name;
        const outFilename = `${baseName}_${randomUUID().slice(0, 8)}.${args.convertTo}`;
        const outPath = path.join(outDir, outFilename);
        fs.writeFileSync(outPath, outputBuffer);

        logHive('tool_result', `Generated Carbone document: ${outFilename}`, ctx.agentId ?? undefined, {
          templateId,
          renderId,
          convertTo: args.convertTo,
        }, ctx.runId ?? undefined, ctx.sessionId ?? undefined);

        return {
          ok:         true,
          outputPath: outPath,
          filename:   outFilename,
          sizeBytes:  outputBuffer.length,
          message:    'Document generated successfully.',
        };
      } catch (err: any) {
        logger.error('Carbone generation failed:', err);
        return { ok: false, error: err.message };
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

const EMPTY_EXTRA_CORE = new Set<string>();

/** Per-agent extra-core tool names from agents.extra_core_tools (JSON array).
 *  Cheap (single indexed PK lookup) and cycle-safe — db.ts does not import
 *  registry. Resolution is forgiving: unknown/missing names are silently
 *  ignored downstream because they simply never match a registry tool.
 *  See docs/specs/per-agent-image-tools-spec.md (Fix 1). */
function resolveExtraCoreTools(ctx: ToolContext): Set<string> {
  if (!ctx.agentId) return EMPTY_EXTRA_CORE;
  try {
    const row = getAgentById(ctx.agentId);
    const raw = row?.extra_core_tools;
    if (!raw) return EMPTY_EXTRA_CORE;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x: unknown): x is string => typeof x === 'string')) : EMPTY_EXTRA_CORE;
  } catch { return EMPTY_EXTRA_CORE; }
}

/** Core tools that are always included in the upfront tool list sent to the
 *  model, PLUS any tools an agent's extra_core_tools allowlist elevates. Both
 *  are gate-filtered — elevation never bypasses a gate. Non-elevated, non-core
 *  tools remain accessible via search_tools + call_tool. */
export function visibleCoreTools(ctx: ToolContext): ToolDef[] {
  const extra = resolveExtraCoreTools(ctx);
  const all = [...registry, ...getMcpRegistryTools()];
  return all.filter(t => (t.core || extra.has(t.name)) && (!t.gate || t.gate(ctx).allowed));
}

/**
 * Startup sanity check: every ToolDef carries BOTH `schema` (used by the
 * OpenAI/MCP planes via z.toJSONSchema) and `shape` (used by the Claude SDK's
 * tool() helper). Tools defined inline duplicate the two by hand, and a
 * drift means the tool validates differently per plane — works on one,
 * fails on another, with nothing to flag it. Compare their derived JSON
 * Schemas and warn loudly on any mismatch. Called once at server boot.
 */
export function validateRegistryShapes(): number {
  let mismatches = 0;
  for (const t of registry) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fromSchema = JSON.stringify(z.toJSONSchema(t.schema as any, { target: 'draft-7' }));
      const fromShape  = JSON.stringify(z.toJSONSchema(z.object(t.shape), { target: 'draft-7' }));
      if (fromSchema !== fromShape) {
        mismatches++;
        logger.warn('registry: schema/shape DRIFT — tool validates differently per plane', { tool: t.name });
      }
    } catch (err) {
      mismatches++;
      logger.warn('registry: schema/shape validation threw', { tool: t.name, error: (err as Error).message });
    }
  }
  if (mismatches === 0) logger.info(`registry: schema/shape validation passed for ${registry.length} tools`);
  return mismatches;
}
