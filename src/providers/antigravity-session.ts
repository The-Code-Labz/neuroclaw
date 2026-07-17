// Persistent tmux session manager for the agy (Antigravity CLI) provider.
// One tmux session per sessionId::agentId pair. Sessions are reused across
// turns so agy maintains native conversation context without history re-injection.
//
// agy has NO `--append-system-prompt` and NO hooks (unlike claude). So:
//   • Persona is injected by folding it into the FIRST interactive prompt,
//     launched with `agy -i "<persona + respond-protocol + first message>"`.
//     `-i` ("--prompt-interactive") runs that initial prompt and keeps the
//     session alive as a REPL — verified against agy 1.0.5.
//   • Follow-up turns are pasted into the live REPL (bracketed paste handles the
//     multi-line [run_id]/[context] envelope without premature submission).
//   • Completion is signalled by agy calling the neuroclaw `respond` MCP tool,
//     which resolves waitForRespond(runId) on the respond bus. No hooks needed.

import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash, randomUUID } from 'crypto';
import { buildAgentScopedEnv } from '../broker/subprocessSecrets';
import { ensureAntigravityMcpRegistered } from '../system/antigravity-config-writer';
import { resolveCliBinary, MODEL_DISPLAY_NAMES } from './antigravity';
import { respondBus, type RespondPayload } from '../system/agy-respond-bus';
import { logger } from '../utils/logger';
import { config } from '../config';

const execFileAsync = promisify(execFile);

// Completion poller tuning. agy has no process-exit (long-lived REPL) and no
// hooks, so a turn ends one of three ways: (1) agy calls the respond MCP tool
// (clean push — preferred), (2) the REPL goes back to idle without calling it
// (we nudge, then scrape the pane), (3) the hard timeout (a genuine runaway).
const POLL_INTERVAL_MS         = 800;
const IDLE_TICKS_AFTER_THINKING = 3;       // ~2.4s of stable idle once we've seen it generate
const IDLE_TICKS_COLD           = 10;      // ~8s of solid idle if we never caught a generating frame
const COLD_SETTLE_MIN_MS        = 12_000;  // ...and only after this long, to avoid the pre-generation idle
const NUDGE_WAIT_MS             = 60_000;  // give the nudge a minute to yield a clean respond before scraping

// Folded into the FIRST interactive prompt (and thus the persona). Instructs agy
// to call respond as its final action every turn, carrying run_id from the
// [run_id: ...] line so the respond bus can route the reply to the right caller.
export const RESPOND_INSTRUCTION = `

## Response Protocol
At the end of EVERY response — no exceptions — call the \`respond\` MCP tool
(neuroclaw/respond) with:
  - content: your complete response text
  - run_id: the value from the [run_id: ...] line in the user's message
Do not rely on a plain-text reply reaching the user. The respond tool is your
only delivery channel back to NeuroClaw.
`;

function tmuxName(key: string): string {
  return 'nclaw-agy-' + createHash('sha1').update(key).digest('hex').slice(0, 12);
}

// Single-quote a string for safe embedding in a `sh -c` command line.
function sh(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }

// agy's --model flag takes the human display name ("Gemini 3.5 Flash (Medium)").
// Map the internal model id; if it is unknown, omit --model so agy falls back to
// its configured default rather than exiting on an unrecognised value (mirrors
// the defensive omit in claude-interactive).
function modelArgs(modelId: string | undefined): string[] {
  const display = modelId ? MODEL_DISPLAY_NAMES[modelId] : undefined;
  if (!display) {
    if (modelId) logger.warn('agy: unknown model id — launching with agy default', { modelId });
    return [];
  }
  return ['--model', sh(display)];
}

// Build the [run_id]/[context]/body envelope agy parses each turn.
function buildEnvelope(runId: string, memoryBlock: string | undefined, userMessage: string): string {
  const parts: string[] = [`[run_id: ${runId}]`];
  if (memoryBlock) parts.push(`[context]\n${memoryBlock}\n[/context]`);
  parts.push('', userMessage);
  return parts.join('\n');
}

interface AgySession {
  name:       string;
  agentId:    string;
  sessionId:  string;
  lastUsedAt: number;
}

export interface SendOpts {
  key:          string;
  agentId:      string;
  sessionId:    string;
  userMessage:  string;
  systemPrompt: string;
  runId:        string;
  model?:       string;
  memoryBlock?: string;
}

class AgySessionManager {
  private sessions  = new Map<string, AgySession>();
  private ttlTimer: ReturnType<typeof setInterval> | null = null;

