import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDashboardHTML } from './html';
import { registerApiRoutes } from './routes';
import { startConfigWatcher } from '../system/config-watcher';
import { startCleanupScheduler } from '../system/cleanup';
import { startCatalogRefresh } from '../system/model-catalog';

// TODO [Discord bot]: Replace or augment this server with a Discord.js client
// TODO [MCP bridge]: Mount an MCP server alongside Hono for IDE tool integration
// TODO [LiveKit]: Initialise a LiveKit room server connection here

const app = new Hono();

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
// Token-guard the HTML and the JSX/asset paths.
const v2Guard = async (c: import('hono').Context, next: () => Promise<void>) => {
  const token = c.req.query('token') ?? c.req.header('x-dashboard-token') ?? '';
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
    const html = fs.readFileSync(path.join(V2_ROOT, 'NeuroClaw.html'), 'utf-8');
    return c.html(html);
  } catch (err) {
    return c.text(`v2 not found: ${(err as Error).message}`, 500);
  }
});

// Static assets for v2 — JSX + uploads. rewriteRequestPath strips the
// /dashboard-v2 prefix so serveStatic resolves files relative to V2_ROOT.
app.use('/dashboard-v2/*', serveStatic({
  root: 'src/dashboard/v2',
  rewriteRequestPath: (p) => p.replace(/^\/dashboard-v2/, ''),
}));

registerApiRoutes(app);

// Redirect root → dashboard
app.get('/', (c) => c.redirect(`/dashboard?token=${config.dashboard.token}`));

serve({ fetch: app.fetch, port: config.dashboard.port, hostname: '127.0.0.1' }, (info) => {
  logger.info(`Dashboard → http://localhost:${info.port}/dashboard?token=${config.dashboard.token}`);
  startConfigWatcher();
  startCleanupScheduler();
  startCatalogRefresh();
});
