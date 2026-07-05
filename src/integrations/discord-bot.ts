// Discord bot manager — runs N concurrent bots, one per row in the
// `discord_bots` table. Each bot is its own discord.js Client (its own
// gateway connection, its own identity/avatar/name from the Discord
// Developer Portal). Channel→agent routing lives in `discord_channel_routes`.
//
// Lifecycle:
//   - Boot: read enabled bots, spawn a Client for each.
//   - Reload: poll the DB every RELOAD_INTERVAL_SEC for adds/removes/edits.
//   - Per-bot status (idle | connecting | ready | error) is written back to
//     `discord_bots.status` so the dashboard can show it live.
//   - Migration: on first run, if no rows exist but DISCORD_BOT_TOKEN is set
//     in env, we seed a row from the legacy single-bot config.
//
// Distinct from the Composio Discord toolkit: that's outbound (agents post
// TO Discord); this is inbound (users chat WITH NeuroClaw via Discord).
//
// Inspired by OpenClaw's Discord channel plugin — distilled to ~350 LOC by
// dropping voice / slash commands / threads / monitor / security audit /
// SecretRef. Add those back as separate concerns when needed.

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type VoiceState,
  type Interaction,
  ChannelType,
  ApplicationCommandOptionType,
} from 'discord.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  getAgentById, getAgentByName,
  listDiscordBots, listDiscordRoutes,
  createDiscordBot, updateDiscordBot,
  getDiscordBot,
  parseAutoReplyGuilds,
  getDiscordVoicePref, setDiscordVoicePref,
  getOrCreateSessionByExternalId,
  getDiscordBotSkills,
  logAnalytics,
  markRunDelivered,
  enqueueJob, getCachedAudio, buildAudioCacheKey,
  type DiscordBotRow,
} from '../db';
import { transcribe } from '../audio/transcribe';
import { resolveAgentVoice } from '../audio/tts';
import { handleVoiceStateUpdate, destroyBotSessions, type BotVoiceContext } from './discord-voice';
import { dispatchSlash, getCommandCatalog, reconstructArgs } from '../system/slash-registry';
import { getSessionDocuments } from '../system/attachment-registry';
import { persistUpload } from '../system/session-uploads';
import { listSkills } from '../skills/skill-loader';
import { agentBus, type AgentEvent } from '../system/event-bus';
import { startPlaceholderMonitor } from '../system/discord-placeholder-monitor';

const RELOAD_INTERVAL_SEC = 30;

// ── Voice-pref intent detection ────────────────────────────────────────────
// Cheap, conservative regex layer so a user can say "stop sending audio" once
// and have it stick — even if the agent doesn't think to call the
// discord_set_user_voice tool. Fires only on clear toggle phrases; incidental
// mentions ("the audio file you sent earlier was great") shouldn't match.

const VOICE_OFF_PATTERNS = [
  /\b(stop|don'?t|do not|quit|please stop)\s+(?:sending|attaching|posting|including|giving|adding|making)\s+(?:the\s+|me\s+|any\s+)?(?:audio|voice|voice\s*notes?|mp3s?|sound|speech|tts)\b/i,
  /\b(?:disable|turn\s+off|mute|kill|silence|cut)\s+(?:the\s+)?(?:audio|voice|mp3s?|tts|speech|sound|voice\s*reply|voice\s*replies)\b/i,
  /\b(?:no|stop)\s+(?:more\s+)?(?:audio|voice\s*notes?|mp3s?|tts|voice\s*reply|voice\s*replies|speech)\b/i,
  /\b(?:audio|voice|tts|speech|sound)\s+(?:off|disabled?)\b/i,
  /\btext[-\s]*only\b/i,
  /\byou\s+don'?t\s+(?:have|need)\s+to\s+(?:send|attach|include|make|do|add)\s+(?:me\s+)?(?:the\s+|any\s+)?(?:audio|voice|mp3s?|sound|speech|tts|voice\s*reply|voice\s*replies)\b/i,
];

const VOICE_ON_PATTERNS = [
  /\b(?:enable|turn\s+on|unmute|reactivate|re-?enable)\s+(?:the\s+)?(?:audio|voice|mp3s?|tts|speech|voice\s*reply|voice\s*replies)\b/i,
  /\b(?:audio|voice|tts|speech)\s+(?:on|back\s+on|please)\b/i,
  /\b(?:send|attach|include)\s+(?:the\s+)?(?:audio|voice|mp3s?|sound|speech)\s+(?:again|back)?\b/i,
  /\bi\s+(?:want|need|like|prefer)\s+(?:the\s+)?(?:audio|voice|mp3s?|tts|speech|voice\s*reply)\b/i,
];

function detectVoicePrefIntent(text: string): 'on' | 'off' | null {
  if (!text) return null;
  // OFF wins on conflict — if both fire we err on the side of "no surprise audio".
  for (const re of VOICE_OFF_PATTERNS) if (re.test(text)) return 'off';
  for (const re of VOICE_ON_PATTERNS)  if (re.test(text)) return 'on';
  return null;
}

// ── Plain-text attachment intake ───────────────────────────────────────────
// Lets the user drop .md / .txt / .json / source files into Discord and have
// the agent actually read them. We inline the contents into the user message
// as fenced blocks — works for every provider (no native file-attachment API
// needed). PDFs / docx / images stay out of scope here (vision handles images;
// PDF/OCR is deferred per user direction).

const TEXT_EXTENSIONS = new Set([
  // docs + data
  'md','markdown','mdx','txt','text','rst','adoc','asciidoc',
  'json','jsonc','json5','yaml','yml','toml','xml','csv','tsv','log',
  'ini','env','conf','cfg','properties','editorconfig',
  // code
  'ts','tsx','js','jsx','mjs','cjs','py','rb','go','rs','java','kt','swift',
  'c','cpp','cc','h','hpp','cs','php','lua','dart','scala','clj','ex','exs',
  'css','scss','sass','less','vue','svelte',
  'sh','bash','zsh','fish','ps1','bat','cmd',
  'sql','graphql','gql','proto',
  'dockerfile','makefile','gitignore','gitattributes',
  // misc
  'patch','diff','srt','vtt','ipynb',
  // NOTE: html / htm / xhtml are intentionally NOT here. They route through
  // the binary-document path (DOC_EXTENSIONS below) so docuflow can extract
  // structured text instead of the agent receiving raw markup as a fenced
  // block. Keep these in sync with the dashboard chat input.
]);

// Binary / structured documents — fetched from Discord, base64-encoded, and
// forwarded to /api/chat as `documents[]`. The chat route registers them in
// the per-session attachment registry; agents retrieve bytes via the
// `get_attachment` tool and feed them to docuflow (or any other parser MCP).
const DOC_EXTENSIONS = new Set(['pdf', 'docx', 'epub', 'html', 'htm', 'xhtml']);
const DOC_MIME_EXACT = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/epub+zip',
  'text/html',
  'application/xhtml+xml',
]);
const DISCORD_FILE_MAX_BYTES = 25 * 1024 * 1024;   // 25 MB hard cap on most servers
const DOC_PER_FILE_MAX_BYTES = 25 * 1024 * 1024;   // 25 MB / file (Discord caps at 25 MB on most servers anyway)
const DOC_TOTAL_MAX_BYTES    = 50 * 1024 * 1024;   // 50 MB / turn — matches attachment-registry per-session cap

function isDocumentAttachment(name: string | null, contentType: string | null): boolean {
  const ct = (contentType ?? '').toLowerCase().split(';')[0].trim();
  if (ct && DOC_MIME_EXACT.has(ct)) return true;
  const lower = (name ?? '').toLowerCase();
  if (!lower) return false;
  const base = lower.split('/').pop() ?? lower;
  const dot  = base.lastIndexOf('.');
  if (dot < 0) return false;
  return DOC_EXTENSIONS.has(base.slice(dot + 1));
}

interface FetchedDocument {
  name:      string;
  mime_type: string;
  /** Base64 (no data: prefix) ready for the /api/chat `documents[]` field. */
  data:      string;
  /** Decoded byte size — used for budget accounting. */
  size:      number;
}

// Per-turn attachment download cache. A single Discord turn can need the same
// attachment for several purposes — transcription, document parsing, text
// inlining, and upload persistence — and without memoization each path
// re-downloads the bytes (up to 50 MB twice for a document). This fetches any
// given URL at most once per message and hands the same Buffer to every caller.
// Each consumer keeps its own size-gating and only calls the fetcher once it has
// decided to download, so oversized files are still never fetched.
interface FetchedBytes { ok: boolean; status: number; buf: Buffer }
type AttachmentFetcher = (url: string) => Promise<FetchedBytes>;

function makeAttachmentFetcher(): AttachmentFetcher {
  const cache = new Map<string, Promise<FetchedBytes>>();
  return (url) => {
    let p = cache.get(url);
    if (!p) {
      p = (async (): Promise<FetchedBytes> => {
        const r = await fetch(url);
        const buf = r.ok ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
        return { ok: r.ok, status: r.status, buf };
      })();
      cache.set(url, p);
    }
    return p;
  };
}

async function fetchDocumentAttachments(
  attachments: Array<{ url: string; name: string | null; contentType: string | null; size: number }>,
  perFileMaxBytes: number,
  totalMaxBytes:   number,
  fetcher:         AttachmentFetcher,
): Promise<{ docs: FetchedDocument[]; skipped: string[] }> {
  const docs: FetchedDocument[] = [];
  const skipped: string[] = [];
  let consumed = 0;
  for (const a of attachments) {
    const label = a.name ?? 'attachment';
    if (a.size > perFileMaxBytes) {
      skipped.push(`${label} (over per-file limit: ${Math.round(perFileMaxBytes / 1024 / 1024)} MB)`);
      continue;
    }
    if (consumed + a.size > totalMaxBytes) {
      skipped.push(`${label} (would exceed per-turn budget)`);
      continue;
    }
    try {
      const r = await fetcher(a.url);
      if (!r.ok) { skipped.push(`${label} (HTTP ${r.status})`); continue; }
      const buf = r.buf;
      if (buf.length === 0) { skipped.push(`${label} (empty file)`); continue; }
      if (buf.length > perFileMaxBytes) {
        // Discord lied about size in the metadata — re-check post-download.
        skipped.push(`${label} (post-download size over limit)`);
        continue;
      }
      docs.push({
        name:      label,
        mime_type: a.contentType ?? 'application/octet-stream',
        data:      buf.toString('base64'),
        size:      buf.length,
      });
      consumed += buf.length;
    } catch (err) {
      skipped.push(`${label} (${(err as Error).message})`);
    }
  }
  return { docs, skipped };
}

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = new Set([
  'application/json','application/ld+json','application/xml',
  'application/yaml','application/x-yaml','application/toml','application/x-toml',
  'application/javascript','application/typescript','application/sql','application/graphql',
  'application/x-sh','application/x-shellscript','application/x-httpd-php',
  // NOTE: application/xhtml+xml is intentionally NOT here — it's a document
  // (handled by isDocumentAttachment + docuflow), not raw text to inline.
]);

function isTextAttachment(name: string | null, contentType: string | null): boolean {
  const ct = (contentType ?? '').toLowerCase().split(';')[0].trim();
  // HTML / XHTML are documents, not raw-inlined text. Route them through the
  // document path so docuflow can structure them. Check this FIRST so the
  // text/* MIME prefix below doesn't claim text/html.
  if (ct === 'text/html' || ct === 'application/xhtml+xml') return false;
  if (ct) {
    if (TEXT_MIME_PREFIXES.some(p => ct.startsWith(p))) return true;
    if (TEXT_MIME_EXACT.has(ct)) return true;
  }
  // Skip anything obviously not text even if extension would otherwise match.
  if (ct.startsWith('audio/') || ct.startsWith('image/') || ct.startsWith('video/')) return false;
  // Hard-reject always-binary types. NOTE: application/octet-stream is
  // deliberately NOT rejected here — Discord reports it for .md / .json /
  // source files, which the extension fallback below correctly claims as text.
  if (ct === 'application/pdf' || ct === 'application/zip') return false;
  // Extension fallback — Discord often reports application/octet-stream for
  // .md / .json / source files, so the extension is often the only signal.
  const lower = (name ?? '').toLowerCase();
  if (!lower) return false;
  // Special cases (no extension): "Dockerfile", "Makefile"
  const base = lower.split('/').pop() ?? lower;
  if (TEXT_EXTENSIONS.has(base)) return true;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = base.slice(dot + 1);
  return TEXT_EXTENSIONS.has(ext);
}

