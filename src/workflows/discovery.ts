import path from 'path';
import os from 'os';
import fs from 'fs';
import { tryLoadWorkflow, isLoadError, type LoadWorkflowResult } from './loader';
import { logger } from '../utils/logger';

const log = logger;

const BUNDLED_DIR = path.join(__dirname, 'defaults');
const USER_DIR = path.join(os.homedir(), '.nclaw', 'workflows');

/**
 * Load all workflows from bundled and user directories.
 * User workflows override bundled workflows with the same name.
 */
export function discoverWorkflows(): Map<string, LoadWorkflowResult> {
  const map = new Map<string, LoadWorkflowResult>();

  for (const result of loadDir(BUNDLED_DIR, 'bundled')) {
    map.set(result.workflow.name, result);
  }
  for (const result of loadDir(USER_DIR, 'user')) {
    map.set(result.workflow.name, result); // overrides bundled
  }

  return map;
}

/**
 * Find a workflow by name (exact, then case-insensitive, then suffix match).
 */
export function findWorkflow(name: string): LoadWorkflowResult | null {
  const all = discoverWorkflows();

  // Exact match
  if (all.has(name)) return all.get(name)!;

  // Case-insensitive
  const lower = name.toLowerCase();
  for (const [k, v] of all) {
    if (k.toLowerCase() === lower) return v;
  }

  // Suffix match (e.g. "review" matches "code-review")
  for (const [k, v] of all) {
    if (k.toLowerCase().endsWith(lower)) return v;
  }

  return null;
}

function loadDir(dir: string, source: 'bundled' | 'user'): LoadWorkflowResult[] {
  if (!fs.existsSync(dir)) return [];
  const results: LoadWorkflowResult[] = [];
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  for (const file of files) {
    const result = tryLoadWorkflow(path.join(dir, file), source);
    if (isLoadError(result)) {
      log.warn('workflow.loadError', { file, error: result.error });
    } else {
      results.push(result);
    }
  }
  return results;
}
