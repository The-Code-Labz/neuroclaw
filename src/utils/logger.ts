import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface ParsedLogLine {
  t:   string;
  lvl: string;
  src: string;
  msg: string;
}

export const logEvents = new EventEmitter();
logEvents.setMaxListeners(50);

const COLORS: Record<LogLevel, string> = {
  info:  '\x1b[36m',  // cyan
  warn:  '\x1b[33m',  // yellow
  error: '\x1b[31m',  // red
  debug: '\x1b[90m',  // grey
};
const RESET = '\x1b[0m';

let cliMode = false;
export function setCliMode(enabled: boolean): void { cliMode = enabled; }

const LOG_DIR  = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'neuroclaw.log');

let logDirReady = false;
function ensureLogDir() {
  if (logDirReady) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logDirReady = true;
  } catch { /* non-fatal */ }
}

function laTimestamp(): string {
  return new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: true });
}

function extractSrc(msg: string): string {
  const m = msg.match(/^([a-z][a-z0-9\-/]+):/i);
  return m ? m[1].slice(0, 18) : 'system';
}

function parseLine(line: string): ParsedLogLine {
  // Format: [2026-05-05 18:08:15] [INFO] task-monitor: message {...}
  const m = line.match(/^\[([^\]]+)\]\s+\[([A-Z]+)\]\s+(.*)$/);
  if (!m) return { t: '—', lvl: 'INFO', src: 'system', msg: line };
  const [, t, lvl, rest] = m;
  return { t: t.trim(), lvl, src: extractSrc(rest), msg: rest };
}

// ── In-memory ring buffer for recent log lines (fast dashboard queries) ─────
const RING_SIZE = 2000;
const logRing: ParsedLogLine[] = [];

function pushToRing(line: ParsedLogLine): void {
  if (logRing.length >= RING_SIZE) logRing.shift();
  logRing.push(line);
}

// Analytics integration - lazy loaded to avoid circular dependency
let analyticsTracker: ((eventType: string, data?: unknown) => void) | null = null;
let analyticsLoading = false;

// Debug log persistence - lazy loaded to avoid circular dependency
let debugInserter: ((row: { id?: string; session_id: string | null; agent_id: string | null; source: string; message: string; data: string | null }) => void) | null = null;
let debugLoading = false;

function tryLogToAnalytics(level: LogLevel, message: string, data?: unknown): void {
  // Only track errors and warnings
  if (level !== 'error' && level !== 'warn') return;
  
  // Don't track analytics-related errors to avoid infinite loops
  if (message.includes('analytics') || message.includes('Analytics')) return;
  
  // Lazy load the analytics function to avoid circular dependency
  if (!analyticsTracker && !analyticsLoading) {
    analyticsLoading = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const db = require('../db');
      if (typeof db.logAnalytics === 'function') {
        analyticsTracker = db.logAnalytics;
      }
    } catch {
      // DB not ready yet, will retry on next call
      analyticsLoading = false;
    }
  }
  
  if (analyticsTracker) {
    try {
      const src = extractSrc(message);
      analyticsTracker('log_error', {
        level,
        source: src,
        message: message.slice(0, 500),
        data: data ? JSON.stringify(data).slice(0, 500) : undefined,
      });
    } catch {
      // Never let analytics tracking crash the logger
    }
  }
}

function tryLogToDebug(message: string, data?: unknown): void {
  if (!debugInserter && !debugLoading) {
    debugLoading = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const db = require('../db');
      if (typeof db.insertDebugLog === 'function') {
        debugInserter = db.insertDebugLog;
      }
    } catch {
      debugLoading = false;
    }
  }

  if (debugInserter) {
    try {
      const src = extractSrc(message);
      const rawData = (data !== null && typeof data === 'object' && !Array.isArray(data))
        ? (data as Record<string, unknown>)
        : undefined;
      debugInserter({
        session_id: typeof rawData?.sessionId === 'string' ? rawData.sessionId : null,
        agent_id:   typeof rawData?.agentId   === 'string' ? rawData.agentId   : null,
        source:     src,
        message:    message.slice(0, 2000),
        data:       (() => { try { return data !== undefined ? JSON.stringify(data).slice(0, 1000) : null; } catch { return '[unserializable]'; } })(),
      });
    } catch { /* never crash the logger */ }
  }
}

