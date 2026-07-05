import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { registry } from '../tools/registry';
import type { ToolContext } from '../tools/context';
import type { GateIO } from '../cli/tui';

const RESET = '\x1b[0m';
const RED   = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN  = '\x1b[36m';
const BOLD  = '\x1b[1m';

let gateInstalled = false;

function colorDiff(raw: string): string {
  return raw
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return BOLD + line + RESET;
      if (line.startsWith('+')) return GREEN + line + RESET;
      if (line.startsWith('-')) return RED + line + RESET;
      if (line.startsWith('@@')) return CYAN + line + RESET;
      return line;
    })
    .join('\n');
}

function computeDiff(oldContent: string, newContent: string, label: string): string {
  const base = `nclaw-${process.pid}-${randomBytes(4).toString('hex')}`;
  const tmpA = path.join(os.tmpdir(), `${base}-old`);
  const tmpB = path.join(os.tmpdir(), `${base}-new`);
  try {
    fs.writeFileSync(tmpA, oldContent, 'utf8');
    fs.writeFileSync(tmpB, newContent, 'utf8');
    const result = spawnSync(
      'diff',
      ['-u', '--label', `a/${label}`, '--label', `b/${label}`, tmpA, tmpB],
      { encoding: 'utf8' },
    );
    if (result.error) {
      return `(diff unavailable: ${(result.error as NodeJS.ErrnoException).code ?? 'unknown error'} — review carefully before approving)`;
    }
    return result.stdout || '(no textual differences)';
  } finally {
    try { fs.unlinkSync(tmpA); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpB); } catch { /* ignore */ }
  }
}

export function installConfirmGate(gateIO: GateIO): void {
  if (gateInstalled) return;
  gateInstalled = true;

  // ── Wrap fs_write ────────────────────────────────────────────────────────
  const fsWriteEntry = registry.find((t) => t.name === 'fs_write');
  if (fsWriteEntry) {
    const original = fsWriteEntry.handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fsWriteEntry as any).handler = async (
      args: { path: string; content: string; mode?: string },
      ctx: ToolContext,
    ): Promise<unknown> => {
      const target = path.resolve(args.path);
      const execRoot = process.env.EXEC_ROOT;
      if (execRoot) {
        const resolvedRoot = fs.realpathSync(path.resolve(execRoot));
        const resolvedTarget = (() => { try { return fs.realpathSync(target); } catch { return target; } })();
        if (!resolvedTarget.startsWith(resolvedRoot)) {
          return { ok: false, path: target, error: 'exec: path is outside EXEC_ROOT' };
        }
      }
      let oldContent = '';
      let isNew = false;
      try {
        oldContent = fs.readFileSync(target, 'utf8');
      } catch {
        isNew = true;
      }

      gateIO.writeLine('');
      const isBinary = (s: string) => s.includes('\x00');
      if (isNew) {
        const bytes = Buffer.byteLength(args.content, 'utf8');
        gateIO.writeLine(`${BOLD}New file:${RESET} ${args.path} (${bytes} bytes)`);
      } else if (isBinary(oldContent) || isBinary(args.content)) {
        const bytes = Buffer.byteLength(args.content, 'utf8');
        gateIO.writeLine(`${CYAN}(binary file — diff skipped, new size: ${bytes} bytes)${RESET}`);
      } else {
        const diff = computeDiff(oldContent, args.content, args.path);
        gateIO.writeLine(colorDiff(diff));
      }

      const approved = await gateIO.askYesNo(`${BOLD}Write${RESET} ${args.path}? [y/N] `);
      if (!approved) {
        return { ok: false, path: target, error: 'cancelled by user' };
      }
      return original(args, ctx);
    };
  }

  // ── Wrap bash_run ────────────────────────────────────────────────────────
  const bashRunEntry = registry.find((t) => t.name === 'bash_run');
  if (bashRunEntry) {
    const original = bashRunEntry.handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bashRunEntry as any).handler = async (
      args: { command: string; cwd?: string; timeout_ms?: number },
      ctx: ToolContext,
    ): Promise<unknown> => {
      gateIO.writeLine('');
      gateIO.writeLine(`${BOLD}Shell command:${RESET}`);
      gateIO.writeLine(`  ${CYAN}${args.command}${RESET}`);
      if (args.cwd) gateIO.writeLine(`  ${BOLD}cwd:${RESET} ${args.cwd}`);
      gateIO.writeLine('');

      const approved = await gateIO.askYesNo(`${BOLD}Run command?${RESET} [y/N] `);
      if (!approved) {
        return {
          ok: false, exit_code: null, signal: null,
          stdout: '', stderr: 'cancelled by user',
          duration_ms: 0, truncated: false,
          command: args.command, cwd: args.cwd ?? (process.env.EXEC_DEFAULT_CWD ?? process.cwd()),
        };
      }
      return original(args, ctx);
    };
  }
}
