// Gemini Live voice session for NeuroClaw Discord bots.
//
// GeminiLiveVoiceSession is a drop-in replacement for VoiceSession when an
// agent has voice_provider === 'gemini_live'. Instead of transcribe→chat→TTS,
// it streams raw PCM audio directly to the Gemini Live API and plays back the
// model's audio reply in the voice channel.
//
// Audio pipeline (inbound):
//   Discord Opus packets → OpusDecoder → stereo 48kHz PCM → downmix to mono
//   → downsample 48kHz→16kHz → mix all active speakers → send to Gemini
//
// Audio pipeline (outbound):
//   Gemini inlineData audio (PCM 24kHz mono) → upsample 24kHz→48kHz →
//   stereo interleave → Readable stream → Discord AudioPlayer

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  EndBehaviorType,
  entersState,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus,
  AudioPlayer,
} from '@discordjs/voice';
import { Readable } from 'stream';
import { GoogleGenAI, Modality } from '@google/genai';
import type { Session, FunctionResponse } from '@google/genai';
import { config } from '../config';
import { getAgentById, getDiscordVoicePref } from '../db';
import { toGeminiFunctionDeclarations } from './gemini-tools';
import { buildOpenAiTools } from '../tools/adapters/openai';
import type { ToolContext } from '../tools/context';
import { logger } from '../utils/logger';
import type { BotVoiceContext } from './discord-voice';
import type { AgentRecord } from '../db';

// Suppress unused import warnings — these are referenced in JSDoc / types
void joinVoiceChannel;

// Reconnect backoff for an unexpectedly-closed Gemini Live session. Without a
// cap + delay, a persistently-failing endpoint (bad key, quota, model down)
// that closes right after open spins a tight unbounded reconnect loop.
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS  = 30_000;

// ── Audio Utility Functions ────────────────────────────────────────────────

/**
 * Downmix stereo 16-bit PCM to mono by averaging left and right channels.
 * Input is a raw Buffer containing interleaved Int16 samples (L, R, L, R …).
 */
export function downmixToMono(stereoBuffer: Buffer): Int16Array {
  const samples = new Int16Array(stereoBuffer.buffer, stereoBuffer.byteOffset, stereoBuffer.byteLength / 2);
  const mono = new Int16Array(samples.length / 2);
  for (let i = 0; i < mono.length; i++) {
    mono[i] = (samples[i * 2] + samples[i * 2 + 1]) >> 1;
  }
  return mono;
}

/**
 * Downsample mono 48kHz Int16 audio to 16kHz by taking every 3rd sample
 * (simple averaging of each triplet).
 */
export function downsample48to16(input: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(input.length / 3));
  for (let i = 0; i < out.length; i++) {
    const base = i * 3;
    out[i] = Math.round((input[base] + input[base + 1] + input[base + 2]) / 3);
  }
  return out;
}

/**
 * Upsample mono 24kHz Int16 audio to 48kHz by doubling each sample with
 * linear interpolation between adjacent frames.
 */
export function upsample24to48(input: Int16Array): Int16Array {
  if (input.length === 0) return new Int16Array(0);
  const out = new Int16Array(input.length * 2);
  for (let i = 0; i < input.length - 1; i++) {
    out[i * 2]     = input[i];
    out[i * 2 + 1] = Math.round((input[i] + input[i + 1]) / 2);
  }
  const last = input.length - 1;
  out[last * 2]     = input[last];
  out[last * 2 + 1] = input[last];
  return out;
}

/**
 * Mix multiple mono Int16 frames into a single frame by clamped addition.
 * All frames are padded to the length of the longest one.
 */
export function mixFrames(frames: Int16Array[]): Int16Array {
  if (frames.length === 0) return new Int16Array(0);
  const len = Math.max(...frames.map(f => f.length));
  const out = new Int16Array(len);
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i++) {
      out[i] = Math.max(-32768, Math.min(32767, out[i] + frame[i]));
    }
  }
  return out;
}

// ── Lazy OpusEncoder loader ────────────────────────────────────────────────

