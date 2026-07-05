import * as cron from 'node-cron';
import { EventEmitter } from 'events';
import {
  listCronJobs, getCronJob, createCronRun, finishCronRun, updateCronJobTimestamps,
  type CronJob,
} from '../db';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';
import { bashRun } from './exec-tools';

export const cronEvents = new EventEmitter();
cronEvents.setMaxListeners(50);

const scheduled = new Map<string, cron.ScheduledTask>();

export function startCronScheduler(): void {
  const jobs = listCronJobs(undefined, true);
  let count = 0;
  for (const job of jobs) {
    if (job.schedule && cron.validate(job.schedule)) {
      _register(job);
      count++;
    }
  }
  logger.info(`cron: scheduler started — ${count} job(s) registered`);
}

export function syncJob(id: string): void {
  const existing = scheduled.get(id);
  if (existing) { existing.stop(); scheduled.delete(id); }

  const job = getCronJob(id);
  if (!job || !job.enabled || !job.schedule) return;

  if (!cron.validate(job.schedule)) {
    logger.warn(`cron: job "${job.name}" has invalid schedule: ${job.schedule}`);
    return;
  }
  _register(job);
}

function _register(job: CronJob): void {
  const task = cron.schedule(job.schedule!, () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { enqueueJob } = require('../db') as typeof import('../db');
    enqueueJob('cron_run', { jobId: job.id, triggeredBy: 'schedule' });
  });
  scheduled.set(job.id, task);
}

export async function executeJobNow(id: string, triggeredBy: string): Promise<string> {
  return _execute(id, triggeredBy);
}

async function _execute(jobId: string, triggeredBy: string): Promise<string> {
  const job = getCronJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const run = createCronRun(jobId, triggeredBy);
  const t0  = Date.now();

  cronEvents.emit('run_started', { jobId, runId: run.id });
  logHive('cron_run_started', `cron: Cron job "${job.name}" started (${triggeredBy})`, undefined, {
    jobId, runId: run.id, type: job.job_type,
  });

  let output:    string | null = null;
  let errorText: string | null = null;
  let status: 'success' | 'error' = 'success';

  try {
    switch (job.job_type) {
      case 'agent_message':    output = await _runAgentMessage(job, run.id); break;
      case 'outbound_webhook': output = await _runOutboundWebhook(job);      break;
      case 'shell_command':    output = await _runShellCommand(job);         break;
      case 'n8n_workflow':     output = await _runN8nWorkflow(job);          break;
      case 'kestra_flow':      output = await _runKestraFlow(job);           break;
      default: throw new Error(`Unknown job_type: ${job.job_type}`);
    }
  } catch (err) {
    status    = 'error';
    errorText = err instanceof Error ? err.message : String(err);
    cronEvents.emit('run_error', { jobId, runId: run.id, error: errorText });
  }

  const durationMs = Date.now() - t0;
  let outboundStatus: number | undefined;

  if (job.on_complete_webhook_url && status === 'success') {
    try {
      const resp = await fetch(job.on_complete_webhook_url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jobId, runId: run.id, output, durationMs }),
      });
      outboundStatus = resp.status;
    } catch { /* best-effort */ }
  }

  finishCronRun(run.id, status, output, errorText, durationMs, outboundStatus);
  updateCronJobTimestamps(jobId, new Date().toISOString(), null);

  const hiveAction = status === 'success' ? 'cron_run_complete' : 'cron_run_error';
  logHive(hiveAction, `cron: Cron job "${job.name}" ${status} in ${durationMs}ms`, undefined, {
    jobId, runId: run.id, durationMs,
  });
  cronEvents.emit('run_done', { jobId, runId: run.id, status, durationMs });

  return run.id;
}

async function _runAgentMessage(job: CronJob, runId: string): Promise<string> {
  const cfg = JSON.parse(job.config) as { agentId?: string; message?: string; sessionId?: string };
  if (!cfg.agentId || !cfg.message) throw new Error('agent_message job requires agentId and message in config');

  // Dynamic import breaks the registry → alfred → registry circular dep.
  const { chatStream }     = await import('../agent/alfred');
  const { createSession, getAgentById } = await import('../db');

  const agent     = getAgentById(cfg.agentId);
  const sessionId = cfg.sessionId ?? createSession('cron-' + job.id.slice(0, 8), undefined, 'cron');
  const sysPrompt = agent?.system_prompt ?? 'You are a helpful AI assistant.';

  let fullReply = '';
  await chatStream(
    cfg.message, sessionId,
    (chunk) => {
      fullReply += chunk;
      cronEvents.emit('run_chunk', { jobId: job.id, runId, text: chunk });
    },
    sysPrompt, cfg.agentId,
  );
  return fullReply;
}

