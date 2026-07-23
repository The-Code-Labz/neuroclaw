import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger';

const exec = promisify(execFile);

export interface TmuxLaunch {
  name:      string;                 // tmux session name, e.g. nc-<sessionId>
  command:   string;                 // full shell command to run in the window (the `claude ...` line)
  cwd:       string;
  env?:      Record<string, string | undefined>;
  /** tmux `new-session -e KEY=VALUE` pairs — the ONLY way to inject env into a
   *  pane under a persistent tmux server (new panes inherit the server's env,
   *  not the client execFile env). */
  envArgs?:  string[];
  cols?:     number;                 // default 220
  rows?:     number;                 // default 50
}

async function tmux(args: string[], env?: Record<string, string | undefined>): Promise<string> {
  const { stdout } = await exec('tmux', args, { env: env as NodeJS.ProcessEnv | undefined, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export async function isAlive(name: string): Promise<boolean> {
  try { await tmux(['has-session', '-t', name]); return true; } catch { return false; }
}

export async function listNcSessions(): Promise<string[]> {
  try {
    const out = await tmux(['list-sessions', '-F', '#{session_name}']);
    return out.split('\n').map(s => s.trim()).filter(n => n.startsWith('nc-'));
  } catch { return []; }   // "no server running" → no sessions
}

export async function killSession(name: string): Promise<void> {
  try { await tmux(['kill-session', '-t', name]); } catch { /* already gone */ }
}

// A NeuroClaw-managed interactive tmux session, for the dashboard watch view.
export interface ManagedTmuxSession {
  name:      string;                 // raw tmux session name
  kind:      'claude' | 'antigravity';
  sessionId?: string;                // for claude (nc-<sessionId>); agy names are opaque hashes
  createdAt: number;                 // epoch ms
}

// List every live interactive session we manage across BOTH providers:
//   claude-interactive → nc-<sessionId>      (claude-interactive.ts)
//   antigravity (agy)  → nclaw-agy-<hash>     (antigravity-session.ts)
export async function listManagedSessions(): Promise<ManagedTmuxSession[]> {
  try {
    const out = await tmux(['list-sessions', '-F', '#{session_name}\t#{session_created}']);
    return out.split('\n').map(l => l.trim()).filter(Boolean).map((line): ManagedTmuxSession | null => {
      const [name, created] = line.split('\t');
      const createdAt = (Number(created) || 0) * 1000;
      if (name.startsWith('nclaw-agy-')) return { name, kind: 'antigravity', createdAt };
      if (name.startsWith('nc-'))        return { name, kind: 'claude', sessionId: name.slice(3), createdAt };
      return null;
    }).filter((s): s is ManagedTmuxSession => s !== null);
  } catch { return []; }   // "no server running" → none
}

// Capture the pane. scrollbackLines>0 includes that many lines of history above
// the visible pane (read-only watch view wants a bit of scrollback).
export function capturePane(name: string, scrollbackLines = 0): Promise<string> {
  const args = scrollbackLines > 0
    ? ['capture-pane', '-t', name, '-p', '-S', `-${scrollbackLines}`]
    : ['capture-pane', '-t', name, '-p'];
  return tmux(args).catch(() => '');
}

// Send a single line into the REPL: literal text, then Enter. Newlines in the
// text would submit early, so collapse them (v1 limitation — chat prompts only).
export async function sendLine(name: string, text: string): Promise<void> {
  const flat = text.replace(/\r?\n/g, ' ');
  await tmux(['send-keys', '-t', name, '-l', '--', flat]);
  await tmux(['send-keys', '-t', name, 'Enter']);
}

async function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// Launch (if absent) and wait until the REPL prompt box is ready, auto-accepting
// the one-time folder-trust prompt. Resolves when ready, throws on timeout.
export async function ensureSession(opts: TmuxLaunch, readyTimeoutMs = 45_000): Promise<void> {
  if (await isAlive(opts.name)) return;
  await tmux([
    'new-session', '-d', '-s', opts.name,
    '-x', String(opts.cols ?? 220), '-y', String(opts.rows ?? 50), '-c', opts.cwd,
    ...(opts.envArgs ?? []),
  ], opts.env);
  await tmux(['set-option', '-t', opts.name, 'history-limit', '2000'], opts.env);
  // Run the launch command in the window.
  await tmux(['send-keys', '-t', opts.name, '-l', '--', opts.command], opts.env);
  await tmux(['send-keys', '-t', opts.name, 'Enter'], opts.env);

  const deadline = Date.now() + readyTimeoutMs;
  let trustHandled = false;
  while (Date.now() < deadline) {
    await sleep(1500);
    const pane = await capturePane(opts.name);
    if (!trustHandled && /trust this folder|Is this a project you/i.test(pane)) {
      await tmux(['send-keys', '-t', opts.name, 'Enter'], opts.env);   // accept option 1 (default)
      trustHandled = true;
      continue;
    }
    // The REPL is ready when the prompt box is drawn (the input chevron line).
    if (/\n[│|]?\s*❯\s/.test(pane) || /\n❯\s/.test(pane)) return;
  }
  throw new Error(`claude-tmux: session ${opts.name} did not reach ready state in ${readyTimeoutMs}ms`);
}
