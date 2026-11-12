import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalJWKSet, exportJWK, generateKeyPair, SignJWT,
} from 'jose';
import { randomUUID } from 'node:crypto';
import { createWorkersApp, type WorkerDependencies } from '../src/workers/app.js';
import { SupabaseTokenVerifier } from '../src/workers/SupabaseTokenVerifier.js';
import { AppError } from '../src/errors.js';
import type { Alert, AlertProjection } from '../src/repositories/types.js';

const ISSUER = 'https://synthetic-project.supabase.co/auth/v1';
const AUDIENCE = 'authenticated';
const USER = randomUUID(), SESSION = randomUUID();
const subject = { uid: USER, sessionId: SESSION };
let key: CryptoKey, otherKey: CryptoKey;
let verifier: SupabaseTokenVerifier;

before(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  key = pair.privateKey;
  otherKey = (await generateKeyPair('ES256')).privateKey;
  const jwk = await exportJWK(pair.publicKey);
  verifier = new SupabaseTokenVerifier({ issuer: ISSUER, audience: AUDIENCE },
    createLocalJWKSet({ keys: [{ ...jwk, kid: 'local-key', alg: 'ES256', use: 'sig' }] }));
});

async function token(over: Record<string, unknown> = {}, signingKey: CryptoKey = key, kid = 'local-key') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: ISSUER, aud: AUDIENCE, sub: USER, session_id: SESSION,
    iat: now, exp: now + 300, role: 'authenticated', ...over,
  }).setProtectedHeader({ alg: 'ES256', kid }).sign(signingKey);
}

describe('Supabase JWT verification without any provider connection', () => {
  test('accepts a signed user session and returns only subject and session identifiers', async () => {
    assert.deepEqual(await verifier.verify(await token({ email: 'private@example.invalid' })), subject);
  });

  const refused: Array<[string, Record<string, unknown>]> = [
    ['wrong issuer', { iss: 'https://attacker.invalid/auth/v1' }],
    ['wrong audience', { aud: 'other-backend' }],
    ['expired token', { exp: 1 }],
    ['missing expiry', { exp: undefined }],
    ['missing subject', { sub: undefined }],
    ['non-UUID subject', { sub: 'arbitrary-user' }],
    ['missing session', { session_id: undefined }],
    ['invalid session', { session_id: 'not-a-session' }],
    ['service-role token', { role: 'service_role' }],
    ['anonymous user', { is_anonymous: true }],
    ['future-issued token', { iat: Math.floor(Date.now() / 1000) + 3600 }],
    ['not-yet-valid token', { nbf: Math.floor(Date.now() / 1000) + 3600 }],
  ];
  for (const [name, claims] of refused) {
    test(`refuses ${name}`, async () => {
      await assert.rejects(() => token(claims).then((value) => verifier.verify(value)),
        (err: unknown) => err instanceof AppError && err.code === 'unauthenticated');
    });
  }
  test('rejects a different signing key and an unknown key identifier', async () => {
    await assert.rejects(() => token({}, otherKey).then((value) => verifier.verify(value)), /Sign in required/);
    await assert.rejects(() => token({}, key, 'unknown-key').then((value) => verifier.verify(value)), /Sign in required/);
  });
  test('rejects malformed, unsigned and oversized input without echoing it', async () => {
    for (const value of ['private-not-a-token', 'e30.e30.', 'x'.repeat(8193)]) {
      await assert.rejects(() => verifier.verify(value),
        (err: unknown) => err instanceof AppError && err.message === 'Sign in required.');
    }
  });
  test('refuses symmetric tokens rather than accepting project signing secrets', async () => {
    const value = await new SignJWT({ sub: USER }).setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode('synthetic-shared-secret-only-for-test'));
    await assert.rejects(() => verifier.verify(value), /Sign in required/);
  });
  test('requires an HTTPS issuer with the exact auth path and no credentials or URL parameters', () => {
    for (const issuer of ['http://issuer.invalid/auth/v1', 'https://issuer.invalid/other',
      'https://user:password@issuer.invalid/auth/v1', 'https://issuer.invalid/auth/v1?key=x']) {
      assert.throws(() => new SupabaseTokenVerifier({ issuer, audience: AUDIENCE }));
    }
  });
});

const alert: Alert = {
  id: randomUUID(), key: randomUUID(), ownerId: USER, status: 'active',
  createdAt: new Date('2026-10-24T08:00:00Z'), expiresAt: new Date('2026-10-24T10:00:00Z'),
  latitude: 9, longitude: 38, geohash: 'sc04', locationQuality: 'live', attemptCount: 0,
};
const projection: AlertProjection = {
  alertId: alert.id, alertKey: alert.key, displayName: 'Chosen contact projection',
  fuzzedLat: 9, fuzzedLng: 38, fuzzedPrecision: 'exact', isUrgent: false,
  status: 'active', createdAt: alert.createdAt, hasVoiceNote: false,
  reportedDelayMs: null, audience: 'contact',
};

