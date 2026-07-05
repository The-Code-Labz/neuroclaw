// nclaw doctor — public entry point.
//
// The CLI delegates here from src/cli-code.ts when argv[2] === 'doctor'.
// This module also doubles as the side-effect import that registers every
// shipped check (via ./checks).

import { getDb } from '../db';
import { runDoctor } from './runner';
import './checks'; // side-effect: registers every shipped check
import { listChecks } from './registry';
import type { DoctorCtx } from './types';

export type { DoctorCheck, DoctorResult, DoctorReport, DoctorCtx } from './types';
export { register, listChecks, getCheck } from './registry';
export { runDoctor };

function printHelp(): void {
  const all = listChecks();
  const lines: string[] = [];
  lines.push('Usage: nclaw doctor [--scope=<scope>] [--fix] [--json]');
  lines.push('');
  lines.push('Options:');
  lines.push('  --scope=<scope>   Only run checks in the given scope');
  lines.push('  --fix             Apply automated fixes where available');
  lines.push('  --json            Emit a machine-readable report on stdout');
  lines.push('  -h, --help        Show this message');
  lines.push('');
  lines.push('Available checks:');
  for (const c of all) {
    lines.push(`  [${c.scope}] ${c.id} (${c.severity}) — ${c.description}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

export async function cli(argv: string[]): Promise<number> {
  const args = argv.slice(0);
  const fix = args.includes('--fix');
  const json = args.includes('--json');
  const help = args.includes('--help') || args.includes('-h');
  const scopeArg = args.find(a => a.startsWith('--scope='))?.split('=')[1];

  if (help) {
    printHelp();
    return 0;
  }

  const ctx: DoctorCtx = {
    db: getDb(),
    env: process.env,
    repoRoot: process.cwd(),
    applyFixes: fix,
  };

  const report = await runDoctor({
    scope: scopeArg,
    format: json ? 'json' : 'terminal',
    fix,
    ctx,
  });

  return report.summary.failed > 0 ? 1 : 0;
}

// Allow `tsx src/doctor/index.ts` to run the CLI directly (used by the
// `npm run doctor` and `npm run doctor:fix` scripts).
if (require.main === module) {
  cli(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(err => {
      // eslint-disable-next-line no-console
      console.error('doctor: fatal error', err);
      process.exit(2);
    });
}
