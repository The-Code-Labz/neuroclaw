/**
 * system/ssh-connect.ts — agent SSH capability L2 (spec: ssh-machines-feature §3, deliverable #3).
 *
 * SECURITY MODEL
 *   • Credentials NEVER live in this process's DB or in agent context. The
 *     private key / password (+ optional passphrase) is resolved at call time
 *     from the NC Broker via broker.withSecrets (restricted-secret capability,
 *     scope-checked + audited), used inside the connect callback, and dropped.
 *     The agent that called ssh_run never sees the value.
 *   • Host keys are TOFU-with-human-confirmation (§10): first connect captures
 *     the SHA-256 fingerprint and is REFUSED until an operator verifies it in
 *     the Machines tab (fingerprint_status → 'verified'). A later mismatch is
 *     a hard fail + auto-disable + alert — never a silent auto-update.
 *   • Machine-level authorization (allowed_agents, disabled, sensitivity /
 *     critical-run confirm) is enforced HERE, after machine_id is known, as a
 *     second fail-closed check on top of gateSsh (§4.0).
 *   • Command exec is at-most-once (§7.3): a per-exec UUID is logged; a dropped
 *     channel returns execution_uncertain, never a blind retry.
 *   • Agent forwarding + X11 are never enabled (§6.4).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Client, type ConnectConfig } from 'ssh2';
import { agentStore, broker } from '../broker';
import { RESTRICTED_SECRET_CAPABILITY } from '../broker/restrictedSecrets';
import {
  createAgentUserMessage,
  getSshMachine, getSshMachineByName, insertSshAudit, updateSshMachine,
  type SshMachineRow,
} from '../db';
import { requestConfirmation } from './pending-confirmation';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';

// ── tunables (§7.1, §8.1, §8.2) ──────────────────────────────────────────────
const READY_TIMEOUT_MS   = 20_000;   // ssh2 handshake timeout
const CONNECT_TIMEOUT_MS  = 15_000;  // outer race — don't wait on OS TCP timeout
const KEEPALIVE_MS        = 15_000;  // idle NAT/LB drop is the #1 "it hangs" bug
const KEEPALIVE_MAX       = 3;       // ~45s to detect a dead link
const DEFAULT_EXEC_MS     = 300_000; // command timeout, separate from connect
const MAX_STREAM_BYTES    = 1024 * 1024; // 1 MB cap per stream (§8.2)
const MAX_XFER_BYTES      = 100 * 1024 * 1024; // 100 MB SFTP cap (§8.3)
const CONNECT_RETRIES     = 3;       // transport-only (§7.3)

// Host-key algorithm allowlist (§6.3) — ed25519 / ecdsa only unless legacy opt-in.
const STRONG_HOST_KEYS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
] as const;

// Catastrophic-command tripwires (§5.3) — log + ALERT, never block.
const TRIPWIRES: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?\s+\/(?:\s|$)/i,   // rm -rf /
  /\bmkfs\b/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,  // classic fork bomb
  />\s*\/dev\/sd[a-z]/i,
  /\bcurl\b[^\n]*\|\s*(?:sudo\s+)?sh\b/i,
  /\bwget\b[^\n]*\|\s*(?:sudo\s+)?sh\b/i,
];

// ── result envelope (§8.2) ───────────────────────────────────────────────────
export type SshErrorType = 'connection' | 'command' | 'internal' | null;

export interface SshRunResult {
  ok:         boolean;
  machine:    string;
  exitCode:   number | null;
  stdout:     string;
  stderr:     string;
  truncated?: boolean;
  binary?:    boolean;
  errorType?: SshErrorType;
  execId?:    string;
  connection?: { host: string; port: number; user: string };
  error?:     string;
}

export interface SshTransferResult {
  ok:        boolean;
  machine:   string;
  bytes?:    number;
  errorType?: SshErrorType;
  error?:    string;
}

/** Common caller identity threaded from the tool handler. */
export interface SshCallerCtx {
  agentId?:         string | null;
  agentName:        string;
  sessionId:        string;
  taskId?:          string | null;
  runId?:           string | null;
  turnNumber?:      number;
  delegationChain?: string | null;
  /** Operator actions (Test Connection from the tab) bypass the per-agent grant. */
  operator?:        boolean;
}

