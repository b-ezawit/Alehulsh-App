import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, type Deps } from '../src/server.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';
import { InMemorySlidingWindowLimiter } from '../src/rate/RateLimiter.js';
import { createLogger } from '../src/logger.js';
import { acceptanceDeletableStore } from '../src/routes/accept.js';
import { AccountDeleter } from '../src/services/AccountDeleter.js';
import type { AlertProjection } from '../src/repositories/types.js';
import {
  FakeAlertRepository, FakeUserRepository, FakeInboxRepository, FakeAcceptanceRepository,
  FakeLocationRevealRepository, FakeEvidenceRepository, FakeEvidenceStore,
  fakeVerifier, authAs, OWNER, STRANGER, testConfig,
} from './fakes.js';

const HELPER = 'helper_uid';
const OUTSIDER = 'outsider_uid';
const ALERT = 'alert_1';

let alerts: FakeAlertRepository;
let inbox: FakeInboxRepository;
let acceptances: FakeAcceptanceRepository;
let queue: InMemoryTaskQueue;
let app: ReturnType<typeof buildServer>;

function projection(audience: 'responder' | 'contact'): AlertProjection {
  return {
    alertId: ALERT,
    displayName: '',
    // A snapped cell centre, not her position. The test asserts this is what
    // comes back — accepting must not upgrade it.
    fuzzedLat: 9.0125,
    fuzzedLng: 38.7636,
    fuzzedPrecision: 'geohash7',
    isUrgent: false,
    status: 'active',
    createdAt: new Date('2026-09-11T10:00:00Z'),
    hasVoiceNote: false,
    audience,
  };
}

beforeEach(() => {
  alerts = new FakeAlertRepository();
  inbox = new FakeInboxRepository();
  acceptances = new FakeAcceptanceRepository();
  queue = new InMemoryTaskQueue();
  const deps: Deps = {
    config: testConfig, logger: createLogger('error'), tokenVerifier: fakeVerifier,
    alerts, users: new FakeUserRepository(), inbox, acceptances, queue,
    limiter: new InMemorySlidingWindowLimiter(),
    evidence: new FakeEvidenceRepository(),
    evidenceStore: new FakeEvidenceStore(),
    reveals: new FakeLocationRevealRepository(),
  };
  app = buildServer(deps);
  alerts.seed({ id: ALERT, ownerId: OWNER, status: 'active' });
});

const accept = (uid: string, alertId = ALERT) =>
  app.inject({ method: 'POST', url: `/v1/alerts/${alertId}/accept`, headers: authAs(uid), payload: {} });

describe('P1-10 — only an alert you were notified about', () => {
  test('a selected responder can accept', async () => {
    await inbox.put(HELPER, projection('responder'));
    const res = await accept(HELPER);
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().acceptance.audience, 'responder');
    assert.equal(await acceptances.findFor(ALERT, HELPER) !== null, true);
  });

  test('someone who was never sent it cannot accept', async () => {
    await inbox.put(HELPER, projection('responder'));
    const res = await accept(OUTSIDER);
    assert.equal(res.statusCode, 404);
    assert.equal(await acceptances.findFor(ALERT, OUTSIDER), null);
  });

  test('not being selected is indistinguishable from the alert not existing', async () => {
    const notSelected = await accept(OUTSIDER);
    const noSuchAlert = await accept(OUTSIDER, 'no_such_alert');
    assert.equal(notSelected.statusCode, noSuchAlert.statusCode);
    assert.deepEqual(notSelected.json(), noSuchAlert.json());
  });

  test('the owner cannot accept her own alert — she is never in the fan-out', async () => {
    const res = await accept(OWNER);
    assert.equal(res.statusCode, 404);
  });

  test('unauthenticated is rejected', async () => {
    await inbox.put(HELPER, projection('responder'));
    const res = await app.inject({ method: 'POST', url: `/v1/alerts/${ALERT}/accept`, payload: {} });
    assert.equal(res.statusCode, 401);
  });
});

