// src/standards/freshness.ts
//
// Boot-time freshness guard for the indexed standards library.
// Warns if standards/index.yml references missing files or if a standards/*.md
// file lacks an index entry. Primary guard (CI secondary, origin push broken).

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { logger } from '../utils/logger';

const STANDARDS_DIR = path.resolve(process.cwd(), 'standards');
const INDEX_PATH = path.join(STANDARDS_DIR, 'index.yml');

interface StandardEntry {
  id?: string;
  path?: string;
  always_on?: boolean;
  tags?: string[];
}

export function checkStandardsFreshness(): void {
  try {
    if (!fs.existsSync(INDEX_PATH)) {
      logger.warn('standards freshness: index.yml not found');
      return;
    }

    const raw = fs.readFileSync(INDEX_PATH, 'utf8');
    const index = YAML.parse(raw) as { standards?: StandardEntry[] };
    const entries = Array.isArray(index.standards) ? index.standards : [];

    const indexedPaths = new Set<string>();
    const indexedIds = new Set<string>();
    const missingFiles: string[] = [];

    for (const entry of entries) {
      if (!entry || !entry.path) continue;
      indexedPaths.add(entry.path);
      if (entry.id) indexedIds.add(entry.id);

      const abs = path.resolve(process.cwd(), entry.path);
      if (!fs.existsSync(abs)) {
        missingFiles.push(entry.path);
      }
    }

    const allFiles = fs.readdirSync(STANDARDS_DIR)
      .filter(f => f.endsWith('.md') && !f.startsWith('_'))
      .map(f => `standards/${f}`);

    const unindexedFiles = allFiles.filter(f => !indexedPaths.has(f));

    if (missingFiles.length > 0) {
      logger.warn('standards freshness: index.yml references missing files', { files: missingFiles });
    }
    if (unindexedFiles.length > 0) {
      logger.warn('standards freshness: markdown files lack index.yml entries', { files: unindexedFiles });
    }
    if (missingFiles.length === 0 && unindexedFiles.length === 0) {
      logger.info(`standards freshness: ${entries.length} entries, all files accounted for`);
    }
  } catch (err) {
    logger.warn('standards freshness check failed', { err: (err as Error).message });
  }
}
