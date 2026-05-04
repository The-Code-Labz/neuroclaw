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
  ChannelType,
} from 'discord.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  getAgentById, getAgentByName,
  listDiscordBots, listDiscordRoutes,
  createDiscordBot, updateDiscordBot,
  parseAutoReplyGuilds,
  getDiscordVoicePref, setDiscordVoicePref,
  type DiscordBotRow,
} from '../db';
import { transcribe } from '../audio/transcribe';
import { synthesize, resolveAgentVoice } from '../audio/tts';

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
  'html','htm','css','scss','sass','less','vue','svelte',
  'sh','bash','zsh','fish','ps1','bat','cmd',
  'sql','graphql','gql','proto',
  'dockerfile','makefile','gitignore','gitattributes',
  // misc
  'patch','diff','srt','vtt','ipynb',
]);

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = new Set([
  'application/json','application/ld+json','application/xml','application/xhtml+xml',
  'application/yaml','application/x-yaml','application/toml','application/x-toml',
  'application/javascript','application/typescript','application/sql','application/graphql',
  'application/x-sh','application/x-shellscript','application/x-httpd-php',
]);

function isTextAttachment(name: string | null, contentType: string | null): boolean {
  const ct = (contentType ?? '').toLowerCase().split(';')[0].trim();
  if (ct) {
    if (TEXT_MIME_PREFIXES.some(p => ct.startsWith(p))) return true;
    if (TEXT_MIME_EXACT.has(ct)) return true;
  }
  // Skip anything obviously not text even if extension would otherwise match.
  if (ct.startsWith('audio/') || ct.startsWith('image/') || ct.startsWith('video/')) return false;
  if (ct === 'application/pdf' || ct === 'application/zip' || ct === 'application/octet-stream' && false) return false;
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
): Promise<{ files: InlinedTextFile[]; skipped: string[] }> {
  const files: InlinedTextFile[] = [];
  const skipped: string[] = [];
  let consumed = 0;
  for (const a of attachments) {
    if (consumed >= budgetBytes) { skipped.push(`${a.name ?? 'attachment'} (over total budget)`); continue; }
    try {
      const r = await fetch(a.url);
      if (!r.ok) { skipped.push(`${a.name ?? 'attachment'} (HTTP ${r.status})`); continue; }
      const ab = await r.arrayBuffer();
      const buf = Buffer.from(ab);
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
  agentId:         string;
  requireMention:  boolean;
}

interface RunningBot {
  client:          Client;
  row:             DiscordBotRow;
  routes:          Map<string, ChannelRoute>; // channel_id → { agentId, requireMention }
  autoReplyGuilds: Set<string>;                // guild ids where mention is NOT required (subject to per-channel override)
  startedAt:       number;
}

const running = new Map<string, RunningBot>();

// ── Per-(bot, channel, user) sticky session memory ─────────────────────────
// Reuse the same NeuroClaw session id for an entire (bot, channel, user)
// thread of conversation so the agent has context across @mentions. Cleared
// on bot restart; memory_index + vault still persist via the normal pipeline.
const sessionKeys = new Map<string, string>();
function sessionKeyFor(botId: string, msg: Message): string {
  return `${botId}::${msg.channelId}::${msg.author.id}`;
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
    m.set(r.channel_id, { agentId: r.agent_id, requireMention: !!r.require_mention });
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
  reply:     string;
  sessionId: string | null;       // captured from the SSE `session` event so we can stick it for next turn
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

async function streamChatResponse(
  message: string,
  agentId: string,
  sessionId?: string,
  attachments?: Array<{ url: string; mime_type?: string; name?: string }>,
  discordContext?: DiscordTurnContext,
): Promise<ChatStreamResult> {
  const url = `http://127.0.0.1:${config.dashboard.port}/api/chat`;
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
      // Pass the Discord IDs through so the agent knows which platform it's
      // on and which bot/channel/message to act on. The chat handler injects
      // a system note so the agent can call discord_react/etc with real IDs
      // instead of guessing or asking the user.
      ...(discordContext ? { discord: discordContext } : {}),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`/api/chat HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let assembled = '';
  let capturedSessionId: string | null = null;
  let finished = false;          // got a `done` event — stop reading and return what we have
  let streamError: string | null = null;

  outer: while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n\n')) !== -1) {
      const event = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const dataLine = event.split('\n').find(l => l.startsWith('data: '));
      if (!dataLine) continue;
      let evt: { type?: string; content?: string; message?: string; error?: string; sessionId?: string };
      try {
        evt = JSON.parse(dataLine.slice(6));
      } catch {
        // Partial JSON across chunks — try to recombine on the next read.
        continue;
      }
      if (evt.type === 'session' && typeof evt.sessionId === 'string') {
        capturedSessionId = evt.sessionId;
      } else if (evt.type === 'chunk' && typeof evt.content === 'string') {
        assembled += evt.content;
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

  if (assembled.trim()) return { reply: assembled.trim(), sessionId: capturedSessionId };
  // Empty assembled + we saw an error → that's the actual failure to surface.
  if (streamError) throw new Error(streamError);
  // Empty assembled + no error + no `done` → the server hung up early.
  if (!finished) throw new Error('chat stream closed without a response');
  return { reply: '', sessionId: capturedSessionId };
}

// ── Per-bot message handler ────────────────────────────────────────────────

async function handleMessage(bot: RunningBot, msg: Message): Promise<void> {
  if (msg.author.bot) return;

  const isDm = msg.channel.type === ChannelType.DM;
  const mentioned = bot.client.user ? msg.mentions.has(bot.client.user.id) : false;
  const channelRoute = bot.routes.get(msg.channelId);
  // Auto-reply layered logic:
  //   - guild is opted in via auto_reply_guilds → bot replies without @mention
  //   - UNLESS this specific channel has a route with require_mention=1
  //     (carve-out for shared servers where multiple bots co-exist)
  const guildAutoReply = !!msg.guildId && bot.autoReplyGuilds.has(msg.guildId);
  const channelOverride = channelRoute?.requireMention === true;
  const autoReply = guildAutoReply && !channelOverride;
  if (!isDm && !mentioned && !autoReply) return;

  // Allowlist (still env-based — applies to all bots; per-bot allowlist is v1.8 polish).
  const allow = config.discordBot.allowedUsers;
  if (allow.length > 0 && !allow.includes(msg.author.id)) {
    logger.warn('discord-bot: ignored message from non-allowlisted user', { botId: bot.row.id, userId: msg.author.id });
    return;
  }

  const botMention = bot.client.user ? `<@${bot.client.user.id}>` : '';
  let text = msg.content.replace(new RegExp(botMention, 'g'), '').trim();

  // Voice notes: transcribe audio attachments BEFORE checking emptiness so a
  // mic-only message ("press and hold to talk") still routes to the agent.
  // We accept multiple audio attachments (rare, but Discord allows it) and
  // concatenate the transcripts in attachment order.
  const audioAttachments = [...msg.attachments.values()].filter(a => (a.contentType ?? '').startsWith('audio/'));
  if (audioAttachments.length > 0) {
    const transcripts: string[] = [];
    for (const a of audioAttachments) {
      try {
        const r = await fetch(a.url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        const { text: t } = await transcribe({ audio: buf, mimeType: a.contentType ?? 'audio/ogg', filename: a.name ?? undefined });
        if (t.trim()) transcripts.push(t.trim());
      } catch (err) {
        logger.warn('discord-bot: transcription failed', { botId: bot.row.id, attachment: a.name, err: (err as Error).message });
      }
    }
    if (transcripts.length > 0) {
      const joined = transcripts.join('\n');
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
    const result = await fetchTextAttachments(textCandidates, TEXT_FILE_TOTAL_MAX_BYTES);
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

  // Allow image-only messages (text empty but attachments present) — the
  // chat API accepts attachments without a text body. The agent will see
  // either the native image or the preprocessed description.
  const hasImages = msg.attachments.some(a => (a.contentType ?? '').startsWith('image/'));
  if (!text && !hasImages) {
    if (msg.channel.isSendable()) await msg.reply('Yes? (mention me with a question)');
    return;
  }

  // Resolve agent: per-channel route → bot's default → instance default.
  const routeAgentId = channelRoute?.agentId;
  const agentId = routeAgentId ?? bot.row.default_agent_id ?? resolveAgentId(config.discordBot.defaultAgent);
  if (!agentId) {
    if (msg.channel.isSendable()) await msg.reply(`*(no agent route — set a default for bot "${bot.row.name}" or add a channel route)*`);
    return;
  }

  if (msg.channel.isSendable() && 'sendTyping' in msg.channel) {
    msg.channel.sendTyping().catch(() => { /* best-effort */ });
  }

  const key = sessionKeyFor(bot.row.id, msg);
  const existingSession = sessionKeys.get(key);

  // Pull image attachments off the Discord message. We only forward what
  // looks like an image — Discord lets users attach arbitrary files (PDFs,
  // .zips) but vision models care about images. Filter on contentType prefix.
  const imageAttachments = [...msg.attachments.values()]
    .filter(a => (a.contentType ?? '').startsWith('image/'))
    .map(a => ({ url: a.url, mime_type: a.contentType ?? undefined, name: a.name ?? undefined }));

  // Detect "stop sending audio" / "voice on" intents in the user's message
  // BEFORE we route to the LLM. Flipping the pref here means the very turn the
  // user objects on is also text-only — the post-reply audio gate consults the
  // pref we just wrote.
  const voiceIntent = detectVoicePrefIntent(text);
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

  let result: ChatStreamResult;
  try {
    result = await streamChatResponse(text, agentId, existingSession, imageAttachments, discordCtx);
  } catch (err) {
    // Drop the cached session for this (bot, channel, user) — the next turn
    // will mint a fresh one. Prevents a one-off FK violation or session-purge
    // on the dashboard from breaking the conversation forever.
    sessionKeys.delete(key);
    logger.error('discord-bot: chat call failed', { botId: bot.row.id, err: (err as Error).message });
    if (msg.channel.isSendable()) {
      await msg.reply(`*(chat error: ${(err as Error).message.slice(0, 200)})*`);
    }
    return;
  }
  // Stick the REAL session id (from the SSE `session` event) for next turn.
  // Stale/synthetic ids hit FK violations on the second message; this avoids that.
  if (result.sessionId) sessionKeys.set(key, result.sessionId);

  if (!result.reply) {
    if (msg.channel.isSendable()) await msg.reply('*(no response)*');
    return;
  }
  const chunks = chunkForDiscord(result.reply, config.discordBot.maxReplyChars);
  if (!msg.channel.isSendable()) return;

  for (const c of chunks) await msg.reply(c);

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
        const out = await synthesize({
          text:     result.reply,
          provider: voice.provider,
          voiceId:  voice.voiceId || undefined,
          format:   'mp3',
        });
        await msg.reply({
          content: '',
          files: [{ attachment: out.buffer, name: `voice-${Date.now()}.mp3` }],
        });
      } catch (err) {
        logger.warn('discord-bot: tts failed', { botId: bot.row.id, agentId, err: (err as Error).message });
      }
    }
  }
}

// ── Per-bot lifecycle ──────────────────────────────────────────────────────

async function startBot(row: DiscordBotRow): Promise<void> {
  if (running.has(row.id)) return;          // already running
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
    ],
    partials: [Partials.Channel],
  });

  const bot: RunningBot = {
    client,
    row,
    routes:          loadRoutesForBot(row.id),
    autoReplyGuilds: new Set(parseAutoReplyGuilds(row.auto_reply_guilds)),
    startedAt:       Date.now(),
  };
  running.set(row.id, bot);
  updateDiscordBot(row.id, { status: 'connecting', last_started_at: new Date().toISOString() });

  client.once('ready', () => {
    const u = client.user;
    logger.info('discord-bot: ready', { botId: row.id, name: row.name, tag: u?.tag, guilds: client.guilds.cache.size });
    updateDiscordBot(row.id, {
      status:        'ready',
      status_detail: null,
      bot_user_id:   u?.id ?? null,
      bot_user_tag:  u?.tag ?? null,
    });
  });

  client.on('messageCreate', (msg) => {
    handleMessage(bot, msg).catch(err => logger.error('discord-bot: handler crashed', { botId: row.id, err: (err as Error).message }));
  });

  client.on('error', (err) => {
    logger.error('discord-bot: gateway error', { botId: row.id, err: err.message });
    updateDiscordBot(row.id, { status: 'error', status_detail: err.message.slice(0, 240) });
  });

  try {
    await client.login(row.token);
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('discord-bot: login failed', { botId: row.id, err: msg });
    updateDiscordBot(row.id, { status: 'error', status_detail: msg.slice(0, 240) });
    running.delete(row.id);
    try { await client.destroy(); } catch { /* ignore */ }
  }
}

async function stopBot(botId: string): Promise<void> {
  const bot = running.get(botId);
  if (!bot) return;
  running.delete(botId);
  try { await bot.client.destroy(); } catch { /* ignore */ }
  updateDiscordBot(botId, { status: 'idle', status_detail: null });
  logger.info('discord-bot: stopped', { botId });
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
    // Refresh routes + cached row state (cheap)
    live.row             = row;
    live.routes          = loadRoutesForBot(row.id);
    live.autoReplyGuilds = new Set(parseAutoReplyGuilds(row.auto_reply_guilds));
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
  migrateEnvBotIfNeeded();
  await reload();
  setInterval(() => {
    reload().catch(err => logger.error('discord-bot: reload failed', { err: (err as Error).message }));
  }, RELOAD_INTERVAL_SEC * 1000);
  logger.info('discord-bot manager: started', { reloadSec: RELOAD_INTERVAL_SEC });
}

/** Force an immediate reload — called by API endpoints when a bot is added/edited/removed. */
export async function reloadDiscordBots(): Promise<void> {
  await reload();
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
