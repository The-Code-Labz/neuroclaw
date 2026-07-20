import { randomUUID } from 'crypto';
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { buildAgentScopedEnv } from '../broker/subprocessSecrets';
import { ensureSession, sendLine, isAlive, killSession } from '../system/claude-tmux';
import { prepareProviderGitEnv, NC_GIT_SHIM_DIR } from '../system/nc-git-env';

export interface ClaudeInteractiveOptions {
  prompt:       string;
  systemPrompt: string;          // the agent's persona (static identity)
  sessionId:    string;
  model:        string;
  agentId:      string;
  execEnabled?: boolean;
  onProgress?:  (label: string) => void;   // tool/notification labels
}

interface PendingTurn {
  resolve:     (text: string) => void;
  reject:      (err: Error) => void;
  onProgress?: (label: string) => void;
  timer:       NodeJS.Timeout;
}

// One in-flight turn per NeuroClaw session — sessionId is the correlation key.
const pending       = new Map<string, PendingTurn>();
const sessionSecret = new Map<string, string>();   // sessionId → per-session hook secret
const lastActivity  = new Map<string, number>();    // sessionId → Date.now() of last turn/event
const lastMsgCount  = new Map<string, number>();    // sessionId → assistant-msg count at last resolve
const STATE_DIR     = '/tmp/nc-claude';

function tmuxName(sessionId: string): string { return `nc-${sessionId}`; }

// Deterministic claude --session-id from the NeuroClaw session id (stable across restarts).
function claudeSessionId(sessionId: string): string {
  return /^[0-9a-f-]{36}$/i.test(sessionId) ? sessionId : randomUUID();
}

// claude persists each session's transcript at
// ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl. `--session-id` is strict
// CREATE — it errors "Session ID ... is already in use" if the session already
// exists (e.g. on the 2nd+ turn, or after a tmux-pane reap, or across a
// dashboard restart). So we must `--resume` an existing session and only
// `--session-id` a brand-new one. Glob across project dirs to avoid depending
// on the exact cwd-slug format.
function claudeSessionExistsOnDisk(cid: string): boolean {
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!existsSync(projectsDir)) return false;
    for (const d of readdirSync(projectsDir)) {
      if (existsSync(path.join(projectsDir, d, `${cid}.jsonl`))) return true;
    }
  } catch { /* fall through → treat as new */ }
  return false;
}

// Count assistant text blocks in the persisted transcript — MUST match the
// counting in scripts/claude-stop-hook.mjs, because this value seeds the
// stale-Stop guard (lastMsgCount) that the hook's `count` is compared against.
function countTranscriptTextBlocks(cid: string): number {
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!existsSync(projectsDir)) return 0;
    for (const d of readdirSync(projectsDir)) {
      const tp = path.join(projectsDir, d, `${cid}.jsonl`);
      if (!existsSync(tp)) continue;
      let n = 0;
      for (const line of readFileSync(tp, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let ev: any; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'assistant') {
          for (const b of (ev.message?.content ?? [])) {
            if (b && b.type === 'text') n++;
          }
        }
      }
      return n;
    }
  } catch { /* unreadable → 0, fail-open to prior behavior */ }
  return 0;
}

function buildAllowlist(execEnabled: boolean): string[] {
  return execEnabled ? ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'] : ['Read', 'Grep', 'Glob'];
}

function writeConfigFiles(sessionId: string, secret: string): { settingsPath: string; mcpPath: string } {
  const dir = path.join(STATE_DIR, sessionId);
  mkdirSync(dir, { recursive: true });
  const hook = path.resolve(process.cwd(), 'scripts/claude-stop-hook.mjs');
  const url  = `http://127.0.0.1:${config.dashboard.port}/api/claude-hook`;
  const cmd  = (event: string) => `node ${hook} --event ${event} --session ${sessionId} --secret ${secret} --url ${url}`;
  const settings = {
    hooks: {
      Stop:         [{ hooks: [{ type: 'command', command: cmd('stop') }] }],
      PostToolUse:  [{ hooks: [{ type: 'command', command: cmd('tool') }] }],
      Notification: [{ hooks: [{ type: 'command', command: cmd('notification') }] }],
    },
  };
  const settingsPath = path.join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(settings));
  // NeuroClaw HTTP MCP — agent gets memory/vault/spawn natively.
  const mcp = {
    mcpServers: {
      neuroclaw: { type: 'http', url: `http://127.0.0.1:${config.dashboard.port}/mcp`, headers: { 'x-dashboard-token': config.dashboard.token } },
    },
  };
  const mcpPath = path.join(dir, 'mcp.json');
  writeFileSync(mcpPath, JSON.stringify(mcp));
  return { settingsPath, mcpPath };
}