const TEXT_FILE_PER_FILE_MAX_BYTES = 200 * 1024;       // 200 KB / file
const TEXT_FILE_TOTAL_MAX_BYTES    = 800 * 1024;       // 800 KB total per turn

interface InlinedTextFile {
  name:      string;
  bytes:     number;       // bytes actually inlined (post-truncation)
  truncated: boolean;
  body:      string;
}

async function fetchTextAttachments(
  attachments: Array<{ url: string; name: string | null; contentType: string | null; size: number }>,
  budgetBytes: number,
  fetcher:     AttachmentFetcher,
): Promise<{ files: InlinedTextFile[]; skipped: string[] }> {
  const files: InlinedTextFile[] = [];
  const skipped: string[] = [];
  let consumed = 0;
  for (const a of attachments) {
    if (consumed >= budgetBytes) { skipped.push(`${a.name ?? 'attachment'} (over total budget)`); continue; }
    try {
      const r = await fetcher(a.url);
      if (!r.ok) { skipped.push(`${a.name ?? 'attachment'} (HTTP ${r.status})`); continue; }
      const buf = r.buf;
      const allowed = Math.min(TEXT_FILE_PER_FILE_MAX_BYTES, budgetBytes - consumed);
      const truncated = buf.length > allowed;
      const sliced = truncated ? buf.subarray(0, allowed) : buf;
      // Strip a UTF-8 BOM if present so it doesn't render as a stray char.
      const start = (sliced.length >= 3 && sliced[0] === 0xEF && sliced[1] === 0xBB && sliced[2] === 0xBF) ? 3 : 0;
      let body = sliced.subarray(start).toString('utf-8');
      // Reject obvious-binary payloads even when the extension said text — a
      // single NUL byte means we're almost certainly not looking at UTF-8.
      if (body.includes('\x00')) { skipped.push(`${a.name ?? 'attachment'} (binary content)`); continue; }
      if (truncated) body += `\n…[truncated, ${buf.length - allowed} more bytes]`;
      files.push({ name: a.name ?? 'attachment', bytes: sliced.length - start, truncated, body });
      consumed += sliced.length;
    } catch (err) {
      skipped.push(`${a.name ?? 'attachment'} (${(err as Error).message})`);
    }
  }
  return { files, skipped };
}

function fenceLanguageFor(filename: string): string {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = lower.slice(dot + 1);
  // Map a few common extensions to fence languages so syntax highlighting
  // works in the chat thread (and the LLM's parsing biases correctly).
  const map: Record<string, string> = {
    md:'markdown', markdown:'markdown', mdx:'markdown',
    json:'json', jsonc:'json', json5:'json',
    yaml:'yaml', yml:'yaml',
    toml:'toml', xml:'xml', html:'html', htm:'html', css:'css', scss:'scss',
    js:'javascript', jsx:'jsx', mjs:'javascript', cjs:'javascript',
    ts:'typescript', tsx:'tsx',
    py:'python', rb:'ruby', go:'go', rs:'rust', java:'java', kt:'kotlin',
    swift:'swift', c:'c', cpp:'cpp', cc:'cpp', h:'c', hpp:'cpp', cs:'csharp',
    php:'php', sh:'bash', bash:'bash', zsh:'bash', fish:'fish',
    sql:'sql', graphql:'graphql', gql:'graphql', proto:'proto',
    csv:'csv', tsv:'tsv', log:'',
    ini:'ini', env:'', conf:'', cfg:'',
    diff:'diff', patch:'diff',
  };
  return map[ext] ?? '';
}

// ── State ──────────────────────────────────────────────────────────────────

interface ChannelRoute {
  agentId:        string;
  requireMention: boolean;
  autoReply:      boolean;
}

interface RunningBot {
  client:          Client;
  row:             DiscordBotRow;
  routes:          Map<string, ChannelRoute>; // channel_id → { agentId, requireMention, autoReply }
  autoReplyGuilds: Set<string>;                // guild ids where mention is NOT required (subject to per-channel override)
  startedAt:       number;
  unhealthySince:  number | null;              // timestamp when bot last entered an error/disconnect state; null when healthy
  lastCloseCode:   number | null;              // most recent shard close code; used to detect permanent (unrecoverable) failures
  permanentFailureLogged: boolean;             // true once we've logged + surfaced a permanent gateway failure (avoids log spam)
  commandsRegistered: boolean;                 // slash commands pushed once per process; 'ready' fires again on every reconnect
}

const running = new Map<string, RunningBot>();

// Gateway close codes that recur on every reconnect — restarting can't fix them
// (bad token, disallowed/invalid privileged intents, sharding/version errors).
const PERMANENT_GATEWAY_CLOSE_CODES = new Set([
  4004, // Authentication failed (invalid token)
  4010, // Invalid shard
  4011, // Sharding required
  4012, // Invalid API version
  4013, // Invalid intent(s)
  4014, // Disallowed intent(s) — a privileged intent not enabled in the portal
]);

// Bots that failed to LOG IN for a reason a reload can't fix (invalid token /
// disallowed intents). Maps bot id → the token that failed, so the reload loop
// stops re-login spinning on the SAME token but auto-recovers the moment an
// operator edits the token (a deliberate fix). An explicit manual restart also
// clears it unconditionally. (Post-login gateway close-code failures like 4014
// use a separate path in reload() that keeps the bot in `running` — see
// PERMANENT_GATEWAY_CLOSE_CODES.)
const permanentlyFailedBots = new Map<string, string>();

function isPermanentLoginError(msg: string): boolean {
  return /invalid token|disallowed intent|tokeninvalid|disallowedintents/i.test(msg);
}

// ── Per-bot inbound message dedup ──────────────────────────────────────────
// Prevents double-processing when the same messageCreate event fires more than
// once WITHIN THIS PROCESS (e.g. a duplicated gateway event after a resume).
// NOTE: this is per-process in-memory state — it CANNOT dedupe across two
// separate processes logged into the same bot token (each keeps its own set).
// Don't run two managers on one token. Discord message IDs are unique
// snowflakes; we cap the set at 2000 to bound memory on busy servers.
const seenMessageIds = new Map<string, Set<string>>(); // botId → Set<messageId>
const SEEN_MSG_CAP = 2000;

// ── Per-session image carryover ────────────────────────────────────────────
// When a user drops an image with no text ("here's my homework") and then sends
// a follow-up message with only text ("solve this"), the image attachment is
// gone from msg.attachments on the second turn — Discord messages are stateless.
// We cache the last set of image attachments per session and inject them on the
// next text-only turn so the agent can answer follow-up questions without
// forcing the user to re-upload.
//
// TTL is 30 minutes — long enough for multi-step conversations, short enough
// that we don't try to use expired Discord CDN links (which are typically valid
// for hours, but 30 min is conservative and matches the attachment-registry TTL).
// When a new image arrives it replaces the stored one rather than appending.
interface PendingImageEntry {
  images:    Array<{ url: string; mime_type?: string; name?: string }>;
  storedAt:  number;
}
const sessionPendingImages = new Map<string, PendingImageEntry>();
const PENDING_IMAGE_TTL_MS = 30 * 60 * 1000;

// ── Per-session document carryover ──────────────────────────────────────────
// Same idea as image carryover, but for binary documents (PDF/DOCX/EPUB/HTML)
// and storing the already-downloaded BYTES rather than the Discord CDN URL.
// Discord messages are stateless: when a user uploads a PDF and then sends a
// text-only follow-up ("make it concise", "remove the dashes"), msg.attachments
// is empty on that turn, so the agent lost the document entirely and bluffed
// "the link expired, re-upload it." We cache the fetched bytes per session and
// re-feed them on follow-up turns. Bytes (not URL) means an expired signed CDN
// link can never break the follow-up. The attachment-registry dedups by content
// hash, so re-feeding the same PDF reuses its server-side parse (no re-parse).
interface PendingDocEntry {
  documents: FetchedDocument[];
  storedAt:  number;
}
const sessionPendingDocuments = new Map<string, PendingDocEntry>();
const PENDING_DOC_TTL_MS = 30 * 60 * 1000;

// ── Carryover TTL sweep ──────────────────────────────────────────────────
// The pending-image / pending-document maps above are pruned lazily on the
// next text-only turn in the SAME session. A session that uploads media and
// never sends such a follow-up would otherwise pin its entry forever — and the
// document map stores up to DOC_TOTAL_MAX_BYTES of base64 per session. Sweep
// expired entries on a fixed interval so memory can't grow without bound.
const CARRYOVER_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

function sweepCarryoverMaps(now = Date.now()): { images: number; documents: number } {
  let images = 0;
  let documents = 0;
  for (const [sessionId, entry] of sessionPendingImages) {
    if (now - entry.storedAt > PENDING_IMAGE_TTL_MS) {
      sessionPendingImages.delete(sessionId);
      images++;
    }
  }
  for (const [sessionId, entry] of sessionPendingDocuments) {
    if (now - entry.storedAt > PENDING_DOC_TTL_MS) {
      sessionPendingDocuments.delete(sessionId);
      documents++;
    }
  }
  if (images > 0 || documents > 0) {
    logger.debug('discord-bot: swept expired carryover entries', { images, documents });
  }
  return { images, documents };
}

function isDuplicateMessage(botId: string, messageId: string): boolean {
  let seen = seenMessageIds.get(botId);
  if (!seen) { seen = new Set(); seenMessageIds.set(botId, seen); }
  if (seen.has(messageId)) return true;
  seen.add(messageId);
  if (seen.size > SEEN_MSG_CAP) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return false;
}

