/**
 * broker/scrubber.ts — output scrubber (spec v3 §9).
 *
 * Defense-in-depth: every byte leaving `/api/broker/exec` (stdout + stderr)
 * passes through here so secret values that leaked into command output get
 * replaced by `***<NAME>***` before reaching the caller.
 *
 * Also covers common encodings: base64, base64url, URL-encoded, hex.
 *
 * Over-scrub guard (name classification): a naked substring replace of a
 * NON-sensitive identifier value (a service URL, username, bucket name, …)
 * mangles unrelated output — a MinIO endpoint scrubbed out of every log line
 * that mentions the host, a username blanked from an audit trail. We therefore
 * classify each secret by its NAME (`SCOPE_SERVICE_TYPE`) and skip scrubbing
 * ONLY when every TYPE token is a proven identifier token. Everything else —
 * any credential marker (KEY/TOKEN/SECRET/PASSWORD/PAT), any unknown/CUSTOM
 * token, any unparseable name — is fail-closed to SCRUB. Real credentials are
 * never in the identifier set, so they always scrub, in every encoding.
 */
import { parseName } from './nameParser';

export interface ScrubResult {
  scrubbed: string;
  triggered: boolean;
}

/**
 * TYPE tokens that denote a routing/identity value — NOT a credential. A secret
 * whose TYPE segment is composed ENTIRELY of these tokens is never scrubbed.
 * Kept deliberately conservative: adding a token here says "values of this kind
 * are safe to appear verbatim in output". When in doubt, leave it out (→ scrub).
 */
const IDENTIFIER_TOKENS = new Set<string>([
  'URL', 'URI', 'ENDPOINT', 'HOST', 'HOSTNAME', 'DOMAIN', 'ADDRESS', 'ADDR',
  'USERNAME', 'USER', 'LOGIN', 'ACCOUNT', 'EMAIL',
  'BUCKET', 'NAME', 'REGION', 'ZONE', 'PROJECT', 'ORG', 'NAMESPACE',
  'PORT', 'PATH', 'PREFIX', 'DATABASE', 'SCHEMA', 'TABLE',
  'VERSION', 'MODEL', 'PROVIDER', 'CHANNEL', 'TOPIC', 'QUEUE',
]);

/**
 * TYPE tokens that unambiguously mark a credential. Presence of ANY of these
 * forces SCRUB regardless of the other tokens (fail-closed short-circuit).
 */
const CREDENTIAL_TOKENS = new Set<string>([
  'KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASS', 'PAT', 'CREDENTIAL', 'CRED',
  'AUTH', 'SIGNATURE', 'SIGN', 'PRIVATE', 'CERT', 'SEED', 'SALT', 'NONCE',
  'SESSION', 'COOKIE', 'BEARER', 'APIKEY', 'ACCESSKEY', 'SECRETKEY', 'DSN',
]);

/**
 * Decide whether a secret's VALUE should be scrubbed from output, based solely
 * on its NAME. Fail-closed: returns `true` (scrub) for anything unparseable,
 * CUSTOM, unknown-token, or credential-marked. Returns `false` (never-scrub)
 * ONLY when the name parses cleanly AND every TYPE token is a proven identifier.
 *
 * Invariant: a real credential name (…_KEY, …_TOKEN, …_PAT, …) can never reach
 * the `false` branch, so real secrets always scrub.
 */
export function shouldScrubName(name: string): boolean {
  const parsed = parseName(name);
  if (!parsed) return true;                       // unparseable → fail-closed
  const tokens = parsed.type.split('_').filter(Boolean);
  if (tokens.length === 0) return true;           // no TYPE tokens → fail-closed
  for (const tok of tokens) {
    if (CREDENTIAL_TOKENS.has(tok)) return true;  // any credential marker → scrub
    if (!IDENTIFIER_TOKENS.has(tok)) return true; // unknown / CUSTOM token → scrub
  }
  return false;                                   // every token a proven identifier → never-scrub
}

/**
 * Entropy/length floor for the naked-substring (literal) replace.
 *
 * A short, low-entropy, single dictionary-ish token (`admin`, `password`,
 * `changeme`, `test`, a leftover placeholder from a mis-typed secret) is almost
 * never a real credential, yet as a naked substring it appears all over
 * unrelated output — blanking it corrupts logs and, worse, long-term memory.
 * We therefore SKIP the literal replace for such values. This ONLY relaxes the
 * literal branch: the base64 / base64url / URL / hex encodings below still scrub
 * (an encoded form of a short word does not false-positive on ordinary text),
 * so the change can only ADD data-integrity protection, never remove scrubbing
 * from a real key — a real key is long and/or high-entropy and/or carries
 * separator symbols, so it fails at least one condition and always scrubs.
 *
 * Gate is an AND of three independent degeneracy signals:
 *   1. short          — length ≤ 8
 *   2. single token   — pure ASCII alphanumeric, no separators/symbols/spaces
 *   3. low per-char entropy — Shannon entropy < 3.0 bits/char
 */
const LITERAL_LEN_FLOOR = 8;
const LITERAL_ENTROPY_FLOOR = 3.0;
const SINGLE_ALNUM_TOKEN_RE = /^[A-Za-z0-9]+$/;

/** Shannon entropy in bits per character. Empty string → 0. */
function shannonEntropyPerChar(value: string): number {
  if (value.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * True when a value is too short + low-entropy + dictionary-ish to be a real
 * credential — signalling that its LITERAL form must not be naked-substring
 * scrubbed. Never consulted for the encoded forms.
 */
export function isLiteralScrubExempt(value: string): boolean {
  if (value.length === 0 || value.length > LITERAL_LEN_FLOOR) return false;
  if (!SINGLE_ALNUM_TOKEN_RE.test(value)) return false;
  return shannonEntropyPerChar(value) < LITERAL_ENTROPY_FLOOR;
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
    if (!shouldScrubName(name)) continue;   // proven non-sensitive identifier — leave verbatim
    const replacement = `***${name}***`;

    // 1. Literal — skipped for degenerate short/low-entropy dictionary-ish
    // values (see isLiteralScrubExempt); the encodings below still scrub, so a
    // real key is never left exposed.
    if (!isLiteralScrubExempt(value) && result.includes(value)) {
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
  // Only scrubbable secrets contribute to the holdback — never-scrub identifiers
  // must not delay/buffer output they will never touch.
  const values = Object.entries(secrets)
    .filter(([name, v]) => Boolean(v) && shouldScrubName(name))
    .map(([, v]) => v);
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