// ── typed connect error ──────────────────────────────────────────────────────
type ConnectCode =
  | 'tofu_first_seen' | 'tofu_unverified' | 'fingerprint_mismatch'
  | 'auth' | 'transport' | 'timeout' | 'internal';

class SshConnectError extends Error {
  errorType: SshErrorType;
  code:      ConnectCode;
  fingerprint?: string;
  constructor(errorType: SshErrorType, code: ConnectCode, message: string, fingerprint?: string) {
    super(message);
    this.errorType = errorType;
    this.code = code;
    this.fingerprint = fingerprint;
  }
}

function classifyErr(err: unknown): SshConnectError {
  const e = err as { message?: string; level?: string; code?: string } | undefined;
  const msg = String(e?.message ?? err ?? 'ssh error');
  const code = e?.code ?? '';
  if (/authentication|all configured auth|permission denied/i.test(msg))
    return new SshConnectError('connection', 'auth', 'authentication failed');
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(code)
      || /timed out|timeout|getaddrinfo|handshake/i.test(msg))
    return new SshConnectError('connection', 'transport', msg);
  return new SshConnectError('connection', 'internal', msg);
}

// ── generic secret-shape scrubber (§9.2) — for output whose value we don't know
function scrubShapes(text: string): string {
  if (!text) return text;
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '***PRIVATE_KEY_REDACTED***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '***AWS_KEY_REDACTED***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '***JWT_REDACTED***')
    .replace(/\bghp_[A-Za-z0-9]{30,}\b/g, '***GH_TOKEN_REDACTED***')
    .replace(/\bGOCSPX-[A-Za-z0-9_-]{10,}\b/g, '***OAUTH_SECRET_REDACTED***')
    .replace(/\b(?:sk|rk)-[A-Za-z0-9]{20,}\b/g, '***API_KEY_REDACTED***')
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1***REDACTED***');
}

function looksBinary(sample: string): boolean {
  if (!sample) return false;
  let nonPrintable = 0;
  const n = Math.min(sample.length, 4096);
  for (let i = 0; i < n; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32)) nonPrintable++;
  }
  return nonPrintable / n > 0.3;
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** Resolve a machine by id first, then by name (agents reference by name). */
export function resolveMachine(ref: string): SshMachineRow | undefined {
  return getSshMachine(ref) ?? getSshMachineByName(ref);
}

/** Best-effort operator alert (§9.3) — never throws into the SSH flow. */
function alertUser(machine: SshMachineRow, title: string, detail: string, sessionId?: string | null): void {
  try {
    createAgentUserMessage({
      fromAgentId: 'ssh', fromName: 'SSH', kind: 'alert',
      body: `${title}\n\n${detail}`,
      metadata: { machineId: machine.id, host: machine.host },
      sessionId: sessionId ?? null,
    });
  } catch { /* notify failure must not break the SSH flow */ }
  logHive('ssh_alert', title, undefined, { machineId: machine.id, detail: detail.slice(0, 200) });
}

/**
 * Machine-level authorization (§4.0 conditions 3+4). gateSsh already enforced
 * 1/2/5; this is the second fail-closed check now that machine_id is known.
 */
function authorizeMachine(machine: SshMachineRow, ctx: SshCallerCtx): { ok: true } | { ok: false; outcome: string; reason: string } {
  if (machine.disabled) return { ok: false, outcome: 'denied-gate', reason: `machine '${machine.name}' is disabled (quarantined)` };
  if (ctx.operator) return { ok: true }; // operator (tab Test Connection) — grant check N/A
  let allowed: string[] = [];
  try { allowed = JSON.parse(machine.allowed_agents || '[]'); } catch { allowed = []; }
  if (!ctx.agentId || !allowed.includes(ctx.agentId)) {
    return { ok: false, outcome: 'denied-no-grant', reason: `agent is not on the allow-list for machine '${machine.name}'` };
  }
  return { ok: true };
}

