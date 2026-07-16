// Compression telemetry — roll-up counters, on-disk only, TTL-bounded.
// Per the Phase 1 mandate: NO per-call DB rows. Counters are kept in memory and
// flushed to a small JSON file; old daily buckets are pruned on flush.

import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

export type TelemetryEngine = 'lite' | 'headroom' | 'rtk';

interface EngineStats {
  calls: number;
  bytesIn: number;
  bytesOut: number;
}

interface DayBucket {
  engines: Record<TelemetryEngine, EngineStats>;
  exemptCalls: number;
}

interface TelemetryFile {
  buckets: Record<string, DayBucket>;
  updatedAt: string;
}

const ENGINES: TelemetryEngine[] = ['lite', 'headroom', 'rtk'];

function emptyEngine(): EngineStats {
  return { calls: 0, bytesIn: 0, bytesOut: 0 };
}

function emptyBucket(): DayBucket {
  return {
    engines: { lite: emptyEngine(), headroom: emptyEngine(), rtk: emptyEngine() },
    exemptCalls: 0,
  };
}

const memory: { buckets: Record<string, DayBucket>; loaded: boolean } = {
  buckets: {},
  loaded: false,
};

function telemetryPath(): string {
  const envPath = process.env.TOKEN_OPT_TELEMETRY_PATH?.trim();
  if (envPath) return path.resolve(envPath);
  const dbDir = path.dirname(config.db.path || './neuroclaw.db');
  return path.resolve(dbDir, 'compression-telemetry.json');
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function pruneBuckets(buckets: Record<string, DayBucket>): Record<string, DayBucket> {
  const ttlHours = Math.max(1, config.optimize.telemetryTtlHours);
  const cutoff = Date.now() - ttlHours * 3600 * 1000;
  const out: Record<string, DayBucket> = {};
  for (const [day, bucket] of Object.entries(buckets)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const dayTs = Date.parse(`${day}T00:00:00.000Z`);
    if (Number.isNaN(dayTs) || dayTs < cutoff) continue;
    out[day] = bucket;
  }
  return out;
}

function load(): void {
  if (memory.loaded) return;
  memory.loaded = true;
  const p = telemetryPath();
  try {
    if (!fs.existsSync(p)) return;
    const raw = fs.readFileSync(p, 'utf8');
    const parsed: TelemetryFile = JSON.parse(raw);
    if (parsed.buckets && typeof parsed.buckets === 'object') {
      Object.assign(memory.buckets, pruneBuckets(parsed.buckets));
    }
  } catch (err) {
    logger.warn('compression-telemetry: load failed', { error: String(err) });
  }
}

function flush(): void {
  const p = telemetryPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const file: TelemetryFile = {
      buckets: pruneBuckets(memory.buckets),
      updatedAt: new Date().toISOString(),
    };
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
    fs.renameSync(tmp, p);
  } catch (err) {
    logger.warn('compression-telemetry: flush failed', { error: String(err) });
  }
}

let flushTimer: NodeJS.Timeout | null = null;

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 5000);
}

export function recordCompressionTelemetry(
  engine: TelemetryEngine | 'exempt',
  bytesIn: number,
  bytesOut: number,
): void {
  load();
  const k = todayKey();
  if (!memory.buckets[k]) memory.buckets[k] = emptyBucket();
  const bucket = memory.buckets[k];
  if (engine === 'exempt') {
    bucket.exemptCalls += 1;
  } else {
    const s = bucket.engines[engine];
    s.calls += 1;
    s.bytesIn += Math.max(0, bytesIn);
    s.bytesOut += Math.max(0, bytesOut);
  }
  scheduleFlush();
}

export function getCompressionTelemetry(): {
  engines: Record<TelemetryEngine, EngineStats>;
  exemptCalls: number;
  updatedAt: string;
  global: { lite: boolean; headroom: boolean; rtk: boolean };
} {
  load();
  const totals: Record<TelemetryEngine, EngineStats> = {
    lite: emptyEngine(),
    headroom: emptyEngine(),
    rtk: emptyEngine(),
  };
  let exemptCalls = 0;
  for (const bucket of Object.values(memory.buckets)) {
    exemptCalls += bucket.exemptCalls || 0;
    for (const e of ENGINES) {
      totals[e].calls += bucket.engines[e].calls;
      totals[e].bytesIn += bucket.engines[e].bytesIn;
      totals[e].bytesOut += bucket.engines[e].bytesOut;
    }
  }
  return {
    engines: totals,
    exemptCalls,
    updatedAt: new Date().toISOString(),
    global: {
      lite: config.optimize.engines.lite,
      headroom: config.optimize.engines.headroom,
      rtk: config.tokenOpt.toolCompression,
    },
  };
}
