import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDashboardHTML } from './html';
import { registerApiRoutes } from './routes';
import { startConfigWatcher } from '../system/config-watcher';

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

registerApiRoutes(app);

// Redirect root → dashboard
app.get('/', (c) => c.redirect(`/dashboard?token=${config.dashboard.token}`));

serve({ fetch: app.fetch, port: config.dashboard.port, hostname: '127.0.0.1' }, (info) => {
  logger.info(`Dashboard → http://localhost:${info.port}/dashboard?token=${config.dashboard.token}`);
  startConfigWatcher();
});
