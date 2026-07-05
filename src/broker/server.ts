/**
 * broker/server.ts — wires broker routes into the existing Hono app.
 *
 * Two mount points (spec v3 §4):
 *
 *   /api/broker/agent/*   — agent endpoints, gated by HMAC Bearer token
 *   /api/broker/admin/*   — dashboard endpoints, gated by the existing
 *                            dashboard-token middleware in routes.ts
 *
 * The dashboard token middleware (`app.use('/api/*')`) already runs for both
 * mounts; the agent mount adds `agentAuthMiddleware` ON TOP so the supplied
 * Bearer token is the canonical identity for downstream handlers.
 */
import type { Hono } from 'hono';
import { initBrokerHmacKey, initBrokerStorage } from './bootstrap';
import { agentAuthMiddleware } from './agentAuthMiddleware';
import { buildAgentRoutes } from './routes/agent';
import { buildAdminRoutes } from './routes/admin';
import { buildRotationAdminRoutes, buildPublicWebhookRoute } from './routes/rotation';
import { logger } from '../utils/logger';

/**
 * Register `/api/broker/*` on the supplied Hono app. Idempotent — safe to call
 * from `registerApiRoutes` even if the broker has already been initialised.
 */
export function registerBrokerRoutes(app: Hono): void {
  initBrokerHmacKey();
  // Fire-and-forget — adapter selection is async because Infisical needs a
  // network round-trip to authenticate. Routes mount immediately; the first
  // request will either find the adapter ready or fall back to env-manager
  // (logged at boot).
  void initBrokerStorage();

  app.use('/api/broker/agent/*', agentAuthMiddleware);
  app.route('/api/broker/agent', buildAgentRoutes());

  app.route('/api/broker/admin', buildAdminRoutes());
  app.route('/api/broker/admin', buildRotationAdminRoutes());

  logger.info('broker: routes mounted at /api/broker/{agent,admin}/*');
}

/**
 * Register PUBLIC webhook routes that must bypass the /api/* dashboard-token
 * gate. Call this in `registerApiRoutes` BEFORE `app.use('/api/*', ...)`.
 *
 * Auth on these routes is provided by per-route HMAC signature checks, not
 * by the dashboard token. The path layout is `/webhooks/broker/...` so the
 * existing cron `/webhooks/:slug` namespace stays unambiguous.
 */
export function registerBrokerPublicRoutes(app: Hono): void {
  app.route('/webhooks', buildPublicWebhookRoute());
  logger.info('broker: public webhook mounted at /webhooks/broker/rotation');
}
