import 'dotenv/config';
import { syncSkillExports } from '../src/skills/exporters';

async function main(): Promise<void> {
  const result = await syncSkillExports({ refresh: true });
  for (const summary of result) {
    if (summary.error) {
      console.error(`${summary.exporter}: ${summary.error}`);
      process.exitCode = 1;
      continue;
    }
    if (summary.written.length > 0) {
      console.log(`${summary.exporter}: wrote ${summary.written.join(', ')}`);
    }
    if (summary.skipped.length > 0) {
      console.log(`${summary.exporter}: skipped ${summary.skipped.join('; ')}`);
    }
    if (summary.written.length === 0 && summary.skipped.length === 0) {
      console.log(`${summary.exporter}: already up to date`);
    }
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