// ── Per-(bot, channel, user) sticky session key ─────────────────────────────
// Build a stable external_id string for a (bot, channel, user) conversation.
// This key is stored in the `sessions` table so the same session is reused
// even after a process restart — the old in-memory Map approach lost the
// mapping on every restart, causing every new process to open a fresh session.
function sessionExternalId(botId: string, msg: Message): string {
  return `discord::${botId}::${msg.channelId}::${msg.author.id}`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveAgentId(nameOrId: string | null): string | null {
  if (!nameOrId) return null;
  const byId = getAgentById(nameOrId);
  if (byId) return byId.id;
  const byName = getAgentByName(nameOrId);
  return byName?.id ?? null;
}

function loadRoutesForBot(botId: string): Map<string, ChannelRoute> {
  const m = new Map<string, ChannelRoute>();
  for (const r of listDiscordRoutes(botId)) {
    m.set(r.channel_id, {
      agentId:        r.agent_id,
      requireMention: !!r.require_mention,
      autoReply:      !!r.auto_reply,
    });
  }
  return m;
}

function chunkForDiscord(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf(' ',  max);
    if (cut < max * 0.5) cut = max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

interface ChatStreamResult {
  reply:              string;
  sessionId:          string | null;       // captured from the SSE `session` event so we can stick it for next turn
  runId:              string | null;       // captured from the SSE `run` event so we can mark delivered after live edit
  agentImages:        Array<{ url: string; alt: string; caption: string }>;
  agentFiles:         Array<{ url: string; filename: string; mime: string; size: number; caption: string }>;
  hadBackgroundSpawn: boolean;             // true if a spawn_started event arrived — agent delegated and produced no text
}

export interface DiscordTurnContext {
  bot_id:       string;
  bot_name:     string;
  channel_id:   string;
  guild_id:     string | null;
  message_id:   string;
  author_id:    string;
  author_name:  string;
  // True when both the bot and the responding agent have voice toggled on, so
  // the chat handler can tell the agent in its system context that its text
  // reply will be auto-synthesized to audio. Without this, the agent answers
  // "can you speak?" from its training (i.e. "no, I'm text-only") even though
  // the pipeline is in fact attaching an mp3.
  voice_reply_enabled?: boolean;
}

// Inactivity window for a single Discord turn. Defaults to 5 minutes. This is
// NOT an absolute cap — streamChatResponse re-arms it on every SSE event, so a
// turn only aborts after STREAM_TIMEOUT_MS of *silence* (a genuinely hung
// stream), never mid-flight on a slow-but-healthy generation. Override with
// DISCORD_STREAM_TIMEOUT_MS in env (value in milliseconds).
const STREAM_TIMEOUT_MS = parseInt(process.env.DISCORD_STREAM_TIMEOUT_MS ?? '300000', 10);

async function streamChatResponse(
  message: string,
  agentId: string,
  sessionId?: string,
  attachments?: Array<{ url: string; mime_type?: string; name?: string }>,
  discordContext?: DiscordTurnContext,
  documents?: Array<{ name: string; data: string; mime_type?: string }>,
  onChunk?: (token: string) => void,
): Promise<ChatStreamResult> {
  const url = `http://127.0.0.1:${config.dashboard.port}/api/chat`;
  const controller = new AbortController();
  // INACTIVITY timeout — not an absolute wall-clock cap. Re-armed on every SSE
  // event so a healthy stream that keeps producing output never aborts; only a
  // stream that goes *silent* for STREAM_TIMEOUT_MS is treated as hung. The old
  // absolute cap aborted slow-but-healthy turns mid-stream (e.g. a 5m43s essay),
  // which the placeholder monitor then re-delivered on top of what the inline
  // live-edit had already posted — the "replied the same thing twice" bug.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
  };
  armIdle();

  // Captured outside the try so the catch wrapper below can attach them to
  // the AbortError on timeout — liveEditLoop reads err.runId to hand off the
  // placeholder to startPlaceholderMonitor without losing the run reference.
  let outerCapturedRunId:     string | null = null;
  let outerCapturedSessionId: string | null = null;

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':       'application/json',
        'x-dashboard-token':  config.dashboard.token,
      },
      body: JSON.stringify({
        message,
        agentId,
        sessionId,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        // Binary document uploads (PDF / DOCX / EPUB / HTML) fetched from
        // Discord and base64-encoded server-side. The chat handler registers
        // them in the per-session attachment registry and tells the agent
        // how to retrieve the bytes via `get_attachment`.
        ...(documents && documents.length > 0 ? { documents } : {}),
        // Pass the Discord IDs through so the agent knows which platform it's
        // on and which bot/channel/message to act on. The chat handler injects
        // a system note so the agent can call discord_react/etc with real IDs
        // instead of guessing or asking the user.
        ...(discordContext ? { discord: discordContext } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`/api/chat HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let assembled = '';
    let capturedSessionId: string | null = null;
    let capturedRunId:     string | null = null;
    let capturedImages: Array<{ url: string; alt: string; caption: string }> = [];
    let capturedFiles: Array<{ url: string; filename: string; mime: string; size: number; caption: string }> = [];
    let hadBackgroundSpawn = false; // true if spawn_started arrived — agent delegated work to a sub-agent
    let finished = false;           // got a `done` event — stop reading and return what we have
    let streamError: string | null = null;

    outer: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      armIdle(); // liveness: bytes arrived — push the inactivity deadline forward
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const dataLine = event.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        let evt: { type?: string; content?: string; message?: string; error?: string; sessionId?: string; runId?: string; url?: string; alt?: string; caption?: string; filename?: string; mime?: string; size?: number };
        try {
          evt = JSON.parse(dataLine.slice(6));
        } catch {
          // Partial JSON across chunks — try to recombine on the next read.
          continue;
        }
        if (evt.type === 'session' && typeof evt.sessionId === 'string') {
          capturedSessionId = evt.sessionId;
          outerCapturedSessionId = capturedSessionId;
        } else if (evt.type === 'run' && typeof evt.runId === 'string') {
          capturedRunId = evt.runId;
          outerCapturedRunId = capturedRunId;
        } else if (evt.type === 'chunk' && typeof evt.content === 'string') {
          assembled += evt.content;
          onChunk?.(evt.content);
        } else if (evt.type === 'agent_image' && typeof evt.url === 'string') {
          capturedImages.push({ url: evt.url, alt: evt.alt || '', caption: evt.caption || '' });
        } else if (evt.type === 'agent_file' && typeof evt.url === 'string') {
          capturedFiles.push({
            url:      evt.url,
            filename: typeof evt.filename === 'string' ? evt.filename : 'file',
            mime:     typeof evt.mime     === 'string' ? evt.mime     : 'application/octet-stream',
            size:     typeof evt.size     === 'number' ? evt.size     : 0,
            caption:  typeof evt.caption  === 'string' ? evt.caption  : '',
          });
        } else if (evt.type === 'spawn_started') {
          hadBackgroundSpawn = true;
        } else if (evt.type === 'done') {
          // Server signals turn complete. We have everything we need; stop reading
          // so any post-turn pipeline events (memory extractor, langfuse flush, etc.)
          // can't retroactively turn a successful response into a failure.
          finished = true;
          break outer;
        } else if (evt.type === 'error') {
          // Capture (don't throw yet) so a post-response error doesn't wipe out
          // chunks the user already received.
          streamError = evt.message ?? evt.error ?? 'chat stream error';
        }
      }
    }

    // Cancel the underlying network read so the server stops streaming.
    try { await reader.cancel(); } catch { /* best-effort */ }

    if (assembled.trim()) {
      // If the stream ended without a proper `done` event, the response was
      // cut off — either by an LLM provider error mid-stream (server sent an
      // `error` event then closed) or by a premature HTTP connection close.
      // Don't silently return partial content: append a visible notice so the
      // user knows to retry rather than assuming the response is complete.
      if (!finished) {
        const reason = streamError
          ? streamError.slice(0, 120)
          : 'connection closed before generation finished';
        return {
          reply:              assembled.trim() + `\n\n*(incomplete response — ${reason})*`,
          sessionId:          capturedSessionId,
          runId:              capturedRunId,
          agentImages:        capturedImages,
          agentFiles:         capturedFiles,
          hadBackgroundSpawn: hadBackgroundSpawn,
        };
      }
      return { reply: assembled.trim(), sessionId: capturedSessionId, runId: capturedRunId, agentImages: capturedImages, agentFiles: capturedFiles, hadBackgroundSpawn };
    }
    // Empty assembled + we saw an error → that's the actual failure to surface.
    if (streamError) throw new Error(streamError);
    // Empty assembled + no error + no `done` → the server hung up early.
    if (!finished) throw new Error('chat stream closed without a response');
    return { reply: '', sessionId: capturedSessionId, runId: capturedRunId, agentImages: capturedImages, agentFiles: capturedFiles, hadBackgroundSpawn };
  } catch (err) {
    // Tag the error with captured ids so liveEditLoop can hand off the
    // placeholder to the timeout-recovery monitor without losing context.
    if (err && typeof err === 'object') {
      (err as { runId?: string | null }).runId = outerCapturedRunId;
      (err as { sessionId?: string | null }).sessionId = outerCapturedSessionId;
    }
    throw err;
  } finally {
    clearTimeout(idleTimer);
  }
}

// Streams LLM tokens into a Discord message in real-time by progressively
// editing a reply. Splits into a new message when the buffer approaches
// Discord's 2000-char limit. The ▌ placeholder must already be posted by
// the caller (handleMessage) before any async work so there's no silence window.
async function liveEditLoop(
  initialMsg: Message,   // already-posted ▌ placeholder
  userMsg: Message,      // original user message — used for reply() on splits
  agentId: string,
  sessionId: string | undefined,
  text: string,
  imageAttachments: Array<{ url: string; mime_type?: string; name?: string }>,
  discordCtx: DiscordTurnContext,
  documents: Array<{ name: string; data: string; mime_type?: string }>,
): Promise<ChatStreamResult> {
  let liveBuffer   = '';
  let lastFlushed  = '';
  let activeMsg    = initialMsg;
  let streamDone   = false;
  // Delivery-integrity tracking. Every Discord write here used to swallow its
  // own failure with `.catch(() => {})` AND advance lastFlushed regardless — so
  // a rejected edit made the flush loop think it was caught up, it broke early,
  // and the tail silently died in the buffer while the dashboard (a separate
  // SSE consumer) showed the full reply. We now only advance lastFlushed on a
  // confirmed write, log every failure, and after N consecutive failures flip
  // deliveryBroken so the loop bails to the chunked re-send self-heal below.
  let flushFailures  = 0;
  let deliveryBroken = false;
  const MAX_FLUSH_FAILURES = 5;

  // Single flush step — called serially by the loop below so there is never
  // more than one in-flight Discord edit at a time.
  const doFlush = async () => {
    if (deliveryBroken) return;        // stop hammering Discord once delivery is known-broken
    if (liveBuffer === lastFlushed) return;

    if (liveBuffer.length >= 1800) {
      // Split path — finalize current message and open a new one.
      // Find a natural language boundary so we don't slice mid-word.
      // Priority: paragraph break > line break > word boundary > hard cut.
      let cut = liveBuffer.lastIndexOf('\n\n', 1990);
      if (cut < 900) cut = liveBuffer.lastIndexOf('\n', 1990);
      if (cut < 900) cut = liveBuffer.lastIndexOf(' ', 1990);
      if (cut < 900) cut = 1990;
      const content = liveBuffer.slice(0, cut);
      try {
        await activeMsg.edit({ content });
      } catch (e) {
        logger.warn('discord-bot: split-finalize edit failed', { agentId, err: e instanceof Error ? e.message : String(e) });
      }
      // Open a new message for the remainder. Retry once before giving up — a
      // single transient 5xx/rate-limit shouldn't clobber message #1's head.
      let opened: Message | null = null;
      for (let attempt = 0; attempt < 2 && !opened; attempt++) {
        try {
          opened = await userMsg.reply('▌');
        } catch (e) {
          logger.warn('discord-bot: split new-message reply failed', { agentId, attempt: attempt + 1, err: e instanceof Error ? e.message : String(e) });
        }
      }
      if (!opened) {
        // Couldn't open a continuation message. Do NOT overwrite message #1's
        // head with the tail (the old bug). Mark delivery broken and let the
        // post-loop self-heal re-send the full reply as fresh chunks.
        flushFailures++;
        if (flushFailures >= MAX_FLUSH_FAILURES) deliveryBroken = true;
        lastFlushed = content;
        liveBuffer  = liveBuffer.slice(cut).trimStart();
        return;
      }
      activeMsg     = opened;
      flushFailures = 0;
      liveBuffer  = liveBuffer.slice(cut).trimStart(); // tokens may have arrived during the awaits above
      lastFlushed = '';                      // reset — avoids a spurious empty-edit on the next tick
    } else {
      // Normal path — edit with cursor appended.
      // Snapshot liveBuffer BEFORE the await so lastFlushed tracks what was
      // actually sent, not tokens that arrive during the Discord round-trip.
      // CRITICAL: only advance lastFlushed when the edit actually committed —
      // setting it on failure is what made the loop think it was caught up and
      // silently drop the tail.
      const snapshot = liveBuffer;
      try {
        await activeMsg.edit({ content: snapshot + '▌' });
        lastFlushed   = snapshot;
        flushFailures = 0;
      } catch (e) {
        flushFailures++;
        logger.warn('discord-bot: live edit failed', { agentId, attempt: flushFailures, err: e instanceof Error ? e.message : String(e) });
        if (flushFailures >= MAX_FLUSH_FAILURES) {
          deliveryBroken = true;       // unblock loop exit; self-heal re-send takes over
          lastFlushed    = snapshot;   // allow the streamDone equality check to release
        }
        // else: leave lastFlushed stale so the next tick RETRIES this content.
      }
    }
  };

  // Flush loop — one edit in flight at a time, serialized with await.
  //
  // Why not setInterval + isFlushing?  When Discord rate-limits a message edit,
  // discord.js blocks the awaiting call for `retry_after` seconds (typically 1–5s).
  // The old isFlushing guard silently skipped every interval tick during that
  // backoff window, so the message appeared frozen even though tokens were still
  // arriving. Replacing the interval with an async loop that awaits each edit
  // means: we always wait for the current edit to resolve, then wait the
  // configured gap, then flush whatever accumulated — no silent drops, no races.
  const FLUSH_INTERVAL_MS = 750; // ~1.3 edits/sec — well within Discord's 5/sec per-route limit
  const flushLoopDone = (async () => {
    while (true) {
      await new Promise<void>(r => setTimeout(r, FLUSH_INTERVAL_MS));
      await doFlush();
      // Bail immediately once delivery is known-broken — the self-heal re-send
      // after the loop delivers the full reply as fresh chunks.
      if (deliveryBroken) break;
      // Exit only after the stream is finished AND the buffer is fully flushed.
      if (streamDone && liveBuffer === lastFlushed) break;
    }
  })();

  // Fix 2 — pre-timeout soft threshold. At 90s elapsed, if the stream is still
  // open AND nothing has been flushed yet, drop a durable "still working"
  // status so the user sees feedback BEFORE the hard abort fires. Doesn't
  // disturb live streaming if tokens are still arriving — only edits when the
  // placeholder is still empty (lastFlushed unchanged).
  const SOFT_THRESHOLD_MS = parseInt(process.env.DISCORD_SOFT_TIMEOUT_MS ?? '90000', 10);
  const softTimer = setTimeout(() => {
    // Only edit if we haven't streamed any actual content yet — otherwise we'd
    // wipe the live token stream. Once the user is seeing tokens flow they
    // don't need a "still working" notice.
    if (liveBuffer.length === 0) {
      activeMsg.edit({
        content: `*(⏳ Still working on it — I'll post the answer here when done)*`,
      }).catch(() => { /* best-effort */ });
    }
  }, SOFT_THRESHOLD_MS);
  if (typeof softTimer.unref === 'function') softTimer.unref();

  let result: ChatStreamResult;
  try {
    result = await streamChatResponse(
      text,
      agentId,
      sessionId,
      imageAttachments,
      discordCtx,
      documents,
      (token) => { liveBuffer += token; },
    );
    clearTimeout(softTimer);
  } catch (err) {
    clearTimeout(softTimer);
    // Signal the flush loop to exit on its next iteration (≤750ms).
    streamDone = true;

    const isTimeout = err instanceof Error &&
      (err.name === 'AbortError' || (err as Error).message === 'This operation was aborted');
    const errText = isTimeout
      ? `*(⏳ still working on this — I'll post the answer here when it's done)*`
      : `*(chat error: ${(err as Error).message.slice(0, 200)})*`;
    await activeMsg.edit({ content: errText }).catch(() => {});

    // Timeout recovery: hand the placeholder off to the background monitor.
    // The monitor owns heartbeat edits AND the final-answer edit when the
    // detached run reaches a terminal state — replacing the inline heartbeat
    // subscription we used to do here. Marking the run delivered=1 after the
    // edit succeeds prevents deliverRun from posting a duplicate reply.
    //
    // We need a runId to hand off. streamChatResponse captures it from the SSE
    // 'run' event the chat handler emits during agent start. If we aborted
    // before that event arrived (extremely rare — run is emitted within the
    // first few ms), we have no runId to monitor and fall back to deliverRun's
    // new-reply path, which is the prior behavior.
    const handoffRunId = (err as { runId?: string }).runId
      ?? (typeof (err as { capturedRunId?: string }).capturedRunId === 'string'
            ? (err as { capturedRunId?: string }).capturedRunId
            : undefined);
    if (isTimeout && sessionId && handoffRunId && handoffRunId.length > 0) {
      startPlaceholderMonitor({
        runId:          handoffRunId,
        sessionId,
        placeholderMsg: activeMsg,
        userMsg,
        botId:          discordCtx.bot_id,
      });
    } else if (isTimeout && sessionId) {
      // No runId captured before abort. Fall back to the legacy heartbeat-only
      // subscription so the placeholder doesn't look frozen while deliverRun
      // (which posts a new reply) waits for run:terminal. Bounded by a safety
      // timer so we never leak a listener on crash paths.
      const THROTTLE_MS = 10_000;
      const MAX_WAIT_MS = 30 * 60_000;
      let lastEdit     = Date.now();
      let unsubscribed = false;
      const unsub = () => {
        if (unsubscribed) return;
        unsubscribed = true;
        agentBus.off('agent', onProgress);
        clearTimeout(safetyTimer);
      };
      const safetyTimer = setTimeout(unsub, MAX_WAIT_MS);
      const onProgress = (e: AgentEvent) => {
        if (e.sessionId !== sessionId) return;
        if (e.type !== 'heartbeat') return;
        const now = Date.now();
        if (now - lastEdit < THROTTLE_MS) return;
        lastEdit = now;
        const label = `*(⏳ Working on it… [${e.currentActivity}])*`;
        activeMsg.edit({ content: label }).catch(() => { unsub(); });
      };
      agentBus.on('agent', onProgress);
    }

    throw err;
  }

  // Signal the flush loop to exit, then wait for it to finish flushing any
  // tokens that arrived in the final SSE chunk before we do the cursor-strip edit.
  // This also prevents the old race where clearInterval() left an in-flight
  // flush() awaiting its discord.js call concurrently with the final edit below.
  streamDone = true;
  await flushLoopDone;

  // Final edit — strip the cursor. Guard against empty-string edit (Discord rejects it).
  // Empty buffer happens when the stream ends exactly at a split boundary.
  if (!deliveryBroken) {
    const finalContent = liveBuffer || '​';  // ​ = zero-width space
    try {
      await activeMsg.edit({ content: finalContent });
    } catch (e) {
      deliveryBroken = true;
      logger.warn('discord-bot: final cursor-strip edit failed', { agentId, err: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── Delivery self-heal ──
  // If the live-edit path failed to commit the full reply, re-send the
  // complete text as fresh chunked messages with retry. This is the safety net
  // that guarantees Discord eventually receives what the dashboard saw — the
  // exact reason "dashboard completed but Discord came up short" happened. In
  // the normal (activeMsg) path liveEditLoop owns delivery end-to-end, so there
  // is no competing re-send to duplicate against.
  if (deliveryBroken && result.reply && result.reply.length > 0) {
    logger.warn('discord-bot: live delivery broken — re-sending full reply as chunks', { agentId, replyLen: result.reply.length });
    for (const c of chunkForDiscord(result.reply, config.discordBot.maxReplyChars)) {
      let sent = false;
      for (let attempt = 0; attempt < 3 && !sent; attempt++) {
        try {
          await userMsg.reply(c);
          sent = true;
        } catch (e) {
          logger.warn('discord-bot: self-heal chunk send failed', { agentId, attempt: attempt + 1, err: e instanceof Error ? e.message : String(e) });
          await new Promise<void>(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
      if (!sent) logger.error('discord-bot: self-heal chunk permanently undeliverable', { agentId });
    }
  }

  // Live delivery is complete. Mark the run delivered so deliverRun bails when
  // endRun fires run:terminal moments later — preventing a duplicate Discord post.
  // Also shuts down Bug #2: if the sweeper false-drops this run before endRun
  // runs, runDeliveryRetrySweep's deliverRun call will see delivered=1 and bail.
  if (result.runId) {
    try { markRunDelivered(result.runId, 1); } catch { /* best-effort */ }
  }

  return result;
}

// Fetches each image captured during a chat turn and posts it as a Discord
// file attachment. Works for both local /uploads/ paths and remote https URLs.
async function postAgentImages(
  images: Array<{ url: string; alt: string; caption: string }>,
  msg:    Message,
): Promise<void> {
  if (!images.length) return;
  const port  = config.dashboard.port;
  const token = config.dashboard.token;
  for (const img of images) {
    try {
      let fetchUrl = img.url;
      if (img.url.startsWith('/')) {
        // Reject any traversal sequence (raw or percent-encoded) rather than
        // trying to sanitize it — only literal /uploads/ and /tmp/ paths pass.
        // Match `..` only as a whole path segment (real traversal) — not `..`
        // inside a filename like `report..final.pdf`, which is legitimate.
        if (/(^|\/)\.\.(\/|$)/.test(img.url) || /%2e/i.test(img.url)) {
          throw new Error(`Rejected path with traversal sequence: ${img.url}`);
        }
        if (!img.url.startsWith('/uploads/') && !img.url.startsWith('/tmp/')) {
          throw new Error(`Rejected non-uploads local path: ${img.url}`);
        }
        fetchUrl = `http://127.0.0.1:${port}${img.url}?token=${encodeURIComponent(token)}`;
      }
      const res = await fetch(fetchUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const ct  = res.headers.get('content-type') || 'image/png';
      const ext = ct.includes('jpeg') ? 'jpg' : (ct.split('/')[1] ?? 'png').replace(/;.*/, '');
      const safeName = (img.alt || 'image').slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `${safeName}.${ext}`;
      const content  = img.caption || undefined;
      await msg.reply({ content, files: [{ attachment: buf, name: filename }] });
    } catch (err) {
      logger.warn('discord-bot: failed to post agent image', { url: img.url, err: (err as Error).message });
    }
  }
}

// ── Per-bot message handler ────────────────────────────────────────────────

// Persist a Discord attachment into the session uploads store, gating on the
// DECLARED size before downloading so a huge file never spikes memory. Oversized
// files are recorded as a surfaced stub (no download). Dedup (by content hash)
// collapses any overlap with the images/docs that also flow through /api/chat.
async function persistDiscordAttachment(
  sessionId: string,
  a: { url: string; name?: string | null; contentType?: string | null; size?: number },
  fetcher: AttachmentFetcher,
): Promise<void> {
  const name = a.name ?? 'attachment';
  const declared = a.size ?? 0;
  if (declared > config.uploads.perFileMaxBytes) {
    await persistUpload({ sessionId, source: 'discord', name, mime: a.contentType ?? null, declaredSize: declared });
    return;
  }
  try {
    // Reuse the per-turn download cache: if this attachment was already fetched
    // for transcription / doc-parse / text-inline, no second download happens.
    const r = await fetcher(a.url);
    if (!r.ok) return;
    await persistUpload({ sessionId, source: 'discord', name, mime: a.contentType ?? null, bytes: r.buf });
  } catch { /* non-fatal — never break the turn over a persistence failure */ }
}

async function handleMessage(bot: RunningBot, msg: Message): Promise<void> {
  if (msg.author.bot) return;
  if (isDuplicateMessage(bot.row.id, msg.id)) {
    logger.warn('discord-bot: duplicate messageCreate skipped', { botId: bot.row.id, messageId: msg.id });
    return;
  }

  const isDm = msg.channel.type === ChannelType.DM;
  const mentioned = bot.client.user ? msg.mentions.has(bot.client.user.id) : false;
  // Resolve channel route with thread inheritance: if the message landed in a
  // thread, the thread's own snowflake won't be in `bot.routes` (threads are
  // created ad-hoc and aren't registered). Fall back to the parent channel's
  // route so threads inherit the parent's agent + auto_reply + require_mention
  // exactly as if the user had posted in the parent. Non-thread channels and
  // DMs are unaffected.
  let channelRoute = bot.routes.get(msg.channelId);
  if (!channelRoute && msg.channel.isThread() && msg.channel.parentId) {
    channelRoute = bot.routes.get(msg.channel.parentId);
  }
  // Auto-reply layered logic:
  //   - guild is opted in via auto_reply_guilds → bot replies without @mention
  //   - UNLESS this specific channel has a route with require_mention=1
  //     (carve-out for shared servers where multiple bots co-exist)
  //   - OR this specific channel has auto_reply=1 → bot replies without @mention
  //     regardless of guild settings (channel "owns" replies; DMs excluded)
  const guildAutoReply   = !!msg.guildId && bot.autoReplyGuilds.has(msg.guildId);
  const channelOverride  = channelRoute?.requireMention === true;
  const channelAutoReply = !!msg.guildId && channelRoute?.autoReply === true;
  const autoReply        = (guildAutoReply && !channelOverride) || channelAutoReply;
  if (!isDm && !mentioned && !autoReply) return;

  // Allowlist (still env-based — applies to all bots; per-bot allowlist is v1.8 polish).
  const allow = config.discordBot.allowedUsers;
  if (allow.length > 0 && !allow.includes(msg.author.id)) {
    logger.warn('discord-bot: ignored message from non-allowlisted user', { botId: bot.row.id, userId: msg.author.id });
    return;
  }

  // Post ▌ immediately — before any async work — so the user sees a response
  // within milliseconds of the bot deciding to reply. Passed into liveEditLoop
  // as the first message to edit. Null if the channel became unsendable.
  let activeMsg: Message | null = null;
  if (msg.channel.isSendable()) {
    activeMsg = await msg.reply('▌').catch(() => null);
  }

  const botMention = bot.client.user ? `<@${bot.client.user.id}>` : '';
  let text = msg.content.replace(new RegExp(botMention, 'g'), '').trim();
  // Snapshot the user's ACTUAL words (typed text, plus voice transcripts added
  // below) before any attachment augmentation. Voice-pref intent detection runs
  // on this — never on inlined file contents or document notes — otherwise a
  // user uploading a file whose body contains "text-only" would silently
  // disable their audio replies. See the detectVoicePrefIntent call below.
  const typedText = text;
  let transcribedText = '';

  // Fast-path slash commands BEFORE any attachment download / transcription.
  // dispatchSlash requires a leading '/', so a "/foo" message that also carries
  // an attached file shouldn't pay transcription + document-download cost just
  // to be discarded. Resolve agent + session early (both cheap + idempotent via
  // getOrCreateSessionByExternalId) and dispatch; on a hit we delete the
  // placeholder and return. Non-slash messages fall through unchanged.
  if (text.startsWith('/')) {
    const slashAgentId = channelRoute?.agentId ?? bot.row.default_agent_id ?? resolveAgentId(config.discordBot.defaultAgent);
    if (slashAgentId) {
      const slashExtId = sessionExternalId(bot.row.id, msg);
      const slashSessionId = getOrCreateSessionByExternalId(
        slashExtId,
        slashAgentId,
        undefined,
        'discord',
      );
      const handled = await dispatchSlash(text, {
        sessionId: slashSessionId,
        surface:   'discord',
        agentId:   slashAgentId,
        reply:     async (replyText) => { if (msg.channel.isSendable()) await msg.reply(replyText); },
      });
      if (handled) {
        if (activeMsg) await activeMsg.delete().catch(() => { /* best-effort */ });
        return;
      }
    }
  }

  // One download cache for the whole turn — transcription, doc-parse, text-inline
  // and upload-persist all pull through this, so no attachment is fetched twice.
  const fetchAttachment = makeAttachmentFetcher();

  // Kick off document (PDF / DOCX / EPUB / HTML) fetch immediately so Discord's
  // signed CDN URLs don't expire while audio transcription is running. We await
  // the promise below where the result is actually consumed.
  const docCandidatesEarly = [...msg.attachments.values()]
    .filter(a => isDocumentAttachment(a.name ?? null, a.contentType ?? null))
    .map(a => ({ url: a.url, name: a.name ?? null, contentType: a.contentType ?? null, size: a.size ?? 0 }));
  const docFetchPromise = docCandidatesEarly.length > 0
    ? fetchDocumentAttachments(docCandidatesEarly, DOC_PER_FILE_MAX_BYTES, DOC_TOTAL_MAX_BYTES, fetchAttachment)
    : Promise.resolve({ docs: [] as FetchedDocument[], skipped: [] as string[] });

  // Voice notes: transcribe audio attachments BEFORE checking emptiness so a
  // mic-only message ("press and hold to talk") still routes to the agent.
  // We accept multiple audio attachments (rare, but Discord allows it) and
  // concatenate the transcripts in attachment order.
  const audioAttachments = [...msg.attachments.values()].filter(a => (a.contentType ?? '').startsWith('audio/'));
  if (audioAttachments.length > 0) {
    const transcripts: string[] = [];
    for (const a of audioAttachments) {
      try {
        const r = await fetchAttachment(a.url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = r.buf;
        const { text: t } = await transcribe({ audio: buf, mimeType: a.contentType ?? 'audio/ogg', filename: a.name ?? undefined });
        if (t.trim()) transcripts.push(t.trim());
      } catch (err) {
        logger.warn('discord-bot: transcription failed', { botId: bot.row.id, attachment: a.name, err: (err as Error).message });
      }
    }
    if (transcripts.length > 0) {
      const joined = transcripts.join('\n');
      transcribedText = joined;
      text = text ? `${text}\n\n${joined}` : joined;
    }
  }

  // Plain-text attachments: download .md/.txt/.json/source files and inline
  // their contents as fenced markdown blocks so any LLM provider can see
  // them. Per-file 200 KB cap, total 800 KB cap. Images / audio / PDFs are
  // handled (or deferred) elsewhere.
  const textCandidates = [...msg.attachments.values()]
    .filter(a => isTextAttachment(a.name ?? null, a.contentType ?? null))
    .map(a => ({ url: a.url, name: a.name ?? null, contentType: a.contentType ?? null, size: a.size ?? 0 }));
  if (textCandidates.length > 0) {
    const result = await fetchTextAttachments(textCandidates, TEXT_FILE_TOTAL_MAX_BYTES, fetchAttachment);
    if (result.files.length > 0) {
      const blocks = result.files.map(file => {
        const lang = fenceLanguageFor(file.name);
        // Upgrade fence to four backticks if the body contains triple backticks
        // so an embedded markdown sample can't prematurely close our block.
        const fence = file.body.includes('```') ? '````' : '```';
        const truncatedNote = file.truncated ? ' · truncated' : '';
        const header = `[File: ${file.name} · ${file.bytes} bytes${truncatedNote}]`;
        return `${header}\n${fence}${lang}\n${file.body}\n${fence}`;
      });
      const joined = blocks.join('\n\n');
      text = text ? `${text}\n\n${joined}` : joined;
    }
    if (result.skipped.length > 0) {
      logger.warn('discord-bot: text attachments skipped', { botId: bot.row.id, skipped: result.skipped });
    }
  }

  // Binary document attachments (PDF / DOCX / EPUB / HTML): await the fetch
  // that was already started above (before audio transcription) so the bytes
  // are ready without racing against Discord's signed URL expiry.
  let documents: FetchedDocument[] = [];
  let docSkipped: string[] = [];
  if (docCandidatesEarly.length > 0) {
    const result = await docFetchPromise;
    documents  = result.docs;
    docSkipped = result.skipped;
    if (docSkipped.length > 0) {
      logger.warn('discord-bot: document attachments skipped', { botId: bot.row.id, skipped: docSkipped });
    }
    if (documents.length > 0) {
      // Append a short user-visible note about which docs are in play. The
      // detailed system block (attachment_ids + how to fetch) is injected
      // server-side by /api/chat once the docs are registered.
      const names = documents.map(d => d.name).join(', ');
      const note = `[Attached document${documents.length === 1 ? '' : 's'}: ${names}]`;
      text = text ? `${text}\n\n${note}` : note;
    }
  }

  // Allow image-only AND document-only messages (text empty but attachments
  // present) — the chat API accepts attachments without a text body. The
  // agent will see native images, preprocessed image descriptions, or the
  // attachment registry descriptors for binary documents.
  const hasImages = msg.attachments.some(a => (a.contentType ?? '').startsWith('image/'));
  if (!text && !hasImages && documents.length === 0) {
    if (activeMsg) await activeMsg.delete().catch(() => {});
    if (msg.channel.isSendable()) await msg.reply('Yes? (mention me with a question)');
    return;
  }

  // Surface document-rejection errors to the user up front so they don't
  // wonder why their PDF was ignored. The agent reply still goes through.
  if (docSkipped.length > 0 && msg.channel.isSendable()) {
    const lines = docSkipped.map(s => `  • ${s}`).join('\n');
    await msg.reply(`*Heads up — some documents couldn't be attached:*\n${lines}`).catch(() => {});
  }

  // Resolve agent: per-channel route → bot's default → instance default.
  const routeAgentId = channelRoute?.agentId;
  const agentId = routeAgentId ?? bot.row.default_agent_id ?? resolveAgentId(config.discordBot.defaultAgent);
  if (!agentId) {
    if (activeMsg) await activeMsg.delete().catch(() => {});
    if (msg.channel.isSendable()) await msg.reply(`*(no agent route — set a default for bot "${bot.row.name}" or add a channel route)*`);
    return;
  }

  logger.info('discord-bot: message received', { botId: bot.row.id, channelId: msg.channelId, userId: msg.author.id, isDm, textLen: text.length });

  // Resolve (or create) a persistent session for this (bot, channel, user) combo.
  // getOrCreateSessionByExternalId stores the mapping in SQLite so it survives
  // process restarts — the old in-memory Map was wiped on every restart, which
  // caused "a whole new session" to be opened for every restart regardless of
  // whether a conversation was already in progress.
  const extId = sessionExternalId(bot.row.id, msg);
  const sessionId = getOrCreateSessionByExternalId(
    extId,
    agentId,
    undefined,
    'discord',
  );

  // Persist EVERY attachment (images, audio, docs, text, arbitrary) into the
  // session uploads store so any type is discoverable via list_uploads /
  // get_upload and revisitable later. Audio/text/arbitrary files would
  // otherwise be transcript-only / inlined / dropped. Images + documents also
  // flow through /api/chat below; dedup collapses the duplicate.
  for (const a of msg.attachments.values()) {
    await persistDiscordAttachment(sessionId, {
      url: a.url, name: a.name, contentType: a.contentType, size: a.size,
    }, fetchAttachment);
  }

  // Pull image attachments off the Discord message. We only forward what
  // looks like an image — Discord lets users attach arbitrary files (PDFs,
  // .zips) but vision models care about images. Filter on contentType prefix.
  let imageAttachments: Array<{ url: string; mime_type?: string; name?: string }> = [...msg.attachments.values()]
    .filter(a => (a.contentType ?? '').startsWith('image/'))
    .map(a => ({ url: a.url, mime_type: a.contentType ?? undefined, name: a.name ?? undefined }));

  // Image carryover: if this turn has images, cache them for future text-only
  // turns. If this turn has NO images but a recent cached set exists, inject it
  // so the agent can answer follow-up questions ("solve this", "what does it say?")
  // without requiring the user to re-upload the same image.
  if (imageAttachments.length > 0) {
    sessionPendingImages.set(sessionId, { images: imageAttachments, storedAt: Date.now() });
  } else {
    const pending = sessionPendingImages.get(sessionId);
    if (pending && Date.now() - pending.storedAt <= PENDING_IMAGE_TTL_MS) {
      imageAttachments = pending.images;
      logger.debug('discord-bot: injecting image from previous turn', {
        sessionId, botId: bot.row.id, count: imageAttachments.length,
      });
    } else if (pending) {
      // TTL expired — drop the stale entry
      sessionPendingImages.delete(sessionId);
    }
  }

  // Document carryover: mirror the image logic above. If this turn carried
  // documents, cache their bytes for later text-only turns; otherwise re-inject
  // a recent cached set so the agent keeps the document context on follow-ups
  // without the user re-uploading. We cache BYTES (not the Discord CDN URL), so
  // an expired signed link can't break the follow-up — the exact failure the
  // user hit. The registry dedups by content hash, so re-feeding is cheap.
  if (documents.length > 0) {
    sessionPendingDocuments.set(sessionId, { documents, storedAt: Date.now() });
  } else {
    const pendingDocs = sessionPendingDocuments.get(sessionId);
    if (pendingDocs && Date.now() - pendingDocs.storedAt <= PENDING_DOC_TTL_MS) {
      documents = pendingDocs.documents;
    } else {
      if (pendingDocs) sessionPendingDocuments.delete(sessionId);
      // Durable fallback: the in-memory carryover is cold (e.g. after a server
      // restart), but the document may still be in the durable attachment store.
      const durable = getSessionDocuments(sessionId, PENDING_DOC_TTL_MS);
      if (durable.length > 0) {
        documents = durable.map(d => ({
          name:      d.name,
          mime_type: d.mime_type,
          data:      d.data,
          size:      Buffer.byteLength(Buffer.from(d.data, 'base64')),
        }));
        sessionPendingDocuments.set(sessionId, { documents, storedAt: Date.now() });
      }
    }
    if (documents.length > 0) {
      const names = documents.map(d => d.name).join(', ');
      const note = `[Attached document${documents.length === 1 ? '' : 's'} (from earlier in this conversation): ${names}]`;
      text = text ? `${text}\n\n${note}` : note;
      logger.debug('discord-bot: injecting document(s) from previous turn', {
        sessionId, botId: bot.row.id, count: documents.length,
      });
    }
  }

  // Detect "stop sending audio" / "voice on" intents in the user's message
  // BEFORE we route to the LLM. Flipping the pref here means the very turn the
  // user objects on is also text-only — the post-reply audio gate consults the
  // pref we just wrote.
  // Run ONLY against the user's typed words + transcribed speech (see typedText
  // / transcribedText snapshots above), never the attachment-augmented `text`.
  const voiceIntentSource = transcribedText
    ? `${typedText}\n${transcribedText}`.trim()
    : typedText;
  const voiceIntent = detectVoicePrefIntent(voiceIntentSource);
  if (voiceIntent === 'off') {
    setDiscordVoicePref(bot.row.id, msg.author.id, false, 'user requested no audio');
    logger.info('discord-bot: voice pref OFF (user intent)', { botId: bot.row.id, userId: msg.author.id });
  } else if (voiceIntent === 'on') {
    setDiscordVoicePref(bot.row.id, msg.author.id, true, 'user requested audio');
    logger.info('discord-bot: voice pref ON (user intent)', { botId: bot.row.id, userId: msg.author.id });
  }

  // Pre-compute whether this turn will have its text reply auto-synthesized
  // to audio. The mp3 attach happens after the chat call regardless, but the
  // agent needs to know NOW so it doesn't tell the user "I'm text-only."
  // Resolution rules:
  //   - DM or @mention: bot toggle AND agent toggle AND (no per-user pref OR pref is on).
  //   - Auto-reply (channel reply with no @mention): the same gates AND the
  //     user has explicitly opted IN via a per-user pref. Auto-reply audio is
  //     intrusive in shared channels, so we treat "no preference set" as "no
  //     audio" — the user has to ask for it once before the bot starts attaching.
  const turnAgent = getAgentById(agentId);
  const userPref  = getDiscordVoicePref(bot.row.id, msg.author.id);
  const userVoiceOptedOut = userPref?.voice_enabled === 0;
  const userVoiceOptedIn  = userPref?.voice_enabled === 1;
  const wasAutoReply = !isDm && !mentioned;     // we already short-circuited if all three were false
  const voiceReplyEnabled = !!(
    bot.row.voice_enabled &&
    turnAgent?.tts_enabled &&
    !userVoiceOptedOut &&
    (wasAutoReply ? userVoiceOptedIn : true)
  );

  const discordCtx: DiscordTurnContext = {
    bot_id:      bot.row.id,
    bot_name:    bot.row.name,
    channel_id:  msg.channelId,
    guild_id:    msg.guildId ?? null,
    message_id:  msg.id,
    author_id:   msg.author.id,
    author_name: msg.author.username ?? msg.author.tag ?? msg.author.id,
    voice_reply_enabled: voiceReplyEnabled,
  };

  logger.info('discord-bot: calling agent', { botId: bot.row.id, agentId, channelId: msg.channelId, sessionId });

  let result: ChatStreamResult = { reply: '', sessionId: null, runId: null, agentImages: [], agentFiles: [], hadBackgroundSpawn: false };
  try {
    if (activeMsg) {
      // Live streaming path — tokens appear in Discord as they arrive.
      // /api/chat already serializes turns per session; no queue wrapping needed here.
      result = await liveEditLoop(activeMsg, msg, agentId, sessionId, text, imageAttachments, discordCtx, documents);
    } else {
      // Fallback: channel became unsendable after the initial ▌ post attempt.
      // Collect the full reply silently and send in chunks if the channel recovers.
      result = await streamChatResponse(text, agentId, sessionId, imageAttachments, discordCtx, documents);
      if (result.reply && msg.channel.isSendable()) {
        for (const c of chunkForDiscord(result.reply, config.discordBot.maxReplyChars)) {
          await msg.reply(c);
        }
      }
    }
  } catch (err) {
    const errMsg = (err as Error).message;
    const isTimeout = (err as Error).name === 'AbortError' || errMsg === 'This operation was aborted';
    logger.error('discord-bot: chat call failed', {
      botId: bot.row.id,
      err:   errMsg,
      kind:  isTimeout ? `timeout after ${STREAM_TIMEOUT_MS / 1000}s` : 'stream error',
    });
    // liveEditLoop already edited the live message with the error text.
    // For the fallback path (activeMsg null), post a new error reply.
    if (!activeMsg && msg.channel.isSendable()) {
      const label = isTimeout
        ? `*(⏳ still working on this — I'll post the answer here when it's done)*`
        : `*(chat error: ${errMsg.slice(0, 200)})*`;
      await msg.reply(label);
    }
    return;
  }

  logger.info('discord-bot: agent replied', { botId: bot.row.id, agentId, replyLen: result.reply.length });

  if (!result.reply) {
    if (result.hadBackgroundSpawn) {
      // Agent delegated to a background sub-agent and produced no text itself.
      // Show a holding message — the sub-agent's result will be delivered separately.
      logger.info('discord-bot: empty reply after background spawn — showing holding message', { botId: bot.row.id, agentId, sessionId: result.sessionId });
      const holdingText = `*(⏳ Working on it — I'll post the result here when it's done)*`;
      if (activeMsg) {
        await activeMsg.edit({ content: holdingText }).catch(() => {});
      } else if (msg.channel.isSendable()) {
        await msg.reply(holdingText);
      }
    } else {
      logger.warn('discord-bot: empty reply — agent produced no text output', { botId: bot.row.id, agentId, sessionId: result.sessionId });
      if (activeMsg) {
        await activeMsg.edit({ content: '*(no response)*' }).catch(() => {});
      } else if (msg.channel.isSendable()) {
        await msg.reply('*(no response)*');
      }
    }
    return;
  }

  // Voice reply: same gate as voiceReplyEnabled above, re-evaluated post-turn
  // so a tool call mid-stream (discord_set_user_voice) takes effect on this
  // very reply. Auto-reply turns require an explicit per-user opt-in — without
  // one the bot stays text-only on unsolicited replies in shared channels.
  const finalUserPref = getDiscordVoicePref(bot.row.id, msg.author.id);
  const finalUserOptedOut = finalUserPref?.voice_enabled === 0;
  const finalUserOptedIn  = finalUserPref?.voice_enabled === 1;
  const audioGate = bot.row.voice_enabled && !finalUserOptedOut && (wasAutoReply ? finalUserOptedIn : true);
  if (audioGate) {
    const agent = getAgentById(agentId);
    if (agent && agent.tts_enabled) {
      try {
        const voice = resolveAgentVoice(agent);
        const cacheKey = buildAudioCacheKey(voice.provider, voice.voiceId || 'default', 'default', result.reply);
        const cached = getCachedAudio(cacheKey);
        if (cached) {
          await msg.reply({
            content: '',
            files: [{ attachment: Buffer.from(cached.audio_blob), name: `voice-${Date.now()}.mp3` }],
          });
        } else {
          // Enqueue TTS generation so the reply path stays fast. One job per
          // reply: the job worker splits the text into chunks internally and
          // synthesizes+delivers them sequentially, so multi-chunk audio always
          // arrives in order (separate jobs raced and interleaved).
          enqueueJob('tts_synthesize', {
            text: result.reply,
            provider: voice.provider,
            voiceId: voice.voiceId || undefined,
            format: 'mp3',
            agentId,
            sessionId: sessionId,
            replyTarget: 'discord',
            discordContext: {
              botId:     bot.row.id,
              channelId: msg.channelId,
              messageId: msg.id,
              userId:    msg.author.id,
            },
          }, 5);
        }
      } catch (err) {
        logger.warn('discord-bot: tts failed', { botId: bot.row.id, agentId, err: (err as Error).message });
      }
    }
  }

  // Post any inline images the agent generated (e.g. via generate_image / send_image_to_user).
  await postAgentImages(result.agentImages, msg);
  await postAgentFiles(result.agentFiles, msg);
}

// Fetches each file captured during a chat turn and posts it as a Discord
// file attachment. Mirrors postAgentImages() — handles both local /uploads/
// paths and remote https URLs. Caption becomes the Discord message content.
async function postAgentFiles(
  files: Array<{ url: string; filename: string; mime: string; size: number; caption: string }>,
  msg:   Message,
): Promise<void> {
  if (!files.length) return;
  const port  = config.dashboard.port;
  const token = config.dashboard.token;
  for (const file of files) {
    try {
      let resolvedUrl: string;
      if (file.url.startsWith('/')) {
        // Guard: only literal /uploads/ and /tmp/ paths — reject any traversal
        // sequence (raw or percent-encoded) outright instead of sanitizing.
        // Match `..` only as a whole path segment (real traversal) — not `..`
        // inside a filename like `report..final.pdf`, which is legitimate.
        if (/(^|\/)\.\.(\/|$)/.test(file.url) || /%2e/i.test(file.url)) {
          throw new Error(`Rejected path with traversal sequence: ${file.url}`);
        }
        if (!file.url.startsWith('/uploads/') && !file.url.startsWith('/tmp/')) {
          throw new Error(`Rejected non-uploads local path: ${file.url}`);
        }
        resolvedUrl = `http://127.0.0.1:${port}${file.url}?token=${encodeURIComponent(token)}`;
      } else {
        resolvedUrl = file.url;
      }
      const res = await fetch(resolvedUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > DISCORD_FILE_MAX_BYTES) {
        await msg.reply({ content: `⚠️ \`${file.filename}\` is too large to attach (${(buf.length / 1_048_576).toFixed(1)} MB — Discord limit is 25 MB).` });
        continue;
      }
      await msg.reply({
        content: file.caption || undefined,
        files:   [{ attachment: buf, name: file.filename }],
      });
    } catch (err) {
      logger.warn('discord-bot: failed to post agent file', {
        url: file.url, filename: file.filename, err: (err as Error).message,
      });
    }
  }
}

// ── Per-bot lifecycle ──────────────────────────────────────────────────────

async function startBot(row: DiscordBotRow): Promise<void> {
  if (running.has(row.id)) return;          // already running
  // Skip a bot that previously failed permanently — but ONLY while its token is
  // unchanged. If the operator edited the token (a deliberate fix), drop the
  // record and re-attempt with the new token instead of dead-ending until a
  // manual restart.
  const failedToken = permanentlyFailedBots.get(row.id);
  if (failedToken !== undefined) {
    if (failedToken === row.token) return; // same bad token — still hopeless, don't spin
    permanentlyFailedBots.delete(row.id);  // token changed — give the new one a chance
  }
  if (!row.enabled || !row.token) {
    updateDiscordBot(row.id, { status: 'disabled' });
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel],
  });

  const bot: RunningBot = {
    client,
    row,
    routes:          loadRoutesForBot(row.id),
    autoReplyGuilds: new Set(parseAutoReplyGuilds(row.auto_reply_guilds)),
    startedAt:       Date.now(),
    unhealthySince:  null,
    lastCloseCode:   null,
    permanentFailureLogged: false,
    commandsRegistered: false,
  };
  running.set(row.id, bot);
  updateDiscordBot(row.id, { status: 'connecting', last_started_at: new Date().toISOString() });

  // Use `on` (not `once`) so the status is updated back to `ready` on every
  // reconnect — discord.js re-fires `ready` after each successful reconnection,
  // and missing those events leaves the dashboard stuck showing `error` even
  // when the bot has recovered.
  client.on('ready', () => {
    const u = client.user;
    logger.info('discord-bot: ready', { botId: row.id, name: row.name, tag: u?.tag, guilds: client.guilds.cache.size });
    bot.unhealthySince = null;
    bot.lastCloseCode = null;            // a clean connect clears any prior permanent-failure suspicion
    bot.permanentFailureLogged = false;
    updateDiscordBot(row.id, {
      status:        'ready',
      status_detail: null,
      bot_user_id:   u?.id ?? null,
      bot_user_tag:  u?.tag ?? null,
    });
    
    // Track Discord bot connection in analytics
    logAnalytics('discord_connected', {
      botId: row.id,
      botName: row.name,
      botTag: u?.tag,
      guildCount: client.guilds.cache.size,
    });

    // Register built-in commands + any skills the bot owner has opted in to.
    // 'ready' fires again on every gateway reconnect, but the command catalog
    // doesn't change at runtime — re-pushing it to every guild on each resume is
    // pure rate-limit churn. Do it once per process.
    if (bot.commandsRegistered) return;
    bot.commandsRegistered = true;
    const optType = (t: 'string' | 'integer' | 'boolean') =>
      t === 'integer' ? ApplicationCommandOptionType.Integer
      : t === 'boolean' ? ApplicationCommandOptionType.Boolean
      : ApplicationCommandOptionType.String;
    const builtinCmds = getCommandCatalog('discord').map(cmd => ({
      name:        cmd.name,
      description: cmd.description.length > 100
        ? (logger.warn('discord-bot: command description truncated', { name: cmd.name }), cmd.description.slice(0, 100))
        : cmd.description,
      // Discord requires required options declared BEFORE optional ones — sort
      // defensively so a future mixed-option command can't produce an invalid
      // registration payload.
      options: (cmd.options ?? [])
        .slice()
        .sort((a, b) => Number(b.required ?? false) - Number(a.required ?? false))
        .map(o => ({
          name:        o.name,
          description: o.description.slice(0, 100),
          type:        optType(o.type),
          required:    !!o.required,
        })),
    }));
    const registeredSkillNames = getDiscordBotSkills(row.id);
    const allSkills = listSkills();
    const skillCmds = registeredSkillNames
      .map(name => allSkills.find(s => s.name === name))
      .filter((s): s is NonNullable<typeof s> => s != null)
      .map(s => ({
        name: s.name,
        description: (s.description || `Run the ${s.name} skill`).slice(0, 100),
      }));
    const catalog = [...builtinCmds, ...skillCmds];
    // GLOBAL registration: commands work in every guild the bot is in AND in
    // DMs, and auto-apply to guilds the bot joins later — no per-guild re-push,
    // no restart needed for new servers. (~1h first propagation, then cached.)
    client.application?.commands.set(catalog)
      .then(() => logger.info('discord-bot: registered global slash commands', { botId: row.id, count: catalog.length }))
      .catch(err =>
        logger.error('discord-bot: failed to register global slash commands', { botId: row.id, err: (err as Error).message }),
      );
    // One-time cleanup: earlier builds registered commands PER GUILD. Clear those
    // stale guild-scoped copies so they don't render as duplicates alongside the
    // new globals. Best-effort; harmless if a guild had none.
    client.guilds.cache.forEach(guild => {
      guild.commands.set([]).catch(() => { /* best-effort stale-guild clear */ });
    });
  });

  client.on('interactionCreate', (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    // Same allowlist gate as handleMessage — slash commands must not be a
    // bypass when the operator has restricted the bot to specific users.
    const allow = config.discordBot.allowedUsers;
    if (allow.length > 0 && !allow.includes(interaction.user.id)) {
      logger.warn('discord-bot: ignored slash command from non-allowlisted user', { botId: row.id, userId: interaction.user.id, command: interaction.commandName });
      interaction.reply({ content: 'You are not authorized to use this bot.', ephemeral: true }).catch(() => { /* best-effort */ });
      return;
    }
    const agentId = row.default_agent_id ?? resolveAgentId(config.discordBot.defaultAgent);
    if (!agentId) return;
    const extId = `discord::${row.id}::${interaction.channelId ?? interaction.user.id}::${interaction.user.id}`;
    const sessionId = getOrCreateSessionByExternalId(
      extId,
      agentId,
      undefined,
      'discord',
    );
    // Reconstruct the raw args string from the native option values so
    // arg-taking commands (/rename, /pin off, /archive off, /workflow run …)
    // actually receive their arguments instead of firing with an empty string.
    const cmdMeta = getCommandCatalog('discord').find(c => c.name === interaction.commandName);
    const slashArgs = reconstructArgs(
      cmdMeta?.options,
      (n) => interaction.options.get(n)?.value as string | number | boolean | undefined,
    );
    dispatchSlash(`/${interaction.commandName}${slashArgs ? ` ${slashArgs}` : ''}`, {
      sessionId,
      surface: 'discord',
      agentId,
      reply: async (text) => {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: text, ephemeral: true });
        } else {
          await interaction.reply({ content: text, ephemeral: true });
        }
      },
    }).then(async (handled) => {
      if (handled) return;
      // Not a built-in — check if it's a registered skill for this bot.
      const skill = listSkills().find(s => s.name === interaction.commandName);
      if (!skill?.body) return;
      await interaction.deferReply();
      const result = await streamChatResponse(
        `[Skill activated: /${skill.name}]\n${skill.body}`,
        agentId,
        sessionId,
        [],
        undefined,
      );
      const reply = result.reply?.trim() || '(no response)';
      // Chunk instead of hard-truncating at 2000 — a long skill reply previously
      // lost its tail silently. First chunk goes to the deferred reply, the rest
      // as follow-ups (valid within the interaction token window). Each send is
      // guarded so an expired token / failed part doesn't throw out of the chain.
      const parts = chunkForDiscord(reply, 2000);
      await interaction.editReply({ content: parts[0] }).catch(err =>
        logger.warn('discord-bot: skill reply editReply failed', { botId: row.id, err: (err as Error).message }));
      for (const part of parts.slice(1)) {
        await interaction.followUp({ content: part }).catch(err =>
          logger.warn('discord-bot: skill reply follow-up failed', { botId: row.id, err: (err as Error).message }));
      }
    }).catch(err =>
      logger.error('discord-bot: interaction dispatch failed', { botId: row.id, err: (err as Error).message }),
    );
  });

  client.on('messageCreate', (msg) => {
    handleMessage(bot, msg).catch(err => logger.error('discord-bot: handler crashed', { botId: row.id, err: (err as Error).message }));
  });

  client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
    const ctx: BotVoiceContext = {
      botId:  bot.row.id,
      client: bot.client,
      routes: bot.routes,
      row:    bot.row,
    };
    handleVoiceStateUpdate(ctx, oldState, newState).catch(err =>
      logger.error('discord-bot: voice handler crashed', { botId: row.id, err: (err as Error).message }),
    );
  });

  client.on('error', (err) => {
    logger.error('discord-bot: gateway error', { botId: row.id, err: err.message });
    bot.unhealthySince = bot.unhealthySince ?? Date.now();
    updateDiscordBot(row.id, { status: 'error', status_detail: err.message.slice(0, 240) });
    
    // Track Discord bot error in analytics
    logAnalytics('discord_error', {
      botId: row.id,
      botName: row.name,
      errorType: 'gateway',
      message: err.message,
    });
  });

  // WebSocket-level errors from individual shards — logged separately from
  // the client-level `error` event so they show up in the dashboard logs.
  client.on('shardError', (err, shardId) => {
    logger.warn('discord-bot: shard WebSocket error', { botId: row.id, shardId, err: err.message });
    bot.unhealthySince = bot.unhealthySince ?? Date.now();
    
    // Track shard errors in analytics
    logAnalytics('discord_error', {
      botId: row.id,
      botName: row.name,
      errorType: 'shard',
      shardId,
      message: err.message,
    });
  });

  // Shard disconnected — could be a transient network blip. discord.js will
  // attempt to reconnect automatically; we update the status so the dashboard
  // doesn't show `ready` while the connection is actually down.
  client.on('shardDisconnect', (closeEvent, shardId) => {
    logger.warn('discord-bot: shard disconnected', { botId: row.id, shardId, code: closeEvent.code, reason: closeEvent.reason });
    bot.unhealthySince = bot.unhealthySince ?? Date.now();
    bot.lastCloseCode = closeEvent.code;
    if (!client.isReady()) {
      updateDiscordBot(row.id, { status: 'connecting', status_detail: `reconnecting (close code ${closeEvent.code})` });
    }
    
    // Track disconnects in analytics
    logAnalytics('discord_disconnected', {
      botId: row.id,
      botName: row.name,
      shardId,
      closeCode: closeEvent.code,
      reason: closeEvent.reason,
    });
  });

  try {
    await client.login(row.token);
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('discord-bot: login failed', { botId: row.id, err: msg });
    if (isPermanentLoginError(msg)) {
      // Invalid token / disallowed intents recur on every retry — stop the
      // reload loop from re-login spinning. Cleared by a manual restart.
      permanentlyFailedBots.set(row.id, row.token ?? '');
      logger.error('discord-bot: permanent login failure — not auto-retrying; fix token/intents then restart the bot', { botId: row.id, name: row.name });
    }
    updateDiscordBot(row.id, { status: 'error', status_detail: msg.slice(0, 240) });
    running.delete(row.id);
    try { await client.destroy(); } catch { /* ignore */ }
    
    // Track login failure in analytics
    logAnalytics('discord_error', {
      botId: row.id,
      botName: row.name,
      errorType: 'login',
      message: msg,
    });
  }
}

async function stopBot(botId: string): Promise<void> {
  const bot = running.get(botId);
  if (!bot) return;
  running.delete(botId);
  seenMessageIds.delete(botId); // free dedup set so stopped bots don't leak memory
  await destroyBotSessions(botId);
  try { await bot.client.destroy(); } catch { /* ignore */ }
  updateDiscordBot(botId, { status: 'idle', status_detail: null });
  logger.info('discord-bot: stopped', { botId });
  
  // Track bot stop in analytics
  const uptimeMs = Date.now() - bot.startedAt;
  logAnalytics('discord_stopped', {
    botId,
    botName: bot.row.name,
    uptimeMs,
    reason: 'manual_stop',
  });
}

// ── Reload loop ────────────────────────────────────────────────────────────

async function reload(): Promise<void> {
  const desired = listDiscordBots(true);
  const desiredById = new Map(desired.map(b => [b.id, b]));

  // Stop bots that are gone or disabled
  for (const [id] of running) {
    const want = desiredById.get(id);
    if (!want || !want.enabled) await stopBot(id);
  }

  // Start (or restart on token change) bots that are enabled
  for (const row of desired) {
    if (!row.enabled) continue;
    const live = running.get(row.id);
    if (!live) {
      await startBot(row);
      continue;
    }
    // Restart if the token changed (re-login required)
    if (live.row.token !== row.token) {
      logger.info('discord-bot: token changed, restarting', { botId: row.id });
      await stopBot(row.id);
      await startBot(row);
      continue;
    }
    // Permanent gateway failures (e.g. 4014 Disallowed Intents) recur on every
    // reconnect — restarting just spins. Surface the cause once and stop here;
    // an operator fix + manual restart is required. Note: a successful `ready`
    // resets lastCloseCode, so a healthy bot never trips this.
    if (live.lastCloseCode !== null && PERMANENT_GATEWAY_CLOSE_CODES.has(live.lastCloseCode) && !live.client.isReady()) {
      if (!live.permanentFailureLogged) {
        live.permanentFailureLogged = true;
        logger.error('discord-bot: permanent gateway failure — not auto-restarting; check token / privileged intents, then restart', { botId: row.id, name: row.name, closeCode: live.lastCloseCode });
        logAnalytics('discord_error', { botId: row.id, botName: row.name, errorType: 'permanent_close', closeCode: live.lastCloseCode });
        updateDiscordBot(row.id, { status: 'error', status_detail: `permanent gateway failure (close code ${live.lastCloseCode}) — check token / privileged intents` });
      }
      // Still refresh cached row/routes so an operator's edit is picked up.
      live.row             = row;
      live.routes          = loadRoutesForBot(row.id);
      live.autoReplyGuilds = new Set(parseAutoReplyGuilds(row.auto_reply_guilds));
      continue;
    }

    // Restart bots that have been unhealthy for more than 2 reload cycles.
    // discord.js retries reconnection on its own for most transient errors, but
    // a non-permanent close code can still wedge the client. We give it 2× the
    // reload interval before forcing a full stop+start so transient reconnects
    // aren't interrupted.
    const unhealthyMs = RELOAD_INTERVAL_SEC * 2 * 1000;
    if (live.unhealthySince !== null && !live.client.isReady() && Date.now() - live.unhealthySince > unhealthyMs) {
      logger.warn('discord-bot: bot has been unhealthy, forcing restart', { botId: row.id, unhealthySec: Math.round((Date.now() - live.unhealthySince) / 1000) });
      
      // Track forced restart in analytics
      const unhealthySec = Math.round((Date.now() - live.unhealthySince) / 1000);
      logAnalytics('discord_restart', {
        botId: row.id,
        botName: row.name,
        reason: 'unhealthy',
        unhealthySec,
      });
      
      await stopBot(row.id);
      await startBot(row);
      continue;
    }
    // Refresh routes + cached row state (cheap)
    live.row             = row;
    live.routes          = loadRoutesForBot(row.id);
    live.autoReplyGuilds = new Set(parseAutoReplyGuilds(row.auto_reply_guilds));
  }
}

/**
 * Send a plain-text message to a Discord channel using any running bot.
 * Used by AlertDispatcher for code-level notifications — no LLM in path.
 * Returns { ok: false, error } on failure instead of throwing.
 */
export async function sendToChannel(
  channelId: string,
  text: string,
  botId?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    let bot: RunningBot | undefined;
    if (botId) {
      bot = running.get(botId);
    } else {
      for (const b of running.values()) {
        if (b.client.isReady()) { bot = b; break; }
      }
    }
    if (!bot || !bot.client.isReady()) {
      return { ok: false, error: 'no ready Discord bot available' };
    }
    const channel = await bot.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      return { ok: false, error: `channel ${channelId} not found or not text-based` };
    }
    await (channel as import('discord.js').TextChannel).send({ content: text });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Post a message to a Discord channel out-of-band (not in direct reply to a
 * live turn) — used by run-delivery to deliver a finished background run.
 * Splits on Discord's length limit; the first chunk carries an @mention of the
 * original author, and that prefix is reserved from the first chunk's budget.
 * Returns { ok: false, error } instead of throwing.
 */
/**
 * Post an audio buffer as a file attachment to a Discord channel.
 * Used by the job worker to deliver async TTS results after synthesis completes.
 */
export async function postAudioToChannel(
  botId: string | undefined,
  channelId: string,
  audioBuf: Buffer,
  opts?: { replyToMessageId?: string; mimeType?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    let bot: RunningBot | undefined;
    if (botId) bot = running.get(botId);
    if (!bot) {
      for (const b of running.values()) {
        if (b.client.isReady()) { bot = b; break; }
      }
    }
    if (!bot || !bot.client.isReady()) {
      return { ok: false, error: 'no ready Discord bot available' };
    }
    const channel = await bot.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      return { ok: false, error: `channel ${channelId} not found or not text-based` };
    }
    const tc = channel as import('discord.js').TextChannel;
    // Guard against oversized uploads (mirrors postAgentFiles). A blob past the
    // hard cap throws "Request entity too large" — surface it as a clean failure
    // (which the job worker retries / logs) instead of an opaque throw.
    if (audioBuf.length > DISCORD_FILE_MAX_BYTES) {
      return { ok: false, error: `audio ${audioBuf.length} bytes exceeds Discord file cap (${DISCORD_FILE_MAX_BYTES})` };
    }
    const ext  = opts?.mimeType?.includes('wav') ? 'wav' : opts?.mimeType?.includes('ogg') ? 'ogg' : 'mp3';
    const name = `voice-${Date.now()}.${ext}`;
    const payload = { content: '', files: [{ attachment: audioBuf, name }] };
    if (opts?.replyToMessageId) {
      try {
        const ref = await tc.messages.fetch(opts.replyToMessageId);
        await ref.reply(payload);
        return { ok: true };
      } catch (err) {
        // Only fall through to a plain send when the original message is gone
        // (Unknown Message, 10008). Any other error (e.g. a post-send network
        // blip after Discord already accepted the reply) must NOT fall through,
        // or it would post the same audio twice.
        const code = (err as { code?: number })?.code;
        if (code !== 10008) return { ok: false, error: (err as Error).message };
        // Original message gone — fall through to plain channel send.
      }
    }
    await tc.send(payload);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function postToChannel(
  botId: string | undefined,
  channelId: string,
  text: string,
  opts?: { replyToMessageId?: string; mentionUserId?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    let bot: RunningBot | undefined;
    if (botId) bot = running.get(botId);
    if (!bot) {
      for (const b of running.values()) {
        if (b.client.isReady()) { bot = b; break; }
      }
    }
    if (!bot || !bot.client.isReady()) {
      return { ok: false, error: 'no ready Discord bot available' };
    }
    const channel = await bot.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      return { ok: false, error: `channel ${channelId} not found or not text-based` };
    }
    const tc = channel as import('discord.js').TextChannel;
    const mention = opts?.mentionUserId ? `<@${opts.mentionUserId}> ` : '';
    // Reserve the mention prefix from the first chunk so it never overflows.
    const chunks = chunkForDiscord(text, 1990 - mention.length);
    for (let i = 0; i < chunks.length; i++) {
      const content = i === 0 ? mention + chunks[i] : chunks[i];
      if (i === 0 && opts?.replyToMessageId) {
        try {
          const ref = await tc.messages.fetch(opts.replyToMessageId);
          await ref.reply(content);
          continue;
        } catch {
          // Original message gone — fall through to a plain channel send.
        }
      }
      await tc.send({ content });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** List the Discord guilds a running bot is a member of, with id/name/icon.
 *  Returns null if the bot isn't currently running (no live gateway). */
export function listBotGuilds(botId: string): Array<{ id: string; name: string; icon_url: string | null; member_count: number | null }> | null {
  const bot = running.get(botId);
  if (!bot || !bot.client.isReady()) return null;
  return [...bot.client.guilds.cache.values()].map(g => ({
    id:           g.id,
    name:         g.name,
    icon_url:     g.iconURL?.({ size: 64 }) ?? null,
    member_count: g.memberCount ?? null,
  }));
}

/**
 * Add an emoji reaction to a Discord message. Used by the discord_react tool
 * so agents can express acknowledgement, agreement, or sentiment without
 * sending a full reply.
 *
 * Looks up the channel and message via the running bot's cached client.
 * Discord rejects unknown emojis (or returns 400 for malformed unicode);
 * we surface that as a returned error string instead of throwing so tool
 * dispatch stays clean.
 *
 * Pass either:
 *   - a unicode emoji directly: "👍", "🔥", "❤️"
 *   - a custom guild emoji as <:name:id> or just the id
 */
export async function reactToMessage(
  botId: string,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const bot = running.get(botId);
  if (!bot || !bot.client.isReady()) return { ok: false, error: 'bot is not connected to the Discord gateway' };

  try {
    // .channels.fetch handles guild + DM channels uniformly. The cache fast-path
    // returns instantly when the bot already saw the channel during this session.
    const channel = await bot.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) return { ok: false, error: 'channel not found or does not support messages' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = await (channel as any).messages.fetch(messageId);
    if (!message) return { ok: false, error: 'message not found' };
    await message.react(emoji);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 240) };
  }
}

/**
 * Look up the most recent inbound message in a channel for a given user —
 * lets agents react to "the message that just triggered me" without the
 * caller needing to thread the message id through every tool call.
 */
export function lastInboundMessage(botId: string, channelId: string, userId?: string): string | null {
  const bot = running.get(botId);
  if (!bot || !bot.client.isReady()) return null;
  const channel = bot.client.channels.cache.get(channelId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!channel || !('messages' in channel)) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cached = [...((channel as any).messages.cache.values() as IterableIterator<any>)]
    .filter(m => !m.author.bot && (!userId || m.author.id === userId))
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  return cached[0]?.id ?? null;
}

// ── Env-config migration (legacy single-bot setup) ─────────────────────────

function migrateEnvBotIfNeeded(): void {
  const tokenFromEnv = config.discordBot.token;
  if (!tokenFromEnv) return;
  const existing = listDiscordBots(true);
  // Only migrate when zero rows exist — once the user adds bots through the
  // dashboard, env stops being the source of truth.
  if (existing.length > 0) return;

  const defaultAgentId = resolveAgentId(config.discordBot.defaultAgent);
  const row = createDiscordBot({
    name:             'Default (env)',
    token:            tokenFromEnv,
    default_agent_id: defaultAgentId,
  });
  logger.info('discord-bot: migrated DISCORD_BOT_TOKEN env into discord_bots row', { botId: row.id });
}

// ── Public entry: start the manager ────────────────────────────────────────

export async function startDiscordBotManager(): Promise<void> {
  installShutdownHandlers();

  // Validate config at startup so misconfigurations surface immediately in
  // logs rather than silently causing "no agent route" errors at message time.

  // 1. DISCORD_CHANNEL_ROUTES JSON (env-based legacy routing)
  const rawRoutes = process.env.DISCORD_CHANNEL_ROUTES?.trim();
  if (rawRoutes) {
    try { JSON.parse(rawRoutes); } catch {
      logger.warn('discord-bot: DISCORD_CHANNEL_ROUTES is not valid JSON — channel routing will be ignored', { raw: rawRoutes.slice(0, 80) });
    }
  }

  // 2. Per-bot default_agent_id — this is what actually routes messages when
  //    there is no per-channel route. Warn if any bot's default agent is missing
  //    or inactive so the issue shows up on restart, not on the first message.
  for (const bot of listDiscordBots(true)) {
    if (!bot.enabled) continue;
    if (bot.default_agent_id) {
      const agent = getAgentById(bot.default_agent_id);
      if (!agent) {
        logger.warn('discord-bot: default agent not found — bot will reply "no agent route" to unrouted messages', { bot: bot.name, agentId: bot.default_agent_id });
      } else if (agent.status !== 'active') {
        logger.warn('discord-bot: default agent is inactive — bot will reply "no agent route" to unrouted messages', { bot: bot.name, agent: agent.name, status: agent.status });
      }
    } else {
      // No bot-level default — falls through to env DISCORD_DEFAULT_AGENT.
      const fallbackName = config.discordBot.defaultAgent;
      const fallback = resolveAgentId(fallbackName);
      if (!fallback) {
        logger.warn('discord-bot: bot has no default agent and DISCORD_DEFAULT_AGENT is not set — unrouted messages will fail', { bot: bot.name, envFallback: fallbackName });
      }
    }
  }

  migrateEnvBotIfNeeded();
  await reload();
  setInterval(() => {
    reload().catch(err => logger.error('discord-bot: reload failed', { err: (err as Error).message }));
  }, RELOAD_INTERVAL_SEC * 1000);
  const carryoverSweep = setInterval(() => sweepCarryoverMaps(), CARRYOVER_SWEEP_INTERVAL_MS);
  if (typeof carryoverSweep.unref === 'function') carryoverSweep.unref();
  logger.info('discord-bot manager: started', { reloadSec: RELOAD_INTERVAL_SEC, streamTimeoutMs: STREAM_TIMEOUT_MS });
}

/** Force an immediate reload — called by API endpoints when a bot is added/edited/removed. */
export async function reloadDiscordBots(): Promise<void> {
  await reload();
}

export async function restartBot(botId: string): Promise<void> {
  logger.info('discord-bot: manual restart', { botId });
  permanentlyFailedBots.delete(botId); // manual restart re-attempts even after a permanent failure
  await stopBot(botId);
  const row = getDiscordBot(botId);
  if (row && row.enabled) {
    await startBot(row);
    logAnalytics('discord_restart', { botId, reason: 'manual', botName: row.name });
  } else {
    logger.info('discord-bot: restart skipped — bot disabled or not found', { botId });
  }
}

/**
 * Gracefully shut down every running bot. Discord shows the bot as offline
 * within a couple of seconds — much faster than the gateway timeout. Called
 * on process exit (SIGTERM/SIGINT from tsx-watch reload, manual kill, etc.)
 * so users can SEE that the bot is offline during a restart instead of
 * sending messages into a void thinking the bot is up.
 */
export async function stopAllDiscordBots(): Promise<void> {
  const ids = [...running.keys()];
  if (ids.length === 0) return;
  logger.info('discord-bot manager: stopping all bots', { count: ids.length });
  await Promise.all(ids.map(id => stopBot(id).catch(() => { /* best-effort */ })));
}

let shutdownHandlersInstalled = false;
function installShutdownHandlers(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;

  // SIGINT/SIGTERM are what tsx-watch sends on reload AND what `Ctrl+C`
  // sends manually. We destroy the Discord clients explicitly so the bot
  // user goes offline immediately. Without this, the gateway times out
  // 30-60s later and users see a falsely "online" bot during restarts.
  const onExit = (signal: string) => {
    logger.info('discord-bot manager: shutdown signal', { signal });
    stopAllDiscordBots()
      .catch(() => { /* ignore */ })
      .finally(() => {
        // Re-raise the signal so the surrounding tsx-watch / process supervisor
        // sees the same exit code it would have without our handler.
        process.kill(process.pid, signal as NodeJS.Signals);
      });
  };
  process.once('SIGINT',  () => onExit('SIGINT'));
  process.once('SIGTERM', () => onExit('SIGTERM'));
  // beforeExit fires when the event loop empties — covers normal exits
  // where no signal was sent (e.g. an `await` chain finished).
  process.once('beforeExit', () => {
    stopAllDiscordBots().catch(() => { /* best-effort */ });
  });
}

// ── Standalone runner ──────────────────────────────────────────────────────
// `npm run bot:discord` — runs the manager as a standalone process.
// When embedded in the dashboard server, call startDiscordBotManager() instead.

const isEntryPoint =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /discord-bot\.[mc]?[jt]s$/.test(process.argv[1] ?? '');

if (isEntryPoint) {
  startDiscordBotManager().catch((err) => {
    logger.error('discord-bot: failed to start', { err: (err as Error).message });
    process.exit(1);
  });
}
