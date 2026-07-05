// MCP-backed agent dispatcher. When an agent has provider='mcp', chatStream
// proxies the user's message directly to a remote MCP tool (no local LLM
// turn). The remote response is streamed back as a single chunk and persisted
// to the session like any normal assistant message. Streaming token-by-token
// is intentionally not supported in v1 — the spec calls for waiting on the
// final result.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getMcpServer, parseMcpHeaders, saveMessage, deleteLastUserMessage, startRun, endRun, type AgentRecord } from '../db';
import { callTool } from '../mcp/mcp-client';
import { logger } from '../utils/logger';
import { logHive, getCrossSessionContext, getSharedCommsNotesContext } from '../system/hive-mind';
import type { MetaEvent } from './alfred';

export async function chatStreamMcp(
  userMessage: string,
  sessionId: string,
  onChunk: (chunk: string) => void | Promise<void>,
  agentRecord: AgentRecord,
  onMeta?: (e: MetaEvent) => void | Promise<void>,
  runId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const ownsRun = !runId;
  const activeRunId = runId ?? startRun({
    origin:            'chat',
    sessionId,
    initiatingAgentId: agentRecord.id,
    userMessage,
  });

  if (!agentRecord.mcp_server_id || !agentRecord.mcp_tool_name) {
    const err = `Agent "${agentRecord.name}" has provider=mcp but missing mcp_server_id or mcp_tool_name`;
    logger.error('chatStreamMcp: misconfigured agent', { agentId: agentRecord.id });
    await onMeta?.({ type: 'error', error: err });
    if (ownsRun) endRun(activeRunId, { status: 'error', error_text: err });
    throw new Error(err);
  }

  const server = getMcpServer(agentRecord.mcp_server_id);
  if (!server) {
    const err = `MCP server for agent "${agentRecord.name}" no longer exists (id: ${agentRecord.mcp_server_id})`;
    await onMeta?.({ type: 'error', error: err });
    if (ownsRun) endRun(activeRunId, { status: 'error', error_text: err });
    throw new Error(err);
  }
  if (!server.enabled) {
    const err = `MCP server "${server.name}" for agent "${agentRecord.name}" is disabled`;
    await onMeta?.({ type: 'error', error: err });
    if (ownsRun) endRun(activeRunId, { status: 'error', error_text: err });
    throw new Error(err);
  }

  const inputField = agentRecord.mcp_input_field || 'query';
  const headers = parseMcpHeaders(server.headers);
  const crossCtx = getCrossSessionContext(agentRecord.id, sessionId);
  const notesCtx = getSharedCommsNotesContext(agentRecord.id);
  const ctxBlock = (crossCtx || '') + (notesCtx || '');
  const toolInput = ctxBlock ? `${ctxBlock}\n\n${userMessage}` : userMessage;
  const args: Record<string, unknown> = { [inputField]: toolInput };

  saveMessage(sessionId, 'user', userMessage, agentRecord.id);

  await onMeta?.({ type: 'mcp_call_start', server: server.name, tool: agentRecord.mcp_tool_name });

  if (signal?.aborted) {
    if (ownsRun) endRun(activeRunId, { status: 'done', final_output: '' });
    return;
  }
  let textOut = '';
  try {
    const result = await callTool(
      server.url,
      agentRecord.mcp_tool_name,
      args,
      Object.keys(headers).length > 0 ? headers : undefined,
      (server.transport as 'auto' | 'http' | 'sse' | undefined) ?? 'auto',
    );
    textOut = await detectAndServeImages(
      extractText(result),
      sessionId,
      agentRecord.name,
      onMeta,
    );
  } catch (e) {
    const detail = (e as Error).message || String(e);
    logger.error('chatStreamMcp: remote call failed', {
      agentId: agentRecord.id,
      server: server.name,
      tool: agentRecord.mcp_tool_name,
      error: detail,
    });
    logHive(
      'mcp_agent_call_failed',
      `${agentRecord.name} -> ${server.name}/${agentRecord.mcp_tool_name}: ${detail.slice(0, 120)}`,
      agentRecord.id,
      { error: detail },
      activeRunId,
    );
    await onMeta?.({ type: 'error', error: detail });
    if (ownsRun) endRun(activeRunId, { status: 'error', error_text: detail });
    // H4: the user row was saved (line ~64) before this remote call failed, and
    // no assistant reply follows. MCP agents keep no in-memory history, so the DB
    // row is the only state — drop the orphan so it can't form a consecutive-user
    // transcript on the next turn.
    deleteLastUserMessage(sessionId, agentRecord.id);
    throw e;
  }

  await onChunk(textOut);
  saveMessage(sessionId, 'assistant', textOut, agentRecord.id);
  await onMeta?.({ type: 'mcp_call_done', server: server.name, tool: agentRecord.mcp_tool_name, length: textOut.length });
  logHive(
    'mcp_agent_call_ok',
    `${agentRecord.name} -> ${server.name}/${agentRecord.mcp_tool_name}: ${textOut.length} chars`,
    agentRecord.id,
    undefined,
    activeRunId,
  );
  if (ownsRun) {
    endRun(activeRunId, { status: 'done', final_output: textOut });
  }
}