function sh(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }

// Base env for the claude subprocess: strip ANTHROPIC_API_KEY so the bundled CLI
// uses subscription OAuth (normal billing pool), not API-key billing — the whole
// point of the interactive path. Mirrors claude-cli.ts buildChildEnv().
function buildChildEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export async function* streamClaudeInteractiveChat(
  opts: ClaudeInteractiveOptions,
): AsyncGenerator<string, void, void> {
  const name   = tmuxName(opts.sessionId);
  const secret = sessionSecret.get(opts.sessionId) ?? randomUUID();
  sessionSecret.set(opts.sessionId, secret);

  // Seed the stale-Stop guard across process restarts. lastMsgCount is
  // in-memory only — a resumed session would otherwise start at seen=0 while
  // the on-disk transcript already holds N assistant messages, so the first
  // flush-race Stop (carrying the OLD count > 0) would resolve this turn with
  // the PREVIOUS session's text.
  if (!lastMsgCount.has(opts.sessionId)) {
    const cidSeed = claudeSessionId(opts.sessionId);
    if (claudeSessionExistsOnDisk(cidSeed)) {
      lastMsgCount.set(opts.sessionId, countTranscriptTextBlocks(cidSeed));
    }
  }

  // Mark the session active at the VERY START of the turn — before the
  // (up-to-45s) ensureSession spawn. Otherwise lastActivity stays unset (0)
  // during the spawn window and the reaper's `last === 0` orphan branch kills
  // the session mid-spawn, so ensureSession then polls a dead pane until it
  // throws "did not reach ready state". (This was the real cause of the Discord
  // session timeouts; setting it only after ensureSession was too late.)
  lastActivity.set(opts.sessionId, Date.now());

  if (!(await isAlive(name))) {
    const { settingsPath, mcpPath } = writeConfigFiles(opts.sessionId, secret);
    const sub   = await buildAgentScopedEnv(opts.agentId, 'claude-interactive', buildChildEnv());
    // Broker-scoped secrets + git coordination env must be delivered via tmux
    // `new-session -e` pairs: a persistent tmux server gives new panes the
    // SERVER's captured env, not the client's execFile env, so `env: sub.env`
    // is a silent no-op. Mirror antigravity-session.ts:146-167.
    const gitEnv = await prepareProviderGitEnv({}, opts.agentId, opts.sessionId, process.cwd());
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(sub.resolved)) {
      if (v) envArgs.push('-e', `${k}=${v}`);
    }
    for (const [k, v] of Object.entries(gitEnv)) {
      if (v !== undefined) envArgs.push('-e', `${k}=${v}`);
    }
    // Pre-approve the in-process NeuroClaw MCP tools (mounted via mcp.json) so
    // the interactive REPL doesn't block on a permission prompt the first time
    // the agent calls memory/vault/spawn/etc — mirrors claude-cli.ts. Without
    // this an MCP tool call hangs the pane and the turn times out with no Stop.
    const allow = [...buildAllowlist(!!opts.execEnabled), 'mcp__neuroclaw__*'].join(',');
    // The persona/system prompt is large (team roster + guidance + memory +
    // Discord context + recent transcript). Passing it inline as a CLI arg makes
    // the whole `claude …` line exceed tmux send-keys' per-argument limit
    // ("command too long"). Write it to a file and let the pane's shell expand
    // `"$(cat file)"` at run time, so the send-keys argument stays tiny. The
    // command-substitution output inside double quotes is not re-parsed, so any
    // prompt content (quotes, $, backticks) is passed through verbatim.
    const dir        = path.join(STATE_DIR, opts.sessionId);
    const promptPath = path.join(dir, 'system-prompt.txt');
    writeFileSync(promptPath, opts.systemPrompt);
    // `claude` is the Anthropic CLI — it can ONLY run claude-* models. If the
    // agent is configured with a non-Claude model (e.g. a gpt-* id), do NOT pass
    // --model: claude errors on an unknown model and exits immediately, the REPL
    // never starts, and the turn dies as "timed out / no Stop hook". Fall back to
    // claude's own subscription default instead.
    const modelArgs = /^claude-/i.test(opts.model) ? ['--model', sh(opts.model)] : [];
    if (modelArgs.length === 0) {
      logger.warn('claude-interactive: non-Claude model on a claude-interactive agent — using claude default', {
        agentId: opts.agentId, configuredModel: opts.model,
      });
    }
    // Resume an already-persisted session; create only if brand-new. Using
    // --session-id on an existing id errors "already in use" → claude exits →
    // "did not reach ready state". --resume reattaches and keeps native context.
    const cid = claudeSessionId(opts.sessionId);
    const sessionFlags = claudeSessionExistsOnDisk(cid)
      ? ['--resume', cid]
      : ['--session-id', cid];
    // Shell startup files (.bashrc/.profile) can prepend directories ahead of a
    // tmux -e PATH, so also export PATH in the launch command itself. This is a
    // defense-in-depth guard: the -e pair still carries the value, and the export
    // guarantees the shim resolves first after the shell has started.
    const pathExport = `export PATH=${sh(NC_GIT_SHIM_DIR)}:"$PATH"; `;
    const launch = pathExport + [
      'claude',
      ...sessionFlags,
      '--settings', sh(settingsPath),
      '--mcp-config', sh(mcpPath),
      '--append-system-prompt', `"$(cat ${sh(promptPath)})"`,
      ...modelArgs,
      '--allowedTools', sh(allow),
    ].join(' ');
    await ensureSession({ name, command: launch, cwd: process.cwd(), env: sub.env, envArgs });
  }

  const turn = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(opts.sessionId);
      reject(new Error('claude-interactive: turn timed out (no Stop hook)'));
    }, config.claudeInteractive.turnTimeoutMs);
    pending.set(opts.sessionId, { resolve, reject, onProgress: opts.onProgress, timer });
  });

  lastActivity.set(opts.sessionId, Date.now());
  await sendLine(name, opts.prompt);
  let text: string;
  try {
    text = await turn;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Give-up parity with claude-cli/codex: a turn timeout used to throw,
    // which Discord renders as "stream closed without a response". The tmux
    // session stays alive (the REPL may still be mid-generation), so report
    // back instead — the user can follow up to collect the result.
    if (msg.includes('turn timed out')) {
      const min = Math.round(config.claudeInteractive.turnTimeoutMs / 60000);
      logger.warn('claude-interactive: turn timed out — yielding report-back instead of error', {
        sessionId: opts.sessionId, agentId: opts.agentId ?? null,
      });
      yield `🛑 **No reply within ${min} min** — the Claude session is still alive and may still be working on it. ` +
            `Send a follow-up message to check on it or continue.`;
      return;
    }
    throw err;
  }
  yield text;
}