function writeAudit(machine: SshMachineRow | null, ctx: SshCallerCtx, fields: {
  fingerprint_result?: string | null;
  command_scrubbed?: string | null;
  exit_code?: number | null;
  stdout_bytes?: number | null;
  stderr_bytes?: number | null;
  duration_ms?: number | null;
  outcome: string;
  exec_id?: string | null;
}): void {
  try {
    insertSshAudit({
      agent_id:  ctx.agentId ?? null,
      session_id: ctx.sessionId ?? null,
      task_id:   ctx.taskId ?? null,
      delegation_chain: ctx.delegationChain ?? null,
      machine_id: machine?.id ?? null,
      host:      machine?.host ?? null,
      port:      machine?.port ?? null,
      auth_method: machine?.auth_method ?? null,
      ...fields,
    });
    logHive('ssh_invocation', `ssh ${fields.outcome} — ${machine?.name ?? 'unknown'}`, ctx.agentId ?? undefined, {
      machineId: machine?.id ?? null, outcome: fields.outcome, execId: fields.exec_id ?? null,
    });
  } catch (err) {
    logger.warn('ssh: audit write failed', { err: String(err) });
  }
}

/**
 * Resolve creds (key/password + optional passphrase) through the broker and
 * hand them ONLY to the callback. Exceptions are scrubbed at this boundary
 * (§9.2) so an ssh2 auth error can't leak the passphrase up the stack.
 */
async function withMachineSecrets<T>(
  machine: SshMachineRow, ctx: SshCallerCtx,
  fn: (secret: string, passphrase?: string) => Promise<T>,
): Promise<T> {
  const names = [machine.secret_name];
  if (machine.passphrase_secret_name) names.push(machine.passphrase_secret_name);
  return agentStore.run({ agentName: ctx.agentName, sessionId: ctx.sessionId }, async () =>
    broker.withSecrets(names, async (env) => {
      const secret = env[machine.secret_name];
      if (!secret) throw new SshConnectError('internal', 'internal', `broker secret ${machine.secret_name} is empty`);
      const passphrase = machine.passphrase_secret_name ? env[machine.passphrase_secret_name] : undefined;
      try {
        return await fn(secret, passphrase);
      } catch (err) {
        // Never let a raw ssh2 auth exception (which can embed config) escape.
        if (err instanceof SshConnectError) throw err;
        throw classifyErr(err);
      }
    }, RESTRICTED_SECRET_CAPABILITY),
  );
}

