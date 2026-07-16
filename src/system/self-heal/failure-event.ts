// Self-heal: failure normalization + signature.
//
// Turns any raw failure surface (review-block, tool give-up, exec error, task
// failure) into a stable FailureEvent whose `signature` is what failure-memory
// keys on. Getting the signature RIGHT is the whole ballgame (ASAGI §3):
//   • strip too little → never a cache hit (defeats the point)
//   • strip too much   → collisions where a wrong stored fix auto-injects into
//                        an UNRELATED bug (actively harmful)
// So the signature = error-class + coarse-module-identity + normalized message
// + phase. Paths/line-numbers/timestamps/hex/ids are stripped from the message,
// but a coarse module identity is kept SEPARATELY so two "Cannot read property
// x of undefined" from different modules do NOT collapse into one entry.

import { createHash } from 'crypto';

export type FailurePhase =
  | 'review'   // task failed the holdout/review gate  (the killer-feature path)
  | 'tool'     // tool-call give-up streak
  | 'exec'     // shell / exec error
  | 'task'     // generic task→failed
  | 'infra'    // host load / liveness / heartbeat timing
  | 'vcs';     // git-state artifacts (lock, dangling worktree, stale ref)

export interface FailureEvent {
  taskId?:      string;
  phase:        FailurePhase;
  errorClass:   string;      // e.g. TypeError, TimeoutError, ReviewBlock:high
  moduleIdent:  string;      // coarse module/fn identity (collision guard)
  message:      string;      // scrubbed + normalized representative message
  signature:    string;      // stable hash — the failure-memory key
  artifactRef?: string;      // file/module the failure is about (blast-radius anchor)
  runId?:       string;      // autonomous run id (storm-breaker scope)
  raw?:         string;      // scrubbed raw (never persisted verbatim into Learn)
}

// ── secret scrub (ASAGI blocking #2) ──────────────────────────────────────
// rawError can carry broker tokens, env dumps, JWTs, URLs with keys. This runs
// BEFORE anything is stored or logged. Broker rules: values never persist.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,            '‹key›'],          // sk-… style keys
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g,  '‹jwt›'],          // JWTs
  [/\bBearer\s+[A-Za-z0-9._-]{8,}/gi,            'Bearer ‹token›'], // auth headers
  [/\bghp_[A-Za-z0-9]{20,}/g,                    '‹gh-pat›'],       // github PAT
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g,            '‹slack›'],         // slack tokens
  [/([?&](?:api[_-]?key|token|secret|password|access[_-]?key)=)[^&\s]+/gi, '$1‹redacted›'],
  [/\b[A-Za-z0-9]{32,}\b/g,                       '‹hex›'],          // long opaque blobs
];

export function scrubSecrets(input: string): string {
  let s = input;
  for (const [re, repl] of SECRET_PATTERNS) s = s.replace(re, repl);
  return s;
}

// ── message normalization ─────────────────────────────────────────────────
// Strip the volatile bits so the SAME bug matches across runs, while keeping
// the structural shape so DIFFERENT bugs stay distinct.
function normalizeMessage(msg: string): string {
  return scrubSecrets(msg)
    .replace(/[0-9a-f]{7,40}\b/gi, '‹sha›')                       // git shas / hashes
    .replace(/\/[^\s'"]+\/([\w.-]+\.[a-z]{1,5})/gi, '$1')          // /abs/path/foo.ts → foo.ts
    .replace(/:\d+:\d+/g, '')                                      // :line:col
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '‹ts›')          // ISO timestamps
    .replace(/\b\d+\b/g, 'N')                                      // bare numbers
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

// ── error class extraction ────────────────────────────────────────────────
function extractErrorClass(msg: string, phase: FailurePhase): string {
  const m = msg.match(/\b([A-Z][a-zA-Z]*(?:Error|Exception|Timeout))\b/);
  if (m) return m[1];
  // HTTP-status classes are meaningful for tool/exec phases.
  const http = msg.match(/\b(4\d\d|5\d\d)\b/);
  if (http) return `HTTP${http[1]}`;
  return phase === 'review' ? 'ReviewBlock' : 'Failure';
}

// ── coarse module identity (collision guard, ASAGI §3) ────────────────────
// Prefer an explicit artifactRef; else pull the first source file mentioned in
// the message/stack. Keep it COARSE (basename, no line/col) so it groups a bug
// by where it lives without over-fragmenting on line drift.
export function extractModuleIdent(msg: string, artifactRef?: string): string {
  if (artifactRef && artifactRef.trim()) {
    const base = artifactRef.split(/[\\/]/).pop() ?? artifactRef;
    return base.replace(/:\d+.*$/, '').trim().slice(0, 80);
  }
  const m = msg.match(/([\w.-]+\.(?:ts|tsx|js|jsx|py|sql|json))/);
  return m ? m[1] : 'unknown';
}

// ── recoverable-class detector (ASAGI blocking #6) ────────────────────────
// Transient errors that the upstream recoverable-classifier / circuit-breakers
// already retry. These must NEVER be persisted to failure-memory — backoff is
// not a learned procedure, and storing it just pollutes lookup.
const RECOVERABLE_RE =
  /\b(429|502|503|504|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|rate.?limit|overloaded|timed out|socket hang up|stale.?read|read.?before.?write|has not been read yet)\b/i;

export function isRecoverable(msg: string): boolean {
  return RECOVERABLE_RE.test(msg);
}

// ── vcs-noise detector (ASAGI blocking #5) ────────────────────────────────
// Git-state artifacts. Excluded from Learn regardless of Verify outcome — a
// "fix" like delete-lockfile / force-checkout that Verify-passes by coincidence
// would auto-replay as a footgun against a legitimate lock later.
const VCS_RE =
  /\b(index\.lock|\.git\/|worktree|detached HEAD|fatal: .*ref|cannot lock ref|unmerged|merge conflict|dangling|stash)\b/i;

export function isVcsNoise(msg: string): boolean {
  return VCS_RE.test(msg);
}

// ── phase inference ───────────────────────────────────────────────────────
export function inferPhase(msg: string, hint?: FailurePhase): FailurePhase {
  if (hint) {
    // A vcs/infra shape overrides a generic 'task'/'exec' hint so exclusions apply.
    if (hint === 'exec' || hint === 'task') {
      if (isVcsNoise(msg)) return 'vcs';
    }
    return hint;
  }
  if (isVcsNoise(msg)) return 'vcs';
  return 'task';
}

// ── the builder ───────────────────────────────────────────────────────────
export function buildFailureEvent(opts: {
  phase?:       FailurePhase;
  rawError:     string;
  taskId?:      string;
  artifactRef?: string;
  runId?:       string;
}): FailureEvent {
  const scrubbedRaw = scrubSecrets(opts.rawError ?? '');
  const phase       = inferPhase(scrubbedRaw, opts.phase);
  const message     = normalizeMessage(scrubbedRaw);
  const errorClass  = extractErrorClass(message, phase);
  const moduleIdent = extractModuleIdent(message, opts.artifactRef);

  // Signature = phase | errorClass | moduleIdent | normalizedMessage.
  // moduleIdent is a SEPARATE component (not folded into message) precisely so
  // identical messages from different modules do not collide.
  const signature = createHash('sha256')
    .update(`${phase}|${errorClass}|${moduleIdent}|${message}`)
    .digest('hex')
    .slice(0, 24);

  return {
    taskId:      opts.taskId,
    phase,
    errorClass,
    moduleIdent,
    message,
    signature,
    artifactRef: opts.artifactRef,
    runId:       opts.runId,
    raw:         scrubbedRaw.slice(0, 2000),
  };
}
