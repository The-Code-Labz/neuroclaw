import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import dotenv from 'dotenv';
import { getDb } from '../db';
import { resetClient } from '../agent/openai-client';
import { logger } from '../utils/logger';

// Subscribers (dashboard SSE connections) listen on this emitter
export const configEvents = new EventEmitter();
configEvents.setMaxListeners(100);

let lastMtime = 0;

function getEnvPath(): string {
  return path.resolve(process.cwd(), '.env');
}

function syncConfigToDb(): void {
  try {
    const db = getDb();
    const updates: Array<{ key: string; val: string }> = [
      { key: 'VOIDAI_MODEL',    val: process.env.VOIDAI_MODEL    ?? 'gpt-5.1'    },
      { key: 'DASHBOARD_PORT',  val: process.env.DASHBOARD_PORT  ?? '3141'       },
      { key: 'VOIDAI_API_KEY',  val: process.env.VOIDAI_API_KEY  ?? ''           },
      { key: 'DASHBOARD_TOKEN', val: process.env.DASHBOARD_TOKEN ?? 'change-me'  },
    ];
    const stmt = db.prepare("UPDATE config_items SET value = ?, updated_at = datetime('now') WHERE key = ?");
    for (const { key, val } of updates) {
      stmt.run(val, key);
    }
  } catch (err) {
    logger.warn('Failed to sync config to DB after reload', err);
  }
}

export function startConfigWatcher(): void {
  const envPath = getEnvPath();

  // Snapshot current mtime so the first poll doesn't fire as a change
  try {
    lastMtime = fs.statSync(envPath).mtimeMs;
  } catch {
    lastMtime = Date.now();
  }

  setInterval(() => {
    try {
      const stat = fs.statSync(envPath);
      if (stat.mtimeMs > lastMtime) {
        lastMtime = stat.mtimeMs;
        dotenv.config({ path: envPath, override: true });
        syncConfigToDb();
        resetClient(); // force new OpenAI client with updated key
        configEvents.emit('change');
        logger.info('.env changed — config reloaded and client reset');
      }
    } catch {
      // .env missing or unreadable — skip silently
    }
  }, 2000);

  logger.info('Config watcher started (polling .env every 2 s)');
}
