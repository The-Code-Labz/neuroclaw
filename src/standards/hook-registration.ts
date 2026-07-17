// src/standards/hook-registration.ts
//
// Durable, tracked registration of the indexed-standards hook into Claude Code's
// machine-local settings.json. Mirrors the antigravity boot-time settings patcher
// pattern (src/providers/antigravity.ts). Idempotent; safe to call on every boot.

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

const SETTINGS_PATH = '/root/.claude/settings.json';
const HOOK_SCRIPT_PATH = '/home/neuroclaw-v1/scripts/standards-hook.js';
const NODE_BIN = '/usr/bin/node';
const EVENTS = ['SessionStart', 'UserPromptSubmit'] as const;

interface CommandHook {
  type: 'command';
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: CommandHook[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function buildStandardsHookEntry(): HookGroup {
  return {
    hooks: [
      {
        type: 'command',
        command: `"${NODE_BIN}" "${HOOK_SCRIPT_PATH}"`,
        timeout: 10,
      },
    ],
  };
}

function isStandardsHookEntry(group: HookGroup): boolean {
  return Array.isArray(group?.hooks) && group.hooks.some(
    (h) => typeof h?.command === 'string' && h.command.includes('standards-hook.js')
  );
}

/**
 * Idempotently register the standards hook in /root/.claude/settings.json.
 * Replaces any existing standards-hook entries (including broken worktree-path
 * registrations) with the canonical deploy path, and preserves all other hooks
 * such as the gsd-* entries.
 */
export function initStandardsHookRegistration(): void {
  try {
    let settings: ClaudeSettings = {};
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn('standards-hook: failed to read settings.json; starting fresh', { err: (err as Error).message });
      }
    }

    settings.hooks = settings.hooks || {};
    const before = JSON.stringify(settings, null, 2) + '\n';

    for (const event of EVENTS) {
      const list = settings.hooks[event] || [];
      const cleaned = list.filter((group) => !isStandardsHookEntry(group));
      cleaned.push(buildStandardsHookEntry());
      settings.hooks[event] = cleaned;
    }

    const after = JSON.stringify(settings, null, 2) + '\n';
    if (after === before) {
      logger.info('standards-hook: registration already correct', { path: SETTINGS_PATH });
      return;
    }

    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, after, 'utf8');
    logger.info('standards-hook: registered in Claude Code settings', { path: SETTINGS_PATH });
  } catch (err) {
    logger.warn('standards-hook: registration failed', { err: (err as Error).message });
  }
}
