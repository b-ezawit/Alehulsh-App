import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, type Deps } from '../src/server.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';
import { createLogger } from '../src/logger.js';
import { distanceMetres } from '../src/geo.js';
import { revealDeletableStore } from '../src/routes/reveal.js';
import { AccountDeleter } from '../src/services/AccountDeleter.js';
import type { AlertProjection } from '../src/repositories/types.js';
import {
  FakeAlertRepository, FakeUserRepository, FakeInboxRepository, FakeAcceptanceRepository,
  FakeLocationRevealRepository, fakeVerifier, authAs, OWNER, testConfig,
} from './fakes.js';

const HELPER = 'helper_uid';
const OUTSIDER = 'outsider_uid';
const ALERT = 'alert_1';

// Meskel Square, Addis Ababa.
const TRUE_LAT = 9.0125;
const TRUE_LNG = 38.7636;
/** ~20m north — inside the 50m radius. */
const NEAR = { latitude: 9.01268, longitude: 38.7636 };
/** ~500m north — outside it. */
const FAR = { latitude: 9.0170, longitude: 38.7636 };

let alerts: FakeAlertRepository;
let inbox: FakeInboxRepository;
let acceptances: FakeAcceptanceRepository;
let reveals: FakeLocationRevealRepository;
let app: ReturnType<typeof buildServer>;

const projection = (): AlertProjection => ({
  alertId: ALERT, displayName: '',
  fuzzedLat: 9.0125, fuzzedLng: 38.7636, fuzzedPrecision: '~150m',
  isUrgent: false, status: 'active', createdAt: new Date('2026-09-11T10:00:00Z'),
  hasVoiceNote: false, audience: 'responder',
});

beforeEach(() => {
  alerts = new FakeAlertRepository();
  inbox = new FakeInboxRepository();
  acceptances = new FakeAcceptanceRepository();
  reveals = new FakeLocationRevealRepository();
  const deps: Deps = {
    config: testConfig, logger: createLogger('error'), tokenVerifier: fakeVerifier,
    alerts, users: new FakeUserRepository(), inbox, acceptances, reveals,
    queue: new InMemoryTaskQueue(),
  };
  app = buildServer(deps);
  alerts.seed({ id: ALERT, ownerId: OWNER, status: 'active', latitude: TRUE_LAT, longitude: TRUE_LNG });
});

const reveal = (uid: string, at: { latitude: number; longitude: number }, alertId = ALERT) =>
  app.inject({ method: 'POST', url: `/v1/alerts/${alertId}/reveal`, headers: authAs(uid), payload: at });

const acceptAs = (uid: string) =>
  app.inject({ method: 'POST', url: `/v1/alerts/${ALERT}/accept`, headers: authAs(uid), payload: {} });

describe('P2-08.2 — both conditions required', () => {
  test('accepted and close: released', async () => {
    await inbox.put(HELPER, projection());
    await acceptAs(HELPER);
    const res = await reveal(HELPER, NEAR);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().granted, true);
    assert.equal(res.json().location.latitude, TRUE_LAT);
    assert.equal(res.json().location.precision, 'exact');
  });

  test('close but never accepted: denied', async () => {
    await inbox.put(HELPER, projection());
    const res = await reveal(HELPER, NEAR);
    assert.equal(res.json().granted, false);
    assert.equal(res.json().location, undefined);
    assert.equal(reveals.log.at(-1)!.deniedReason, 'not_accepted');
  });

  test('accepted but far away: denied', async () => {
    await inbox.put(HELPER, projection());
    await acceptAs(HELPER);
    const res = await reveal(HELPER, FAR);
    assert.equal(res.json().granted, false);
    assert.equal(res.json().location, undefined);
    assert.equal(reveals.log.at(-1)!.deniedReason, 'too_far');
  });

  test('never selected: cannot even reach the check', async () => {
    await inbox.put(HELPER, projection());
    const res = await reveal(OUTSIDER, NEAR);
    assert.equal(res.statusCode, 404);
    assert.equal(reveals.log.length, 0);
  });

  test('unauthenticated is rejected', async () => {
    await inbox.put(HELPER, projection());
    const res = await app.inject({ method: 'POST', url: `/v1/alerts/${ALERT}/reveal`, payload: NEAR });
    assert.equal(res.statusCode, 401);
  });
});

