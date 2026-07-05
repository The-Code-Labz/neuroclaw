// scripts/exec-hang-repro.ts
// Run with: npx tsx scripts/exec-hang-repro.ts
// Each case wraps bashRun in a wall-clock guard so a regression (hang) reports
// FAIL instead of hanging the script.

import { bashRun } from '../src/system/exec-tools';

async function withGuard<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  let t: NodeJS.Timeout;
  const guard = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`HUNG > ${ms}ms`)), ms); });
  try { return await Promise.race([p, guard]); }
  finally { clearTimeout(t!); }
}

async function main() {
  let failures = 0;

  // Case 1: background grandchild holds the pipe. MUST return promptly with "hi".
  try {
    const t0 = Date.now();
    const r = await withGuard('bg-pipe', 10_000, bashRun({ command: 'sleep 30 & echo hi', timeout_ms: 60_000 }));
    const dt = Date.now() - t0;
    const ok = r.stdout.includes('hi') && dt < 5_000;
    console.log(`[1] bg-pipe: ${ok ? 'PASS' : 'FAIL'} (dt=${dt}ms stdout=${JSON.stringify(r.stdout.trim())})`);
    if (!ok) failures++;
  } catch (e) { console.log(`[1] bg-pipe: FAIL (${(e as Error).message})`); failures++; }

  // Case 2: foreground command exceeds timeout. MUST return ~timeout, timedOut path.
  try {
    const t0 = Date.now();
    const r = await withGuard('fg-timeout', 10_000, bashRun({ command: 'sleep 30', timeout_ms: 2_000 }));
    const dt = Date.now() - t0;
    const ok = dt < 5_000 && r.ok === false;
    console.log(`[2] fg-timeout: ${ok ? 'PASS' : 'FAIL'} (dt=${dt}ms ok=${r.ok} signal=${r.signal})`);
    if (!ok) failures++;
  } catch (e) { console.log(`[2] fg-timeout: FAIL (${(e as Error).message})`); failures++; }

  // Case 3: normal command. MUST succeed.
  try {
    const r = await withGuard('normal', 10_000, bashRun({ command: 'echo hello' }));
    const ok = r.ok && r.exit_code === 0 && r.stdout.includes('hello');
    console.log(`[3] normal: ${ok ? 'PASS' : 'FAIL'} (ok=${r.ok} stdout=${JSON.stringify(r.stdout.trim())})`);
    if (!ok) failures++;
  } catch (e) { console.log(`[3] normal: FAIL (${(e as Error).message})`); failures++; }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
