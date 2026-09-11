import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { versionTelemetryDeletableStore } from '../src/routes/appPolicy.js';
import { AccountDeleter } from '../src/services/AccountDeleter.js';
import { createLogger } from '../src/logger.js';
import {
  makeDeps, FakeClientPolicyRepository, FakeVersionTelemetryRepository,
  authAs, OWNER, testConfig,
} from './fakes.js';

let clientPolicy: FakeClientPolicyRepository;
let versionTelemetry: FakeVersionTelemetryRepository;
let app: ReturnType<typeof buildServer>;

beforeEach(() => {
  clientPolicy = new FakeClientPolicyRepository();
  versionTelemetry = new FakeVersionTelemetryRepository();
  app = buildServer(makeDeps({ clientPolicy, versionTelemetry }));
  clientPolicy.policy.android = { minVersion: '1.2.0', latestVersion: '1.5.0' };
});

const ask = (query: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/v1/app/policy?${query}`, headers });

describe('P1-26.1 — the upgrade floor', () => {
  test('a client below the minimum is told to upgrade', async () => {
    const res = await ask('platform=android&version=1.1.0');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().mustUpgrade, true);
    assert.equal(res.json().minVersion, '1.2.0');
  });

  test('a client at or above the minimum is not', async () => {
    assert.equal((await ask('platform=android&version=1.2.0')).json().mustUpgrade, false);
    assert.equal((await ask('platform=android&version=2.0.0')).json().mustUpgrade, false);
  });

  test('the endpoint is unauthenticated — it runs before sign-in', async () => {
    // The user who cannot sign in is exactly the one who may need an update.
    const res = await ask('platform=android&version=1.1.0');
    assert.equal(res.statusCode, 200);
  });

  test('the floor can be raised without a restart', async () => {
    assert.equal((await ask('platform=android&version=1.3.0')).json().mustUpgrade, false);
    clientPolicy.policy.android.minVersion = '1.4.0';
    assert.equal((await ask('platform=android&version=1.3.0')).json().mustUpgrade, true);
  });
});

describe('when in doubt, do not block', () => {
  test('an unreadable client version does not block', async () => {
    assert.equal((await ask('platform=android&version=garbage')).json().mustUpgrade, false);
  });

  test('a missing client version does not block', async () => {
    assert.equal((await ask('platform=android')).json().mustUpgrade, false);
  });

  test('a typo in the configured minimum does not brick every install', async () => {
    clientPolicy.policy.android.minVersion = '1.2';   // not a version
    assert.equal((await ask('platform=android&version=1.0.0')).json().mustUpgrade, false);
  });

  test('no configured minimum does not block', async () => {
    clientPolicy.policy.android.minVersion = null;
    assert.equal((await ask('platform=android&version=0.0.1')).json().mustUpgrade, false);
  });

  test('a platform with no policy does not block', async () => {
    assert.equal((await ask('platform=ios&version=0.0.1')).json().mustUpgrade, false);
  });

  test('an unknown platform is rejected rather than guessed at', async () => {
    assert.equal((await ask('platform=symbian&version=1.0.0')).statusCode, 400);
  });
});

describe('P1-26.3 — adoption telemetry', () => {
  test('a signed-in caller has their version recorded', async () => {
    await ask('platform=android&version=1.3.0', authAs(OWNER));
    assert.equal(versionTelemetry.store.get(OWNER)?.version, '1.3.0');
  });

  test('an anonymous caller still gets an answer and records nothing', async () => {
    const res = await ask('platform=android&version=1.3.0');
    assert.equal(res.statusCode, 200);
    assert.equal(versionTelemetry.store.size, 0);
  });

  test('a telemetry failure never affects the answer', async () => {
    versionTelemetry.record = async () => { throw new Error('telemetry store down'); };
    const res = await ask('platform=android&version=1.1.0', authAs(OWNER));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().mustUpgrade, true);
  });

  test('only the latest version per account is kept, not a history', async () => {
    await ask('platform=android&version=1.3.0', authAs(OWNER));
    await ask('platform=android&version=1.4.0', authAs(OWNER));
    assert.equal(versionTelemetry.store.size, 1);
    assert.equal(versionTelemetry.store.get(OWNER)?.version, '1.4.0');
  });

  test('the distribution is operator-only', async () => {
    await ask('platform=android&version=1.3.0', authAs(OWNER));
    const anon = await app.inject({ method: 'GET', url: '/internal/version-distribution' });
    assert.equal(anon.statusCode, 404);

    const asUser = await app.inject({
      method: 'GET', url: '/internal/version-distribution', headers: authAs(OWNER),
    });
    assert.equal(asUser.statusCode, 404);

    const operator = await app.inject({
      method: 'GET', url: '/internal/version-distribution',
      headers: { 'x-task-secret': testConfig.taskRunnerSecret },
    });
    assert.equal(operator.statusCode, 200);
    assert.deepEqual(operator.json().distribution, { '1.3.0': 1 });
  });
});

describe('deletion reaches the version record — C-16', () => {
  test('purging an account removes it', async () => {
    await ask('platform=android&version=1.3.0', authAs(OWNER));
    const deleter = new AccountDeleter(
      [versionTelemetryDeletableStore(versionTelemetry)], createLogger('error'),
    );
    const receipt = await deleter.deleteAccount(OWNER);
    assert.equal(receipt.purged.client_versions, 1);
    assert.equal(versionTelemetry.store.size, 0);
  });
});
