/**
 * broker/audit.ts — append-only audit log for broker access (spec v3 §11/§15).
 *
 * Writes NDJSON rows to `logs/broker-audit.ndjson`. Each row records WHO
 * (agent + session), WHAT (event + secret names), WHY (purpose), and the
 * OUTCOME. Values are NEVER written.
 *
 * Rows are also kept in an in-memory ring buffer so the dashboard audit panel
 * can render instantly without re-reading the file.
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import type { BrokerAuditRow } from './types';

const AUDIT_DIR = path.resolve(process.cwd(), 'logs');
const AUDIT_PATH = path.join(AUDIT_DIR, 'broker-audit.ndjson');

const RING_CAP = 500;
const ring: BrokerAuditRow[] = [];

function ensureDir(): void {
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  } catch (err) {
    logger.warn('broker-audit: failed to ensure log dir', { err: (err as Error).message });
  }
}

export function auditLog(row: Omit<BrokerAuditRow, 'ts'>): void {
  const full: BrokerAuditRow = { ts: new Date().toISOString(), ...row };

  ring.push(full);
  if (ring.length > RING_CAP) ring.shift();

  try {
    ensureDir();
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(full) + '\n');
  } catch (err) {
    logger.error('broker-audit: write failed', { err: (err as Error).message, event: full.event });
  }
}

export function getRecentAudit(limit = 100): BrokerAuditRow[] {
  const n = Math.max(1, Math.min(limit, RING_CAP));
  return ring.slice(-n).reverse();
}

export function queryAudit(opts: {
  limit?: number;
  agent?: string;
  event?: BrokerAuditRow['event'];
  since?: string;
} = {}): BrokerAuditRow[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 2000));

  let lines: string[] = [];
  try {
    if (fs.existsSync(AUDIT_PATH)) {
      lines = fs.readFileSync(AUDIT_PATH, 'utf8').split('\n').filter(Boolean);
    }
  } catch (err) {
    logger.warn('broker-audit: read failed', { err: (err as Error).message });
    return [];
  }

  const out: BrokerAuditRow[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let row: BrokerAuditRow;
    try { row = JSON.parse(lines[i]) as BrokerAuditRow; } catch { continue; }
    if (opts.agent && row.agent !== opts.agent) continue;
    if (opts.event && row.event !== opts.event) continue;
    if (opts.since && row.ts < opts.since) continue;
    out.push(row);
  }
  return out;
}

export function getAuditPath(): string { return AUDIT_PATH; }
export function _resetAuditRingForTests(): void { ring.length = 0; }
