// Audio transcoding for transcription. VoidAI's Whisper clone rejects formats
// that OpenAI's reference Whisper accepts (notably .ogg), so we remux/re-encode
// non-whitelist inputs into webm before sending. Discord voice notes ship as
// Ogg-Opus, which is bit-for-bit compatible with WebM-Opus — we just rewrap the
// container with `-c:a copy` so there's no quality loss and no re-encode.

import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

// VoidAI's accepted formats per the 400 response.
const WHISPER_OK = new Set(['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm', 'flac']);

const FFMPEG_PATH = (ffmpegStatic as unknown as string | null) ?? 'ffmpeg';

interface TranscodeResult {
  buffer:   Buffer;
  mimeType: string;
  ext:      string;
}

/**
 * Return the same buffer untouched if Whisper already accepts the format,
 * otherwise transcode to a Whisper-friendly container. Ogg-Opus → WebM-Opus
 * via `-c:a copy` (no re-encode); anything else falls through to mp3.
 */
export async function transcodeForWhisper(buf: Buffer, mimeType: string, filename?: string): Promise<TranscodeResult> {
  const ext = inferExt(mimeType, filename);
  if (WHISPER_OK.has(ext)) {
    return { buffer: buf, mimeType, ext };
  }
  // Ogg containers (Discord voice messages, Firefox MediaRecorder defaults)
  // get rewrapped into WebM with the audio stream copied — no quality loss.
  if (ext === 'ogg' || ext === 'oga' || mimeType.includes('ogg')) {
    try {
      const out = await runFfmpeg(buf, ['-c:a', 'copy', '-f', 'webm']);
      return { buffer: out, mimeType: 'audio/webm', ext: 'webm' };
    } catch {
      // Fall through to the universal re-encode path if remuxing somehow fails
      // (e.g. exotic non-Opus stream inside an .ogg container).
    }
  }
  const out = await runFfmpeg(buf, ['-vn', '-acodec', 'libmp3lame', '-q:a', '4', '-f', 'mp3']);
  return { buffer: out, mimeType: 'audio/mpeg', ext: 'mp3' };
}

function inferExt(mimeType: string, filename?: string): string {
  const fromName = filename ? filename.split('.').pop()?.toLowerCase() : '';
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  const m = mimeType.toLowerCase();
  if (m.includes('ogg'))   return 'ogg';
  if (m.includes('webm'))  return 'webm';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav'))   return 'wav';
  if (m.includes('flac'))  return 'flac';
  if (m.includes('m4a') || m.includes('mp4')) return 'm4a';
  return '';
}

function runFfmpeg(input: Buffer, outArgs: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ['-loglevel', 'error', '-i', 'pipe:0', ...outArgs, 'pipe:1'];
    const ff = spawn(FFMPEG_PATH, args);
    const out: Buffer[] = [];
    let errBuf = '';
    ff.stdout.on('data', (d: Buffer) => out.push(d));
    ff.stderr.on('data', (d: Buffer) => { errBuf += d.toString(); });
    ff.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    ff.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exit ${code}: ${errBuf.slice(0, 240)}`));
    });
    // Pipe stdin as one chunk; ignore EPIPE in the rare case ffmpeg closes early.
    ff.stdin.on('error', () => { /* swallow EPIPE */ });
    ff.stdin.write(input);
    ff.stdin.end();
  });
}