function log(level: LogLevel, message: string, data?: unknown): void {
  const t       = laTimestamp();
  const dataStr = data !== undefined ? ' ' + JSON.stringify(data) : '';
  const plain   = `[${t}] [${level.toUpperCase()}] ${message}${dataStr}`;

  if (!cliMode) {
    const isError = level === 'error' || level === 'warn';
    const stream  = isError ? process.stderr : process.stdout;
    const isTTY   = stream.isTTY ?? false;
    if (isTTY) {
      stream.write(`${COLORS[level]}${plain}${RESET}\n`);
    } else {
      stream.write(plain + '\n');
    }
  }

  ensureLogDir();
  if (logDirReady) {
    try { fs.appendFileSync(LOG_FILE, plain + '\n'); } catch { /* non-fatal */ }
  }

  const parsedLine: ParsedLogLine = {
    t,
    lvl: level.toUpperCase(),
    src: extractSrc(message),
    msg: message + dataStr,
  };

  try {
    pushToRing(parsedLine);
    logEvents.emit('line', parsedLine);
  } catch { /* never crash on emit */ }

  if (level === 'debug') {
    try {
      const rawData = (data !== null && typeof data === 'object' && !Array.isArray(data))
        ? (data as Record<string, unknown>)
        : undefined;
      logEvents.emit('debug', {
        id:         '',
        session_id: typeof rawData?.sessionId === 'string' ? rawData.sessionId : null,
        agent_id:   typeof rawData?.agentId   === 'string' ? rawData.agentId   : null,
        source:     extractSrc(message),
        message:    message + dataStr,
        data:       null,
        created_at: new Date().toISOString(),
      });
    } catch { /* never crash */ }
  }

  // Track errors/warnings in analytics for aggregation
  tryLogToAnalytics(level, message, data);

  // Persist debug logs to database
  if (level === 'debug') tryLogToDebug(message, data);
}

/**
 * Read the last N lines from a file efficiently by reading from the end.
 * Avoids loading multi-GB log files into memory.
 */
function readLastLines(filePath: string, n: number): string[] {
  const result: string[] = [];
  const chunkSize = 8192; // 8KB chunks
  let buffer = '';
  let pos: number;

  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return [];
    pos = stats.size;
  } catch {
    return [];
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    while (result.length < n && pos > 0) {
      const readSize = Math.min(chunkSize, pos);
      pos -= readSize;

      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, pos);
      buffer = chunk.toString('utf8') + buffer;

      // Extract lines from buffer
      const lines = buffer.split('\n');
      // The first element may be a partial line (if we started mid-line)
      // unless we're at the very start of the file
      const isStartOfFile = pos === 0;

      // Start from the end, collect complete lines
      for (let i = lines.length - 1; i >= 0; i--) {
        if (result.length >= n) break;
        const line = lines[i];
        if (i === 0 && !isStartOfFile) {
          // This is a partial line — keep it in buffer for next iteration
          buffer = line;
          break;
        }
        if (line) result.unshift(line);
      }

      if (!isStartOfFile && result.length < n) {
        // Reset buffer to any partial line we kept
        buffer = buffer || '';
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return result;
}

export function readRecentLogLines(n: number): ParsedLogLine[] {
  // Prefer in-memory ring buffer for instant reads
  if (n <= logRing.length) {
    return logRing.slice(-n);
  }
  // Fall back to file tail-read for larger requests (e.g. after restart)
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = readLastLines(LOG_FILE, n);
    return lines.map(parseLine);
  } catch {
    return [];
  }
}

export function readFilteredLogLines(n: number, srcValues: string[], contains?: string): ParsedLogLine[] {
  // Prefer in-memory ring buffer for instant reads on small requests
  if (n <= logRing.length && !contains && srcValues.length === 0) {
    return logRing.slice(-n);
  }

  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = readLastLines(LOG_FILE, Math.min(n * 3, 5000)); // read a bit extra for filtering
    const srcSet  = new Set(srcValues);
    const matches = lines.map(parseLine).filter(l => {
      if (srcSet.size > 0 && !srcSet.has(l.src)) return false;
      if (contains && !l.msg.includes(contains)) return false;
      return true;
    });
    return matches.slice(-n);
  } catch {
    return [];
  }
}

export const logger = {
  info:  (msg: string, data?: unknown) => log('info',  msg, data),
  warn:  (msg: string, data?: unknown) => log('warn',  msg, data),
  error: (msg: string, data?: unknown) => log('error', msg, data),
  debug: (msg: string, data?: unknown) => log('debug', msg, data),

  /** Return the path of the active log file. */
  logFilePath: () => LOG_FILE,
};
