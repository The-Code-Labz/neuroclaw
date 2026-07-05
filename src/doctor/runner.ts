// Doctor runner — iterates the registered checks, optionally executes
// automated fixes, and feeds the result through one of the formatters.

import { spawn } from 'node:child_process';
import { listChecks } from './registry';
import { renderTerminal, renderJson } from './format';
import type { DoctorReport, DoctorReportEntry, DoctorCtx, DoctorResult } from './types';

interface RunOpts {
  scope?: string;
  format?: 'terminal' | 'json';
  fix?: boolean;
  /** When false, the renderer's output is suppressed (used by tests). */
  emit?: boolean;
  ctx: DoctorCtx;
}

async function runFix(command: string, cwd: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  return await new Promise(resolve => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      timeout: 120_000,
      env: process.env,
    });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    child.on('error', err => resolve({ ok: false, error: err.message }));
    child.on('close', code => {
      resolve({ ok: code === 0, output: out.slice(-2000) });
    });
  });
}

export async function runDoctor(opts: RunOpts): Promise<DoctorReport> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const checks = listChecks(opts.scope);
  const results: DoctorReportEntry[] = [];

  for (const check of checks) {
    const ctx: DoctorCtx = { ...opts.ctx, applyFixes: opts.fix === true };
    let result: DoctorResult;
    try {
      result = await check.run(ctx);
    } catch (err) {
      result = {
        ok: false,
        detail: `Check threw: ${(err as Error).message}`,
        meta: { error: String(err), stack: (err as Error).stack },
      };
    }

    let fixApplied: DoctorReportEntry['fixApplied'];
    if (
      !result.ok
      && opts.fix
      && result.fix?.automated === true
      && result.fix.command
    ) {
      fixApplied = await runFix(result.fix.command, opts.ctx.repoRoot);
      if (fixApplied.ok) {
        // Re-run the check after a successful fix to confirm.
        try {
          const recheck = await check.run(ctx);
          // Replace result with the post-fix result so the report reflects
          // the current state, not the pre-fix state.
          result = recheck;
        } catch (err) {
          result = {
            ok: false,
            detail: `Re-check after fix threw: ${(err as Error).message}`,
            meta: { error: String(err) },
          };
        }
      }
    }

    results.push({ check, result, ...(fixApplied ? { fixApplied } : {}) });
  }

  const summary = {
    total: results.length,
    passed: results.filter(r => r.result.ok).length,
    warned: results.filter(r => !r.result.ok && r.check.severity === 'warn').length,
    failed: results.filter(r => !r.result.ok && r.check.severity === 'fail').length,
  };

  const report: DoctorReport = {
    startedAt,
    durationMs: Date.now() - started,
    results,
    summary,
  };

  if (opts.emit !== false) {
    if (opts.format === 'json') {
      process.stdout.write(renderJson(report) + '\n');
    } else {
      process.stdout.write(renderTerminal(report));
    }
  }

  return report;
}