function harness(over: Partial<WorkerDependencies> = {}) {
  const calls: string[] = [];
  const deps: WorkerDependencies = {
    tokenVerifier: () => ({ verify: async (value) => {
      calls.push(`verify:${value}`);
      if (value !== 'signed-session') throw new AppError('unauthenticated');
      return subject;
    } }),
    sessionIsActive: async (value) => { assert.deepEqual(value, subject); calls.push('live-session'); return true; },
    withRepositories: async (_env, value, run) => {
      assert.deepEqual(value, subject);
      calls.push('repositories');
      return run({
        alerts: { findActiveByOwner: async (uid) => { assert.equal(uid, USER); return alert; } },
        inbox: { listForRecipient: async (uid, limit) => {
          assert.equal(uid, USER); calls.push(`limit:${limit}`); return [projection];
        } },
      });
    },
    ...over,
  };
  return { app: createWorkersApp(deps), calls, deps };
}

function get(app: ReturnType<typeof createWorkersApp>, path: string, bearer = 'signed-session') {
  return app.request(path, { headers: { authorization: `Bearer ${bearer}` } }, {});
}

describe('Hono Workers read routes and activation gates', () => {
  test('health needs no credentials, database, JWKS or live-session dependency', async () => {
    const response = await createWorkersApp().request('/healthz', {}, {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
  test('a missing bearer token is rejected before validation or database work', async () => {
    const { app, calls } = harness();
    assert.equal((await app.request('/v1/me/inbox?uid=someone-else', {}, {})).status, 401);
    assert.deepEqual(calls, []);
  });
  test('the default entry refuses protected reads until live revocation checking is configured', async () => {
    const response = await get(createWorkersApp(), '/v1/me/inbox');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: 'unavailable', message: 'Service temporarily unavailable.' } });
  });
  test('a missing Auth binding fails closed without trying the database', async () => {
    const app = createWorkersApp({ sessionIsActive: async () => true });
    assert.equal((await get(app, '/v1/me/alert')).status, 503);
  });
  test('invalid JWTs are refused before session or data access', async () => {
    const { app, calls } = harness();
    assert.equal((await get(app, '/v1/me/alert', 'tampered')).status, 401);
    assert.deepEqual(calls, ['verify:tampered']);
  });
  test('revoked sessions are refused before data access', async () => {
    const { app, calls } = harness({ sessionIsActive: async () => false });
    assert.equal((await get(app, '/v1/me/alert')).status, 401);
    assert.deepEqual(calls, ['verify:signed-session']);
  });
  test('session-check outages fail closed as unavailable, never JWT-only success', async () => {
    const { app, calls } = harness({ sessionIsActive: async () => { throw new Error('private provider diagnostics'); } });
    const response = await get(app, '/v1/me/alert');
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private|provider/);
    assert.deepEqual(calls, ['verify:signed-session']);
  });
  test('inbox uses the verified subject and preserves the established projection response', async () => {
    const { app, calls } = harness();
    const response = await get(app, '/v1/me/inbox?limit=1');
    assert.equal(response.status, 200);
    const body = await response.json() as { items: Array<Record<string, unknown>>; limit: number; truncated: boolean };
    assert.equal(body.limit, 1);
    assert.equal(body.truncated, true);
    assert.equal(body.items[0]?.['precision'], 'exact');
    assert.equal(body.items[0]?.['latitude'], 9);
    assert.equal('alertKey' in body.items[0]!, false);
    assert.deepEqual(calls, ['verify:signed-session', 'live-session', 'repositories', 'limit:1']);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
  for (const query of ['uid=someone-else', 'limit=0', 'limit=101', 'limit=2.5', 'limit=1&limit=2', 'limit=foo']) {
    test(`rejects inbox query ${query} before repository access`, async () => {
      const { app, calls } = harness();
      assert.equal((await get(app, `/v1/me/inbox?${query}`)).status, 400);
      assert.equal(calls.includes('repositories'), false);
    });
  }
  test('own-alert returns its status without coordinates, owner identity or keyword material', async () => {
    const { app } = harness();
    const response = await get(app, '/v1/me/alert');
    assert.equal(response.status, 200);
    const body = await response.json() as { alert: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.alert).sort(), ['acknowledgmentCount', 'createdAt', 'expiresAt', 'hasLocation', 'id', 'key', 'locationQuality', 'reportedDelayMs', 'status']);
    assert.equal(body.alert['hasLocation'], true);
  });
  test('own-alert rejects another user selector', async () => {
    const { app, calls } = harness();
    assert.equal((await get(app, '/v1/me/alert?uid=someone-else')).status, 400);
    assert.equal(calls.includes('repositories'), false);
  });
  test('missing Hyperdrive binding fails closed even after authentication succeeds', async () => {
    const { withRepositories: _unused, ...deps } = harness().deps;
    const app = createWorkersApp(deps);
    assert.equal((await get(app, '/v1/me/inbox')).status, 503);
  });
  test('unported write endpoints have no working handler', async () => {
    const { app } = harness();
    const response = await app.request('/v1/not-ported', { method: 'POST', headers: { authorization: 'Bearer signed-session' } }, {});
    assert.equal(response.status, 404);
  });
});
