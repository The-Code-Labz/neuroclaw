/**
 * broker/routes/agent.ts — agent-facing broker endpoints (spec v3 §8.1-§8.5).
 *
 * Mounted under `/api/broker/agent/*`. Auth is performed by
 * `agentAuthMiddleware` BEFORE these handlers, so every handler can rely on
 * `c.get('agentCtx')` returning a verified identity.
 *
 *   POST /search    — manifest discovery, scope-filtered
 *   POST /describe  — single-secret metadata
 *   POST /use       — fetch value (agent gets it)
 *   POST /exec      — broker injects + runs command, scrubs output
 *   POST /inject    — bulk env map (supervisor-only)
 */
import { Hono } from 'hono';
import { spawnCollect } from '../../system/spawn-collect';
import { auditLog } from '../audit';
import { resolveScope } from '../scopeResolver';
import { parseName, globMatch } from '../nameParser';
import { isRestrictedName } from '../restrictedSecrets';
import { getStorage } from '../storage';
import { scrubOutput } from '../scrubber';
import { config } from '../../config';
import { resolveWorkspace } from '../../system/workspace';

// Keys that must never be inherited by broker-spawned child processes.
// The broker's /exec route sees the full parent env (HMAC key, dashboard
// token, Infisical credentials) — strip them all before handing off.
const BROKER_EXEC_SCRUB_KEYS = [
  'NC_BROKER_HMAC_KEY', 'NC_AGENT_TOKEN',
  'DASHBOARD_TOKEN', 'VOIDAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'LANGFUSE_SECRET_KEY', 'LANGFUSE_PUBLIC_KEY',
  'NC_BROKER_INFISICAL_CLIENT_SECRET', 'NC_BROKER_INFISICAL_CLIENT_ID',
];

function buildBrokerExecEnv(
  injected: Record<string, string>,
  workspaceDir?: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of BROKER_EXEC_SCRUB_KEYS) delete env[k];
  if (workspaceDir) env.WORKSPACE_DIR = workspaceDir;
  return { ...env, ...injected };
}

const SUPERVISOR_IDENTITY = 'nc-supervisor';

