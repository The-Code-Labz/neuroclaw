import fs from 'fs';
import path from 'path';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const COLORS: Record<LogLevel, string> = {
  info:  '\x1b[36m',  // cyan
  warn:  '\x1b[33m',  // yellow
  error: '\x1b[31m',  // red
  debug: '\x1b[90m',  // grey
};
const RESET = '\x1b[0m';

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

function log(level: LogLevel, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const dataStr   = data !== undefined ? ' ' + JSON.stringify(data) : '';
  const plain     = `[${timestamp}] [${level.toUpperCase()}] ${message}${dataStr}`;

  // Colorized terminal output
  const isError = level === 'error' || level === 'warn';
  const stream  = isError ? process.stderr : process.stdout;
  const isTTY   = stream.isTTY ?? false;
  if (isTTY) {
    stream.write(`${COLORS[level]}${plain}${RESET}\n`);
  } else {
    stream.write(plain + '\n');
  }

  // File output (best-effort)
  ensureLogDir();
  if (logDirReady) {
    try { fs.appendFileSync(LOG_FILE, plain + '\n'); } catch { /* non-fatal */ }
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