/** Open one authenticated connection with the TOFU host-key state machine. */
function connect(machine: SshMachineRow, secret: string, passphrase?: string): Promise<{ conn: Client; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    let verifier: 'ok' | 'first-seen' | 'unverified' | 'mismatch' = 'ok';
    let capturedFp = '';
    let timer: NodeJS.Timeout;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };

    timer = setTimeout(() => finish(() => {
      try { conn.end(); } catch { /* noop */ }
      reject(new SshConnectError('connection', 'timeout', `connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
    }), CONNECT_TIMEOUT_MS);

    const cfg: ConnectConfig = {
      host: machine.host, port: machine.port, username: machine.username,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_MS, keepaliveCountMax: KEEPALIVE_MAX,
      tryKeyboard: true,               // §6.1 hardened boxes advertise kbd-interactive
      hostHash: 'sha256',
      hostVerifier: (hashedKey: string): boolean => {
        const fp = hashedKey.toLowerCase();
        capturedFp = fp;
        if (!machine.host_fingerprint) { verifier = 'first-seen'; return false; }
        if (machine.host_fingerprint.toLowerCase() !== fp) { verifier = 'mismatch'; return false; }
        if (machine.fingerprint_status !== 'verified') { verifier = 'unverified'; return false; }
        return true;
      },
    };
    if (machine.auth_method === 'password') cfg.password = secret;
    else { cfg.privateKey = secret; if (passphrase) cfg.passphrase = passphrase; }
    if (!machine.legacy_algos) cfg.algorithms = { serverHostKey: [...STRONG_HOST_KEYS] };

    // §6.1 answer keyboard-interactive prompts with the stored password/passphrase.
    conn.on('keyboard-interactive', (_n, _i, _l, prompts, cb) => {
      const answer = machine.auth_method === 'password' ? secret : (passphrase ?? '');
      cb(prompts.map(() => answer));
    });
    conn.on('ready', () => finish(() => resolve({ conn, fingerprint: capturedFp })));
    conn.on('error', (err) => finish(() => {
      if (verifier === 'first-seen')  return reject(new SshConnectError('connection', 'tofu_first_seen', 'host key not yet verified', capturedFp));
      if (verifier === 'unverified')  return reject(new SshConnectError('connection', 'tofu_unverified', 'host key pending verification', capturedFp));
      if (verifier === 'mismatch')    return reject(new SshConnectError('connection', 'fingerprint_mismatch', 'host key mismatch', capturedFp));
      reject(classifyErr(err));
    }));
    try { conn.connect(cfg); } catch (err) { finish(() => reject(classifyErr(err))); }
  });
}

/** Connect with transport-only retry (§7.3) — never retries a command. */
async function connectWithRetry(machine: SshMachineRow, secret: string, passphrase?: string): Promise<{ conn: Client; fingerprint: string }> {
  let last: SshConnectError | undefined;
  for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
    try {
      return await connect(machine, secret, passphrase);
    } catch (err) {
      const e = err instanceof SshConnectError ? err : classifyErr(err);
      last = e;
      // Only retry pure transport failures; auth/tofu/mismatch fail immediately.
      if (e.code !== 'transport' && e.code !== 'timeout') throw e;
      if (attempt < CONNECT_RETRIES) {
        const backoff = Math.min(5_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 300);
        await sleep(backoff);
      }
    }
  }
  throw last ?? new SshConnectError('connection', 'transport', 'connect failed');
}

/**
 * Handle a TOFU refusal by blocking on human confirmation to pin the key
 * (§10, §4.3). On approve → persist fingerprint 'verified' and reconnect once.
 */
async function confirmAndPin(machine: SshMachineRow, ctx: SshCallerCtx, fp: string, firstSeen: boolean): Promise<boolean> {
  // Persist the captured fingerprint as pending so the Machines tab shows it.
  if (firstSeen) {
    updateSshMachine(machine.id, { host_fingerprint: fp, fingerprint_status: 'pending_verification' });
    machine.host_fingerprint = fp;
    machine.fingerprint_status = 'pending_verification';
  }
  // Operator "Test Connection" captures the fingerprint but does NOT block —
  // the operator eyeballs it in the tab and clicks Verify (§10 out-of-band check).
  if (ctx.operator) return false;
  const outcome = await requestConfirmation({
    kind: 'ssh_tofu_pin',
    title: `Approve SSH host key for ${machine.name} (${machine.host})?`,
    detail: `Fingerprint (SHA-256): ${fp}\nVerify this out-of-band (cloud console / ssh-keyscan) before approving. Approving pins it as trusted.`,
    subjectRef: machine.id,
    agentId: ctx.agentId ?? null, agentName: ctx.agentName, sessionId: ctx.sessionId,
    runId: ctx.runId ?? null, turnNumber: ctx.turnNumber,
    payload: { host: machine.host, fingerprint: fp },
  });
  if (outcome.approved) {
    updateSshMachine(machine.id, { host_fingerprint: fp, fingerprint_status: 'verified' });
    machine.host_fingerprint = fp;
    machine.fingerprint_status = 'verified';
    logHive('ssh_alert', `host key pinned+verified for ${machine.name}`, ctx.agentId ?? undefined, { machineId: machine.id });
    return true;
  }
  return false;
}

/** Run a single command over an open connection, SIGTERM→SIGKILL on timeout. */
function execOnConn(conn: Client, command: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(new SshConnectError('command', 'internal', String(err.message ?? err)));
      let stdout = ''; let stderr = ''; let truncated = false;
      let killed = false;
      const softKill = setTimeout(() => {
        killed = true;
        try { stream.signal('TERM'); } catch { /* noop */ }
        setTimeout(() => { try { stream.signal('KILL'); } catch { /* noop */ } try { stream.close(); } catch { /* noop */ } }, 3_000);
      }, timeoutMs);
      stream.on('close', (code: number | null) => {
        clearTimeout(softKill);
        if (killed && code == null) return reject(new SshConnectError('command', 'timeout', `command timed out after ${timeoutMs}ms`));
        resolve({ exitCode: code ?? null, stdout, stderr, truncated });
      });
      stream.on('data', (d: Buffer) => {
        if (stdout.length < MAX_STREAM_BYTES) stdout += d.toString('utf8'); else truncated = true;
      });
      stream.stderr.on('data', (d: Buffer) => {
        if (stderr.length < MAX_STREAM_BYTES) stderr += d.toString('utf8'); else truncated = true;
      });
    });
  });
}

/** Shared sensitivity/critical-run gate (§4.2) — blocks on human confirm for critical hosts. */
async function passSensitivityGate(machine: SshMachineRow, ctx: SshCallerCtx, action: string): Promise<boolean> {
  if (machine.sensitivity === 'critical' && !ctx.operator) {
    const outcome = await requestConfirmation({
      kind: 'ssh_critical_run',
      title: `Approve ${action} on CRITICAL machine ${machine.name} (${machine.host})?`,
      detail: `Agent ${ctx.agentName} is requesting ${action} on a machine marked critical.`,
      subjectRef: machine.id,
      agentId: ctx.agentId ?? null, agentName: ctx.agentName, sessionId: ctx.sessionId,
      runId: ctx.runId ?? null, turnNumber: ctx.turnNumber,
    });
    return outcome.approved;
  }
  return true;
}

/** Execute a command on a registered machine. */
export async function sshRunCommand(opts: SshCallerCtx & {
  machineRef: string;
  command: string;
  timeoutMs?: number;
}): Promise<SshRunResult> {
  const execId = randomUUID();
  const machine = resolveMachine(opts.machineRef);
  if (!machine) {
    writeAudit(null, opts, { outcome: 'error', exec_id: execId, command_scrubbed: null });
    return { ok: false, machine: opts.machineRef, exitCode: null, stdout: '', stderr: '', errorType: 'internal', execId, error: 'machine not found' };
  }
  const connInfo = { host: machine.host, port: machine.port, user: machine.username };

  // §4.0 conditions 3+4 — fail-closed authorization.
  const authz = authorizeMachine(machine, opts);
  if (!authz.ok) {
    writeAudit(machine, opts, { outcome: authz.outcome, exec_id: execId });
    return { ok: false, machine: machine.name, exitCode: null, stdout: '', stderr: '', errorType: 'connection', execId, connection: connInfo, error: authz.reason };
  }
  if (machine.fingerprint_status === 'mismatch') {
    writeAudit(machine, opts, { outcome: 'fingerprint-mismatch', fingerprint_result: 'mismatch-blocked', exec_id: execId });
    return { ok: false, machine: machine.name, exitCode: null, stdout: '', stderr: '', errorType: 'connection', execId, connection: connInfo, error: 'host key previously mismatched — machine quarantined; remove and re-add if re-imaged' };
  }

  // §4.2 sensitivity — critical hosts block on human confirmation.
  if (!await passSensitivityGate(machine, opts, 'a command')) {
    writeAudit(machine, opts, { outcome: 'denied-gate', exec_id: execId });
    return { ok: false, machine: machine.name, exitCode: null, stdout: '', stderr: '', errorType: 'connection', execId, connection: connInfo, error: 'denied — human confirmation not granted for critical machine' };
  }

  // §5.3 passive tripwire — log + alert, never block.
  for (const re of TRIPWIRES) {
    if (re.test(opts.command)) {
      alertUser(machine, `⚠ Catastrophic-pattern SSH command on ${machine.name}`, `Agent: ${opts.agentName}\nCommand: ${scrubShapes(opts.command).slice(0, 300)}`, opts.sessionId);
      break;
    }
  }

  const timeoutMs = Math.max(1_000, Math.min(opts.timeoutMs ?? DEFAULT_EXEC_MS, 600_000));
  const started = Date.now();
  try {
    return await withMachineSecrets(machine, opts, async (secret, passphrase) => {
      let handshake: { conn: Client; fingerprint: string };
      try {
        handshake = await connectWithRetry(machine, secret, passphrase);
      } catch (err) {
        const e = err instanceof SshConnectError ? err : classifyErr(err);
        // TOFU: first-seen / unverified → block on human pin, then reconnect once.
        if (e.code === 'tofu_first_seen' || e.code === 'tofu_unverified') {
          const pinned = await confirmAndPin(machine, opts, e.fingerprint ?? machine.host_fingerprint ?? '', e.code === 'tofu_first_seen');
          if (!pinned) {
            writeAudit(machine, opts, { outcome: 'fingerprint-mismatch', fingerprint_result: 'first-seen-pending', exec_id: execId });
            return { ok: false, machine: machine.name, exitCode: null, stdout: '', stderr: '', errorType: 'connection', execId, connection: connInfo, error: 'host key not verified — approve it in Connect → Machines' };
          }
          handshake = await connectWithRetry(machine, secret, passphrase);
        } else if (e.code === 'fingerprint_mismatch') {
          updateSshMachine(machine.id, { fingerprint_status: 'mismatch', disabled: true });
          alertUser(machine, `🚨 SSH host-key MISMATCH on ${machine.name} — machine auto-disabled`, `Expected ${machine.host_fingerprint}\nGot ${e.fingerprint}\nIf you re-imaged/replaced this box, remove and re-add it.`, opts.sessionId);
          writeAudit(machine, opts, { outcome: 'fingerprint-mismatch', fingerprint_result: 'mismatch-blocked', exec_id: execId });
          return { ok: false, machine: machine.name, exitCode: null, stdout: '', stderr: '', errorType: 'connection', execId, connection: connInfo, error: 'host key changed since last connection — connection refused, machine quarantined' };
        } else {
          writeAudit(machine, opts, { outcome: e.code === 'auth' ? 'auth-fail' : 'error', exec_id: execId });
          return { ok: false, machine: machine.name, exitCode: null, stdout: '', stderr: '', errorType: e.errorType, execId, connection: connInfo, error: e.message };
        }
      }

      const { conn } = handshake;
      try {
        const res = await execOnConn(conn, opts.command, timeoutMs);
        const stdoutRaw = res.stdout; const stderrRaw = res.stderr;
        const binary = looksBinary(stdoutRaw);
        const stdout = binary ? `[binary output ${stdoutRaw.length} bytes — preview]\n${Buffer.from(stdoutRaw).toString('base64').slice(0, 512)}` : scrubShapes(stdoutRaw);
        const stderr = scrubShapes(stderrRaw);
        updateSshMachine(machine.id, { last_connected_at: new Date().toISOString() });
        writeAudit(machine, opts, {
          outcome: res.exitCode === 0 ? 'success' : 'error',
          fingerprint_result: 'match',
          command_scrubbed: scrubShapes(opts.command).slice(0, 500),
          exit_code: res.exitCode, stdout_bytes: stdoutRaw.length, stderr_bytes: stderrRaw.length,
          duration_ms: Date.now() - started, exec_id: execId,
        });
        return { ok: res.exitCode === 0, machine: machine.name, exitCode: res.exitCode, stdout, stderr, truncated: res.truncated, binary, errorType: res.exitCode === 0 ? null : 'command', execId, connection: connInfo };
      } finally {
        try { conn.end(); } catch { /* already ended */ }
      }
    });
  } catch (err) {
    const e = err instanceof SshConnectError ? err : classifyErr(err);
    writeAudit(machine, opts, { outcome: 'error', exec_id: execId, duration_ms: Date.now() - started });
    return { ok: false, machine: machine.name, exitCode: null, stdout: '', stderr: '', errorType: e.errorType, execId, connection: connInfo, error: e.message };
  }
}

/** Shared SFTP transfer (upload/download) with authz + caps + audit. */
async function sftpTransfer(
  kind: 'upload' | 'download',
  opts: SshCallerCtx & { machineRef: string; localPath: string; remotePath: string },
): Promise<SshTransferResult> {
  const execId = randomUUID();
  const machine = resolveMachine(opts.machineRef);
  if (!machine) {
    writeAudit(null, opts, { outcome: 'error', exec_id: execId });
    return { ok: false, machine: opts.machineRef, errorType: 'internal', error: 'machine not found' };
  }
  const authz = authorizeMachine(machine, opts);
  if (!authz.ok) {
    writeAudit(machine, opts, { outcome: authz.outcome, exec_id: execId });
    return { ok: false, machine: machine.name, errorType: 'connection', error: authz.reason };
  }
  if (machine.fingerprint_status !== 'verified') {
    return { ok: false, machine: machine.name, errorType: 'connection', error: 'host key not verified — approve it in Connect → Machines before transferring files' };
  }
  if (!await passSensitivityGate(machine, opts, `a file ${kind}`)) {
    writeAudit(machine, opts, { outcome: 'denied-gate', exec_id: execId });
    return { ok: false, machine: machine.name, errorType: 'connection', error: 'denied — human confirmation not granted for critical machine' };
  }
  // §8.3 upload size cap (local file is statable pre-transfer; remote-size cap is v2).
  if (kind === 'upload') {
    try {
      const sz = fs.statSync(opts.localPath).size;
      if (sz > MAX_XFER_BYTES) {
        return { ok: false, machine: machine.name, errorType: 'internal', error: `file ${sz} bytes exceeds ${MAX_XFER_BYTES}-byte transfer cap` };
      }
    } catch {
      return { ok: false, machine: machine.name, errorType: 'internal', error: `local file not found: ${opts.localPath}` };
    }
  }
  const started = Date.now();
  try {
    return await withMachineSecrets(machine, opts, async (secret, passphrase) => {
      const { conn } = await connectWithRetry(machine, secret, passphrase);
      try {
        await new Promise<void>((resolve, reject) => {
          conn.sftp((err, sftp) => {
            if (err) return reject(new SshConnectError('command', 'internal', String(err.message ?? err)));
            const step: { concurrency: number; chunkSize: number } = { concurrency: 64, chunkSize: 32768 };
            if (kind === 'upload') {
              sftp.fastPut(opts.localPath, opts.remotePath, step, (e) => (e ? reject(new SshConnectError('command', 'internal', String(e.message ?? e))) : resolve()));
            } else {
              sftp.fastGet(opts.remotePath, opts.localPath, step, (e) => (e ? reject(new SshConnectError('command', 'internal', String(e.message ?? e))) : resolve()));
            }
          });
        });
        updateSshMachine(machine.id, { last_connected_at: new Date().toISOString() });
        writeAudit(machine, opts, { outcome: 'success', fingerprint_result: 'match', command_scrubbed: `sftp ${kind} ${opts.remotePath}`.slice(0, 300), duration_ms: Date.now() - started, exec_id: execId });
        return { ok: true, machine: machine.name };
      } finally {
        try { conn.end(); } catch { /* already ended */ }
      }
    });
  } catch (err) {
    const e = err instanceof SshConnectError ? err : classifyErr(err);
    writeAudit(machine, opts, { outcome: 'error', exec_id: execId, duration_ms: Date.now() - started });
    return { ok: false, machine: machine.name, errorType: e.errorType, error: e.message };
  }
}

export async function sshUpload(opts: SshCallerCtx & { machineRef: string; localPath: string; remotePath: string }): Promise<SshTransferResult> {
  return sftpTransfer('upload', opts);
}

export async function sshDownload(opts: SshCallerCtx & { machineRef: string; localPath: string; remotePath: string }): Promise<SshTransferResult> {
  return sftpTransfer('download', opts);
}

/**
 * Connectivity smoke test for the "Test Connection" button (operator action).
 * Runs a trivial command; on a first-seen host key it triggers the TOFU
 * pin-confirm flow. operator:true bypasses the per-agent grant check.
 */
export async function sshTestConnection(opts: { machineRef: string; agentName?: string; sessionId?: string }): Promise<SshRunResult> {
  return sshRunCommand({
    machineRef: opts.machineRef,
    command: 'echo neuroclaw-ssh-ok',
    agentName: opts.agentName ?? 'operator',
    sessionId: opts.sessionId ?? 'operator',
    operator: true,
    timeoutMs: 20_000,
  });
}
