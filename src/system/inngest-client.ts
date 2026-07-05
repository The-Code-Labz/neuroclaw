// Inngest client singleton.
//
// Self-hosted Inngest server lives at a public URL (config.inngest.baseUrl). The
// event key / signing key are read from process.env (INNGEST_EVENT_KEY /
// INNGEST_SIGNING_KEY) by the SDK at send/serve time — those env vars are
// populated at boot from Infisical (INGEST_EVENT_KEY / INGEST_SIGNING_KEY) via the
// broker SECRET_REGISTRY, so we don't pass them at construction (they're not
// resolved yet when this module loads). isDev:false forces production mode against
// baseUrl (no localhost:8288 dev-server probing).

import { Inngest } from 'inngest';
import { config } from '../config';

export const inngest = new Inngest({
  id:      'neuroclaw',
  baseUrl: config.inngest.baseUrl,
  isDev:   false,
});

// The Inngest SDK snapshots process.env into the client's internal `_env` at
// construction time (`new Inngest()` above) and reads INNGEST_EVENT_KEY /
// INNGEST_SIGNING_KEY from that snapshot. But our keys arrive ~seconds AFTER boot
// — the broker resolves INGEST_EVENT_KEY/INGEST_SIGNING_KEY from Infisical into
// process.env asynchronously, well after this module is first imported. So the
// snapshot is empty and inngest.send() fails with "no event key".
//
// setEnvVars() (public SDK API) re-reads the live process.env and merges it into
// the client's snapshot. Call this once the broker chain has resolved the keys
// (and again on rotation) so the client picks them up. Idempotent + cheap.
export function refreshInngestEnv(): void {
  inngest.setEnvVars();
}