describe('P1-10 — only yourself', () => {
  test('the uid comes from the token, so a body cannot name someone else', async () => {
    await inbox.put(HELPER, projection('responder'));
    const res = await app.inject({
      method: 'POST', url: `/v1/alerts/${ALERT}/accept`, headers: authAs(HELPER),
      payload: { responderUid: STRANGER, uid: STRANGER },
    });
    // Rejected outright rather than silently ignored: removeAdditional is off,
    // so a client trying to impersonate is a bug we want to see, not absorb.
    assert.equal(res.statusCode, 400);
    assert.equal(await acceptances.findFor(ALERT, STRANGER), null);
  });

  test('accepting records only the caller', async () => {
    await inbox.put(HELPER, projection('responder'));
    await inbox.put(STRANGER, projection('responder'));
    await accept(HELPER);
    const all = await acceptances.listForAlert(ALERT);
    assert.deepEqual(all.map((a) => a.responderUid), [HELPER]);
  });
});

describe('accepting does not change the alert — alert-lifecycle.md §6', () => {
  test('status is untouched', async () => {
    await inbox.put(HELPER, projection('responder'));
    await accept(HELPER);
    assert.equal(alerts.store.get(ALERT)!.status, 'active');
  });

  test('the safety check and expiry are not cancelled', async () => {
    await inbox.put(HELPER, projection('responder'));
    await queue.schedule({ key: 'safety-check', runAt: new Date(), payload: { kind: 'safety-check', alertId: ALERT } });
    await accept(HELPER);
    // A helper on his way is not a confirmation that she is safe. If accepting
    // cancelled escalation, anyone who registers as a helper could silence the
    // alert of the woman he is standing next to.
    assert.equal(queue.scheduled.size, 1);
  });
});

describe('accepting grants no extra location detail — P2-08 is the reveal', () => {
  test('a responder gets back the fuzzed cell, not coordinates', async () => {
    await inbox.put(HELPER, projection('responder'));
    const body = (await accept(HELPER)).json();
    assert.equal(body.alert.precision, 'geohash7');
    assert.equal(body.alert.latitude, 9.0125);
    // The true position is seeded on the alert and must not appear.
    assert.equal(JSON.stringify(body).includes('exactLatitude'), false);
  });

  test('a contact keeps the contact view she was given', async () => {
    await inbox.put(STRANGER, projection('contact'));
    const body = (await accept(STRANGER)).json();
    assert.equal(body.acceptance.audience, 'contact');
  });
});

describe('replays and closed alerts', () => {
  test('accepting twice is idempotent and keeps the first timestamp', async () => {
    await inbox.put(HELPER, projection('responder'));
    const first = await accept(HELPER);
    const second = await accept(HELPER);
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 200);
    assert.equal(first.json().acceptance.acceptedAt, second.json().acceptance.acceptedAt);
    assert.equal((await acceptances.listForAlert(ALERT)).length, 1);
  });

  test('a resolved alert cannot be accepted', async () => {
    alerts.seed({ id: ALERT, ownerId: OWNER, status: 'resolved' });
    await inbox.put(HELPER, projection('responder'));
    const res = await accept(HELPER);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'alert_closed');
  });

  test('resolved and expired are indistinguishable to a responder', async () => {
    await inbox.put(HELPER, projection('responder'));
    alerts.seed({ id: ALERT, ownerId: OWNER, status: 'resolved' });
    const resolved = await accept(HELPER);
    alerts.seed({ id: ALERT, ownerId: OWNER, status: 'expired' });
    const expired = await accept(HELPER);
    assert.deepEqual(resolved.json(), expired.json());
  });

  test('an escalated alert can still be accepted — it is still live', async () => {
    alerts.seed({ id: ALERT, ownerId: OWNER, status: 'escalated' });
    await inbox.put(HELPER, projection('responder'));
    const res = await accept(HELPER);
    assert.equal(res.statusCode, 201);
  });
});

describe('deletion reaches acceptances — C-16', () => {
  test('purging a responder removes what they accepted', async () => {
    await inbox.put(HELPER, projection('responder'));
    await accept(HELPER);
    const deleter = new AccountDeleter([acceptanceDeletableStore(acceptances)], createLogger('error'));
    const receipt = await deleter.deleteAccount(HELPER);
    assert.equal(receipt.complete, true);
    assert.equal(receipt.purged.acceptances, 1);
    assert.equal(await acceptances.findFor(ALERT, HELPER), null);
  });
});
