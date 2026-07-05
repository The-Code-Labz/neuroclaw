---
title: Audio (TTS & transcription)
order: 40
---

# Audio (TTS & transcription)

NeuroClaw supports two audio capabilities: **text-to-speech (TTS)** for turning agent replies into spoken audio, and **speech-to-text transcription** for converting uploaded or recorded audio into text. Both are available via the dashboard API and are wired into the Discord bot reply path.

---

## TTS providers

Two backends are supported behind a single `synthesize()` call. Callers — the dashboard `/api/audio/speak` endpoint and the Discord reply path — do not need to know which backend a given agent is configured for.

### VoidAI (default)

VoidAI exposes an OpenAI-compatible `POST /audio/speech` endpoint. Authentication uses `VOIDAI_API_KEY`; the base URL follows `VOIDAI_BASE_URL`. This is the default provider when an agent has no explicit TTS configuration.

Available voices: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`.

Output format defaults to `mp3`. You can request `wav` or `opus` via the API; the response MIME type adjusts accordingly (`audio/mpeg`, `audio/wav`, `audio/ogg`).

### ElevenLabs

ElevenLabs offers richer voice cloning and a broader voice library. It is **disabled by default** — the integration activates only when `ELEVENLABS_API_KEY` is set.

Requests go to `POST /text-to-speech/{voice_id}` with the `xi-api-key` authentication header. The default model is `eleven_turbo_v2_5`, which prioritises speed and cost. Switch to a higher-fidelity model via `ELEVENLABS_MODEL` when quality matters more than latency.

Voice IDs are not a fixed enum. The dashboard voice picker fetches your library from `GET /v1/voices`, caches it for five minutes, and falls back to the cached list if the API is unreachable during a refresh.

When ElevenLabs is active, the output format mapping is:

| Requested format | ElevenLabs output\_format |
|---|---|
| `mp3` (default) | `mp3_44100_128` |
| `wav` | `pcm_16000` |
| `opus` | `opus_48000_64` |

### Choosing a provider per agent

Each agent record has optional `tts_provider` (`voidai` or `elevenlabs`) and `tts_voice` fields. When set, they take precedence over environment defaults. If neither is set, `resolveAgentVoice()` falls back to `VOIDAI_TTS_VOICE` for VoidAI agents and `ELEVENLABS_DEFAULT_VOICE_ID` for ElevenLabs agents.

---

## Transcription

Speech-to-text uses VoidAI's OpenAI-compatible `POST /audio/transcriptions` endpoint (Whisper). There is one provider for transcription; ElevenLabs STT is not currently integrated.

### Supported input formats

VoidAI's Whisper implementation accepts: `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, `webm`, `flac`.

Formats outside this list — including `.ogg` (common for Discord voice messages and Firefox MediaRecorder output) — are transcoded automatically before upload. See the transcode section below.

### File size limit

Uploads are rejected before sending if they exceed `AUDIO_MAX_MB` (default 25 MB). The error message includes the configured limit so it is visible in logs and API error responses.

### Optional parameters

The `TranscribeRequest` interface accepts:

- `language` — ISO-639-1 language hint (e.g. `en`, `fr`). Improves accuracy for non-English audio.
- `prompt` — priming context string. Useful for proper nouns or domain vocabulary that Whisper would otherwise mishear.
- `model` — override the Whisper model for a single request, independent of `VOIDAI_TRANSCRIBE_MODEL`.

---

## Transcode support

`transcodeForWhisper()` in `src/audio/transcode.ts` handles format normalisation transparently before any transcription request. It uses `ffmpeg` (via `ffmpeg-static`) and operates as follows:

1. If the input format is already on the Whisper-OK list, the buffer is returned unchanged — no re-encode, no latency.
2. If the format is `ogg` / `oga` or has an `audio/ogg` MIME type, it is **remuxed** into a WebM container with `-c:a copy`. This is a lossless container swap; Ogg-Opus (the format Discord voice notes use) is bit-for-bit compatible with WebM-Opus, so no audio quality is lost.
3. Any other unsupported format is re-encoded to MP3 using `libmp3lame` at quality level 4.

If the remux step fails (for example, an exotic non-Opus stream inside an `.ogg` container), the code falls through to the MP3 re-encode path rather than surfacing an error.

---

## How agents use audio

### TTS

TTS fires in two places:

- **Discord bot reply path**: When an agent's `tts_provider` is set and the bot is configured to speak in a voice channel, the reply text is passed to `synthesize()` before being sent.
- **Dashboard `/api/audio/speak`**: The dashboard can request spoken audio for any agent message on demand. The endpoint accepts `text`, `provider`, `voiceId`, `model`, and `format` and returns the audio buffer with the appropriate MIME type.

Text is truncated to `AUDIO_MAX_TTS_CHARS` (default 4000 characters) before the provider call. This cap applies regardless of which provider is used.

### Transcription

Transcription is triggered when a user submits audio input — via the dashboard's voice input UI or a Discord voice attachment. The audio buffer, MIME type, and optional metadata are passed to `transcribe()`, which handles format detection, transcoding if needed, and the Whisper API call. The returned text is then treated as the user's message.

---

## Configuration

All audio environment variables have sensible defaults and are optional except where noted.

| Variable | Default | Notes |
|---|---|---|
| `VOIDAI_TTS_MODEL` | `tts-1` | Whisper-compatible TTS model on the VoidAI endpoint |
| `VOIDAI_TTS_VOICE` | `alloy` | Default voice for VoidAI TTS. Options: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer` |
| `VOIDAI_TRANSCRIBE_MODEL` | `whisper-1` | Whisper model used for speech-to-text |
| `ELEVENLABS_API_KEY` | — | Required to enable the ElevenLabs backend. Omit to keep it disabled |
| `ELEVENLABS_BASE_URL` | `https://api.elevenlabs.io/v1` | Override for self-hosted or proxy deployments |
| `ELEVENLABS_DEFAULT_VOICE_ID` | *(empty)* | Fallback voice ID for agents that use ElevenLabs but have no per-agent voice set. Required if using ElevenLabs |
| `ELEVENLABS_MODEL` | `eleven_turbo_v2_5` | ElevenLabs TTS model. Switch to `eleven_multilingual_v2` or a higher-tier model for better quality |
| `AUDIO_MAX_MB` | `25` | Maximum audio file size accepted by the transcription endpoint, in megabytes |
| `AUDIO_MAX_TTS_CHARS` | `4000` | Maximum characters of text sent to any TTS provider per request; excess is silently truncated |
