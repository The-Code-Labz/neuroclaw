// Doctor check registry. Checks register themselves at import time via
// register(); the runner queries listChecks() with an optional scope filter.

import type { DoctorCheck, Scope } from './types';

const registered: DoctorCheck[] = [];

export function register(check: DoctorCheck): void {
  if (registered.some(c => c.id === check.id)) {
    throw new Error(`Doctor check id collision: ${check.id}`);
  }
  registered.push(check);
}

export function listChecks(scope?: string): DoctorCheck[] {
  if (!scope) return [...registered];
  return registered.filter(c => c.scope === (scope as Scope));
}

export function getCheck(id: string): DoctorCheck | undefined {
  return registered.find(c => c.id === id);
}

/** Test/dev only: wipe the registry. Not exported from index.ts. */
export function _resetRegistry(): void {
  registered.length = 0;
}
