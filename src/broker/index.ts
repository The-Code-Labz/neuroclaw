/**
 * broker/index.ts — public TypeScript API for in-process callers (spec v3 §6.4).
 *
 * In-process code NEVER mints HMAC tokens. Identity flows through
 * AsyncLocalStorage:
 *
 *   import { agentStore, broker } from './broker';
 *
 *   await agentStore.run({ agentName: 'Oracle', sessionId }, async () => {
 *     const repos = await broker.exec({
 *       purpose: 'list repos',
 *       secrets: ['ORACLE_GITHUB_PAT'],
 *       command: 'gh repo list --json name',
 *     });
 *   });
 *
 * If the caller is NOT inside `agentStore.run`, every helper throws
 * `no_agent_context`. This forces explicit identity at every call site.
 */
import { spawn } from 'child_process';
import { agentStore } from './agentToken';
import { resolveScope } from './scopeResolver';
import { getStorage } from './storage';
import { auditLog } from './audit';
import { scrubOutput } from './scrubber';
import { parseName } from './nameParser';

export { agentStore } from './agentToken';
export { mintAgentToken, verifyAgentToken } from './agentToken';

function requireCtx(): { agentName: string; sessionId: string } {
  const ctx = agentStore.getStore();
  if (!ctx) throw new Error('no_agent_context');
  return ctx;
}

export async function use(name: string, purpose = ''): Promise<string> {
  const { agentName, sessionId } = requireCtx();
  if (!resolveScope(agentName, name)) {
    auditLog({ event: 'use', agent: agentName, session_id: sessionId, secret_name: name, purpose, outcome: 'denied' });
    throw new Error('scope_denied');
  }
  const value = await getStorage().getValue(name);
  if (value === null) {
    auditLog({ event: 'use', agent: agentName, session_id: sessionId, secret_name: name, purpose, outcome: 'error', detail: 'not_found' });
    throw new Error('secret_not_found');
  }
  auditLog({ event: 'use', agent: agentName, session_id: sessionId, secret_name: name, purpose, outcome: 'ok' });
  return value;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ExecOpts {
  purpose: string;
  secrets: string[];
  command: string;
  timeoutMs?: number;
}

export async function exec(opts: ExecOpts): Promise<ExecResult> {
  const { agentName, sessionId } = requireCtx();
  const { purpose, secrets, command } = opts;
  const timeoutMs = Math.max(1000, Math.min(opts.timeoutMs ?? 30_000, 120_000));

  for (const name of secrets) {
    if (!resolveScope(agentName, name)) {
      auditLog({
        event: 'exec', agent: agentName, session_id: sessionId,
        secrets_requested: secrets, purpose, outcome: 'denied', detail: `denied_secret=${name}`,
      });
      throw new Error(`scope_denied:${name}`);
    }
  }

  const env: Record<string, string> = {};
  for (const name of secrets) {
    const v = await getStorage().getValue(name);
    if (v === null) throw new Error(`secret_not_found:${name}`);
    env[name] = v;
  }

  const start = Date.now();
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn('bash', ['-c', command], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);

    child.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('close', (code) => {
      clearTimeout(killer);
      const ss = scrubOutput(stdout, env);
      const se = scrubOutput(stderr, env);
      const durationMs = Date.now() - start;

      if (ss.triggered || se.triggered) {
        auditLog({
          event: 'scrub_triggered', agent: agentName, session_id: sessionId,
          secrets_requested: secrets, purpose, outcome: 'ok',
          detail: 'caller leaked a secret value into stdout/stderr',
        });
      }
      auditLog({
        event: 'exec', agent: agentName, session_id: sessionId,
        secrets_requested: secrets, purpose, outcome: 'ok',
        detail: `exit=${code} duration_ms=${durationMs}`,
      });

      resolve({ exitCode: code ?? -1, stdout: ss.scrubbed, stderr: se.scrubbed, durationMs });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      auditLog({
        event: 'exec', agent: agentName, session_id: sessionId,
        secrets_requested: secrets, purpose, outcome: 'error', detail: err.message,
      });
      reject(err);
    });
  });
}

export async function withSecrets<T>(
  names: string[],
  fn: (env: Record<string, string>) => Promise<T> | T,
): Promise<T> {
  const { agentName, sessionId } = requireCtx();
  for (const name of names) {
    if (!resolveScope(agentName, name)) throw new Error(`scope_denied:${name}`);
  }
  const env: Record<string, string> = {};
  for (const name of names) {
    const v = await getStorage().getValue(name);
    if (v === null) throw new Error(`secret_not_found:${name}`);
    env[name] = v;
  }
  auditLog({
    event: 'use', agent: agentName, session_id: sessionId,
    secrets_requested: names, purpose: 'withSecrets', outcome: 'ok',
  });
  return await fn(env);
}

export interface SearchFilter {
  owner?: string;
  service?: string;
  pattern?: string;
  tags?: string[];
}

export async function search(filter: SearchFilter = {}): Promise<Array<{
  name: string; scope: string; service: string; type: string;
  tags: string[]; created: string; rotated: string;
}>> {
  const { agentName, sessionId } = requireCtx();
  const all = await getStorage().list();
  const out = [] as Array<{ name: string; scope: string; service: string; type: string; tags: string[]; created: string; rotated: string }>;
  for (const sec of all) {
    if (!resolveScope(agentName, sec.name)) continue;
    const parsed = parseName(sec.name);
    if (!parsed) continue;
    if (filter.owner && parsed.scope !== filter.owner.toUpperCase()) continue;
    if (filter.service && parsed.service.toLowerCase() !== filter.service.toLowerCase()) continue;
    if (filter.tags && filter.tags.length > 0 && !filter.tags.every((t) => sec.tags.includes(t))) continue;
    out.push({
      name: sec.name, scope: parsed.scope, service: parsed.service, type: parsed.type,
      tags: sec.tags, created: sec.createdAt, rotated: sec.updatedAt,
    });
  }
  auditLog({ event: 'search', agent: agentName, session_id: sessionId, outcome: 'ok', detail: `returned=${out.length}` });
  return out;
}

export const broker = { use, exec, withSecrets, search };
