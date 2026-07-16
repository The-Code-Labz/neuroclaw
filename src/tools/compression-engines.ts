// Compression engines for the universal tool-output middleware.
// Each engine is a pure, idempotent, length-non-increasing transform. They run
// in fixed order (cheap/safe first) inside maybeCompressToolResult().

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Lite engine — structural whitespace/format normalization.
 *   - normalize line endings to LF
 *   - strip ANSI escape sequences
 *   - trim trailing whitespace per line
 *   - collapse 3+ consecutive blank lines to 2
 *   - trim leading/trailing blank lines
 *
 * Never changes values inside tokens; safe for code, paths, IDs, numbers.
 */
export function liteCompressString(input: string): string {
  if (!input || input.length < 2) return input;
  let text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(ANSI_RE, '');
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === '') {
      blanks++;
      if (blanks <= 2) out.push(line);
    } else {
      blanks = 0;
      out.push(line);
    }
  }
  while (out.length > 0 && out[0] === '') out.shift();
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/**
 * Headroom engine — JSON/tabular compaction.
 * Failsafe: if JSON.parse throws, the original string passes through untouched.
 * Only touches strings that look like JSON objects/arrays, so prose and code
 * that isn't valid JSON are never mangled.
 */
export function headroomCompressString(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return input;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return input;
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(parsed);
  } catch {
    return input;
  }
}

/**
 * Recursively apply a string transform to every string leaf in a value tree.
 * Objects/arrays are reconstructed; primitives pass through. Bounded depth to
 * guard against pathological circular-ish shapes.
 */
export function mapStringLeaves(
  value: unknown,
  fn: (s: string) => string,
  depth = 0,
): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) {
    return value.map((v) => mapStringLeaves(v, fn, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = mapStringLeaves(v, fn, depth + 1);
    }
    return out;
  }
  return value;
}
