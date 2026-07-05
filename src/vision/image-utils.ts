// Image downscaling for the vision describer.
//
// Images are handed to the describer inline as base64 data URIs (see
// routes.ts toDataUri — we encode server-side so the backend never has to
// re-fetch an expired Discord CDN link). The hermes/xAI proxy caps the
// request body at exactly 1 MiB, so a large screenshot (>~780 KB raw →
// >1 MiB base64) overflows the cap and the describe call fails with
// "413 Maximum request body size 1048576 exceeded". Gemini/OpenRouter and
// xAI have their own image-size ceilings too.
//
// This shrinks oversized data URIs in place: resize the longest edge down and
// re-encode as JPEG, stepping quality until the base64 payload fits under the
// cap with headroom. Small images and remote URLs pass through untouched.
// Best-effort: any failure returns the original URL so the call still runs.

import Jimp from 'jimp';
import { logger } from '../utils/logger';

// Ceiling for the base64 STRING length. The proxy limit is 1 MiB (1048576) on
// the raw request body; the JSON envelope and field add overhead, so we aim
// well under to leave room.
const MAX_DATA_URI_CHARS = 900_000;
// Practical vision resolution ceiling (longest edge, px). Models gain little
// above this for description tasks, and it keeps token cost/latency down.
const MAX_EDGE = 1568;

/**
 * If `url` is an oversized base64 data URI, downscale + recompress it to fit
 * under the request-body cap. Non-data URLs and already-small data URIs pass
 * through unchanged. Never throws — returns the original on any failure.
 */
export async function shrinkDataUriIfLarge(url: string): Promise<string> {
  if (!url.startsWith('data:')) return url;          // remote URL — body stays tiny
  if (url.length <= MAX_DATA_URI_CHARS) return url;  // already fits comfortably

  const comma = url.indexOf(',');
  if (comma < 0) return url;
  const meta = url.slice(5, comma); // e.g. "image/png;base64"
  if (!/base64/i.test(meta)) return url;

  try {
    const inputBytes = Buffer.from(url.slice(comma + 1), 'base64');
    const img = await Jimp.read(inputBytes);
    const { width, height } = img.bitmap;
    if (width > MAX_EDGE || height > MAX_EDGE) {
      img.scaleToFit(MAX_EDGE, MAX_EDGE);
    }
    // Re-encode as JPEG, stepping quality down until the base64 fits.
    let quality = 82;
    let outB64 = '';
    for (;;) {
      img.quality(quality);
      const out = await img.getBufferAsync(Jimp.MIME_JPEG);
      outB64 = out.toString('base64');
      if (outB64.length <= MAX_DATA_URI_CHARS || quality <= 35) break;
      quality -= 12;
    }
    const result = `data:image/jpeg;base64,${outB64}`;
    logger.info('vision: downscaled oversized image', {
      fromChars: url.length,
      toChars: result.length,
      fromDims: `${width}x${height}`,
      toDims: `${img.bitmap.width}x${img.bitmap.height}`,
      quality,
    });
    return result;
  } catch (err) {
    logger.warn('vision: image downscale failed, sending original', { err: (err as Error).message });
    return url;
  }
}
