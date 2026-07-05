// Terminal + JSON renderers. Zero dependencies — ANSI escapes are inlined
// because shipping a colour lib for one CLI is overkill.

import type { DoctorReport, DoctorReportEntry, Severity } from './types';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GREY = '\x1b[90m';

function tty(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function paint(s: string, code: string): string {
  return tty() ? `${code}${s}${RESET}` : s;
}

function iconAndColor(ok: boolean, severity: Severity): { icon: string; color: string; label: string } {
  if (ok) return { icon: '✓', color: GREEN, label: 'ok  ' };
  if (severity === 'warn') return { icon: '⚠', color: YELLOW, label: 'warn' };
  if (severity === 'info') return { icon: 'ℹ', color: CYAN, label: 'info' };
  return { icon: '✗', color: RED, label: 'fail' };
}

function renderEntry(entry: DoctorReportEntry): string {
  const { check, result, fixApplied } = entry;
  const { icon, color, label } = iconAndColor(result.ok, check.severity);

  const head = `  ${paint(icon, color)} ${paint(label, color)}  ${paint(check.id, BOLD)}  ${paint(`[${check.scope}]`, GREY)}`;
  const lines = [`${head}  ${result.detail}`];

  if (!result.ok && result.fix) {
    lines.push(`        ${paint('fix:', DIM)} ${result.fix.suggestion}`);
    if (result.fix.command) {
      const tag = result.fix.automated ? '$ (auto)' : '$';
      lines.push(`        ${paint(tag, DIM)} ${result.fix.command}`);
    }
  }

  if (fixApplied) {
    const tag = fixApplied.ok
      ? paint('→ fix applied OK', GREEN)
      : paint(`→ fix FAILED${fixApplied.error ? ': ' + fixApplied.error : ''}`, RED);
    lines.push(`        ${tag}`);
  }

  return lines.join('\n');
}

export function renderTerminal(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${paint('nclaw doctor', BOLD)}  ${paint(`· ${report.results.length} check(s)`, DIM)}`);
  lines.push('');
  for (const entry of report.results) {
    lines.push(renderEntry(entry));
  }
  lines.push('');

  const { passed, warned, failed, total } = report.summary;
  const dur = `${(report.durationMs / 1000).toFixed(2)}s`;
  const parts = [
    paint(`${passed} passed`, GREEN),
    warned > 0 ? paint(`${warned} warned`, YELLOW) : `${warned} warned`,
    failed > 0 ? paint(`${failed} failed`, RED) : `${failed} failed`,
  ];
  lines.push(`  ${parts.join(', ')}  ${paint(`(${total} total · ${dur})`, DIM)}`);
  lines.push('');
  return lines.join('\n');
}

export function renderJson(report: DoctorReport): string {
  // Strip the function reference on the check object so JSON.stringify works
  // and the output is portable. Keep every other field.
  const safe = {
    startedAt: report.startedAt,
    durationMs: report.durationMs,
    summary: report.summary,
    results: report.results.map(r => ({
      check: {
        id: r.check.id,
        scope: r.check.scope,
        severity: r.check.severity,
        description: r.check.description,
      },
      result: r.result,
      ...(r.fixApplied ? { fixApplied: r.fixApplied } : {}),
    })),
  };
  return JSON.stringify(safe, null, 2);
}