async function detectAndServeImages(
  textOut: string,
  sessionId: string,
  agentName: string,
  onMeta: ((e: MetaEvent) => void | Promise<void>) | undefined,
): Promise<string> {
  const safeSession = (sessionId ?? 'orphan').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const uploadDir   = path.resolve(process.cwd(), 'uploads', 'chat', safeSession);
  let out = textOut;

  // Detection A: "path: /abs/file.ext" from ChatGPT-style MCP agents.
  // If deliver_image already uploaded to Supabase, a "public_url: https://..." line
  // will be present — prefer that URL directly and skip the local copy.
  const pathRe      = /^path:\s*(.+?\.(png|jpg|jpeg|gif|webp))\s*$/gim;
  const pubUrlRe    = /^public_url:\s*(\S+)\s*$/im;
  const localUrlRe  = /^local_url:\s*\S+[ \t]*\n?/gim;
  const allowedRoot = process.cwd();
  let pathMatch: RegExpExecArray | null;
  while ((pathMatch = pathRe.exec(out)) !== null) {
    const absPath = pathMatch[1].trim();
    try {
      const descMatch = /^description:\s*(.+)$/im.exec(out);
      const alt       = descMatch ? descMatch[1].trim() : 'generated image';
      const ext       = path.extname(absPath).slice(1).toLowerCase() || 'png';
      const mime      = `image/${ext === 'jpg' ? 'jpeg' : ext}`;

      // Prefer Supabase public_url when deliver_image has already uploaded it
      const pubMatch = pubUrlRe.exec(out);
      if (pubMatch) {
        const publicUrl = pubMatch[1].trim();
        await onMeta?.({ type: 'agent_image', fromName: agentName, url: publicUrl, alt, mime });
        out = out.replace(pathMatch[0], `![${alt}](${publicUrl})`);
        out = out.replace(pubUrlRe,   '');
        out = out.replace(localUrlRe, '');
        pathRe.lastIndex = 0;
        continue;
      }

      // Fallback: copy local file into chat uploads dir
      const resolvedPath = path.resolve(absPath);
      if (!resolvedPath.startsWith(allowedRoot + path.sep)) {
        logger.warn('chatStreamMcp: refusing image path outside project directory', { absPath: resolvedPath });
        continue;
      }
      if (fs.existsSync(resolvedPath)) {
        const filename = `${Date.now()}-${randomUUID()}.${ext}`;
        fs.mkdirSync(uploadDir, { recursive: true });
        fs.copyFileSync(resolvedPath, path.join(uploadDir, filename));
        const publicUrl = `/uploads/chat/${safeSession}/${filename}`;
        await onMeta?.({ type: 'agent_image', fromName: agentName, url: publicUrl, alt, mime });
        out = out.replace(pathMatch[0], `![${alt}](${publicUrl})`);
        // Reset regex after string mutation so remaining matches are found correctly
        pathRe.lastIndex = 0;
      }
    } catch (err) {
      logger.warn('chatStreamMcp: image file copy failed', { absPath, error: (err as Error).message });
    }
  }

  // Detection B: [image:<mime>:<b64>] sentinel from MCP spec image content blocks
  const sentinelRe = /\[image:([^:\]]+):([^\]]+)\]/g;
  const sentinels: Array<{ full: string; mime: string; b64: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = sentinelRe.exec(out)) !== null) {
    sentinels.push({ full: m[0], mime: m[1], b64: m[2] });
  }
  const extMap: Record<string, string> = {
    'image/png':  'png',
    'image/jpeg': 'jpg',
    'image/gif':  'gif',
    'image/webp': 'webp',
  };
  for (const { full, mime, b64 } of sentinels) {
    const ext = extMap[mime] ?? 'png';
    try {
      const buf = Buffer.from(b64, 'base64');
      if (buf.length === 0) {
        logger.warn('chatStreamMcp: empty base64 image sentinel skipped', { mime });
        continue;
      }
      const filename  = `${Date.now()}-${randomUUID()}.${ext}`;
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(path.join(uploadDir, filename), buf);
      const publicUrl = `/uploads/chat/${safeSession}/${filename}`;
      await onMeta?.({ type: 'agent_image', fromName: agentName, url: publicUrl, alt: 'generated image', mime });
      out = out.replace(full, `![generated image](${publicUrl})`);
    } catch (err) {
      logger.warn('chatStreamMcp: image sentinel processing failed', { mime, error: (err as Error).message });
    }
  }

  return out;
}

function extractText(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return JSON.stringify(result);

  // MCP content array format: { content: Array<{ type: string; text?: string }>, isError?: boolean }
  const r = result as { content?: unknown; isError?: boolean };
  let body: string;
  if (Array.isArray(r.content)) {
    const parts: string[] = [];
    for (const c of r.content as Array<{ type?: string; text?: string; data?: string; mimeType?: string }>) {
      if (c.type === 'text' && typeof c.text === 'string') {
        parts.push(c.text);
      } else if (c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string') {
        // Emit a sentinel — detectAndServeImages() will decode this into an uploaded file.
        parts.push(`[image:${c.mimeType}:${c.data}]`);
      } else {
        parts.push(JSON.stringify(c));
      }
    }
    body = parts.join('\n').trim();
  } else {
    body = JSON.stringify(result);
  }

  return r.isError ? `MCP tool error:\n${body}` : body;
}
