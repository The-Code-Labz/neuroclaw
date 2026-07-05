/**
 * broker/routes/admin.ts — dashboard-facing broker endpoints (spec v3 §8.6-§8.9).
 *
 * Mounted under `/api/broker/admin/*`. Auth piggybacks on the dashboard token
 * via the existing `app.use('/api/*')` middleware in `dashboard/routes.ts` —
 * a separate Bearer/HMAC token is NOT required for admin paths.
 */
import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { auditLog, getRecentAudit, queryAudit } from '../audit';
import { parseName, isValidUpperSnake, isAllowedType, normalizeAgentPrefix } from '../nameParser';
import { getStorage } from '../storage';
import {
  listAgentPrefixes,
  setCanonicalPrefix,
  getAgentRowByName,
} from '../agentRegistry';
import { mintAgentToken } from '../agentToken';
import { getStorageBackend } from '../bootstrap';
import { InfisicalAdapter } from '../storage-infisical';

const DASHBOARD_AGENT = 'dashboard';

async function readBody(c: import('hono').Context): Promise<Record<string, unknown>> {
  try { return await c.req.json<Record<string, unknown>>(); } catch { return {}; }
}

export function buildAdminRoutes(): Hono {
  const r = new Hono();

  r.post('/list', async (c) => {
    const all = await getStorage().list();
    const grouped: Record<string, Array<{
      name: string; scope: string; service: string; type: string;
      tags: string[]; notes: string; created: string; rotated: string; managed: boolean;
    }>> = {};
    const orphans: Array<{ name: string; reason: string; tags: string[] }> = [];

    for (const sec of all) {
      const parsed = parseName(sec.name);
      if (!parsed) {
        orphans.push({ name: sec.name, reason: 'naming_convention', tags: sec.tags });
        continue;
      }
      const bucket = parsed.scope;
      if (!grouped[bucket]) grouped[bucket] = [];
      grouped[bucket].push({
        name: sec.name, scope: parsed.scope, service: parsed.service, type: parsed.type,
        tags: sec.tags, notes: sec.notes, created: sec.createdAt, rotated: sec.updatedAt, managed: true,
      });
    }

    auditLog({ event: 'admin_list', agent: DASHBOARD_AGENT, session_id: 'dashboard', outcome: 'ok' });
    return c.json({ grouped, orphans });
  });

  r.post('/reveal', async (c) => {
    const body = await readBody(c);
    const name = String(body.name ?? '').trim();
    const purpose = String(body.purpose ?? 'dashboard reveal').trim();
    if (!name) return c.json({ error: 'name_required' }, 400);
    if (!parseName(name)) return c.json({ error: 'invalid_name' }, 400);

    const value = await getStorage().getValue(name);
    if (value === null) {
      auditLog({ event: 'admin_reveal', agent: DASHBOARD_AGENT, session_id: 'dashboard', secret_name: name, purpose, outcome: 'error', detail: 'not_found' });
      return c.json({ error: 'not_found' }, 404);
    }
    auditLog({ event: 'admin_reveal', agent: DASHBOARD_AGENT, session_id: 'dashboard', secret_name: name, purpose, outcome: 'ok' });
    return c.json({ name, value });
  });

  r.post('/create', async (c) => {
    const body = await readBody(c);
    const name = String(body.name ?? '').trim();
    const value = String(body.value ?? '');
    const tags = Array.isArray(body.tags) ? (body.tags as string[]).map(String) : [];
    const notes = String(body.notes ?? '');

    const parsed = parseName(name);
    if (!parsed) {
      return c.json({ error: 'invalid_name', detail: 'name must be SCOPE_SERVICE_TYPE in UPPER_SNAKE_CASE' }, 400);
    }
    if (!value) return c.json({ error: 'value_required' }, 400);

    try {
      await getStorage().create(name, value, { tags, notes });
      auditLog({ event: 'create', agent: DASHBOARD_AGENT, session_id: 'dashboard', secret_name: name, outcome: 'ok' });
      return c.json({ ok: true, name });
    } catch (err) {
      const msg = (err as Error).message;
      auditLog({ event: 'create', agent: DASHBOARD_AGENT, session_id: 'dashboard', secret_name: name, outcome: 'error', detail: msg });
      const status = msg.startsWith('secret_already_exists') ? 409 : 500;
      return c.json({ error: msg }, status);
    }
  });

  r.post('/update', async (c) => {
    const body = await readBody(c);
    const name = String(body.name ?? '').trim();
    if (!name) return c.json({ error: 'name_required' }, 400);
    if (!parseName(name)) return c.json({ error: 'invalid_name' }, 400);

    const updates: { value?: string; tags?: string[]; notes?: string } = {};
    if (typeof body.value === 'string') updates.value = body.value;
    if (Array.isArray(body.tags)) updates.tags = (body.tags as string[]).map(String);
    if (typeof body.notes === 'string') updates.notes = body.notes as string;

    try {
      await getStorage().update(name, updates);
      auditLog({ event: 'update', agent: DASHBOARD_AGENT, session_id: 'dashboard', secret_name: name, outcome: 'ok' });
      return c.json({ ok: true });
    } catch (err) {
      const msg = (err as Error).message;
      auditLog({ event: 'update', agent: DASHBOARD_AGENT, session_id: 'dashboard', secret_name: name, outcome: 'error', detail: msg });
      return c.json({ error: msg }, 500);
    }
  });

  r.post('/delete', async (c) => {
    const body = await readBody(c);
    const name = String(body.name ?? '').trim();
    if (!name) return c.json({ error: 'name_required' }, 400);
    if (!parseName(name)) return c.json({ error: 'invalid_name' }, 400);

    try {
      await getStorage().delete(name);
      auditLog({ event: 'delete', agent: DASHBOARD_AGENT, session_id: 'dashboard', secret_name: name, outcome: 'ok' });
      return c.json({ ok: true });
    } catch (err) {
      const msg = (err as Error).message;
      auditLog({ event: 'delete', agent: DASHBOARD_AGENT, session_id: 'dashboard', secret_name: name, outcome: 'error', detail: msg });
      return c.json({ error: msg }, 500);
    }
  });

  r.post('/rotate', async (c) => {
    const body = await readBody(c);
    const name = String(body.name ?? '').trim();
    const newValue = typeof body.value === 'string' ? (body.value as string) : undefined;
    if (!name) return c.json({ error: 'name_required' }, 400);

    try {
      await getStorage().rotate(name, newValue);
      auditLog({ event: 'rotate', agent: DASHBOARD_AGENT, session_id: 'dashboard', secret_name: name, outcome: 'ok' });
      return c.json({ ok: true });
    } catch (err) {
      const msg = (err as Error).message;
      auditLog({ event: 'rotate', agent: DASHBOARD_AGENT, session_id: 'dashboard', secret_name: name, outcome: 'error', detail: msg });
      return c.json({ error: msg }, 500);
    }
  });

  r.get('/audit', (c) => {
    const limit = Number(c.req.query('limit') ?? '100');
    const agent = c.req.query('agent') ?? undefined;
    const event = (c.req.query('event') ?? undefined) as
      | undefined
      | 'use' | 'exec' | 'search' | 'describe' | 'inject' | 'inject_call'
      | 'create' | 'update' | 'delete' | 'rotate'
      | 'admin_list' | 'admin_reveal' | 'scrub_triggered';
    const since = c.req.query('since') ?? undefined;
    const source = c.req.query('source') ?? 'disk';
    const rows = source === 'memory' ? getRecentAudit(limit) : queryAudit({ limit, agent, event, since });
    return c.json({ rows });
  });

  r.get('/agents', (c) => c.json({ agents: listAgentPrefixes() }));

  r.post('/agents/prefix', async (c) => {
    const body = await readBody(c);
    const agentId = String(body.agent_id ?? '').trim();
    const prefixRaw = body.prefix === null ? null : String(body.prefix ?? '').trim();
    if (!agentId) return c.json({ error: 'agent_id_required' }, 400);

    try {
      setCanonicalPrefix(agentId, prefixRaw);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  r.post('/mint-token', async (c) => {
    const body = await readBody(c);
    const agentName = String(body.agent ?? '').trim();
    const ttl = Math.max(5, Math.min(Number(body.ttl_sec ?? 30), 300));
    if (!agentName) return c.json({ error: 'agent_required' }, 400);

    if (agentName !== 'nc-supervisor' && !getAgentRowByName(agentName)) {
      return c.json({ error: 'unknown_agent' }, 404);
    }

    const token = mintAgentToken(agentName, randomUUID(), ttl);
    return c.json({ token, expires_in: ttl });
  });

  // ── /storage — current backend + health ────────────────────────────────
  r.get('/storage', async (c) => {
    const backend = getStorageBackend();
    const out: {
      backend: 'env-manager' | 'infisical';
      siteUrl?: string;
      ok: boolean;
      detail: string;
      secretCount?: number;
    } = { backend, ok: false, detail: '' };

    const adapter = getStorage();
    if (backend === 'infisical' && adapter instanceof InfisicalAdapter) {
      out.siteUrl = (process.env.NC_BROKER_INFISICAL_SITE_URL ?? 'http://127.0.0.1:8222');
      const r2 = await adapter.ping();
      if (r2.ok) {
        out.ok = true;
        out.detail = `connected (${r2.secretCount} secret${r2.secretCount === 1 ? '' : 's'})`;
        out.secretCount = r2.secretCount;
      } else {
        out.ok = false;
        out.detail = `health probe failed: ${r2.error}`;
      }
    } else {
      // env-manager is always "ok" — it's just file I/O.
      out.ok = true;
      out.detail = 'secrets stored in .env (no encryption-at-rest)';
    }
    return c.json(out);
  });

  r.post('/name/preview', async (c) => {
    const body = await readBody(c);
    const scope = normalizeAgentPrefix(String(body.scope ?? ''));
    const service = normalizeAgentPrefix(String(body.service ?? ''));
    const type = String(body.type ?? '').toUpperCase();

    const errors: string[] = [];
    if (!isValidUpperSnake(scope)) errors.push('scope_invalid');
    if (!isValidUpperSnake(service)) errors.push('service_invalid');
    if (!isAllowedType(type)) errors.push('type_invalid');

    const name = errors.length === 0 ? `${scope}_${service}_${type}` : '';
    let collision = false;
    if (name) {
      const all = await getStorage().list();
      collision = all.some((s) => s.name === name);
    }
    return c.json({ name, errors, collision });
  });

  return r;
}
