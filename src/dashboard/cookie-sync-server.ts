/**
 * cookie-sync-server.ts
 *
 * A lightweight HTTP server (separate from the main dashboard) that accepts
 * cookie payloads from the AI Cookie Sync Chrome extension and writes them as
 * Playwright storage_state.json files so any CLI tool that relies on browser
 * auth (notebooklm-py, etc.) stays fresh automatically.
 *
 * Listens on 0.0.0.0 (publicly reachable) because the extension runs on the
 * user's local machine, not the server. Token-protected via the same
 * DASHBOARD_TOKEN used by the main dashboard.
 *
 * ── Adding a new service ──────────────────────────────────────────────────────
 * 1. Add an entry to SERVICE_PATHS below mapping your service id → file path.
 * 2. Add the matching entry to SERVICES in the extension's background.js.
 * 3. Add host_permissions in extension/manifest.json.
 * 4. Restart the dashboard server. Done.
 */

import fs   from 'fs';
import path from 'path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { config } from '../config';
import { logger } from '../utils/logger';

// ── Service registry ──────────────────────────────────────────────────────────
// Maps extension service id → absolute path for the storage_state.json file.
// Add new services here when you add them to the extension.

const SERVICE_PATHS: Record<string, string> = {
  notebooklm: '/root/.notebooklm/storage_state.json',
  gemini:     '/root/.gemini/storage_state.json',
  grok:       '/root/.grok/storage_state.json',
  chatgpt:    '/root/.chatgpt/storage_state.json',
  venice:     '/root/.venice/storage_state.json',
};

// ── Chrome → Playwright cookie conversion ─────────────────────────────────────

type PlaywrightSameSite = 'Strict' | 'Lax' | 'None';

interface ChromeCookie {
  name:            string;
  value:           string;
  domain:          string;
  path?:           string;
  expirationDate?: number;
  session?:        boolean;
  httpOnly?:       boolean;
  secure?:         boolean;
  sameSite?:       string;
}

interface PlaywrightCookie {
  name:     string;
  value:    string;
  domain:   string;
  path:     string;
  expires:  number;
  httpOnly: boolean;
  secure:   boolean;
  sameSite: PlaywrightSameSite;
}

function mapSameSite(raw: string | undefined): PlaywrightSameSite {
  const map: Record<string, PlaywrightSameSite> = {
    no_restriction: 'None',
    unspecified:    'None',
    lax:            'Lax',
    strict:         'Strict',
  };
  return map[(raw ?? '').toLowerCase()] ?? 'None';
}

function toPlaywright(cookies: ChromeCookie[]): PlaywrightCookie[] {
  return cookies.map((c) => ({
    name:     c.name,
    value:    c.value,
    domain:   c.domain,
    path:     c.path ?? '/',
    expires:  c.session || !c.expirationDate ? -1 : Math.floor(c.expirationDate),
    httpOnly: c.httpOnly ?? false,
    secure:   c.secure   ?? false,
    sameSite: mapSameSite(c.sameSite),
  }));
}

// ── Server ────────────────────────────────────────────────────────────────────

export function startCookieSyncServer(): void {
  const port  = parseInt(process.env.COOKIE_SYNC_PORT ?? '3143', 10);
  const token = config.dashboard.token; // reuse the dashboard token

  const app = new Hono();

  // Allow Chrome extension requests (origin is chrome-extension://<id>)
  app.use('*', cors({
    origin:         '*',
    allowMethods:   ['GET', 'POST', 'OPTIONS'],
    allowHeaders:   ['Content-Type', 'x-cookie-sync-token'],
    exposeHeaders:  [],
    maxAge:         600,
  }));

  // ── Health check (no auth — used by the extension settings "Test" button) ──
  app.get('/health', (c) => c.json({ ok: true, service: 'cookie-sync' }));

  // ── Token guard ────────────────────────────────────────────────────────────
  app.use('/sync', async (c, next) => {
    const tok = c.req.header('x-cookie-sync-token') ?? '';
    if (tok !== token) {
      logger.warn('cookie-sync: rejected request — bad token');
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // ── Cookie sync endpoint ───────────────────────────────────────────────────
  app.post('/sync', async (c) => {
    let body: { service?: string; cookies?: ChromeCookie[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { service, cookies } = body;

    if (!service || typeof service !== 'string') {
      return c.json({ error: 'Missing "service" field' }, 400);
    }
    if (!Array.isArray(cookies) || cookies.length === 0) {
      return c.json({ error: 'Missing or empty "cookies" array' }, 400);
    }

    const filePath = SERVICE_PATHS[service];
    if (!filePath) {
      return c.json({ error: `Unknown service "${service}". Add it to SERVICE_PATHS in cookie-sync-server.ts` }, 400);
    }

    // Ensure target directory exists
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    // Write Playwright storage_state
    const storageState = {
      cookies:  toPlaywright(cookies),
      origins:  [] as unknown[],
    };

    fs.writeFileSync(filePath, JSON.stringify(storageState, null, 2), 'utf-8');

    logger.info(`cookie-sync: wrote ${cookies.length} cookies for "${service}" → ${filePath}`);

    return c.json({ ok: true, service, count: cookies.length });
  });

  // ── Start ──────────────────────────────────────────────────────────────────
  serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
    logger.info(`cookie-sync: listening → http://0.0.0.0:${info.port}/sync`);
    logger.info(`cookie-sync: health   → http://0.0.0.0:${info.port}/health`);
  });
}
