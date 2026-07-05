// doctor types — shared shapes for all checks, the registry, the runner, and the
// terminal/JSON renderers.
//
// A check returns a DoctorResult; if ok=false it should usually include a
// DoctorFix telling the operator (or the --fix runner) how to make it green.

import type Database from 'better-sqlite3';

export type Severity = 'info' | 'warn' | 'fail';

export type Scope =
  | 'auth'
  | 'vault'
  | 'discord'
  | 'tools'
  | 'memory'
  | 'config'
  | 'runtime'
  | 'mcp';

export interface DoctorCtx {
  db: Database.Database;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  /** True iff --fix was passed on the CLI; checks may use this for fine control. */
  applyFixes: boolean;
}

export interface DoctorFix {
  /** Human-readable instruction shown when --fix is not used. */
  suggestion: string;
  /** Shell command runnable in repoRoot; required if automated=true. */
  command?: string;
  /** When true, the runner will exec `command` under --fix. */
  automated?: boolean;
}

export interface DoctorResult {
  ok: boolean;
  /** One-line (occasionally two-line) summary printed in the terminal renderer. */
  detail: string;
  /** Present iff ok=false. */
  fix?: DoctorFix;
  /** Free-form structured detail surfaced in --json output. */
  meta?: Record<string, unknown>;
}

export interface DoctorCheck {
  /** Dotted id — e.g. "vault.dist-fresh". Must be unique across the registry. */
  id: string;
  scope: Scope;
  severity: Severity;
  description: string;
  run: (ctx: DoctorCtx) => Promise<DoctorResult>;
}

export interface DoctorReportEntry {
  check: DoctorCheck;
  result: DoctorResult;
  /** Populated when --fix attempted to run an automated remediation. */
  fixApplied?: { ok: boolean; output?: string; error?: string };
}

export interface DoctorReport {
  startedAt: string;
  durationMs: number;
  results: DoctorReportEntry[];
  summary: {
    total: number;
    passed: number;
    warned: number;
    failed: number;
  };
}