// Called by POST /api/claude-hook after secret validation.
export function resolveClaudeHook(sessionId: string, event: string, payload: { text?: string; tool?: string; count?: number }): boolean {
  lastActivity.set(sessionId, Date.now());
  const p = pending.get(sessionId);
  if (!p) return false;
  if (event === 'stop') {
    // Ignore a STALE Stop that fires before this turn's assistant message is
    // appended — it carries the previous turn's count (and its old text). Only
    // resolve once the assistant-message count has actually advanced; otherwise
    // keep waiting (the real Stop for this turn arrives with a higher count).
    const count = payload.count ?? 0;
    const seen  = lastMsgCount.get(sessionId) ?? 0;
    if (count <= seen) return true;   // acknowledged but not this turn's result
    lastMsgCount.set(sessionId, count);
    clearTimeout(p.timer);
    pending.delete(sessionId);
    p.resolve(payload.text ?? '');
    return true;
  }
  if (event === 'tool')         p.onProgress?.(`${payload.tool ?? 'tool'}…`);
  if (event === 'notification') p.onProgress?.(payload.text ?? 'waiting…');
  return true;
}

export function verifyHookSecret(sessionId: string, secret: string): boolean {
  const expected = sessionSecret.get(sessionId);
  return !!expected && expected === secret;
}

export function killInteractiveSession(sessionId: string): void {
  const p = pending.get(sessionId);
  if (p) { clearTimeout(p.timer); pending.delete(sessionId); }
  sessionSecret.delete(sessionId);
  lastActivity.delete(sessionId);
  lastMsgCount.delete(sessionId);
  void killSession(tmuxName(sessionId));
}

export async function reapInteractiveSessions(): Promise<void> {
  const { listNcSessions } = await import('../system/claude-tmux');
  const now = Date.now();
  for (const name of await listNcSessions()) {
    const sid    = name.replace(/^nc-/, '');
    // Never reap a session with a turn in flight — even a long spawn/turn that
    // hasn't refreshed lastActivity yet. Defense-in-depth alongside the
    // turn-start lastActivity stamp.
    if (pending.has(sid)) continue;
    const last   = lastActivity.get(sid) ?? 0;
    const idleMs = now - last;
    if (last === 0 /* orphan from a prior process */ ||
        idleMs > config.claudeInteractive.idleReapMin * 60_000 ||
        idleMs > config.claudeInteractive.maxSessionMs) {
      logger.info('claude-interactive: reaping session', { name, idleMs, orphan: last === 0 });
      killInteractiveSession(sid);
    }
  }
}
