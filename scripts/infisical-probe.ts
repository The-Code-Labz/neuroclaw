/**
 * scripts/infisical-probe.ts — one-shot Infisical connection probe.
 *
 * Reads NC_BROKER_INFISICAL_* from .env via dotenv, logs in via Universal
 * Auth, lists secrets, prints a summary. Exits non-zero on any failure so
 * shell scripts can branch.
 *
 *   npx tsx scripts/infisical-probe.ts
 */
import 'dotenv/config';
import { InfisicalSDK } from '@infisical/sdk';

const SITE   = process.env.NC_BROKER_INFISICAL_SITE_URL ?? '';
const CID    = process.env.NC_BROKER_INFISICAL_CLIENT_ID ?? '';
const CSEC   = process.env.NC_BROKER_INFISICAL_CLIENT_SECRET ?? '';
const PROJ   = process.env.NC_BROKER_INFISICAL_PROJECT_ID ?? '';
const ENV    = process.env.NC_BROKER_INFISICAL_ENVIRONMENT ?? 'prod';
const PATH_  = process.env.NC_BROKER_INFISICAL_PATH ?? '/';

console.log('Infisical probe');
console.log('  site        :', SITE);
console.log('  project     :', PROJ.slice(0, 8) + '...');
console.log('  environment :', ENV);
console.log('  path        :', PATH_);
console.log('  client id   :', CID.slice(0, 8) + '...');
console.log('');

if (!SITE || !CID || !CSEC || !PROJ) {
  console.error('Missing one or more required NC_BROKER_INFISICAL_* env vars');
  process.exit(2);
}

(async () => {
  const sdk = new InfisicalSDK({ siteUrl: SITE });
  try {
    await sdk.auth().universalAuth.login({ clientId: CID, clientSecret: CSEC });
    console.log('  ✓ auth ok');
  } catch (e) {
    console.error('  ✗ auth failed:', (e as Error).message);
    process.exit(1);
  }

  try {
    const res = await sdk.secrets().listSecrets({
      projectId: PROJ,
      environment: ENV,
      secretPath: PATH_,
      viewSecretValue: false,
    });
    const count = res.secrets?.length ?? 0;
    console.log(`  ✓ list ok — ${count} secret(s) in ${ENV}${PATH_}`);
    for (const s of (res.secrets ?? []).slice(0, 10)) {
      console.log('     ·', s.secretKey);
    }
    if (count > 10) console.log(`     ... (+${count - 10} more)`);
  } catch (e) {
    console.error('  ✗ list failed:', (e as Error).message);
    process.exit(1);
  }
})();
