// Voice channel support for NeuroClaw Discord bots.
//
// Each routed voice channel gets a VoiceSession — one per bot per guild.
// Sessions are created when the first non-bot user joins a routed channel
// and destroyed when the last user leaves. Each user's speech is transcribed
// independently and forwarded to the assigned agent via the /api/chat SSE
// endpoint, with the reply played back as TTS audio in the channel.

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  EndBehaviorType,
  entersState,
  VoiceConnection,
  AudioPlayer,
} from '@discordjs/voice';
import { VoiceState, ChannelType, Client } from 'discord.js';
import { Readable } from 'stream';
import { transcribe } from '../audio/transcribe';
import { synthesize, resolveAgentVoice } from '../audio/tts';
import { getAgentById, getOrCreateSessionByExternalId, listDiscordRoutes } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { GeminiLiveVoiceSession } from './discord-voice-gemini';

// ── Types ──────────────────────────────────────────────────────────────────

export interface BotVoiceContext {
  botId:  string;
  client: Client;
  routes: Map<string, { agentId: string }>;
  row:    { id: string; name: string; voice_channel_enabled: number };
}

// ── Module-level session map ───────────────────────────────────────────────

// Key: `${botId}::${guildId}`
const sessions = new Map<string, VoiceSession>();

// Max time to wait for one audio resource to finish before forcing the player
// to stop. Bounds how long a wedged resource can block the shared playQueue.
const PLAYBACK_IDLE_TIMEOUT_MS = 20_000;

type OpusEncoderInstance = { decode(packet: Buffer): Buffer };
type OpusEncoderCtor = new (sampleRate: number, channels: number) => OpusEncoderInstance;

let opusEncoderCtor: OpusEncoderCtor | null | undefined;

function getOpusEncoderCtor(): OpusEncoderCtor | null {
  if (opusEncoderCtor !== undefined) return opusEncoderCtor;
  try {
    const mod = require('@discordjs/opus') as { OpusEncoder?: OpusEncoderCtor };
    opusEncoderCtor = mod.OpusEncoder ?? null;
  } catch (err) {
    opusEncoderCtor = null;
    logger.warn('discord-voice: @discordjs/opus unavailable, voice transcription disabled', { err: (err as Error).message });
  }
  return opusEncoderCtor;
}

// ── Upstream audio serial queue ────────────────────────────────────────────
// VoidAI rate-limits concurrent audio requests. All transcription and TTS
// calls share this queue so only one is in-flight at a time, across all bots.

let _audioQueue: Promise<void> = Promise.resolve();

function queueAudio<T>(fn: () => Promise<T>): Promise<T> {
  const result = _audioQueue.then(fn);
  _audioQueue = result.then(() => undefined, () => undefined);
  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pcmToWav(pcm: Buffer, sampleRate = 48000, channels = 2, bitDepth = 16): Buffer {
  const byteRate   = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const header     = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);           // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Flush complete sentences from the accumulation buffer, calling onSentence for each.
// Returns the remaining (incomplete) tail of the buffer.
function flushSentences(buf: string, onSentence: (s: string) => void): string {
  // Match sentence-ending punctuation (optionally followed by closing quote/paren) + whitespace
  let rest = buf;
  let match: RegExpExecArray | null;
  const re = /[.!?]["')\]]*\s+/g;
  let lastIdx = 0;
  while ((match = re.exec(rest)) !== null) {
    const sentence = rest.slice(lastIdx, match.index + match[0].length).trim();
    if (sentence) onSentence(sentence);
    lastIdx = match.index + match[0].length;
  }
  return rest.slice(lastIdx);
}

// Minimal SSE chat client — mirrors discord-bot.ts streamChatResponse without
// creating a circular import. Reads chunk events, calls onSentence for each
// complete sentence as tokens arrive, and returns the full reply when done.
async function callChatApi(
  message: string, agentId: string, sessionId: string,
  onSentence?: (sentence: string) => void,
): Promise<string> {
  const url = `http://127.0.0.1:${config.dashboard.port}/api/chat`;
  const controller = new AbortController();
  const voiceTimeoutMs = parseInt(process.env.DISCORD_STREAM_TIMEOUT_MS ?? '300000', 10);
  const timer = setTimeout(() => controller.abort(), voiceTimeoutMs);
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-dashboard-token': config.dashboard.token,
      },
      body:   JSON.stringify({ message, agentId, sessionId }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`chat API returned ${res.status}`);

    let reply = '';
    let sentenceBuf = '';
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finished = false;
    let streamError: string | null = null;

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const dataLine = event.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        const raw = dataLine.slice(6);
        if (raw === '[DONE]') continue;
        try {
          const ev = JSON.parse(raw) as { type?: string; content?: string; message?: string; error?: string };
          if (ev.type === 'chunk') {
            const token = ev.content ?? '';
            reply += token;
            if (onSentence) {
              sentenceBuf += token;
              sentenceBuf = flushSentences(sentenceBuf, onSentence);
            }
          } else if (ev.type === 'done') {
            finished = true;
            break outer;
          } else if (ev.type === 'error') {
            streamError = ev.message ?? ev.error ?? 'chat stream error';
          }
        } catch { /* wait for the next SSE frame */ }
      }
    }

    try { await reader.cancel(); } catch { /* best-effort */ }

    // Flush any trailing text that didn't end with sentence-ending punctuation
    if (onSentence && sentenceBuf.trim()) onSentence(sentenceBuf.trim());

    if (reply.trim()) return reply.trim();
    if (streamError) throw new Error(streamError);
    if (!finished) throw new Error('chat stream closed without a response');
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// ── VoiceSession ───────────────────────────────────────────────────────────