export function buildAgentRoutes(): Hono {
  const r = new Hono();

  // ── /search ─────────────────────────────────────────────────────────────
  r.post('/search', async (c) => {
    const { agentName, sessionId } = c.get('agentCtx');
    const body = c.get('brokerBody') as {
      owner?: string;
      service?: string;
      pattern?: string;
      tags?: string[];
    };

    const all = await getStorage().list();
    const out: Array<{
      name: string; scope: string; service: string; type: string;
      tags: string[]; created: string; rotated: string;
    }> = [];

    for (const sec of all) {
      if (!resolveScope(agentName, sec.name)) continue;
      const parsed = parseName(sec.name);
      if (!parsed) continue;
      if (body.owner && parsed.scope !== body.owner.toUpperCase()) continue;
      if (body.service && parsed.service.toLowerCase() !== body.service.toLowerCase()) continue;
      if (body.pattern && !globMatch(sec.name, body.pattern)) continue;
      if (body.tags && body.tags.length > 0 && !body.tags.every((t) => sec.tags.includes(t))) continue;
      out.push({
        name: sec.name, scope: parsed.scope, service: parsed.service, type: parsed.type,
        tags: sec.tags, created: sec.createdAt, rotated: sec.updatedAt,
      });
    }

    auditLog({ event: 'search', agent: agentName, session_id: sessionId, outcome: 'ok', detail: `returned=${out.length}` });
    return c.json({ secrets: out });
  });

  // ── /describe ───────────────────────────────────────────────────────────
  r.post('/describe', async (c) => {
    const { agentName, sessionId } = c.get('agentCtx');
    const body = c.get('brokerBody') as { name?: string };
    const name = (body.name ?? '').trim();
    if (!name) return c.json({ error: 'name_required' }, 400);

    if (!resolveScope(agentName, name)) {
      auditLog({ event: 'describe', agent: agentName, session_id: sessionId, secret_name: name, outcome: 'denied' });
      return c.json({ error: 'scope_denied' }, 403);
    }

    const parsed = parseName(name);
    if (!parsed) return c.json({ error: 'invalid_name' }, 400);

    const all = await getStorage().list();
    const sec = all.find((s) => s.name === name);
    if (!sec) {
      auditLog({ event: 'describe', agent: agentName, session_id: sessionId, secret_name: name, outcome: 'error', detail: 'not_found' });
      return c.json({ error: 'not_found' }, 404);
    }

    auditLog({ event: 'describe', agent: agentName, session_id: sessionId, secret_name: name, outcome: 'ok' });
    return c.json({
      name: sec.name, scope: parsed.scope, service: parsed.service, type: parsed.type,
      tags: sec.tags, notes: sec.notes, created: sec.createdAt, rotated: sec.updatedAt,
    });
  });

  // ── /use ────────────────────────────────────────────────────────────────
  r.post('/use', async (c) => {
    const { agentName, sessionId } = c.get('agentCtx');
    const body = c.get('brokerBody') as { name?: string; purpose?: string };
    const name = (body.name ?? '').trim();
    const purpose = (body.purpose ?? '').trim();
    if (!name) return c.json({ error: 'name_required' }, 400);

    // Restricted secret class (§2.1 stack 3): the HTTP surface gets an UNCONDITIONAL
    // deny — no remote MCP/bridge consumer legitimately needs a raw SSH key, and the
    // Symbol capability cannot cross the network boundary. No capability accepted here.
    if (isRestrictedName(name)) {
      auditLog({ event: 'use', agent: agentName, session_id: sessionId, secret_name: name, purpose, outcome: 'denied', detail: 'secret_restricted' });
      return c.json({ error: 'secret_restricted' }, 403);
    }

    if (!resolveScope(agentName, name)) {
      auditLog({ event: 'use', agent: agentName, session_id: sessionId, secret_name: name, purpose, outcome: 'denied' });
      return c.json({ error: 'scope_denied' }, 403);
    }

    try {
      const value = await getStorage().getValue(name);
      if (value === null) {
        auditLog({ event: 'use', agent: agentName, session_id: sessionId, secret_name: name, purpose, outcome: 'error', detail: 'not_found' });
        return c.json({ error: 'not_found' }, 404);
      }
      auditLog({ event: 'use', agent: agentName, session_id: sessionId, secret_name: name, purpose, outcome: 'ok' });
      return c.json({ value });
    } catch (err) {
      auditLog({ event: 'use', agent: agentName, session_id: sessionId, secret_name: name, purpose, outcome: 'error', detail: (err as Error).message });
      return c.json({ error: 'fetch_failed' }, 500);
    }
  });

  // ── /exec ───────────────────────────────────────────────────────────────
  r.post('/exec', async (c) => {
    const { agentName, sessionId } = c.get('agentCtx');
    const body = c.get('brokerBody') as {
      secrets?: string[]; command?: string; purpose?: string; timeout_ms?: number;
    };
    const secrets = Array.isArray(body.secrets) ? body.secrets : [];
    const command = (body.command ?? '').trim();
    const purpose = (body.purpose ?? '').trim();
    const timeoutMs = Math.max(1000, Math.min(body.timeout_ms ?? 30_000, 120_000));

    if (!command) return c.json({ error: 'command_required' }, 400);

    for (const name of secrets) {
      // Restricted secret class (§2.1 stack 3): unconditional HTTP deny.
      if (isRestrictedName(name)) {
        auditLog({
          event: 'exec', agent: agentName, session_id: sessionId,
          secrets_requested: secrets, purpose, outcome: 'denied', detail: `secret_restricted=${name}`,
        });
        return c.json({ error: 'secret_restricted', secret: name }, 403);
      }
      if (!resolveScope(agentName, name)) {
        auditLog({
          event: 'exec', agent: agentName, session_id: sessionId,
          secrets_requested: secrets, purpose, outcome: 'denied', detail: `denied_secret=${name}`,
        });
        return c.json({ error: 'scope_denied', secret: name }, 403);
      }
    }

    const injected: Record<string, string> = {};
    for (const name of secrets) {
      const v = await getStorage().getValue(name);
      if (v === null) {
        auditLog({
          event: 'exec', agent: agentName, session_id: sessionId,
          secrets_requested: secrets, purpose, outcome: 'error', detail: `missing_secret=${name}`,
        });
        return c.json({ error: 'secret_not_found', secret: name }, 404);
      }
      injected[name] = v;
    }

    const OUTPUT_CAP = 200_000; // bytes — matches config.exec.outputMaxBytes default
    // Scope the broker's exec cwd into the agent's workspace too, so it isn't an
    // unscoped bypass of the workspace-scoping the in-process exec tools enforce.
    const workspaceDir = config.workspace.enabled
      ? resolveWorkspace(sessionId ?? null, agentName ?? null)
      : undefined;
    // Process-group-safe runner (shared with bash_run): spawns detached, resolves
    // on 'exit', kills the whole group on timeout/cleanup. Prevents the hang where
    // a backgrounded grandchild holds the pipe open and the request never returns.
    const res = await spawnCollect({
      command,
      cwd:            workspaceDir,
      env:            buildBrokerExecEnv(injected, workspaceDir),
      timeoutMs,
      outputCapBytes: OUTPUT_CAP,
      shellArgs:      ['-c'],
    });

    if (res.spawnError) {
      auditLog({
        event: 'exec', agent: agentName, session_id: sessionId,
        secrets_requested: secrets, purpose, outcome: 'error', detail: res.spawnError,
      });
      return c.json({ error: 'spawn_failed', detail: res.spawnError }, 500);
    }

    const ss = scrubOutput(res.stdout, injected);
    const se = scrubOutput(res.stderr, injected);
    const durationMs = res.durationMs;

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
      detail: `exit=${res.code} duration_ms=${durationMs} truncated=${res.truncated} timed_out=${res.timedOut}`,
    });
    return c.json({
      exit_code: res.code ?? -1,
      stdout: ss.scrubbed, stderr: se.scrubbed,
      duration_ms: durationMs, truncated: res.truncated,
    });
  });

  // ── /inject (supervisor-only) ──────────────────────────────────────────
  r.post('/inject', async (c) => {
    const { agentName, sessionId } = c.get('agentCtx');
    const body = c.get('brokerBody') as { target_mcp?: string; secrets?: string[] };

    if (agentName !== SUPERVISOR_IDENTITY) {
      auditLog({
        event: 'inject', agent: agentName, session_id: sessionId,
        outcome: 'denied', detail: 'not_supervisor', target_mcp: body.target_mcp,
      });
      return c.json({ error: 'supervisor_only' }, 403);
    }

    const targetMcp = (body.target_mcp ?? '').trim();
    const secrets = Array.isArray(body.secrets) ? body.secrets : [];
    if (!targetMcp || secrets.length === 0) return c.json({ error: 'invalid_request' }, 400);
    if (secrets.length > 50) return c.json({ error: 'too_many_secrets', max: 50 }, 400);

    // Restricted secret class (§2.1 stack 3): unconditional HTTP deny. `/inject`
    // bypasses resolveScope entirely, so this guard is its ONLY restricted check.
    for (const name of secrets) {
      if (isRestrictedName(name)) {
        auditLog({
          event: 'inject', agent: agentName, session_id: sessionId,
          target_mcp: targetMcp, secrets_requested: secrets, outcome: 'denied', detail: `secret_restricted=${name}`,
        });
        return c.json({ error: 'secret_restricted', secret: name }, 403);
      }
    }

    auditLog({
      event: 'inject_call', agent: agentName, session_id: sessionId,
      target_mcp: targetMcp, secrets_requested: secrets,
      supervisor_pid: process.pid, outcome: 'pending',
    });

    const env: Record<string, string> = {};
    const failed: string[] = [];
    for (const name of secrets) {
      try {
        const v = await getStorage().getValue(name);
        if (v === null) failed.push(name);
        else env[name] = v;
      } catch { failed.push(name); }
    }

    if (failed.length > 0) {
      auditLog({
        event: 'inject', agent: agentName, session_id: sessionId,
        target_mcp: targetMcp, secrets_requested: secrets,
        outcome: 'error', detail: `missing=${failed.join(',')}`,
      });
      return c.json({ error: 'secret_fetch_failed', failed }, 500);
    }

    auditLog({
      event: 'inject', agent: agentName, session_id: sessionId,
      target_mcp: targetMcp, secrets_requested: secrets, outcome: 'ok',
    });
    return c.json({ env });
  });

  return r;
}
