import { randomUUID } from 'crypto';
import { getDb, insertDowntimeEvent, closeDowntimeEvent, getOpenDowntimeEvent } from '../db';
import { readRecentLogLines, logger } from '../utils/logger';
import { detectGiveUpPatterns } from './give-up-telemetry';

const CURSOR_KEY = 'log_analyzer_last_run_at';
const RUN_INTERVAL_MS = 5 * 60 * 1000;

// Thresholds
const HEARTBEAT_GAP_MINUTES = 3;
const ERROR_SPIKE_WINDOW_MS = 2 * 60 * 1000;
const ERROR_SPIKE_COUNT = 5;
const ERROR_SPIKE_CRITICAL = 10;
const CLUSTER_WINDOW_MS = 5 * 60 * 1000;

function getLastRunAt(): string {
  const db = getDb();
  const row = db.prepare('SELECT value FROM config_items WHERE key = ?').get(CURSOR_KEY) as { value: string } | undefined;
  return row?.value ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function setLastRunAt(iso: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO config_items (key, value, description) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(CURSOR_KEY, iso, 'Log analyzer last run timestamp');
}

function detectHeartbeatGaps(since: string): void {
  const db = getDb();
  const beats = db.prepare(`
    SELECT created_at FROM analytics_events
    WHERE event_type = 'heartbeat_batch'
      AND created_at >= ?
    ORDER BY created_at ASC
  `).all(since) as Array<{ created_at: string }>;

  const now = new Date();

  for (let i = 0; i < beats.length - 1; i++) {
    const a = new Date(beats[i].created_at);
    const b = new Date(beats[i + 1].created_at);
    const gapMin = (b.getTime() - a.getTime()) / 60000;
    if (gapMin >= HEARTBEAT_GAP_MINUTES) {
      insertDowntimeEvent({
        id: randomUUID(),
        type: 'heartbeat_gap',
        started_at: beats[i].created_at,
        ended_at: beats[i + 1].created_at,
        duration_minutes: Math.round(gapMin * 10) / 10,
        severity: gapMin >= 10 ? 'critical' : 'warning',
        summary: `Heartbeat gap of ${Math.round(gapMin)}m detected`,
        metadata: null,
      });
    }
  }

  // Check if heartbeat is currently missing (open gap from last beat to now)
  if (beats.length > 0) {
    const last = new Date(beats[beats.length - 1].created_at);
    const sinceLastMin = (now.getTime() - last.getTime()) / 60000;
    if (sinceLastMin >= HEARTBEAT_GAP_MINUTES) {
      const open = getOpenDowntimeEvent('heartbeat_gap');
      if (!open) {
        insertDowntimeEvent({
          id: randomUUID(),
          type: 'heartbeat_gap',
          started_at: beats[beats.length - 1].created_at,
          ended_at: null,
          duration_minutes: null,
          severity: sinceLastMin >= 10 ? 'critical' : 'warning',
          summary: 'Heartbeat gap ongoing',
          metadata: null,
        });
      }
    } else {
      // Close any open heartbeat gap
      const open = getOpenDowntimeEvent('heartbeat_gap');
      if (open) {
        const durationMin = (now.getTime() - new Date(open.started_at).getTime()) / 60000;
        closeDowntimeEvent(open.id, now.toISOString(), Math.round(durationMin * 10) / 10);
      }
    }
  }
}

function detectErrorSpikes(since: string): void {
  const lines = readRecentLogLines(2000);
  const sinceMs = new Date(since).getTime();
  const errorLines = lines.filter(l => l.lvl === 'ERROR' && new Date(l.t).getTime() >= sinceMs);

  if (errorLines.length === 0) return;

  const timestamps = errorLines.map(l => new Date(l.t).getTime()).sort((a, b) => a - b);
  let windowStart = 0;

  while (windowStart < timestamps.length) {
    const t0 = timestamps[windowStart];
    let windowEnd = windowStart;
    while (windowEnd < timestamps.length && timestamps[windowEnd] - t0 <= ERROR_SPIKE_WINDOW_MS) {
      windowEnd++;
    }
    const count = windowEnd - windowStart;
    if (count >= ERROR_SPIKE_COUNT) {
      const startedAt = new Date(t0).toISOString();
      const endedAt   = new Date(timestamps[windowEnd - 1]).toISOString();
      const durationMin = (timestamps[windowEnd - 1] - t0) / 60000;
      insertDowntimeEvent({
        id: randomUUID(),
        type: 'error_spike',
        started_at: startedAt,
        ended_at: endedAt,
        duration_minutes: Math.max(1, Math.round(durationMin * 10) / 10),
        severity: count >= ERROR_SPIKE_CRITICAL ? 'critical' : 'warning',
        summary: `${count} errors in ${Math.round(durationMin + 1)}m window`,
        metadata: null,
      });
      windowStart = windowEnd;
    } else {
      windowStart++;
    }
  }
}

function detectDiscordOffline(since: string): void {
  const db = getDb();
  const events = db.prepare(`
    SELECT created_at FROM analytics_events
    WHERE event_type = 'discord_error' AND created_at >= ?
    ORDER BY created_at ASC
  `).all(since) as Array<{ created_at: string }>;

  if (events.length === 0) return;

  let clusterStart = new Date(events[0].created_at);
  let clusterEnd   = clusterStart;

  for (let i = 1; i < events.length; i++) {
    const t = new Date(events[i].created_at);
    if (t.getTime() - clusterEnd.getTime() <= CLUSTER_WINDOW_MS) {
      clusterEnd = t;
    } else {
      const durationMin = (clusterEnd.getTime() - clusterStart.getTime()) / 60000;
      insertDowntimeEvent({
        id: randomUUID(),
        type: 'discord_offline',
        started_at: clusterStart.toISOString(),
        ended_at: clusterEnd.toISOString(),
        duration_minutes: Math.max(1, Math.round(durationMin * 10) / 10),
        severity: 'warning',
        summary: 'Discord error cluster',
        metadata: null,
      });
      clusterStart = t;
      clusterEnd   = t;
    }
  }

  const finalDuration = (clusterEnd.getTime() - clusterStart.getTime()) / 60000;
  insertDowntimeEvent({
    id: randomUUID(),
    type: 'discord_offline',
    started_at: clusterStart.toISOString(),
    ended_at: clusterEnd.toISOString(),
    duration_minutes: Math.max(1, Math.round(finalDuration * 10) / 10),
    severity: 'warning',
    summary: 'Discord error cluster',
    metadata: null,
  });
}

function detectProviderFailures(since: string): void {
  const lines = readRecentLogLines(2000);
  const sinceMs = new Date(since).getTime();
  const PATTERNS = ['5xx', '503', '502', '504', 'timeout', 'ECONNREFUSED', 'provider error', 'rate limit'];
  const providerLines = lines.filter(l => {
    if (new Date(l.t).getTime() < sinceMs) return false;
    const lower = l.msg.toLowerCase();
    return PATTERNS.some(p => lower.includes(p));
  });

  if (providerLines.length === 0) return;

  const timestamps = providerLines.map(l => new Date(l.t).getTime()).sort((a, b) => a - b);
  let clusterStart = timestamps[0];
  let clusterEnd   = timestamps[0];

  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i] - clusterEnd <= CLUSTER_WINDOW_MS) {
      clusterEnd = timestamps[i];
    } else {
      const durationMin = (clusterEnd - clusterStart) / 60000;
      insertDowntimeEvent({
        id: randomUUID(),
        type: 'provider_failure',
        started_at: new Date(clusterStart).toISOString(),
        ended_at:   new Date(clusterEnd).toISOString(),
        duration_minutes: Math.max(1, Math.round(durationMin * 10) / 10),
        severity: 'warning',
        summary: 'Provider error cluster',
        metadata: null,
      });
      clusterStart = timestamps[i];
      clusterEnd   = timestamps[i];
    }
  }

  const finalDuration = (clusterEnd - clusterStart) / 60000;
  insertDowntimeEvent({
    id: randomUUID(),
    type: 'provider_failure',
    started_at: new Date(clusterStart).toISOString(),
    ended_at:   new Date(clusterEnd).toISOString(),
    duration_minutes: Math.max(1, Math.round(finalDuration * 10) / 10),
    severity: 'warning',
    summary: 'Provider error cluster',
    metadata: null,
  });
}

function runAnalysis(): void {
  try {
    const since = getLastRunAt();
    detectHeartbeatGaps(since);
    detectErrorSpikes(since);
    detectDiscordOffline(since);
    detectProviderFailures(since);
    // Async, self-contained (own 24h window + dedup). Fire-and-forget so a slow
    // task-file never blocks the synchronous downtime detectors above.
    void detectGiveUpPatterns();
    setLastRunAt(new Date().toISOString());
  } catch (err) {
    logger.warn('log-analyzer: run failed', { err: err instanceof Error ? err.message : err });
  }
}

export function startLogAnalyzer(): void {
  runAnalysis();
  setInterval(runAnalysis, RUN_INTERVAL_MS);
  logger.info('log-analyzer: started (5-min interval)');
}