class VoiceSession {
  readonly botId:     string;
  readonly guildId:   string;
  readonly channelId: string;
  readonly agentId:   string;

  private readonly client:           Client;
  private readonly connection:       VoiceConnection;
  private readonly player:           AudioPlayer;
  private readonly activeUsers:      Set<string>                          = new Set();
  private readonly userQueues:       Map<string, Promise<void>>           = new Map();
  private readonly speakingListeners: Map<string, (uid: string) => void>  = new Map();
  private          playQueue:        Promise<void>                        = Promise.resolve();

  constructor(
    ctx: BotVoiceContext,
    guildId: string,
    channelId: string,
    agentId: string,
    connection: VoiceConnection,
  ) {
    this.botId      = ctx.botId;
    this.guildId    = guildId;
    this.channelId  = channelId;
    this.agentId    = agentId;
    this.client     = ctx.client;
    this.connection = connection;
    this.player     = createAudioPlayer();
    this.connection.subscribe(this.player);

    this.connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.handleDisconnect().catch(err =>
        logger.warn('discord-voice: disconnect handler error', { botId: this.botId, err: (err as Error).message }),
      );
    });

    this.connection.on(VoiceConnectionStatus.Destroyed, () => {
      sessions.delete(`${this.botId}::${this.guildId}`);
    });
  }

  private async handleDisconnect(): Promise<void> {
    try {
      // Try to reconnect within 5 s (covers brief network blips)
      await Promise.race([
        entersState(this.connection, VoiceConnectionStatus.Signalling,  5_000),
        entersState(this.connection, VoiceConnectionStatus.Connecting,  5_000),
      ]);
    } catch {
      // Reconnect failed — give up and clean up
      this.leave();
    }
  }

  subscribeUser(userId: string): void {
    if (this.activeUsers.has(userId)) return;
    this.activeUsers.add(userId);

    // Hook receiver.speaking so we create a fresh subscription each time the
    // user starts talking. Because EventEmitter.emit() is synchronous, the
    // subscription is in the receiver's map before the first packet is pushed.
    const onStart = (uid: string) => {
      if (uid !== userId || !this.activeUsers.has(userId)) return;

      const receiver = this.connection.receiver;
      const sub = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: config.voice.silenceThresholdMs },
      });

      // Guard: speaking.start can fire for a quick pause while the previous
      // subscription is still alive — skip if we already have handlers.
      if (sub.listenerCount('data') > 0) return;

      const OpusEncoder = getOpusEncoderCtor();
      if (!OpusEncoder) return;

      const chunks: Buffer[] = [];
      const decoder = new OpusEncoder(48000, 2);
      const maxPcmBytes = config.voice.maxUtteranceSec * 48000 * 2 * 2;
      let accumulated = 0;
      let cappedLogged = false;

      sub.on('data', (opusPacket: Buffer) => {
        if (accumulated >= maxPcmBytes) {
          if (!cappedLogged) {
            logger.warn('discord-voice: utterance capped', { botId: this.botId, userId, maxSec: config.voice.maxUtteranceSec });
            cappedLogged = true;
          }
          return;
        }
        try {
          chunks.push(decoder.decode(opusPacket));
          accumulated += chunks[chunks.length - 1].length;
        } catch { /* discard corrupted Opus packet */ }
      });

      sub.once('end', () => {
        // Explicitly release this per-burst subscription so the Opus decoder and
        // the 'data' listener can't accumulate across a long voice session (a new
        // sub is created on every speaking-start). Harmless if @discordjs/voice
        // has already torn the stream down on close.
        sub.removeAllListeners('data');
        sub.destroy();
        const pcm = Buffer.concat(chunks);
        if (pcm.length < 3840) {
          logger.debug('discord-voice: skipping short utterance', { botId: this.botId, userId, bytes: pcm.length });
          return;
        }
        this.enqueueUtterance(userId, pcmToWav(pcm));
      });
    };

    this.connection.receiver.speaking.on('start', onStart);
    this.speakingListeners.set(userId, onStart);
    logger.info('discord-voice: user joined', { botId: this.botId, userId });
  }

  unsubscribeUser(userId: string): void {
    this.activeUsers.delete(userId);
    this.userQueues.delete(userId); // drop the per-user serialization chain so a left user doesn't linger
    const listener = this.speakingListeners.get(userId);
    if (listener) {
      this.connection.receiver.speaking.off('start', listener);
      this.speakingListeners.delete(userId);
    }
    logger.info('discord-voice: user left', { botId: this.botId, userId, remaining: this.activeUsers.size });
    if (this.activeUsers.size === 0) this.leave();
  }

  private enqueueUtterance(userId: string, wav: Buffer): void {
    const prev = this.userQueues.get(userId) ?? Promise.resolve();
    const next = prev
      .then(() => this.handleUtterance(userId, wav))
      .catch(err => logger.warn('discord-voice: utterance queue error', {
        botId: this.botId, userId, err: (err as Error).message,
      }));
    this.userQueues.set(userId, next);
  }

  private async handleUtterance(userId: string, wav: Buffer): Promise<void> {
    // 1. Transcribe — serialised through the global audio queue so we never
    //    fire concurrent requests at VoidAI's upstream STT endpoint.
    let text: string;
    try {
      const result = await queueAudio(() => transcribe({ audio: wav, mimeType: 'audio/wav', filename: 'voice.wav' }));
      text = result.text.trim();
    } catch (err) {
      logger.warn('discord-voice: transcription failed', { botId: this.botId, userId, err: (err as Error).message });
      return;
    }
    if (!text) return;
    logger.info('discord-voice: utterance transcribed', { botId: this.botId, userId, preview: text.slice(0, 80) });

    // 2. Get or create per-user voice session (isolated from text-channel history)
    const externalId = `discord-voice::${this.botId}::${this.guildId}::${userId}`;
    const sessionId  = getOrCreateSessionByExternalId(externalId, this.agentId, undefined, 'voice');

    // 3. Resolve voice config once so all per-sentence TTS calls use the same settings.
    const agent = getAgentById(this.agentId);
    const voice = agent ? resolveAgentVoice(agent) : { provider: 'voidai' as const, voiceId: '' };
    let sentenceCount = 0;

    // onSentence: called for each complete sentence as Alfred's tokens arrive.
    // Each sentence is synthesized immediately and chained onto this.playQueue
    // so sentences play in order without waiting for the full reply.
    const onSentence = (sentence: string): void => {
      sentenceCount++;
      const prev = this.playQueue;
      this.playQueue = prev.then(async () => {
        const ttsResult = await synthesize({
          text: sentence, provider: voice.provider, voiceId: voice.voiceId || undefined, format: 'opus',
          agentName: getAgentById(this.agentId)?.name,
        }).catch((err: Error) => {
          logger.warn('discord-voice: TTS failed for sentence', { botId: this.botId, err: err.message });
          return null;
        });
        if (!ttsResult) return;
        const resource = createAudioResource(Readable.from(ttsResult.buffer));
        this.player.play(resource);
        await this.awaitPlaybackIdle();
      }).catch((err: Error) => {
        logger.warn('discord-voice: sentence playback error', { botId: this.botId, err: err.message });
      });
    };

    // 4. Chat — streams sentences to onSentence as tokens arrive.
    let reply: string;
    try {
      reply = await callChatApi(text, this.agentId, sessionId, onSentence);
    } catch (err) {
      logger.warn('discord-voice: chat API failed', { botId: this.botId, userId, err: (err as Error).message });
      return;
    }
    if (!reply) return;

    // 5. If no sentences were emitted (reply had no sentence-ending punctuation),
    //    fall back to synthesizing the full reply at once.
    if (sentenceCount === 0) {
      const ttsResult = await synthesize({
        text: reply, provider: voice.provider, voiceId: voice.voiceId || undefined, format: 'opus',
        agentName: getAgentById(this.agentId)?.name,
      }).catch((err: Error) => {
        logger.warn('discord-voice: TTS failed, falling back to text', { botId: this.botId, userId, err: err.message });
        return null;
      });
      if (!ttsResult) { await this.sendTextFallback(reply); return; }
      // Chain onto play queue so it doesn't overlap with a concurrent utterance.
      const prev = this.playQueue;
      // Each utterance is isolated: if playback or the text fallback throw, the
      // error is caught here so the chain stays alive for the next utterance.
      this.playQueue = prev.then(async () => {
        try {
          const resource = createAudioResource(Readable.from(ttsResult.buffer));
          this.player.play(resource);
          await this.awaitPlaybackIdle();
        } catch (err) {
          logger.warn('discord-voice: playback failed, falling back to text', { botId: this.botId, userId, err: (err as Error).message });
          try { await this.sendTextFallback(reply); } catch (fbErr) {
            logger.warn('discord-voice: text fallback also failed', { botId: this.botId, err: (fbErr as Error).message });
          }
        }
      }).catch((err: Error) => {
        logger.warn('discord-voice: utterance chain error (skipping)', { botId: this.botId, err: err.message });
      });
    }

    await this.playQueue;
  }

  // Post the agent reply as text to the first routed GuildText channel for this bot.
  private async sendTextFallback(text: string): Promise<void> {
    try {
      const routes = listDiscordRoutes(this.botId);
      for (const r of routes) {
        const ch = await this.client.channels.fetch(r.channel_id).catch(() => null);
        if (ch && ch.type === ChannelType.GuildText && 'send' in ch) {
          await (ch as { send(t: string): Promise<unknown> }).send(text.slice(0, 1900));
          return;
        }
      }
    } catch (err) {
      logger.warn('discord-voice: text fallback failed', { botId: this.botId, err: (err as Error).message });
    }
  }

  /** True while the underlying voice connection is still usable (not destroyed). */
  get isConnectionActive(): boolean {
    return this.connection.state.status !== VoiceConnectionStatus.Destroyed;
  }

  /**
   * Wait for the player to drain the current resource, but bounded so a single
   * wedged resource cannot freeze the shared playQueue (and every other user's
   * audio) for minutes. On timeout, stop the player so the chain advances.
   */
  private async awaitPlaybackIdle(): Promise<void> {
    try {
      await entersState(this.player, AudioPlayerStatus.Idle, PLAYBACK_IDLE_TIMEOUT_MS);
    } catch {
      logger.warn('discord-voice: playback did not reach Idle in time — stopping resource', { botId: this.botId });
      try { this.player.stop(true); } catch { /* best-effort */ }
    }
  }

  leave(): void {
    try {
      if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        this.connection.destroy();
      }
    } catch { /* ignore */ }
    // Detach speaking listeners so their captured closures (and `this`) don't
    // linger across rejoins.
    try {
      for (const [uid, listener] of this.speakingListeners) {
        this.connection.receiver.speaking.off('start', listener);
        void uid;
      }
    } catch { /* connection already destroyed */ }
    this.speakingListeners.clear();
    this.activeUsers.clear();
    this.userQueues.clear();
    sessions.delete(`${this.botId}::${this.guildId}`);
    logger.info('discord-voice: left channel', {
      botId: this.botId, guildId: this.guildId, channelId: this.channelId,
    });
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Called by discord-bot.ts on every `voiceStateUpdate` event for a given bot.
 * Handles user joins, user leaves, and bot-kicked scenarios.
 */