async function _runOutboundWebhook(job: CronJob): Promise<string> {
  const cfg = JSON.parse(job.config) as {
    url: string; method?: string;
    headers?: Record<string, string>; body?: unknown;
  };
  if (!cfg.url) throw new Error('outbound_webhook job requires url in config');
  const resp = await fetch(cfg.url, {
    method:  cfg.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.headers ?? {}) },
    body:    cfg.body !== undefined ? JSON.stringify(cfg.body) : undefined,
  });
  return await resp.text();
}

async function _runShellCommand(job: CronJob): Promise<string> {
  const cfg = JSON.parse(job.config) as { command: string; timeout?: number };
  if (!cfg.command) throw new Error('shell_command job requires command in config');
  const result = await bashRun({ command: cfg.command, timeout_ms: cfg.timeout ?? 30000 });
  return `exit ${result.exit_code ?? '?'}\n${result.stdout}\n${result.stderr}`.trim();
}

async function _runN8nWorkflow(job: CronJob): Promise<string> {
  const cfg = JSON.parse(job.config) as {
    baseUrl: string; apiKey: string; workflowId: string; payload?: unknown;
  };
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.workflowId)
    throw new Error('n8n_workflow job requires baseUrl, apiKey, workflowId in config');

  const headers = { 'X-N8N-API-KEY': cfg.apiKey, 'Content-Type': 'application/json' };
  const triggerResp = await fetch(`${cfg.baseUrl}/api/v1/workflows/${cfg.workflowId}/execute`, {
    method: 'POST', headers, body: JSON.stringify(cfg.payload ?? {}),
  });
  if (!triggerResp.ok) throw new Error(`n8n trigger failed: ${triggerResp.status}`);
  const triggerData = await triggerResp.json() as { data?: { executionId?: string } };
  const execId = triggerData.data?.executionId;
  if (!execId) throw new Error('n8n did not return an executionId');

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const statusResp = await fetch(`${cfg.baseUrl}/api/v1/executions/${execId}`, { headers });
    if (!statusResp.ok) continue;
    const execData = await statusResp.json() as { data?: { status?: string; data?: unknown } };
    const s = execData.data?.status;
    if (s === 'success')                  return JSON.stringify(execData.data?.data ?? {});
    if (s === 'error' || s === 'crashed') throw new Error(`n8n execution ${execId} ended with status: ${s}`);
  }
  throw new Error(`n8n execution ${execId} timed out after 10 minutes`);
}

async function _runKestraFlow(job: CronJob): Promise<string> {
  const cfg = JSON.parse(job.config) as {
    namespace: string; flowId: string; inputs?: unknown; baseUrl?: string; apiKey?: string;
  };
  if (!cfg.namespace || !cfg.flowId)
    throw new Error('kestra_flow job requires namespace and flowId in config');

  const { config } = await import('../config');
  const baseUrl = (cfg.baseUrl ?? config.kestra.baseUrl).replace(/\/+$/, '');
  const apiKey  = cfg.apiKey ?? config.kestra.apiKey;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const triggerResp = await fetch(
    `${baseUrl}/api/v1/executions/${cfg.namespace}/${cfg.flowId}`,
    { method: 'POST', headers, body: JSON.stringify(cfg.inputs ?? {}) },
  );
  if (!triggerResp.ok) throw new Error(`kestra trigger failed: ${triggerResp.status}`);
  const execData = await triggerResp.json() as { id?: string };
  const execId = execData.id;
  if (!execId) throw new Error('kestra did not return an execution id');

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const statusResp = await fetch(`${baseUrl}/api/v1/executions/${execId}`, { headers });
    if (!statusResp.ok) continue;
    const status = (await statusResp.json() as { state?: { current?: string } }).state?.current;
    if (status === 'SUCCESS' || status === 'WARNING') return `kestra execution ${execId} finished: ${status}`;
    if (status === 'FAILED' || status === 'KILLED' || status === 'CANCELLED')
      throw new Error(`kestra execution ${execId} ended with status: ${status}`);
  }
  throw new Error(`kestra execution ${execId} timed out after 10 minutes`);
}
