/**
 * broker/nameParser.ts — naming convention parser (spec v3 §5).
 *
 *     <SCOPE>_<SERVICE>_<TYPE>
 *
 *   - SCOPE   = SHARED | NEUROCLAW | <AGENT_CANONICAL> | <any UPPER_SNAKE>
 *   - SERVICE = third-party service identifier
 *   - TYPE    = PAT | KEY | TOKEN | SECRET | PASSWORD | URL | CUSTOM | <any UPPER_SNAKE>
 *
 * The full name is the access policy — no separate ACL table.
 */
import type { ParsedSecretName } from './types';

/** Suggested credential types — not an exhaustive allowlist; any UPPER_SNAKE_CASE is accepted. */
export const ALLOWED_TYPES = ['PAT', 'KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'URL', 'CUSTOM'] as const;
export type SecretType = string;

// Accepts any UPPER_SNAKE_CASE type suffix (not just the suggested list).
const NAME_RE = /^([A-Z][A-Z0-9_]*?)_([A-Z][A-Z0-9_]*?)_([A-Z][A-Z0-9_]*)$/;

/** Parse a secret name into `{ scope, service, type }`. Returns null on bad shape. */
export function parseName(name: string): ParsedSecretName | null {
  if (typeof name !== 'string') return null;
  const m = name.match(NAME_RE);
  if (!m) return null;
  return { scope: m[1], service: m[2], type: m[3], raw: name };
}

/** Normalise a raw display name to a canonical agent prefix. */
export function normalizeAgentPrefix(input: string): string {
  return String(input ?? '')
    .replace(/\./g, '')
    .replace(/\s+/g, '_')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '');
}

/** Strict validator for UPPER_SNAKE_CASE. */
export function isValidUpperSnake(input: string): boolean {
  return /^[A-Z][A-Z0-9_]*[A-Z0-9]$|^[A-Z]$/.test(input);
}

/** Any UPPER_SNAKE_CASE value is a valid type — ALLOWED_TYPES is just the suggested list. */
export function isAllowedType(input: string): input is SecretType {
  return isValidUpperSnake(input);
}

/** Compose a `SCOPE_SERVICE_TYPE` name from form fields. Null on bad input. */
export function buildName(scope: string, service: string, type: string): string | null {
  const normScope = normalizeAgentPrefix(scope);
  const normService = normalizeAgentPrefix(service);
  const normType = normalizeAgentPrefix(type);
  if (!isValidUpperSnake(normScope) || !isValidUpperSnake(normService)) return null;
  if (!isAllowedType(normType)) return null;
  return `${normScope}_${normService}_${normType}`;
}

/** Tiny glob (`*`, `?`) — anything fancier is out of scope. */
export function globMatch(name: string, pattern: string): boolean {
  if (!pattern) return true;
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return re.test(name);
}