type OpusEncoderInstance = { decode(p: Buffer): Buffer; encode(p: Buffer): Buffer };
type OpusEncoderCtor = new (sampleRate: number, channels: number) => OpusEncoderInstance;
let _opusCtor: OpusEncoderCtor | null | undefined;
function getOpusCtor(): OpusEncoderCtor | null {
  if (_opusCtor !== undefined) return _opusCtor;
  try {
    const m = require('@discordjs/opus') as { OpusEncoder?: OpusEncoderCtor };
    _opusCtor = m.OpusEncoder ?? null;
  } catch {
    _opusCtor = null;
    logger.warn('discord-voice-gemini: @discordjs/opus unavailable, Gemini voice disabled');
  }
  return _opusCtor;
}

// ── Mix interval constants ─────────────────────────────────────────────────

/** Send a mixed audio frame to Gemini every 20ms (Discord Opus frame size). */
const MIX_INTERVAL_MS = 20;

// ── GeminiLiveVoiceSession ─────────────────────────────────────────────────

export class GeminiLiveVoiceSession {
  readonly botId:     string;
  readonly guildId:   string;
  readonly channelId: string;
  readonly agentId:   string;

  private connection:    VoiceConnection;
  private player:        AudioPlayer;
  private geminiSession: Session | null = null;
  private activeUsers  = new Set<string>();
  private mixBuffers   = new Map<string, Int16Array>();
  private mixInterval: ReturnType<typeof setInterval> | null = null;
  private idleTimer:   ReturnType<typeof setTimeout>  | null = null;
  private lastAudioAt  = Date.now();
  private playQueue    = Promise.resolve();
  private interruptToken = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.connection = connection;
    this.player     = createAudioPlayer();
    this.connection.subscribe(this.player);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const agent = await getAgentById(this.agentId);
    if (!agent) throw new Error(`gemini-live: agent ${this.agentId} not found`);
    await this.openSession(agent);
    this.startMixLoop();
    this.resetIdleTimer();
  }

  async leave(): Promise<void> {
    this.stopMixLoop();
    this.clearIdleTimer();
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.geminiSession) {
      try {
        this.geminiSession.close();
      } catch (err) {
        logger.warn('gemini-live: error closing session', { err });
      }
      this.geminiSession = null;
    }
    try {
      this.player.stop(true);
    } catch { /* best-effort */ }
    try {
      this.connection.destroy();
    } catch { /* already destroyed */ }
  }

  // ── User subscription ────────────────────────────────────────────────────

  subscribeUser(userId: string): void {
    if (this.activeUsers.has(userId)) return;
    this.activeUsers.add(userId);

    const pref = getDiscordVoicePref(this.botId, userId);
    if (pref?.voice_enabled === 0) {
      this.activeUsers.delete(userId);
      return;
    }

    const OpusCtor = getOpusCtor();
    if (!OpusCtor) {
      this.activeUsers.delete(userId);
      return;
    }

    const receiver = this.connection.receiver;
    const stream   = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    const decoder = new OpusCtor(48000, 2);

    stream.on('data', (opusPacket: Buffer) => {
      try {
        const pcmBuf  = decoder.decode(opusPacket) as Buffer;
        if (!pcmBuf || pcmBuf.length < 4) return;
        const mono16k = downsample48to16(downmixToMono(pcmBuf));
        this.mixBuffers.set(userId, mono16k);
      } catch { /* discard corrupted packet */ }
    });

    stream.on('end',   () => { this.mixBuffers.delete(userId); this.activeUsers.delete(userId); });
    stream.on('error', () => { this.mixBuffers.delete(userId); this.activeUsers.delete(userId); });
  }

  unsubscribeUser(userId: string): void {
    this.activeUsers.delete(userId);
    this.mixBuffers.delete(userId);
    if (this.activeUsers.size === 0) {
      void this.leave();
    }
  }

  get userCount(): number {
    return this.activeUsers.size;
  }

  /** True while the underlying voice connection is still usable (not destroyed). */
  get isConnectionActive(): boolean {
    return this.connection.state.status !== VoiceConnectionStatus.Destroyed;
  }

  /** Reconnect a dropped session with exponential backoff, capped; give up after MAX. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return; // a reconnect is already pending
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.warn('gemini-live: reconnect attempts exhausted, leaving channel', {
        agentId: this.agentId, attempts: this.reconnectAttempts,
      });
      void this.leave();
      return;
    }
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    logger.info('gemini-live: scheduling reconnect', { agentId: this.agentId, attempt: this.reconnectAttempts, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.mixInterval === null) return; // left while waiting
      const agent = getAgentById(this.agentId);
      if (!agent) { void this.leave(); return; }
      this.openSession(agent).catch(err => {
        logger.warn('gemini-live: reconnect failed', { err: (err as Error).message, attempt: this.reconnectAttempts });
        this.scheduleReconnect(); // try again (or give up at the cap)
      });
    }, delay);
    if (typeof (this.reconnectTimer as { unref?: () => void }).unref === 'function') {
      (this.reconnectTimer as unknown as { unref: () => void }).unref();
    }
  }

  // ── Internal: Gemini session setup ────────────────────────────────────────

  private async openSession(agent: AgentRecord): Promise<void> {
    const cfg  = config.geminiLive;
    const ai   = new GoogleGenAI({ apiKey: cfg.apiKey });

    // Build tools
    const ctx: ToolContext = { agentId: agent.id };
    const openaiTools = agent.gemini_tools_enabled ? buildOpenAiTools(ctx) : [];
    const functionDeclarations = openaiTools.length
      ? toGeminiFunctionDeclarations(openaiTools as Parameters<typeof toGeminiFunctionDeclarations>[0])
      : undefined;

    // Determine voice: per-agent override > env default
    const voiceName = (agent.gemini_live_voice?.trim() || cfg.liveVoice) ?? 'Zephyr';

    const session = await ai.live.connect({
      model: cfg.liveModel,
      callbacks: {
        onopen: () => {
          logger.info('gemini-live: session opened', { agentId: this.agentId });
          this.reconnectAttempts = 0; // healthy connection — reset backoff
        },
        onmessage: (msg: unknown) => {
          this.handleServerMessage(msg).catch(err =>
            logger.warn('gemini-live: message handler error', { err }),
          );
        },
        onclose: (evt: unknown) => {
          logger.warn('gemini-live: session closed unexpectedly', { agentId: this.agentId, evt });
          this.geminiSession = null;
          // Reconnect only if we haven't left intentionally (mixInterval still
          // running), and with bounded backoff so a persistently-failing
          // endpoint can't spin a tight reconnect loop.
          if (this.mixInterval !== null) this.scheduleReconnect();
        },
        onerror: (err: unknown) => {
          logger.warn('gemini-live: session error', { agentId: this.agentId, err });
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction:  agent.system_prompt ?? undefined,
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
        ...(functionDeclarations && functionDeclarations.length > 0
          ? { tools: [{ functionDeclarations }] }
          : {}),
      },
    });

    this.geminiSession = session;
  }

  // ── Internal: mix loop ────────────────────────────────────────────────────

  private startMixLoop(): void {
    if (this.mixInterval) return;
    this.mixInterval = setInterval(() => {
      const frames = [...this.mixBuffers.values()];
      if (frames.length === 0) return;

      if (!this.geminiSession) {
        this.mixBuffers.clear();
        return;
      }

      this.lastAudioAt = Date.now();
      this.resetIdleTimer();
      this.mixBuffers.clear();

      const mixed = mixFrames(frames);

      // Convert Int16Array to base64 for Gemini
      const raw    = Buffer.from(mixed.buffer, mixed.byteOffset, mixed.byteLength);
      const b64    = raw.toString('base64');

      try {
        this.geminiSession.sendRealtimeInput({
          audio: { data: b64, mimeType: 'audio/l16;rate=16000' },
        });
      } catch (err) {
        logger.warn('gemini-live: sendRealtimeInput failed', { err });
      }
    }, MIX_INTERVAL_MS);
  }

  private stopMixLoop(): void {
    if (this.mixInterval) {
      clearInterval(this.mixInterval);
      this.mixInterval = null;
    }
  }

  // ── Internal: idle timer ──────────────────────────────────────────────────

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    const timeoutMs = config.geminiLive.idleTimeoutMs;
    this.idleTimer = setTimeout(async () => {
      const idleMs = Date.now() - this.lastAudioAt;
      if (idleMs >= timeoutMs) {
        logger.info('gemini-live: idle timeout reached, destroying session', {
          agentId:  this.agentId,
          idleSec:  Math.round(idleMs / 1000),
        });
        await this.leave();
      } else {
        // Reschedule for the remaining window
        this.resetIdleTimer();
      }
    }, timeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ── Internal: server message handler ─────────────────────────────────────

  private async handleServerMessage(msg: unknown): Promise<void> {
    const message = msg as {
      serverContent?: {
        modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
        turnComplete?: boolean;
        interrupted?: boolean;
      };
      toolCall?: { functionCalls?: unknown[] };
    };

    // Barge-in: stop playback immediately if Gemini signals interruption
    if (message.serverContent?.interrupted) {
      this.interruptToken++;
      this.player.stop(true);
      this.playQueue = Promise.resolve();
      return;
    }

    // Handle tool calls
    if (message.toolCall?.functionCalls?.length) {
      await this.handleToolCalls(message.toolCall.functionCalls);
      return;
    }

    // Handle audio output
    const parts = message.serverContent?.modelTurn?.parts ?? [];
    for (const part of parts) {
      if (!part.inlineData?.data) continue;
      const mimeType = part.inlineData.mimeType ?? '';
      if (!mimeType.startsWith('audio/')) continue;

      // Decode base64 PCM from Gemini (24kHz mono Int16)
      const raw  = Buffer.from(part.inlineData.data, 'base64');
      const pcm  = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);

      // Upsample to 48kHz mono; playAudioBuffer handles stereo expansion
      const mono48 = upsample24to48(pcm);
      const mono48k = Buffer.from(mono48.buffer, mono48.byteOffset, mono48.byteLength);
      const tok = this.interruptToken;
      this.playQueue = this.playQueue.then(() => this.playAudioBuffer(mono48k, tok));
    }
  }

  // ── Internal: playback ────────────────────────────────────────────────────

  /**
   * Expand mono Int16 48kHz PCM to stereo, then play it via the AudioPlayer.
   * Awaits the player reaching Idle state with a 30-second timeout.
   */
  private async playAudioBuffer(pcmMono48k: Buffer, token: number): Promise<void> {
    if (token !== this.interruptToken) return;
    // Expand mono → stereo (duplicate each sample into L and R channels)
    const mono   = new Int16Array(pcmMono48k.buffer, pcmMono48k.byteOffset, pcmMono48k.byteLength / 2);
    const stereo = new Int16Array(mono.length * 2);
    for (let i = 0; i < mono.length; i++) {
      stereo[i * 2]     = mono[i]; // left
      stereo[i * 2 + 1] = mono[i]; // right
    }
    const outBuf = Buffer.from(stereo.buffer, stereo.byteOffset, stereo.byteLength);

    const readable = Readable.from(
      (function* () { yield outBuf; })(),
    );
    const resource = createAudioResource(readable, {
      inputType:    StreamType.Raw,
      inlineVolume: false,
    });

    this.player.play(resource);

    try {
      await entersState(this.player, AudioPlayerStatus.Idle, 30_000);
    } catch {
      // Timeout or player stopped early — not fatal, continue queue
      logger.warn('gemini-live: playAudioBuffer timed out waiting for Idle');
    }
  }

  // ── Internal: tool call handler ───────────────────────────────────────────

  private async handleToolCalls(calls: unknown[]): Promise<void> {
    const responses: FunctionResponse[] = [];
    for (const call of calls) {
      const c = call as Record<string, unknown>;
      let result = 'Tool execution unavailable';
      try {
        const res = await fetch(
          `http://127.0.0.1:${config.dashboard.port}/api/tools/execute`,
          {
            method:  'POST',
            headers: {
              'Content-Type':      'application/json',
              'x-dashboard-token': config.dashboard.token,
            },
            body:   JSON.stringify({ tool: c.name, args: c.args, agent_id: this.agentId }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        const json = await res.json() as { result?: string; error?: string };
        result = json.result ?? json.error ?? 'No result';
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
      }
      responses.push({ id: c.id as string, name: c.name as string, response: { output: result } });
    }
    try {
      this.geminiSession?.sendToolResponse({ functionResponses: responses });
    } catch (err) {
      logger.warn('gemini-live: failed to send tool response', { err });
    }
  }
}
