/**
 * broker/scrubber.ts — output scrubber (spec v3 §9).
 *
 * Defense-in-depth: every byte leaving `/api/broker/exec` (stdout + stderr)
 * passes through here so secret values that leaked into command output get
 * replaced by `***<NAME>***` before reaching the caller.
 *
 * Also covers common encodings: base64, base64url, URL-encoded, hex.
 */

export interface ScrubResult {
  scrubbed: string;
  triggered: boolean;
}

/**
 * Replace every occurrence of any `secrets` value (and common encodings of it)
 * in `output` with `***<NAME>***`.
 */
export function scrubOutput(output: string, secrets: Record<string, string>): ScrubResult {
  if (typeof output !== 'string' || output.length === 0) {
    return { scrubbed: output ?? '', triggered: false };
  }

  let result = output;
  let triggered = false;

  for (const [name, value] of Object.entries(secrets)) {
    if (!value) continue;
    const replacement = `***${name}***`;

    // 1. Literal
    if (result.includes(value)) {
      result = result.split(value).join(replacement);
      triggered = true;
    }

    // 2. base64
    const b64 = Buffer.from(value, 'utf8').toString('base64');
    if (b64 !== value && result.includes(b64)) {
      result = result.split(b64).join(replacement);
      triggered = true;
    }

    // 3. base64url
    const b64url = Buffer.from(value, 'utf8').toString('base64url');
    if (b64url !== value && b64url !== b64 && result.includes(b64url)) {
      result = result.split(b64url).join(replacement);
      triggered = true;
    }

    // 4. URL-encoded
    let enc: string | null = null;
    try { enc = encodeURIComponent(value); } catch { enc = null; }
    if (enc && enc !== value && result.includes(enc)) {
      result = result.split(enc).join(replacement);
      triggered = true;
    }

    // 5. Hex
    const hex = Buffer.from(value, 'utf8').toString('hex');
    if (hex !== value && result.includes(hex)) {
      result = result.split(hex).join(replacement);
      triggered = true;
    }
  }

  return { scrubbed: result, triggered };
}

/**
 * Stateful, chunk-boundary-safe wrapper around `scrubOutput` for streamed
 * output. A secret value split across two stream chunks would slip past a
 * naive per-chunk scrub; this holds back a tail long enough to catch any
 * secret (in any supported encoding) that straddles a boundary.
 */
export interface StreamScrubber {
  /** Feed a chunk; returns the safe-to-emit portion (may be ''). */
  push(chunk: string): string;
  /**
   * Call once when the stream ends; returns the scrubbed remainder.
   * MUST be called — omitting it silently discards the held-back tail
   * (up to 3x the longest secret value length), truncating the output.
   */
  flush(): string;
}

export function createStreamScrubber(secrets: Record<string, string>): StreamScrubber {
  const values = Object.values(secrets).filter(Boolean);
  // Hold back enough trailing text to contain any secret straddling a chunk
  // boundary, in any encoding scrubOutput handles. Per raw length L:
  // hex = 2L, base64 ≈ ⌈4L/3⌉, url-encoding ≤ 3L — so 3L covers all three.
  const holdback = values.length === 0
    ? 0
    : Math.max(...values.map((v) => v.length)) * 3;
  let buffer = '';

  return {
    push(chunk: string): string {
      if (holdback === 0) return chunk;            // no secrets — passthrough
      buffer += chunk;
      const scrubbed = scrubOutput(buffer, secrets).scrubbed;
      if (scrubbed.length <= holdback) {           // not enough yet — retain all
        buffer = scrubbed;
        return '';
      }
      const emit = scrubbed.slice(0, scrubbed.length - holdback);
      buffer = scrubbed.slice(scrubbed.length - holdback);
      return emit;
    },
    flush(): string {
      const out = holdback === 0 ? buffer : scrubOutput(buffer, secrets).scrubbed;
      buffer = '';
      return out;
    },
  };
}
