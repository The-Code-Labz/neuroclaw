// Inngest serve handler (Hono adapter).
//
// Mounted at /api/inngest (see dashboard/server.ts). The remote Inngest server
// calls this endpoint to (a) sync/register functions and (b) execute them. The
// signing key is read from process.env (INNGEST_SIGNING_KEY) by the SDK; serveUrl
// tells the Inngest server how to reach us (the public reverse-proxied URL), since
// the server is on another host and can't infer our address.

import { serve } from 'inngest/hono';
import { inngest } from './inngest-client';
import { allFunctions } from './inngest-functions';
import { config } from '../config';

export const inngestServeHandler = serve({
  client:      inngest,
  functions:   allFunctions,
  serveOrigin: new URL(config.inngest.serveUrl).origin,
  servePath:   new URL(config.inngest.serveUrl).pathname,
});
