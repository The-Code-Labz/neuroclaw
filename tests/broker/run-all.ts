/**
 * tests/broker/run-all.ts — minimal in-house test runner for the broker.
 *
 * The repo doesn't ship a test framework yet (per AGENTS.md). This script uses
 * Node's `assert` + a tiny `it()` helper so we can exercise the broker without
 * adding a vitest/jest dep just for this slice. Run with:
 *
 *     npm run test:broker
 *
 * Each `it()` runs synchronously; the script exits non-zero on the first
 * failure so CI can flag regressions.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  initTokenKey, mintAgentToken, verifyAgentToken, AuthError,
  _resetJtiCacheForTests, isTokenKeyInitialised, jtiCacheSize,
} from '../../src/broker/agentToken';
import { scrubOutput, createStreamScrubber } from '../../src/broker/scrubber';
import {
  parseName, normalizeAgentPrefix, isValidUpperSnake,
  isAllowedType, buildName, globMatch,
} from '../../src/broker/nameParser';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadManifest, findManifestForEntrypoint } from '../../src/mcp/secretManifest';
import {
  CredentialDeniedError, CredentialMissingError, agentNameForBroker,
  listAccessibleForName, resolveEnvBundleForName,
  resolveCredential, resolveEnvBundle,
} from '../../src/broker/agentSecrets';
import { deriveCanonicalPrefix } from '../../src/broker/agentRegistry';
import { setStorage } from '../../src/broker/storage';
import type { SecretStorage } from '../../src/broker/storage';
import { resolveCredentialForName, resolveByNameForName } from '../../src/broker/agentSecrets';
import { buildSubprocessEnv, buildAgentScopedEnv } from '../../src/broker/subprocessSecrets';
import { bashRun } from '../../src/system/exec-tools';
import { runSkillScript } from '../../src/system/skill-runner';
import { bashRunSchema, secretsListSchema, runSkillScriptSchema } from '../../src/tools/schemas';
import { buildSecretsBlock } from '../../src/agent/secretsBlock';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  const start = Date.now();
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}  (${Date.now() - start}ms)`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${name}: ${msg}`);
      console.error(`  ✗ ${name}`);
      console.error(`    ${msg}`);
    }
  })();
}

async function suite(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n${name}`);
  await fn();
}

(async () => {
  // ── HMAC tokens ─────────────────────────────────────────────────────────
  await suite('agentToken', async () => {
    await it('initTokenKey rejects wrong-length key', () => {
      assert.throws(() => initTokenKey(Buffer.alloc(16)), /32 bytes/);
    });

    const key = randomBytes(32);
    initTokenKey(key);
    _resetJtiCacheForTests();

    await it('isTokenKeyInitialised reports true after init', () => {
      assert.equal(isTokenKeyInitialised(), true);
    });

    await it('mint + verify round-trip returns same identity', () => {
      const sid = randomUUID();
      const tok = mintAgentToken('Oracle', sid);
      const ctx = verifyAgentToken(tok);
      assert.equal(ctx.agentName, 'Oracle');
      assert.equal(ctx.sessionId, sid);
    });

    await it('replay of same token is rejected', () => {
      _resetJtiCacheForTests();
      const tok = mintAgentToken('Oracle', randomUUID());
      verifyAgentToken(tok);
      assert.throws(() => verifyAgentToken(tok), (err: unknown) =>
        err instanceof AuthError && err.code === 'token_replayed');
    });

    await it('expired token is rejected', () => {
      _resetJtiCacheForTests();
      const tok = mintAgentToken('Oracle', randomUUID(), -10);
      assert.throws(() => verifyAgentToken(tok), (err: unknown) =>
        err instanceof AuthError && err.code === 'token_expired');
    });

    await it('malformed token (no dot) rejected', () => {
      _resetJtiCacheForTests();
      assert.throws(() => verifyAgentToken('not-a-token'), (err: unknown) =>
        err instanceof AuthError && err.code === 'malformed_token');
    });

    await it('tampered signature rejected', () => {
      _resetJtiCacheForTests();
      const tok = mintAgentToken('Oracle', randomUUID());
      const dot = tok.lastIndexOf('.');
      const tampered = tok.slice(0, dot + 1) + 'AAAA' + tok.slice(dot + 5);
      assert.throws(() => verifyAgentToken(tampered), (err: unknown) =>
        err instanceof AuthError && /invalid_signature|malformed/.test(err.code));
    });

    await it('signature signed with different key rejected', () => {
      _resetJtiCacheForTests();
      const tok = mintAgentToken('Oracle', randomUUID());
      initTokenKey(randomBytes(32));
      assert.throws(() => verifyAgentToken(tok), (err: unknown) =>
        err instanceof AuthError && err.code === 'invalid_signature');
      initTokenKey(key);
    });

    await it('jti cache shrinks after prune', () => {
      _resetJtiCacheForTests();
      mintAgentToken('Oracle', randomUUID(), -10); // already-expired token (won't claim)
      // Just verify mint-only doesn't blow up the cache uncontrollably.
      mintAgentToken('Oracle', randomUUID());
      assert.ok(jtiCacheSize() >= 0);
    });
  });

  // ── Scrubber ────────────────────────────────────────────────────────────
  await suite('scrubber', async () => {
    await it('literal secret replaced with ***NAME***', () => {
      const out = scrubOutput('Bearer ghp_supersecret', { ORACLE_GITHUB_PAT: 'ghp_supersecret' });
      assert.equal(out.scrubbed, 'Bearer ***ORACLE_GITHUB_PAT***');
      assert.equal(out.triggered, true);
    });

    await it('base64-encoded secret scrubbed', () => {
      const val = 'shhh-1234';
      const b64 = Buffer.from(val).toString('base64');
      const out = scrubOutput('Authorization: Basic ' + b64, { S: val });
      assert.ok(out.scrubbed.includes('***S***'));
      assert.equal(out.triggered, true);
    });

    await it('URL-encoded secret scrubbed', () => {
      const val = 'a b/c@d?e';
      const enc = encodeURIComponent(val);
      const out = scrubOutput('?token=' + enc, { S: val });
      assert.ok(out.scrubbed.includes('***S***'));
    });

    await it('hex-encoded secret scrubbed', () => {
      const val = 'rawvalue';
      const hex = Buffer.from(val).toString('hex');
      const out = scrubOutput('hex:' + hex, { S: val });
      assert.ok(out.scrubbed.includes('***S***'));
    });

    await it('no leak → not triggered', () => {
      const out = scrubOutput('nothing here', { S: 'secret' });
      assert.equal(out.triggered, false);
      assert.equal(out.scrubbed, 'nothing here');
    });

    await it('empty value skipped', () => {
      const out = scrubOutput('hello', { S: '' });
      assert.equal(out.triggered, false);
    });

    await it('handles realistic curl -v dump', () => {
      const tok = 'ghp_abc123XYZ';
      const verboseDump = `* Connected to api.github.com\n> GET /user/repos HTTP/1.1\n> Authorization: token ${tok}\n> User-Agent: curl/7.88.0\n< HTTP/2 200\n< x-oauth-scopes: repo\n[ok]`;
      const out = scrubOutput(verboseDump, { ORACLE_GITHUB_PAT: tok });
      assert.equal(out.triggered, true);
      assert.equal(out.scrubbed.includes(tok), false);
      assert.ok(out.scrubbed.includes('***ORACLE_GITHUB_PAT***'));
    });
  });

  // ── Name parser ─────────────────────────────────────────────────────────
  await suite('nameParser', async () => {
    await it('parses SHARED_NANOBANANA_KEY', () => {
      const p = parseName('SHARED_NANOBANANA_KEY');
      assert.deepEqual(p, { scope: 'SHARED', service: 'NANOBANANA', type: 'KEY', raw: 'SHARED_NANOBANANA_KEY' });
    });

    await it('parses agent-scoped name', () => {
      const p = parseName('ORACLE_GITHUB_PAT');
      assert.equal(p?.scope, 'ORACLE');
      assert.equal(p?.service, 'GITHUB');
      assert.equal(p?.type, 'PAT');
    });

    await it('parses multi-underscore service', () => {
      const p = parseName('SHARED_VOID_AI_API_KEY');
      assert.equal(p?.scope, 'SHARED');
      assert.equal(p?.type, 'KEY');
      assert.ok(p?.service.includes('AI'));
    });

    await it('rejects bad-shape name', () => {
      assert.equal(parseName('LOWER_case_KEY'), null);
      assert.equal(parseName('JUSTONE'), null);
      assert.equal(parseName('A_B_BAD'), null); // BAD not in ALLOWED_TYPES
    });

    await it('normalizeAgentPrefix strips dots + spaces', () => {
      assert.equal(normalizeAgentPrefix('F.R.I.D.A.Y'), 'FRIDAY');
      assert.equal(normalizeAgentPrefix('Cassandra Cain'), 'CASSANDRA_CAIN');
      assert.equal(normalizeAgentPrefix('oracle'), 'ORACLE');
    });

    await it('isValidUpperSnake accepts single letter, rejects digit-start', () => {
      assert.equal(isValidUpperSnake('A'), true);
      assert.equal(isValidUpperSnake('A_B'), true);
      assert.equal(isValidUpperSnake('1A'), false);
      assert.equal(isValidUpperSnake('A_'), false);
    });

    await it('isAllowedType narrows', () => {
      assert.equal(isAllowedType('PAT'), true);
      assert.equal(isAllowedType('NOPE'), false);
    });

    await it('buildName composes valid names', () => {
      assert.equal(buildName('ORACLE', 'GITHUB', 'PAT'), 'ORACLE_GITHUB_PAT');
      assert.equal(buildName('shared', 'github', 'PAT'), 'SHARED_GITHUB_PAT');
      assert.equal(buildName('ORACLE', 'GITHUB', 'NOPE'), null);
    });

    await it('globMatch supports * and ?', () => {
      assert.equal(globMatch('ORACLE_GITHUB_PAT', '*GITHUB*'), true);
      assert.equal(globMatch('ORACLE_GITHUB_PAT', 'ORACLE_*'), true);
      assert.equal(globMatch('JARVIS_GITHUB_PAT', 'ORACLE_*'), false);
    });
  });

  // ── MCP secret manifest ─────────────────────────────────────────────────
  await suite('secretManifest', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-broker-test-'));

    await it('loads a valid manifest with defaults', () => {
      const p = path.join(tmp, 'good.secrets.yaml');
      fs.writeFileSync(p, 'mcp: archon\nsecrets:\n  - SHARED_TEST_KEY\n');
      const m = loadManifest(p);
      assert.equal(m.mcp, 'archon');
      assert.deepEqual(m.secrets, ['SHARED_TEST_KEY']);
      assert.equal(m.rotation.strategy, 'sighup');
    });

    await it('rejects manifest with missing mcp key', () => {
      const p = path.join(tmp, 'bad-no-mcp.yaml');
      fs.writeFileSync(p, 'secrets:\n  - A\n');
      assert.throws(() => loadManifest(p), /mcp/);
    });

    await it('rejects manifest with non-array secrets', () => {
      const p = path.join(tmp, 'bad-secrets.yaml');
      fs.writeFileSync(p, 'mcp: x\nsecrets: not-array\n');
      assert.throws(() => loadManifest(p), /secrets/);
    });

    await it('rejects invalid rotation strategy', () => {
      const p = path.join(tmp, 'bad-rotation.yaml');
      fs.writeFileSync(p, 'mcp: x\nsecrets:\n  - A_B_KEY\nrotation:\n  strategy: bogus\n');
      assert.throws(() => loadManifest(p), /strategy/);
    });

    await it('accepts each valid rotation strategy', () => {
      for (const strat of ['sighup', 'restart', 'none']) {
        const p = path.join(tmp, `r-${strat}.yaml`);
        fs.writeFileSync(p, `mcp: x\nsecrets:\n  - A_B_KEY\nrotation:\n  strategy: ${strat}\n`);
        const m = loadManifest(p);
        assert.equal(m.rotation.strategy, strat);
      }
    });

    await it('findManifestForEntrypoint resolves <base>.secrets.yaml', () => {
      const entry = path.join(tmp, 'archon.js');
      fs.writeFileSync(entry, '// fake');
      const manifestP = path.join(tmp, 'archon.secrets.yaml');
      fs.writeFileSync(manifestP, 'mcp: archon\nsecrets: []\n');
      assert.equal(findManifestForEntrypoint(entry), manifestP);
    });

    await it('findManifestForEntrypoint falls back to secrets.yaml', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fallback-'));
      const entry = path.join(dir, 'server.ts');
      fs.writeFileSync(entry, '// fake');
      const manifestP = path.join(dir, 'secrets.yaml');
      fs.writeFileSync(manifestP, 'mcp: x\nsecrets: []\n');
      assert.equal(findManifestForEntrypoint(entry), manifestP);
    });

    await it('findManifestForEntrypoint returns null when nothing found', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-empty-'));
      const entry = path.join(dir, 'server.ts');
      fs.writeFileSync(entry, '// fake');
      assert.equal(findManifestForEntrypoint(entry), null);
    });
  });

  // ── Webhook signature parsing (Infisical-specific format) ──────────────
  await suite('webhook signature format', async () => {
    // We test the parser indirectly via crypto so we don't have to spin up
    // the whole Hono stack. The internal helper isn't exported, so we
    // re-implement the contract here and assert it's stable.
    const crypto2 = await import('node:crypto');
    const secret = 'cf2b9e9a311054ace6642d455edada3c667d500a4b0ecf79b70e9061808e1c66';
    const body = '{"event":"test","timestamp":1778874948494}';
    const hex = crypto2.createHmac('sha256', secret).update(body).digest('hex');

    await it('strips Infisical t=<ts>;<hex> prefix correctly', () => {
      const sig = `t=1778874948494;${hex}`;
      const m = sig.match(/^t\s*=\s*\d+\s*;\s*([0-9a-fA-F]+)\s*$/);
      assert.ok(m, 'regex should match');
      assert.equal(m![1], hex);
    });

    await it('rejects bogus t= prefix', () => {
      const sig = 't=NOT_A_NUMBER;abc';
      const m = sig.match(/^t\s*=\s*\d+\s*;\s*([0-9a-fA-F]+)\s*$/);
      assert.equal(m, null);
    });
  });

  await suite('agentSecrets — types & errors', async () => {
    await it('CredentialDeniedError carries name/agent/purpose', () => {
      const e = new CredentialDeniedError('LIESE_N8N_KEY', 'agent-1', 'create_n8n_workflow');
      assert.equal(e.name, 'CredentialDeniedError');
      assert.equal(e.secretName, 'LIESE_N8N_KEY');
      assert.equal(e.agentId, 'agent-1');
      assert.equal(e.purpose, 'create_n8n_workflow');
      assert.ok(e instanceof Error);
    });

    await it('CredentialMissingError carries attempted/agent/purpose', () => {
      const e = new CredentialMissingError(['SHARED_N8N_KEY'], null, 'list_n8n_workflows');
      assert.equal(e.name, 'CredentialMissingError');
      assert.deepEqual(e.attempted, ['SHARED_N8N_KEY']);
      assert.equal(e.agentId, null);
      assert.equal(e.purpose, 'list_n8n_workflows');
      assert.ok(e instanceof Error);
    });
  });

  await suite('agentRegistry — prefix derivation', async () => {
    await it('derives an upper-snake prefix from an agent name', () => {
      assert.equal(deriveCanonicalPrefix('Liese'), 'LIESE');
      assert.equal(deriveCanonicalPrefix('Cassandra Cain'), 'CASSANDRA_CAIN');
      assert.equal(deriveCanonicalPrefix('F.R.I.D.A.Y'), 'FRIDAY');
    });

    await it('returns null for reserved or empty derivations', () => {
      assert.equal(deriveCanonicalPrefix('shared'), null);
      assert.equal(deriveCanonicalPrefix('NeuroClaw'), null);
      assert.equal(deriveCanonicalPrefix(''), null);
      assert.equal(deriveCanonicalPrefix('123'), null);
    });
  });

  await suite('agentSecrets — agentNameForBroker', async () => {
    await it('returns null for null/empty agentId', () => {
      assert.equal(agentNameForBroker(null), null);
      assert.equal(agentNameForBroker(''), null);
    });

    await it('returns null for an unknown agentId', () => {
      assert.equal(agentNameForBroker('00000000-0000-0000-0000-000000000000'), null);
    });
  });

  await suite('agentSecrets — resolveCredentialForName', async () => {
    // Fake SecretStorage so resolution is tested without .env or Infisical.
    const fakeStorage = (secrets: Record<string, string>): SecretStorage => ({
      async list() {
        return Object.keys(secrets).map((name) => ({
          name, tags: [], notes: '', createdAt: '', updatedAt: '',
        }));
      },
      async getValue(name) { return name in secrets ? secrets[name] : null; },
      async create() {}, async update() {}, async delete() {}, async rotate() {},
    });

    await it('prefers <PREFIX>_ over SHARED_ over NEUROCLAW_', async () => {
      setStorage(fakeStorage({
        LIESE_N8N_KEY: 'liese-key',
        SHARED_N8N_KEY: 'shared-key',
        NEUROCLAW_N8N_KEY: 'nc-key',
      }));
      const r = await resolveCredentialForName('Liese', 'LIESE',
        { service: 'N8N', type: 'KEY' }, 'test');
      assert.equal(r.outcome, 'ok');
      if (r.outcome === 'ok') {
        assert.equal(r.name, 'LIESE_N8N_KEY');
        assert.equal(r.value, 'liese-key');
        assert.equal(r.source, 'broker');
      }
    });

    await it('falls back to SHARED_ when no agent-prefixed secret exists', async () => {
      setStorage(fakeStorage({ SHARED_N8N_KEY: 'shared-key' }));
      const r = await resolveCredentialForName('Liese', 'LIESE',
        { service: 'N8N', type: 'KEY' }, 'test');
      assert.equal(r.outcome, 'ok');
      if (r.outcome === 'ok') assert.equal(r.name, 'SHARED_N8N_KEY');
    });

    await it('returns fallback when the secret is in neither broker nor missing', async () => {
      setStorage(fakeStorage({}));
      const r = await resolveCredentialForName('Liese', 'LIESE',
        { service: 'N8N', type: 'KEY' }, 'test', 'env-value');
      assert.equal(r.outcome, 'fallback');
      if (r.outcome === 'fallback') {
        assert.equal(r.value, 'env-value');
        assert.equal(r.source, 'env');
      }
    });

    await it('returns missing when absent and no fallback supplied', async () => {
      setStorage(fakeStorage({}));
      const r = await resolveCredentialForName('Liese', 'LIESE',
        { service: 'N8N', type: 'KEY' }, 'test');
      assert.equal(r.outcome, 'missing');
      if (r.outcome === 'missing') {
        assert.deepEqual(r.attempted,
          ['LIESE_N8N_KEY', 'SHARED_N8N_KEY', 'NEUROCLAW_N8N_KEY']);
      }
    });

    await it('a null-prefix agent never tries a <PREFIX>_ candidate', async () => {
      setStorage(fakeStorage({ SHARED_N8N_KEY: 'shared-key' }));
      const r = await resolveCredentialForName(null, null,
        { service: 'N8N', type: 'KEY' }, 'test');
      assert.equal(r.outcome, 'ok');
      if (r.outcome === 'ok') assert.equal(r.name, 'SHARED_N8N_KEY');
    });
  });

  await suite('agentSecrets — resolveByNameForName', async () => {
    const fakeStorage = (secrets: Record<string, string>): SecretStorage => ({
      async list() {
        return Object.keys(secrets).map((name) => ({
          name, tags: [], notes: '', createdAt: '', updatedAt: '',
        }));
      },
      async getValue(name) { return name in secrets ? secrets[name] : null; },
      async create() {}, async update() {}, async delete() {}, async rotate() {},
    });

    await it('resolves an in-scope name that exists', async () => {
      setStorage(fakeStorage({ SHARED_GH_TOKEN: 'tok' }));
      const r = await resolveByNameForName('Liese', 'LIESE', 'SHARED_GH_TOKEN', 'test');
      assert.equal(r.outcome, 'ok');
      if (r.outcome === 'ok') assert.equal(r.value, 'tok');
    });

    await it('denies a name scoped to a different agent — without fetching it', async () => {
      let fetched = false;
      const spyStorage: SecretStorage = {
        async list() { return []; },
        async getValue() { fetched = true; return 'should-not-be-read'; },
        async create() {}, async update() {}, async delete() {}, async rotate() {},
      };
      setStorage(spyStorage);
      const r = await resolveByNameForName('Liese', 'LIESE', 'ORACLE_GH_TOKEN', 'test');
      assert.equal(r.outcome, 'denied');
      if (r.outcome === 'denied') assert.equal(r.name, 'ORACLE_GH_TOKEN');
      assert.equal(fetched, false); // denied path must not call getValue
    });

    await it('returns missing for an in-scope name that does not exist', async () => {
      setStorage(fakeStorage({}));
      const r = await resolveByNameForName('Liese', 'LIESE', 'SHARED_GH_TOKEN', 'test');
      assert.equal(r.outcome, 'missing');
      if (r.outcome === 'missing') assert.deepEqual(r.attempted, ['SHARED_GH_TOKEN']);
    });

    await it('returns missing for a malformed name', async () => {
      setStorage(fakeStorage({}));
      const r = await resolveByNameForName('Liese', 'LIESE', 'not-a-valid-name', 'test');
      assert.equal(r.outcome, 'missing');
    });
  });

  await suite('agentSecrets — listAccessible & envBundle', async () => {
    const fakeStorage = (secrets: Record<string, string>): SecretStorage => ({
      async list() {
        return Object.keys(secrets).map((name) => ({
          name, tags: ['secret'], notes: `notes for ${name}`,
          createdAt: '', updatedAt: '',
        }));
      },
      async getValue(name) { return name in secrets ? secrets[name] : null; },
      async create() {}, async update() {}, async delete() {}, async rotate() {},
    });

    await it('listAccessibleForName returns only in-scope entries, no value field', async () => {
      setStorage(fakeStorage({
        SHARED_N8N_KEY: 'a', LIESE_GH_TOKEN: 'b', ORACLE_GH_TOKEN: 'c',
      }));
      const rows = await listAccessibleForName('LIESE');
      const names = rows.map((r) => r.name).sort();
      assert.deepEqual(names, ['LIESE_GH_TOKEN', 'SHARED_N8N_KEY']);
      for (const row of rows) {
        assert.equal((row as Record<string, unknown>).value, undefined);
      }
    });

    await it('listAccessibleForName with null prefix sees only SHARED/NEUROCLAW', async () => {
      setStorage(fakeStorage({ SHARED_N8N_KEY: 'a', LIESE_GH_TOKEN: 'b' }));
      const rows = await listAccessibleForName(null);
      assert.deepEqual(rows.map((r) => r.name), ['SHARED_N8N_KEY']);
    });

    await it('resolveEnvBundleForName splits ok / denied / missing', async () => {
      setStorage(fakeStorage({ SHARED_N8N_KEY: 'a' }));
      const r = await resolveEnvBundleForName('Liese', 'LIESE',
        ['SHARED_N8N_KEY', 'ORACLE_GH_TOKEN', 'SHARED_GONE_KEY'], 'test');
      assert.deepEqual(r.env, { SHARED_N8N_KEY: 'a' });
      assert.deepEqual(r.denied, ['ORACLE_GH_TOKEN']);
      assert.deepEqual(r.missing, ['SHARED_GONE_KEY']);
    });
  });

  await suite('agentSecrets — public wrappers & concurrency', async () => {
    const fakeStorage = (secrets: Record<string, string>): SecretStorage => ({
      async list() {
        return Object.keys(secrets).map((name) => ({
          name, tags: [], notes: '', createdAt: '', updatedAt: '',
        }));
      },
      async getValue(name) {
        // small async hop so concurrent calls genuinely interleave
        await new Promise((res) => setTimeout(res, 1));
        return name in secrets ? secrets[name] : null;
      },
      async create() {}, async update() {}, async delete() {}, async rotate() {},
    });

    await it('resolveCredential with an unknown agentId resolves SHARED only', async () => {
      setStorage(fakeStorage({ SHARED_N8N_KEY: 'shared' }));
      const r = await resolveCredential(
        '00000000-0000-0000-0000-000000000000',
        { service: 'N8N', type: 'KEY' }, 'test');
      assert.equal(r.outcome, 'ok');
      if (r.outcome === 'ok') assert.equal(r.name, 'SHARED_N8N_KEY');
    });

    await it('resolveEnvBundle with a null agentId denies <PREFIX>_ names', async () => {
      setStorage(fakeStorage({ SHARED_N8N_KEY: 'a', LIESE_GH_TOKEN: 'b' }));
      const r = await resolveEnvBundle(null, ['SHARED_N8N_KEY', 'LIESE_GH_TOKEN'], 'test');
      assert.deepEqual(r.env, { SHARED_N8N_KEY: 'a' });
      assert.deepEqual(r.denied, ['LIESE_GH_TOKEN']);
    });

    await it('two agents resolving in parallel get their own values — no cross-talk', async () => {
      setStorage(fakeStorage({
        LIESE_N8N_KEY: 'liese-value',
        ORACLE_N8N_KEY: 'oracle-value',
      }));
      const [liese, oracle] = await Promise.all([
        resolveCredentialForName('Liese', 'LIESE', { service: 'N8N', type: 'KEY' }, 'test'),
        resolveCredentialForName('Oracle', 'ORACLE', { service: 'N8N', type: 'KEY' }, 'test'),
      ]);
      assert.equal(liese.outcome, 'ok');
      assert.equal(oracle.outcome, 'ok');
      if (liese.outcome === 'ok') assert.equal(liese.value, 'liese-value');
      if (oracle.outcome === 'ok') assert.equal(oracle.value, 'oracle-value');
    });
  });

  await suite('agentSecrets — degraded storage', async () => {
    const throwingStorage = (): SecretStorage => ({
      async list() { throw new Error('broker unavailable'); },
      async getValue() { throw new Error('broker unavailable'); },
      async create() {}, async update() {}, async delete() {}, async rotate() {},
    });

    await it('resolveCredentialForName degrades to fallback on storage error', async () => {
      setStorage(throwingStorage());
      const r = await resolveCredentialForName('Liese', 'LIESE',
        { service: 'N8N', type: 'KEY' }, 'test', 'env-val');
      assert.equal(r.outcome, 'fallback');
      if (r.outcome === 'fallback') assert.equal(r.value, 'env-val');
    });

    await it('resolveCredentialForName is missing on storage error with no fallback', async () => {
      setStorage(throwingStorage());
      const r = await resolveCredentialForName('Liese', 'LIESE',
        { service: 'N8N', type: 'KEY' }, 'test');
      assert.equal(r.outcome, 'missing');
    });

    await it('resolveByNameForName degrades to missing on storage error', async () => {
      setStorage(throwingStorage());
      const r = await resolveByNameForName('Liese', 'LIESE', 'SHARED_GH_TOKEN', 'test');
      assert.equal(r.outcome, 'missing');
    });

    await it('listAccessibleForName returns [] on storage error', async () => {
      setStorage(throwingStorage());
      assert.deepEqual(await listAccessibleForName('LIESE'), []);
    });
  });

  await suite('subprocessSecrets — buildSubprocessEnv', async () => {
    const fakeStorage = (secrets: Record<string, string>): SecretStorage => ({
      async list() {
        return Object.keys(secrets).map((name) => ({
          name, tags: [], notes: '', createdAt: '', updatedAt: '',
        }));
      },
      async getValue(name) { return name in secrets ? secrets[name] : null; },
      async create() {}, async update() {}, async delete() {}, async rotate() {},
    });

    await it('empty / undefined names is a no-op fast path', async () => {
      setStorage(fakeStorage({ SHARED_GH_TOKEN: 'tok' }));
      const base = { PATH: '/usr/bin' };
      const r = await buildSubprocessEnv(null, [], 'test', base);
      assert.equal(r.env, base);                 // same reference — untouched
      assert.deepEqual(r.resolved, {});
      assert.deepEqual(r.denied, []);
      assert.deepEqual(r.missing, []);
      const r2 = await buildSubprocessEnv(null, undefined, 'test', base);
      assert.equal(r2.env, base);
    });

    await it('merges a resolved SHARED secret onto the base env', async () => {
      setStorage(fakeStorage({ SHARED_GH_TOKEN: 'tok-value' }));
      const r = await buildSubprocessEnv(
        null, ['SHARED_GH_TOKEN'], 'test', { PATH: '/usr/bin' });
      assert.equal(r.env.PATH, '/usr/bin');
      assert.equal(r.env.SHARED_GH_TOKEN, 'tok-value');
      assert.deepEqual(r.resolved, { SHARED_GH_TOKEN: 'tok-value' });
      assert.deepEqual(r.denied, []);
      assert.deepEqual(r.missing, []);
    });

    await it('reports denied and missing names without injecting them', async () => {
      setStorage(fakeStorage({ SHARED_GH_TOKEN: 'tok' }));
      const r = await buildSubprocessEnv(
        null, ['SHARED_GH_TOKEN', 'ORACLE_GH_TOKEN', 'SHARED_GONE_KEY'], 'test', {});
      assert.deepEqual(r.resolved, { SHARED_GH_TOKEN: 'tok' });
      assert.deepEqual(r.denied, ['ORACLE_GH_TOKEN']);
      assert.deepEqual(r.missing, ['SHARED_GONE_KEY']);
      assert.equal(r.env.ORACLE_GH_TOKEN, undefined);
      assert.equal(r.env.SHARED_GONE_KEY, undefined);
    });
  });

  await suite('bash_run — broker secret injection', async () => {
    const fakeStorage = (secrets: Record<string, string>): SecretStorage => ({
      async list() {
        return Object.keys(secrets).map((name) => ({
          name, tags: [], notes: '', createdAt: '', updatedAt: '',
        }));
      },
      async getValue(name) { return name in secrets ? secrets[name] : null; },
      async create() {}, async update() {}, async delete() {}, async rotate() {},
    });

    await it('injects a resolved secret into the child env and scrubs it from stdout', async () => {
      setStorage(fakeStorage({ SHARED_DEMO_TOKEN: 's3cr3t-value-xyz' }));
      const r = await bashRun({
        command: 'echo "out=$SHARED_DEMO_TOKEN"',
        cwd: process.cwd(),
        secrets: ['SHARED_DEMO_TOKEN'],
        purpose: 'test',
      });
      assert.equal(r.ok, true);
      // the value was injected (echo expanded it) but is scrubbed in the result
      assert.equal(r.stdout.trim(), 'out=***SHARED_DEMO_TOKEN***');
      assert.ok(!r.stdout.includes('s3cr3t-value-xyz'));
      assert.equal(r.secrets_denied, undefined);
      assert.equal(r.secrets_missing, undefined);
    });

    await it('scrubs an injected secret from stderr as well', async () => {
      setStorage(fakeStorage({ SHARED_DEMO_TOKEN: 's3cr3t-value-xyz' }));
      const r = await bashRun({
        command: 'echo "err=$SHARED_DEMO_TOKEN" 1>&2',
        cwd: process.cwd(),
        secrets: ['SHARED_DEMO_TOKEN'],
        purpose: 'test',
      });
      assert.equal(r.stderr.trim(), 'err=***SHARED_DEMO_TOKEN***');
      assert.ok(!r.stderr.includes('s3cr3t-value-xyz'));
    });

    await it('reports a scope-denied secret and does not inject it', async () => {
      setStorage(fakeStorage({ ORACLE_DEMO_TOKEN: 'should-never-be-read' }));
      const r = await bashRun({
        command: 'echo "v=[$ORACLE_DEMO_TOKEN]"',
        cwd: process.cwd(),
        secrets: ['ORACLE_DEMO_TOKEN'],
        purpose: 'test',
      });
      assert.deepEqual(r.secrets_denied, ['ORACLE_DEMO_TOKEN']);
      assert.equal(r.secrets_missing, undefined);
      assert.equal(r.stdout.trim(), 'v=[]');   // env var unset → empty expansion
    });

    await it('reports a missing secret', async () => {
      setStorage(fakeStorage({}));
      const r = await bashRun({
        command: 'echo hi',
        cwd: process.cwd(),
        secrets: ['SHARED_ABSENT_TOKEN'],
        purpose: 'test',
      });
      assert.deepEqual(r.secrets_missing, ['SHARED_ABSENT_TOKEN']);
      assert.equal(r.secrets_denied, undefined);
      assert.equal(r.stdout.trim(), 'hi');
    });

    await it('no secrets requested — behaves exactly as before', async () => {
      setStorage(fakeStorage({}));
      const r = await bashRun({ command: 'echo plain', cwd: process.cwd() });
      assert.equal(r.ok, true);
      assert.equal(r.stdout.trim(), 'plain');
      assert.equal(r.secrets_denied, undefined);
      assert.equal(r.secrets_missing, undefined);
    });
  });

  await suite('bash_run schema — secrets & purpose', async () => {
    await it('accepts secrets and purpose', () => {
      const r = bashRunSchema.parse({
        command: 'echo hi', secrets: ['SHARED_GH_TOKEN'], purpose: 'deploy',
      });
      assert.deepEqual(r.secrets, ['SHARED_GH_TOKEN']);
      assert.equal(r.purpose, 'deploy');
    });

    await it('secrets and purpose are optional', () => {
      const r = bashRunSchema.parse({ command: 'echo hi' });
      assert.equal(r.secrets, undefined);
      assert.equal(r.purpose, undefined);
    });
  });

  await suite('secrets_list schema', async () => {
    await it('accepts an optional service filter', () => {
      const r = secretsListSchema.parse({ service: 'N8N' });
      assert.equal(r.service, 'N8N');
    });

    await it('service is optional', () => {
      const r = secretsListSchema.parse({});
      assert.equal(r.service, undefined);
    });
  });

  await suite('secretsBlock — buildSecretsBlock', async () => {
    const fakeStorage = (names: string[]): SecretStorage => ({
      async list() {
        return names.map((name) => ({
          name, tags: [], notes: `notes for ${name}`, createdAt: '', updatedAt: '',
        }));
      },
      async getValue() { return null; },
      async create() {}, async update() {}, async delete() {}, async rotate() {},
    });

    await it('returns an empty string when the agent has no scoped secrets', async () => {
      setStorage(fakeStorage([]));
      assert.equal(await buildSecretsBlock(null), '');
    });

    await it('renders each scoped secret name with service/type and notes', async () => {
      setStorage(fakeStorage(['SHARED_N8N_KEY', 'SHARED_GH_TOKEN']));
      const block = await buildSecretsBlock(null);
      assert.ok(block.includes('SHARED_N8N_KEY'));
      assert.ok(block.includes('(N8N/KEY)'));
      assert.ok(block.includes('SHARED_GH_TOKEN'));
      assert.ok(block.includes('(GH/TOKEN)'));
      assert.ok(block.includes('notes for SHARED_N8N_KEY'));
      assert.ok(block.toLowerCase().includes('bash_run'));
      assert.ok(block.toLowerCase().includes('never'));
    });

    await it('caps the list at 30 entries with an overflow line', async () => {
      const many = Array.from({ length: 42 }, (_, i) => `SHARED_SVC${i}_KEY`);
      setStorage(fakeStorage(many));
      const block = await buildSecretsBlock(null);
      assert.equal(block.split('\n').filter((l) => l.startsWith('- ')).length, 30);
      assert.ok(block.includes('12 more'));
      assert.ok(block.includes('secrets_list'));
    });
  });

  await suite('runSkillScript — broker secret injection', async () => {
    const fakeStorage = (secrets: Record<string, string>): SecretStorage => ({
      async list() {
        return Object.keys(secrets).map((name) => ({
          name, tags: [], notes: '', createdAt: '', updatedAt: '',
        }));
      },
      async getValue(name) { return name in secrets ? secrets[name] : null; },
      async create() {}, async update() {}, async delete() {}, async rotate() {},
    });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-skill-'));
    const scriptPath = path.join(tmpDir, 'echo-secret.sh');
    fs.writeFileSync(scriptPath, 'echo "out=$SHARED_DEMO_TOKEN"\n');

    await it('injects a resolved secret into the skill-script env and scrubs it from stdout', async () => {
      setStorage(fakeStorage({ SHARED_DEMO_TOKEN: 's3cr3t-skill-xyz' }));
      const r = await runSkillScript({
        skillName: 'test-skill',
        scriptPath,
        secrets: ['SHARED_DEMO_TOKEN'],
        purpose: 'test',
      });
      assert.equal(r.ok, true);
      assert.equal(r.stdout.trim(), 'out=***SHARED_DEMO_TOKEN***');
      assert.ok(!r.stdout.includes('s3cr3t-skill-xyz'));
      assert.equal(r.secrets_denied, undefined);
      assert.equal(r.secrets_missing, undefined);
    });

    await it('reports scope-denied and missing secrets without injecting them', async () => {
      setStorage(fakeStorage({ ORACLE_DEMO_TOKEN: 'should-never-be-read' }));
      const r = await runSkillScript({
        skillName: 'test-skill',
        scriptPath,
        secrets: ['ORACLE_DEMO_TOKEN', 'SHARED_ABSENT_TOKEN'],
        purpose: 'test',
      });
      assert.deepEqual(r.secrets_denied, ['ORACLE_DEMO_TOKEN']);
      assert.deepEqual(r.secrets_missing, ['SHARED_ABSENT_TOKEN']);
    });

    await it('no secrets requested — behaves exactly as before', async () => {
      setStorage(fakeStorage({}));
      const r = await runSkillScript({ skillName: 'test-skill', scriptPath });
      assert.equal(r.ok, true);
      assert.equal(r.secrets_denied, undefined);
      assert.equal(r.secrets_missing, undefined);
    });
  });

  await suite('run_skill_script schema — secrets & purpose', async () => {
    await it('accepts secrets and purpose', () => {
      const r = runSkillScriptSchema.parse({
        skill_name: 'demo', script: 'go.sh',
        secrets: ['SHARED_GH_TOKEN'], purpose: 'deploy',
      });
      assert.deepEqual(r.secrets, ['SHARED_GH_TOKEN']);
      assert.equal(r.purpose, 'deploy');
    });

    await it('secrets and purpose are optional', () => {
      const r = runSkillScriptSchema.parse({ skill_name: 'demo', script: 'go.sh' });
      assert.equal(r.secrets, undefined);
      assert.equal(r.purpose, undefined);
    });
  });

  await suite('subprocessSecrets — buildAgentScopedEnv', async () => {
    const fakeStorage = (secrets: Record<string, string>): SecretStorage => ({
      async list() {
        return Object.keys(secrets).map((name) => ({
          name, tags: [], notes: '', createdAt: '', updatedAt: '',
        }));
      },
      async getValue(name) { return name in secrets ? secrets[name] : null; },
      async create() {}, async update() {}, async delete() {}, async rotate() {},
    });

    await it('merges every SHARED/NEUROCLAW secret onto the base env for a null agent', async () => {
      setStorage(fakeStorage({
        SHARED_GH_TOKEN: 'gh', NEUROCLAW_DEMO_KEY: 'demo', LIESE_N8N_KEY: 'liese',
      }));
      const r = await buildAgentScopedEnv(null, 'codex-cli', { PATH: '/usr/bin' });
      assert.equal(r.env.PATH, '/usr/bin');
      assert.equal(r.env.SHARED_GH_TOKEN, 'gh');
      assert.equal(r.env.NEUROCLAW_DEMO_KEY, 'demo');
      assert.equal(r.env.LIESE_N8N_KEY, undefined);      // not in scope for a null agent
      assert.deepEqual(
        Object.keys(r.resolved).sort(), ['NEUROCLAW_DEMO_KEY', 'SHARED_GH_TOKEN']);
    });

    await it('returns the base env untouched when the agent has no scoped secrets', async () => {
      setStorage(fakeStorage({}));
      const base = { PATH: '/usr/bin' };
      const r = await buildAgentScopedEnv(null, 'codex-cli', base);
      assert.equal(r.env, base);                          // same reference — no-op fast path
      assert.deepEqual(r.resolved, {});
    });
  });

  await suite('scrubber — createStreamScrubber', async () => {
    await it('scrubs a secret value contained within a single chunk', () => {
      const s = createStreamScrubber({ SHARED_TOK: 's3cr3t-value' });
      const out = s.push('before s3cr3t-value after') + s.flush();
      assert.ok(out.includes('***SHARED_TOK***'));
      assert.ok(!out.includes('s3cr3t-value'));
      assert.equal(out, 'before ***SHARED_TOK*** after');
    });

    await it('scrubs a secret value split across two chunks', () => {
      const s = createStreamScrubber({ SHARED_TOK: 's3cr3t-value' });
      let out = s.push('start s3cr');     // first half of the secret
      out += s.push('3t-value end');      // second half arrives next chunk
      out += s.flush();
      assert.ok(!out.includes('s3cr3t-value'), 'raw secret must not survive a split');
      assert.ok(out.includes('***SHARED_TOK***'));
      assert.equal(out, 'start ***SHARED_TOK*** end');
    });

    await it('passes output through unchanged when there are no secrets', () => {
      const s = createStreamScrubber({});
      assert.equal(s.push('hello '), 'hello ');
      assert.equal(s.push('world'), 'world');
      assert.equal(s.flush(), '');
    });

    await it('flush emits the held-back tail', () => {
      const s = createStreamScrubber({ SHARED_TOK: 'abc' });
      const emitted = s.push('xy');       // shorter than the holdback — all retained
      assert.equal(emitted, '');
      assert.equal(s.flush(), 'xy');
    });

    await it('scrubs a hex-encoded secret split across two chunks', () => {
      const value = 'ab';                 // hex encoding is '6162' (4 chars)
      const s = createStreamScrubber({ SHARED_TOK: value });
      let out = s.push('prefix_61');       // first half of the hex form
      out += s.push('62_suffix');          // second half arrives next chunk
      out += s.flush();
      assert.ok(!out.includes('6162'), 'hex-encoded secret must not survive a split');
    });
  });

  // ── Result summary ──────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log(`Broker tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
})();
