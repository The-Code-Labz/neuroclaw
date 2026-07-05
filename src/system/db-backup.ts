/**
 * Database Backup System
 *
 * Automatic scheduled backups of neuroclaw.db with:
 * - Configurable retention (default: keep last 7 daily backups)
 * - Hot backup using SQLite's backup API (no downtime)
 * - Manual trigger via API
 * - Startup backup before any operations
 */

import fs from 'fs';
import path from 'path';
import { getDb, logAudit } from '../db';
import { logger } from '../utils/logger';

const BACKUP_DIR = path.join(process.cwd(), 'backups');
const DB_PATH = path.join(process.cwd(), 'neuroclaw.db');

export interface BackupConfig {
  /** Directory to store backups (default: ./backups) */
  backupDir: string;
  /** Number of backups to retain (default: 7) */
  retentionCount: number;
  /** Interval between backups in hours (default: 24) */
  intervalHours: number;
  /** Run backup on startup (default: true) */
  backupOnStartup: boolean;
}

const DEFAULT_CONFIG: BackupConfig = {
  backupDir: BACKUP_DIR,
  retentionCount: 7,
  intervalHours: 24,
  backupOnStartup: true,
};

export interface BackupResult {
  ok: boolean;
  filename?: string;
  filepath?: string;
  sizeBytes?: number;
  durationMs?: number;
  error?: string;
}

export interface BackupInfo {
  filename: string;
  filepath: string;
  sizeBytes: number;
  createdAt: Date;
}

/**
 * Ensure backup directory exists
 */
function ensureBackupDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info('db-backup: created backup dir', { dir });
  }
}

/**
 * Generate backup filename with timestamp
 */
function generateBackupFilename(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
  return `neuroclaw_${timestamp}.db`;
}

/**
 * Perform a hot backup using SQLite's backup API
 * This is safe to run while the database is in use
 */
export async function performBackup(config: Partial<BackupConfig> = {}): Promise<BackupResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();

  try {
    ensureBackupDir(cfg.backupDir);

    const filename = generateBackupFilename();
    const filepath = path.join(cfg.backupDir, filename);

    // Use better-sqlite3's backup API for hot backup. NOTE: db.backup() is
    // ASYNC (returns a Promise) — it MUST be awaited. Without the await, the
    // statSync below races the not-yet-written file → ENOENT → the whole
    // function throws and pruneOldBackups() never runs (backups pile up).
    const db = getDb();
    await db.backup(filepath);

    const stats = fs.statSync(filepath);
    const durationMs = Date.now() - startTime;

    logger.info('db-backup: completed', {
      filename,
      sizeBytes: stats.size,
      sizeMB: (stats.size / 1024 / 1024).toFixed(2),
      durationMs,
    });

    logAudit('db_backup_created', 'system', filename, {
      filepath,
      sizeBytes: stats.size,
      durationMs,
    });

    // Clean up old backups
    pruneOldBackups(cfg.backupDir, cfg.retentionCount);

    return {
      ok: true,
      filename,
      filepath,
      sizeBytes: stats.size,
      durationMs,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('db-backup: failed', { error: errorMsg });
    return {
      ok: false,
      error: errorMsg,
    };
  }
}

/**
 * Remove old backups beyond retention count
 */
