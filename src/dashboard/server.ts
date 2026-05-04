import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDashboardHTML } from './html';
import { registerApiRoutes } from './routes';
import { handleMcpRequest } from './mcp-route';
import { ensureCodexMcpRegistered } from '../system/codex-config-writer';
import { startDiscordBotManager } from '../integrations/discord-bot';
import { startConfigWatcher } from '../system/config-watcher';
import { startCleanupScheduler } from '../system/cleanup';
import { startCatalogRefresh } from '../system/model-catalog';
import { seedDefaultAreas } from '../db';
import { startDreamScheduler } from '../memory/dream-cycle';
import { startHeartbeatScheduler } from '../system/heartbeat';
import { probeAll as probeMcpServers } from '../mcp/mcp-registry';

// TODO [Discord bot]: Replace or augment this server with a Discord.js client
// TODO [MCP bridge]: Mount an MCP server alongside Hono for IDE tool integration
// TODO [LiveKit]: Initialise a LiveKit room server connection here

const app = new Hono<{ Bindings: HttpBindings }>();

// Token guard for /dashboard route
app.use('/dashboard', async (c, next) => {
  const token = c.req.query('token') ?? '';
  if (token !== config.dashboard.token) {
    return c.text('Unauthorized — append ?token=<your-token> to the URL', 401);
  }
  await next();
});

app.get('/dashboard', (c) => c.html(getDashboardHTML()));

// ── v2 dashboard (design-driven, React + Babel via CDN) ──────────────────
// Token-guard accepts ?token query, x-dashboard-token header, OR a
// dashboard-token cookie set when the HTML is served. The cookie keeps
// script-tag fetches (relative .jsx imports) authenticated automatically.
const v2Guard = async (c: import('hono').Context, next: () => Promise<void>) => {
  const cookie = c.req.header('cookie') ?? '';
  const cookieToken = /(?:^|;\s*)dashboard-token=([^;]+)/.exec(cookie)?.[1];
  const token = c.req.query('token') ?? c.req.header('x-dashboard-token') ?? cookieToken ?? '';
  if (token !== config.dashboard.token) {
    return c.text('Unauthorized — append ?token=<your-token> to the URL', 401);
  }
  await next();
};
app.use('/dashboard-v2',   v2Guard);
app.use('/dashboard-v2/*', v2Guard);

const V2_ROOT = path.resolve(process.cwd(), 'src/dashboard/v2');

app.get('/dashboard-v2', (c) => {
  try {
    let html = fs.readFileSync(path.join(V2_ROOT, 'NeuroClaw.html'), 'utf-8');
    // Inject <base> so relative script srcs (src/icons.jsx, etc) resolve under /dashboard-v2/.
    html = html.replace('<head>', '<head>\n<base href="/dashboard-v2/">');
    // Set a session cookie so the .jsx fetches authenticate without ?token in the script tags.
    c.header('Set-Cookie', `dashboard-token=${config.dashboard.token}; Path=/; HttpOnly; SameSite=Strict`);
    return c.html(html);
  } catch (err) {
    return c.text(`v2 not found: ${(err as Error).message}`, 500);
  }
});

// Static assets for v2 — JSX + uploads. rewriteRequestPath strips the
// /dashboard-v2 prefix so serveStatic resolves files relative to V2_ROOT.
// onFound runs after serveStatic resolves the file, so our headers stick.
app.use('/dashboard-v2/*', serveStatic({
  root: 'src/dashboard/v2',
  rewriteRequestPath: (p) => p.replace(/^\/dashboard-v2/, ''),
  onFound: (filepath, c) => {
    if (filepath.endsWith('.jsx')) {
      // Disable caching for JSX so browser always picks up our latest edits.
      c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
      c.header('Pragma',        'no-cache');
      c.header('Content-Type',  'application/javascript; charset=utf-8');
    }
  },
}));

registerApiRoutes(app);

// Streamable-HTTP MCP endpoint for external runtimes (Codex CLI, etc).
// Both POST (RPC requests) and GET (SSE response stream) are handled by the
// same transport on the same path.
app.all('/mcp', handleMcpRequest);

// Redirect root → dashboard
app.get('/', (c) => c.redirect(`/dashboard?token=${config.dashboard.token}`));

serve({ fetch: app.fetch, port: config.dashboard.port, hostname: '127.0.0.1' }, (info) => {
  logger.info(`Dashboard → http://localhost:${info.port}/dashboard?token=${config.dashboard.token}`);
  logger.info(`MCP HTTP  → http://localhost:${info.port}/mcp`);
  startConfigWatcher();
  startCleanupScheduler();
  startCatalogRefresh();
  seedDefaultAreas();
  startDreamScheduler();
  startHeartbeatScheduler();
  // Idempotently register our MCP server in ~/.codex/config.toml so Codex
  // sessions can discover NeuroClaw tools.
  ensureCodexMcpRegistered({ url: `http://127.0.0.1:${info.port}/mcp` })
    .catch((err: unknown) => logger.warn('codex MCP registration failed', { err: (err as Error).message }));
  // Multi-bot Discord manager — reads `discord_bots` table, spawns one
  // gateway client per enabled row, polls every 30s for adds/removes.
  startDiscordBotManager()
    .catch((err: unknown) => logger.warn('discord-bot manager failed to start', { err: (err as Error).message }));
  // MCP server registry — probe every enabled server once on boot, then
  // periodically refresh so the dashboard sees up-to-date status. Probe
  // failures are logged but never propagate.
  probeMcpServers(true).catch((err: unknown) => logger.warn('mcp registry initial probe failed', { err: (err as Error).message }));
  setInterval(() => {
    probeMcpServers(false).catch((err: unknown) => logger.warn('mcp registry probe tick failed', { err: (err as Error).message }));
  }, 60_000);
});
