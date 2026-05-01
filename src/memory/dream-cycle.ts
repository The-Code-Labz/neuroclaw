// P3 — Dream cycle (nightly memory consolidation / "washing system").
//
// Behavior:
//   - scan last DREAM_LOOKBACK_HOURS sessions
//   - summarize conversations
//   - extract decisions
//   - detect patterns
//   - create insights
//   - generate procedures
//   - build next-day plan
//   - archive noise
//
// Schedule:
//   - At startup, compute ms-until-next DREAM_RUN_TIME (HH:MM, local clock)
//   - setTimeout to that moment, run, then schedule next 24h cycle
//   - Implemented in P3.

import { config } from '../config';
import { logger } from '../utils/logger';

let timer: NodeJS.Timeout | null = null;

export function startDreamScheduler(): void {
  if (!config.dream.enabled) {
    logger.info('Dream cycle: disabled (DREAM_ENABLED=false)');
    return;
  }
  logger.info('Dream cycle: scheduler stub registered (P3 will implement run logic)', {
    runTime:       config.dream.runTime,
    lookbackHours: config.dream.lookbackHours,
  });
}

export function stopDreamScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