function pruneOldBackups(backupDir: string, retentionCount: number): void {
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('neuroclaw_') && f.endsWith('.db'))
      .map(f => ({
        name: f,
        path: path.join(backupDir, f),
        mtime: fs.statSync(path.join(backupDir, f)).mtime,
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime()); // newest first

    if (files.length > retentionCount) {
      const toDelete = files.slice(retentionCount);
      for (const file of toDelete) {
        fs.unlinkSync(file.path);
        logger.info('db-backup: pruned old backup', { filename: file.name });
      }
      logAudit('db_backups_pruned', 'system', undefined, {
        deleted: toDelete.map(f => f.name),
        retained: retentionCount,
      });
    }
  } catch (err) {
    logger.warn('db-backup: failed to prune old backups', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * List all available backups
 */
export function listBackups(config: Partial<BackupConfig> = {}): BackupInfo[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!fs.existsSync(cfg.backupDir)) {
    return [];
  }

  try {
    return fs.readdirSync(cfg.backupDir)
      .filter(f => f.startsWith('neuroclaw_') && f.endsWith('.db'))
      .map(f => {
        const filepath = path.join(cfg.backupDir, f);
        const stats = fs.statSync(filepath);
        return {
          filename: f,
          filepath,
          sizeBytes: stats.size,
          createdAt: stats.mtime,
        };
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); // newest first
  } catch {
    return [];
  }
}

/**
 * Restore from a backup file
 * WARNING: This will overwrite the current database!
 */
export async function restoreBackup(backupFilename: string, config: Partial<BackupConfig> = {}): Promise<BackupResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const backupPath = path.join(cfg.backupDir, backupFilename);

  if (!fs.existsSync(backupPath)) {
    return { ok: false, error: `Backup file not found: ${backupFilename}` };
  }

  try {
    // First, create a backup of the current state
    const preRestoreBackup = await performBackup({ ...cfg, retentionCount: cfg.retentionCount + 1 });
    if (!preRestoreBackup.ok) {
      return { ok: false, error: `Failed to create pre-restore backup: ${preRestoreBackup.error}` };
    }

    // Copy the backup over the current database
    // Note: The database connection should be closed before this
    fs.copyFileSync(backupPath, DB_PATH);

    logger.info('db-backup: restored from backup', { from: backupFilename });
    logAudit('db_backup_restored', 'system', backupFilename, {
      preRestoreBackup: preRestoreBackup.filename,
    });

    return {
      ok: true,
      filename: backupFilename,
      filepath: backupPath,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('db-backup: restore failed', { error: errorMsg, backup: backupFilename });
    return { ok: false, error: errorMsg };
  }
}

/**
 * Get backup system status
 */
export function getBackupStatus(config: Partial<BackupConfig> = {}): {
  enabled: boolean;
  lastBackup: BackupInfo | null;
  backupCount: number;
  totalSizeBytes: number;
  nextBackupAt: string | null;
  retentionCount: number;
  intervalHours: number;
} {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const backups = listBackups(cfg);
  const lastBackup = backups.length > 0 ? backups[0] : null;
  const totalSize = backups.reduce((sum, b) => sum + b.sizeBytes, 0);

  // Calculate next backup time
  let nextBackupAt: string | null = null;
  if (backupTimer && lastBackup) {
    const nextTime = new Date(lastBackup.createdAt.getTime() + cfg.intervalHours * 60 * 60 * 1000);
    nextBackupAt = nextTime.toISOString();
  }

  return {
    enabled: backupTimer !== null,
    lastBackup,
    backupCount: backups.length,
    totalSizeBytes: totalSize,
    nextBackupAt,
    retentionCount: cfg.retentionCount,
    intervalHours: cfg.intervalHours,
  };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let backupTimer: NodeJS.Timeout | null = null;

/**
 * Start the automatic backup scheduler
 */
export function startBackupScheduler(config: Partial<BackupConfig> = {}): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (backupTimer) {
    logger.warn('db-backup: scheduler already running — skipping duplicate start');
    return;
  }

  // Run backup on startup if configured (fire-and-forget — performBackup is
  // async and catches its own errors, so the promise never rejects).
  if (cfg.backupOnStartup) {
    void performBackup(cfg).then((result) => {
      if (result.ok) {
        logger.info('db-backup: startup backup completed', { filename: result.filename });
      }
    });
  }

  // Schedule periodic backups
  const intervalMs = cfg.intervalHours * 60 * 60 * 1000;
  backupTimer = setInterval(() => {
    void performBackup(cfg);
  }, intervalMs);

  logger.info('db-backup: scheduler started', {
    intervalHours: cfg.intervalHours,
    retentionCount: cfg.retentionCount,
    backupDir: cfg.backupDir,
  });
}

/**
 * Stop the backup scheduler
 */
export function stopBackupScheduler(): void {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
    logger.info('db-backup: scheduler stopped');
  }
}