  async send(opts: SendOpts): Promise<void> {
    await ensureAntigravityMcpRegistered();

    const existing = this.sessions.get(opts.key);
    const alive = existing ? await this.isAlive(existing.name) : false;
    if (!existing || !alive) {
      // Fresh session: the first turn's message is delivered via `agy -i`, so we
      // do NOT also paste it — that would double-send the turn.
      const session = await this.spawn(opts);
      session.lastUsedAt = Date.now();
      return;
    }
    // Reused session: REPL is already alive; paste the next turn into it.
    await this.sendMessage(existing.name, opts.runId, opts.memoryBlock, opts.userMessage);
    existing.lastUsedAt = Date.now();
  }

  async kill(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    try { execFileSync('tmux', ['kill-session', '-t', session.name]); } catch { /* already dead */ }
  }

  async killAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(k => this.kill(k)));
  }

  private async spawn(opts: SendOpts): Promise<AgySession> {
    const name = tmuxName(opts.key);
    try { execFileSync('tmux', ['kill-session', '-t', name]); } catch { /* ok if not found */ }

    // The first interactive prompt = persona + respond protocol + first turn.
    const initialPrompt =
      opts.systemPrompt + RESPOND_INSTRUCTION + '\n\n' +
      buildEnvelope(opts.runId, opts.memoryBlock, opts.userMessage);
    const sysFile = join(tmpdir(), `nclaw-agy-sys-${name}.txt`);
    await writeFile(sysFile, initialPrompt, 'utf-8');

    // Broker-scoped secrets are injected as tmux session env (-e KEY=VALUE), so
    // they reach the agy process via the pane's shell without appearing in logs.
    const { resolved } = await buildAgentScopedEnv(opts.agentId, 'antigravity', process.env as Record<string, string>);
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(resolved)) {
      if (v) envArgs.push('-e', `${k}=${v}`);
    }

    const agyCli = resolveCliBinary() ?? 'agy';
    // The prompt is large; pass it via shell `"$(cat file)"` expansion so the
    // send-keys argument stays tiny (avoids the tmux per-arg "command too long"
    // limit — the same fix proven in claude-interactive). Command substitution
    // inside double quotes is not re-parsed, so any prompt content is verbatim.
    const launchCmd = [
      agyCli,
      '--dangerously-skip-permissions',
      ...modelArgs(opts.model),
      '-i', `"$(cat ${sh(sysFile)})"`,
    ].join(' ');

    // Bare detached session (with secret env), then run the launch line through
    // the pane's shell — this is the proven claude-tmux pattern for $(cat …).
    await execFileAsync('tmux', [
      'new-session', '-d', '-s', name, '-x', '220', '-y', '50', '-c', process.cwd(),
      ...envArgs,
    ]);
    await execFileAsync('tmux', ['set-option', '-t', name, 'history-limit', '4000']).catch(() => {});
    await execFileAsync('tmux', ['send-keys', '-t', name, '-l', '--', launchCmd]);
    await execFileAsync('tmux', ['send-keys', '-t', name, 'Enter']);

    // Remove the prompt file once the shell has had time to read it via $(cat).
    setTimeout(() => unlink(sysFile).catch(() => {}), 15_000);

    await this.waitForReady(name);

    const session: AgySession = { name, agentId: opts.agentId, sessionId: opts.sessionId, lastUsedAt: Date.now() };
    this.sessions.set(opts.key, session);
    this.startTtlCleanup();
    logger.info('agy: tmux session spawned', { name, key: opts.key });
    return session;
  }

  private async sendMessage(
    sessionName: string,
    runId:       string,
    memoryBlock: string | undefined,
    userMessage: string,
  ): Promise<void> {
    // Wait until the REPL is idle so the paste lands on an empty prompt rather
    // than mid-generation of the previous turn.
    await this.waitForIdle(sessionName);
    await this.pasteIntoRepl(sessionName, buildEnvelope(runId, memoryBlock, userMessage));
  }

  // Submit one (possibly multi-line) message into a live REPL via bracketed
  // paste: load-buffer + paste-buffer -p delivers the whole text as ONE message
  // (no premature submit), then an explicit Enter sends it. A per-session named
  // buffer (-b) avoids cross-session races; -d frees it after pasting.
  private async pasteIntoRepl(sessionName: string, text: string): Promise<void> {
    const msgFile = join(tmpdir(), `nclaw-agy-msg-${sessionName}-${randomUUID().slice(0, 8)}.txt`);
    const buf     = `nclawagy-${createHash('sha1').update(sessionName).digest('hex').slice(0, 8)}`;
    await writeFile(msgFile, text, 'utf-8');
    try {
      await execFileAsync('tmux', ['load-buffer', '-b', buf, msgFile]);
      await execFileAsync('tmux', ['paste-buffer', '-b', buf, '-t', sessionName, '-p', '-d']);
      await execFileAsync('tmux', ['send-keys', '-t', sessionName, 'Enter']);
    } finally {
      unlink(msgFile).catch(() => {});
    }
  }

  // ── Completion state machine ───────────────────────────────────────────────
  // Trigger agy, then resolve the turn by whichever signal arrives first:
  //   • agy calls the respond MCP tool        → clean push text (preferred)
  //   • the REPL goes idle without responding  → nudge once, then scrape the pane
  //   • the hard timeout elapses               → scrape, else throw
  // Listens on the respond bus BEFORE triggering agy (agy can call respond
  // mid-turn and the bus only delivers future emits).
  async sendAndAwait(opts: SendOpts & { timeoutMs: number; signal?: AbortSignal }): Promise<string> {
    // Item I4b: external abort (runaway/stop) — bail before spawning a session we
    // would immediately have to kill.
    if (opts.signal?.aborted) throw new Error('agy: aborted before turn start');
    let respondText: string | null = null;
    const onRespond = (p: RespondPayload) => { if (respondText === null) respondText = p.content; };
    respondBus.once(opts.runId, onRespond);

    try {
      await this.send(opts);
    } catch (err) {
      respondBus.removeListener(opts.runId, onRespond);
      throw err;
    }

    const name = this.sessions.get(opts.key)?.name;
    if (!name) {
      respondBus.removeListener(opts.runId, onRespond);
      throw new Error('agy: no live session after send');
    }

    try {
      return await this.pollCompletion(name, opts.runId, opts.userMessage, () => respondText, opts.timeoutMs, opts.key, opts.signal);
    } finally {
      respondBus.removeListener(opts.runId, onRespond);
    }
  }

  private async pollCompletion(
    name:        string,
    runId:       string,
    userMessage: string,
    getRespond:  () => string | null,
    timeoutMs:   number,
    key:         string,
    signal?:     AbortSignal,
  ): Promise<string> {
    const startAt  = Date.now();
    const deadline = startAt + timeoutMs;
    let sawThinking = false;
    let idleTicks   = 0;
    let nudged      = false;
    let nudgeDeadline = 0;

    while (Date.now() < deadline) {
      // Item I4b: external abort (runaway/stop). Kill the wedged agy tmux session
      // and bail immediately — kill-only would make every capture() return '' so
      // the loop never settles and spins to the full timeout. Identity-guarded:
      // only kill if THIS turn still owns the session on `key` (a fast next turn
      // may have already re-spawned a fresh session under the same key).
      if (signal?.aborted) {
        if (this.sessions.get(key)?.name === name) {
          logger.warn('agy: aborted by external signal — killing tmux session', { name, runId, key });
          await this.kill(key);
        }
        throw new Error('agy: turn aborted by external signal');
      }
      // 1. Clean push path always wins, no matter the pane state.
      const pushed = getRespond();
      if (pushed !== null) return pushed;

      // 2. Read agy's own status line to classify the turn.
      const pane       = await this.capture(name);
      const generating = /esc to cancel|Generating/i.test(pane);
      const idle       = /\? for shortcuts/i.test(pane);
      if (generating)      { sawThinking = true; idleTicks = 0; }
      else if (idle)       { idleTicks++; }
      else                 { idleTicks = 0; }

      // Settled = agy is done but hasn't called respond. Require either a
      // post-generation idle streak, or (if we never caught the generating
      // frame) a long cold-idle streak after a minimum elapsed window — the
      // latter guards against mistaking the brief pre-generation idle for "done".
      const settled = idle && (
        (sawThinking && idleTicks >= IDLE_TICKS_AFTER_THINKING) ||
        (idleTicks   >= IDLE_TICKS_COLD && Date.now() - startAt > COLD_SETTLE_MIN_MS)
      );

      if (settled) {
        if (!nudged) {
          // First recover via the CLEAN channel: tell agy it skipped respond.
          // A false settle here costs only a harmless extra nudge.
          nudged = true;
          nudgeDeadline = Date.now() + NUDGE_WAIT_MS;
          logger.warn('agy: turn idle without respond — nudging for a clean reply', { name, runId });
          await this.nudgeRespond(name, runId).catch(() => {});
          sawThinking = false; idleTicks = 0;   // expect a fresh generate→idle from the nudge
        } else if (Date.now() >= nudgeDeadline) {
          // Nudge didn't produce a respond either — last resort: scrape the pane.
          const scraped = this.scrapeLastReply(await this.capture(name, 400), userMessage);
          logger.warn('agy: nudge yielded no respond — recovered from pane', { name, runId, chars: scraped.length });
          if (scraped) return scraped;
          throw new Error('agy: turn completed without respond and no recoverable pane output');
        }
      }
      await this.sleep(POLL_INTERVAL_MS);
    }

    // Hard deadline — a genuine runaway (or a thinking model that used its whole
    // budget). Prefer a late respond, then a scrape, before failing.
    const late = getRespond();
    if (late !== null) return late;
    const scraped = this.scrapeLastReply(await this.capture(name, 400), userMessage);
    if (scraped) return scraped;
    throw new Error(`agy: turn did not complete within ${timeoutMs}ms`);
  }

  // Paste a one-line reminder asking agy to call respond. Used when a turn went
  // idle without the MCP call — recovers via the clean channel before scraping.
  private async nudgeRespond(name: string, runId: string): Promise<void> {
    const msg = `[run_id: ${runId}] (system reminder) You finished but did not call the respond tool. ` +
      `Call neuroclaw/respond now with run_id "${runId}" and content set to your complete previous answer.`;
    await this.pasteIntoRepl(name, msg);
  }

  // Best-effort extraction of agy's latest assistant reply from the pane. Anchors
  // on the last echo of our prompt's final line, then collects the indented
  // response block, dropping borders, tool-call (●) and thought (▸) markers, and
  // the trailing prompt/status rows. Only used as a fallback when respond is
  // skipped, so "best effort" is acceptable.
  private scrapeLastReply(pane: string, userMessage: string): string {
    const lines = pane.split('\n');
    const tail  = userMessage.split('\n').map(s => s.trim()).filter(Boolean).pop() ?? '';
    let start = -1;
    if (tail) {
      for (let i = 0; i < lines.length; i++) if (lines[i].includes(tail)) start = i;
    }
    if (start < 0) {
      for (let i = 0; i < lines.length; i++) if (/^\s*>\s+\S/.test(lines[i])) start = i;
    }
    if (start < 0) return '';

    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line    = lines[i].replace(/\s+$/, '');
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^[─—_-]{4,}$/.test(trimmed)) continue;        // box border
      if (/^\?\s*for shortcuts/i.test(trimmed)) break;   // status bar → end of turn
      if (/^esc to cancel/i.test(trimmed)) break;
      if (/^>\s*$/.test(trimmed)) continue;              // empty prompt row
      if (/^>\s+/.test(line)) continue;                  // a later input echo
      if (/^[●▸•]/.test(trimmed)) continue;              // tool-call / thought markers
      out.push(line.replace(/^\s{1,2}/, ''));            // strip the block indent
    }
    return out.join('\n').trim().slice(0, 12_000);
  }

  private sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

  private async isAlive(sessionName: string): Promise<boolean> {
    try {
      await execFileAsync('tmux', ['has-session', '-t', sessionName]);
      return true;
    } catch { return false; }
  }

  // Capture the visible pane (status detection) or, with scrollbackLines, a slice
  // of history (so a long reply that scrolled off-screen is still scrapable).
  private async capture(sessionName: string, scrollbackLines = 0): Promise<string> {
    const args = scrollbackLines > 0
      ? ['capture-pane', '-t', sessionName, '-p', '-S', `-${scrollbackLines}`]
      : ['capture-pane', '-t', sessionName, '-p'];
    const r = await execFileAsync('tmux', args).catch(() => ({ stdout: '' }));
    return (r.stdout as string) ?? '';
  }

  // Wait until agy's TUI has come up (banner / prompt box / generating spinner).
  // Best-effort: proceeds on timeout so a slow boot never hard-fails the turn.
  private async waitForReady(sessionName: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pane = await this.capture(sessionName);
      if (/Antigravity CLI|\? for shortcuts|esc to cancel|Generating/i.test(pane)) return;
      await new Promise<void>(r => setTimeout(r, 500));
    }
    logger.warn('agy: session did not show a ready TUI in time — proceeding', { name: sessionName });
  }

  // Wait until the REPL is idle (status line shows "? for shortcuts" and is not
  // mid-generation "esc to cancel"). Best-effort: proceeds on timeout.
  private async waitForIdle(sessionName: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pane = await this.capture(sessionName);
      const generating = /esc to cancel|Generating/i.test(pane);
      const idle       = /\? for shortcuts/i.test(pane);
      if (idle && !generating) return;
      await new Promise<void>(r => setTimeout(r, 500));
    }
    logger.warn('agy: REPL did not return to idle before paste — pasting anyway', { name: sessionName });
  }

  private startTtlCleanup(): void {
    if (this.ttlTimer) return;
    const ttlMs = config.antigravity.sessionTtlMinutes * 60_000;
    this.ttlTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, session] of this.sessions) {
        if (now - session.lastUsedAt > ttlMs) {
          logger.info('agy: killing idle session', { name: session.name, key });
          void this.kill(key);
        }
      }
    }, 60_000);
    this.ttlTimer.unref();
  }
}

export const AgySessions = new AgySessionManager();