describe('the denial must leak nothing — no distance oracle', () => {
  test('every denial is byte-identical regardless of cause or distance', async () => {
    await inbox.put(HELPER, projection());
    const notAccepted = await reveal(HELPER, NEAR);

    await acceptAs(HELPER);
    const far = await reveal(HELPER, FAR);
    const slightlyOutside = await reveal(HELPER, { latitude: 9.01305, longitude: 38.7636 });

    assert.deepEqual(notAccepted.json(), far.json());
    assert.deepEqual(far.json(), slightlyOutside.json());
    assert.equal(far.statusCode, slightlyOutside.statusCode);
  });

  test('no response anywhere contains a distance or bearing', async () => {
    await inbox.put(HELPER, projection());
    await acceptAs(HELPER);
    for (const at of [FAR, NEAR]) {
      const body = JSON.stringify((await reveal(HELPER, at)).json());
      for (const leak of ['distance', 'metres', 'meters', 'bearing', 'closer', 'heading']) {
        assert.equal(body.toLowerCase().includes(leak), false, `${leak} leaked in ${body}`);
      }
    }
  });

  test('an alert with no location denies without revealing that fact differently', async () => {
    alerts.seed({ id: ALERT, ownerId: OWNER, status: 'active', latitude: null, longitude: null });
    await inbox.put(HELPER, projection());
    await acceptAs(HELPER);
    const noLocation = await reveal(HELPER, NEAR);
    assert.equal(noLocation.json().granted, false);
    assert.equal(reveals.log.at(-1)!.deniedReason, 'alert_has_no_location');
  });
});

describe('throttling the position search', () => {
  test('attempts beyond the cap are refused', async () => {
    await inbox.put(HELPER, projection());
    await acceptAs(HELPER);
    for (let i = 0; i < testConfig.revealAttemptCap; i++) await reveal(HELPER, FAR);

    // Now standing right next to her — still refused, because the budget is spent.
    const res = await reveal(HELPER, NEAR);
    assert.equal(res.json().granted, false);
    assert.equal(reveals.log.at(-1)!.deniedReason, 'throttled');
  });

  test('throttling looks like any other denial', async () => {
    await inbox.put(HELPER, projection());
    await acceptAs(HELPER);
    const first = await reveal(HELPER, FAR);
    for (let i = 0; i < testConfig.revealAttemptCap; i++) await reveal(HELPER, FAR);
    const throttled = await reveal(HELPER, FAR);
    assert.equal(throttled.statusCode, first.statusCode);
    assert.deepEqual(throttled.json(), first.json());
  });
});

describe('P2-08.3 — every release is attributable', () => {
  test('a grant is logged with responder, time and claimed position', async () => {
    await inbox.put(HELPER, projection());
    await acceptAs(HELPER);
    await reveal(HELPER, NEAR);
    const [entry] = reveals.granted();
    assert.equal(entry!.responderUid, HELPER);
    assert.equal(entry!.alertId, ALERT);
    assert.equal(entry!.claimedLat, NEAR.latitude);
    assert.ok(entry!.at instanceof Date);
    assert.ok(entry!.distanceM! < testConfig.revealRadiusM);
  });

  test('denials are logged too — the failures are the signal', async () => {
    await inbox.put(HELPER, projection());
    await acceptAs(HELPER);
    await reveal(HELPER, FAR);
    await reveal(HELPER, FAR);
    assert.equal(reveals.log.length, 2);
    assert.equal(reveals.granted().length, 0);
  });

  test('nothing is released when the audit append fails', async () => {
    await inbox.put(HELPER, projection());
    await acceptAs(HELPER);
    reveals.append = async () => { throw new Error('audit store down'); };
    const res = await reveal(HELPER, NEAR);
    // An unlogged reveal must not be possible, so the request fails instead.
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.stringify(res.json()).includes(String(TRUE_LAT)), false);
  });
});

describe('access dies with the alert', () => {
  test('a resolved alert releases nothing', async () => {
    await inbox.put(HELPER, projection());
    await acceptAs(HELPER);
    alerts.seed({ id: ALERT, ownerId: OWNER, status: 'resolved', latitude: TRUE_LAT, longitude: TRUE_LNG });
    const res = await reveal(HELPER, NEAR);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'alert_closed');
  });

  test('an escalated alert still releases — she is in more danger, not less', async () => {
    alerts.seed({ id: ALERT, ownerId: OWNER, status: 'escalated', latitude: TRUE_LAT, longitude: TRUE_LNG });
    await inbox.put(HELPER, projection());
    await acceptAs(HELPER);
    const res = await reveal(HELPER, NEAR);
    assert.equal(res.json().granted, true);
  });
});

describe('deletion reaches the reveal log — C-16', () => {
  test('purging a responder removes their attempts', async () => {
    await inbox.put(HELPER, projection());
    await acceptAs(HELPER);
    await reveal(HELPER, NEAR);
    const deleter = new AccountDeleter([revealDeletableStore(reveals)], createLogger('error'));
    const receipt = await deleter.deleteAccount(HELPER);
    assert.equal(receipt.purged.location_reveals, 1);
    assert.equal(reveals.log.length, 0);
  });
});

describe('distanceMetres', () => {
  test('zero for the same point', () => {
    assert.equal(distanceMetres(TRUE_LAT, TRUE_LNG, TRUE_LAT, TRUE_LNG), 0);
  });

  test('one degree of latitude is about 111km', () => {
    const d = distanceMetres(9, 38.76, 10, 38.76);
    assert.ok(d > 110_000 && d < 112_000, `got ${d}`);
  });

  test('symmetric', () => {
    const a = distanceMetres(9.0125, 38.7636, 9.0170, 38.7700);
    const b = distanceMetres(9.0170, 38.7700, 9.0125, 38.7636);
    assert.ok(Math.abs(a - b) < 1e-6);
  });
});
