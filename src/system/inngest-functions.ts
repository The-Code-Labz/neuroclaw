// Inngest function definitions.
//
// PHASE 1 (current): STUBS — they receive events and log them but do NOT execute
// the work; the legacy job-worker.ts still does all execution. This lets us verify
// the full event round-trip (NeuroClaw → Inngest → callback → function fires)
// with zero behavior change. Phase 2 replaces these bodies with real logic.

import { NonRetriableError } from 'inngest';
import { inngest } from './inngest-client';
import { logger } from '../utils/logger';

// ── Event name → job type mapping (mirrors job_queue types) ──────────────────
export const JOB_TYPE_TO_EVENT: Record<string, string> = {
  background_agent:   'agent/background.run',
  agent_task:         'agent/task.assigned',
  tts_synthesize:     'tts/synthesize.requested',
  memory_extract:     'memory/extract.requested',
  embedding_generate: 'embedding/generate.requested',
  workflow_run:       'workflow/run.requested',
  dream_cycle:        'memory/dream-cycle.triggered',
  maintenance:        'system/maintenance.scheduled',
  cron_run:           'cron/job.triggered',
};

// ── Stub factory ──────────────────────────────────────────────────────────────
// NOTE: inngest v4 takes (options, handler) — the trigger moved INTO options as
// `triggers: [...]` (v3 used a separate 2nd arg). The plan's Phase 2 bodies are
// written v3-style and must be adapted the same way.
function stubFn(id: string, eventName: string) {
  return inngest.createFunction(
    { id, retries: 0, triggers: [{ event: eventName }] },
    async ({ event }) => {
      logger.info(`inngest stub: received ${eventName}`, { data: event.data });
      return { stub: true, event: eventName };
    },
  );
}

// ── Stub functions (Phase 1 — replaced with real logic in Phase 2) ───────────
export const backgroundAgentFn   = stubFn('neuroclaw/background-agent',   'agent/background.run');
export const agentTaskFn         = stubFn('neuroclaw/agent-task',         'agent/task.assigned');
export const ttsSynthesizeFn     = stubFn('neuroclaw/tts-synthesize',     'tts/synthesize.requested');
export const memoryExtractFn     = stubFn('neuroclaw/memory-extract',     'memory/extract.requested');
export const embeddingGenerateFn = stubFn('neuroclaw/embedding-generate', 'embedding/generate.requested');
export const workflowRunFn       = stubFn('neuroclaw/workflow-run',       'workflow/run.requested');
export const dreamCycleFn        = stubFn('neuroclaw/dream-cycle',        'memory/dream-cycle.triggered');
export const maintenanceFn       = stubFn('neuroclaw/maintenance',        'system/maintenance.scheduled');
export const cronRunFn           = stubFn('neuroclaw/cron-run',           'cron/job.triggered');
export const runContinuationFn   = stubFn('neuroclaw/run-continuation',   'run/terminal.done');
// Spike sentinel — lets us prove the round-trip without touching real job types.
export const spikePingFn         = stubFn('neuroclaw/spike-ping',         'spike/test.ping');

// ── Exported array for the serve handler ─────────────────────────────────────
export const allFunctions = [
  backgroundAgentFn,
  agentTaskFn,
  ttsSynthesizeFn,
  memoryExtractFn,
  embeddingGenerateFn,
  workflowRunFn,
  dreamCycleFn,
  maintenanceFn,
  cronRunFn,
  runContinuationFn,
  spikePingFn,
];

// Used in Phase 2 (typed import kept warm).
void NonRetriableError;