export async function handleVoiceStateUpdate(
  ctx: BotVoiceContext,
  oldState: VoiceState,
  newState: VoiceState,
): Promise<void> {
  const member = newState.member ?? oldState.member;
  if (!member) return;

  // Ignore bot accounts (including this bot's own state changes, handled separately)
  if (member.user.bot) return;

  const guildId    = newState.guild.id;
  const sessionKey = `${ctx.botId}::${guildId}`;

  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  // ── User left a voice channel ──────────────────────────────────────────
  if (oldChannelId && oldChannelId !== newChannelId) {
    const session = sessions.get(sessionKey);
    if (session && session.channelId === oldChannelId) {
      session.unsubscribeUser(member.id);
    }
  }

  // ── User joined a voice channel ────────────────────────────────────────
  if (newChannelId && newChannelId !== oldChannelId) {
    if (!ctx.row.voice_channel_enabled) return;

    const route = ctx.routes.get(newChannelId);
    if (!route) return; // channel not routed — ignore

    const channel = newState.channel;
    if (!channel || channel.type !== ChannelType.GuildVoice) return;

    let session = sessions.get(sessionKey);

    // A session whose connection is already being torn down (e.g. a user left
    // then rejoined before the async Destroyed event fired and cleared the map)
    // must not be reused — reusing it leaves the bot present but deaf. Drop it
    // and fall through to a fresh join.
    if (session && !session.isConnectionActive) {
      session.leave();
      sessions.delete(sessionKey);
      session = undefined;
    }

    if (!session) {
      // Bot is not in this guild yet — join the channel
      const connection = joinVoiceChannel({
        channelId:       channel.id,
        guildId,
        adapterCreator:  newState.guild.voiceAdapterCreator,
        selfDeaf:        false,
        selfMute:        false,
      });

      // Route to GeminiLiveVoiceSession if the agent is configured for it
      const agentRow = await getAgentById(route.agentId);
      if (agentRow?.voice_provider === 'gemini_live' && config.geminiLive.enabled) {
        const geminiSession = new GeminiLiveVoiceSession(ctx, guildId, channel.id, route.agentId, connection);
        sessions.set(sessionKey, geminiSession as unknown as VoiceSession);
        logger.info('discord-voice: joined channel (gemini-live)', {
          botId: ctx.botId, guildId, channelId: channel.id, agentId: route.agentId,
        });
        await geminiSession.start().catch(err => {
          logger.error('discord-voice: GeminiLiveVoiceSession failed to start', { err });
          sessions.delete(sessionKey);
          connection.destroy();
        });
        for (const existingMember of channel.members.values()) {
          if (!existingMember.user.bot) geminiSession.subscribeUser(existingMember.id);
        }
        return; // early return — GeminiLiveVoiceSession manages its own subscriptions
      }

      session = new VoiceSession(ctx, guildId, channel.id, route.agentId, connection);
      sessions.set(sessionKey, session);
      logger.info('discord-voice: joined channel', {
        botId: ctx.botId, guildId, channelId: channel.id, agentId: route.agentId,
      });

      // Subscribe to any non-bot members already in the channel
      for (const existingMember of channel.members.values()) {
        if (!existingMember.user.bot) session.subscribeUser(existingMember.id);
      }
    } else {
      // Bot is already in this guild's voice channel — subscribe only if same channel
      if (session.channelId === newChannelId) {
        session.subscribeUser(member.id);
      }
      // User joined a different channel — bot stays put (one voice session per guild)
    }
  }
}

/**
 * Destroy all active voice sessions for a given bot. Called when a bot is
 * stopped so connections are cleaned up before the gateway disconnects.
 */
export async function destroyBotSessions(botId: string): Promise<void> {
  await Promise.all(
    [...sessions.values()]
      .filter(s => s.botId === botId)
      .map(s => Promise.resolve(s.leave())),
  );
}
