import { test, describe, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, type Deps } from '../src/server.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';
import { createLogger } from '../src/logger.js';
import { hashKeyword } from '../src/crypto/keyword.js';
import { taskKeys } from '../src/tasks.js';
import {
  FakeAlertRepository, FakeUserRepository, FakeInboxRepository, FakeAcceptanceRepository, fakeVerifier, authAs,
  OWNER, STRANGER, PEPPER, testConfig,
} from './fakes.js';

const KEYWORD = 'sunflower';
let alerts: FakeAlertRepository;
let users: FakeUserRepository;
let queue: InMemoryTaskQueue;
let app: ReturnType<typeof buildServer>;
let hash: string;

before(async () => { hash = await hashKeyword(KEYWORD, PEPPER); });

beforeEach(() => {
  alerts = new FakeAlertRepository();
  users = new FakeUserRepository();
  queue = new InMemoryTaskQueue();
  users.set(OWNER, { safetyKeywordHash: hash });
  const deps: Deps = {
    config: testConfig, logger: createLogger('error'), tokenVerifier: fakeVerifier,
    alerts, users, queue,
    inbox: new FakeInboxRepository(), acceptances: new FakeAcceptanceRepository(),
  };
  app = buildServer(deps);
});

const seedActive = () => alerts.seed({ id: OWNER, ownerId: OWNER, status: 'active' });
const resolve = (uid: string, keyword: string) =>
  app.inject({ method: 'POST', url: `/v1/alerts/${OWNER}/resolve`, headers: authAs(uid), payload: { keyword } });

describe('POST /v1/alerts/:id/resolve — authorization', () => {
  test('a stranger cannot resolve someone else alert', async () => {
    seedActive();
    const res = await resolve(STRANGER, KEYWORD);
    assert.equal(res.statusCode, 404);
    assert.equal(alerts.store.get(OWNER)!.status, 'active');
  });

  test('unauthenticated is rejected', async () => {
    seedActive();
    const res = await app.inject({
      method: 'POST', url: `/v1/alerts/${OWNER}/resolve`, payload: { keyword: KEYWORD },
    });
    assert.equal(res.statusCode, 401);
  });
});

describe('the coercion requirement — responses must be identical', () => {
  test('correct and wrong keyword return the same status and body', async () => {
    seedActive();
    const right = await resolve(OWNER, KEYWORD);
    alerts.store.clear(); seedActive();
    const wrong = await resolve(OWNER, 'not-the-keyword');
    assert.equal(right.statusCode, wrong.statusCode);
    assert.equal(right.body, wrong.body);
  });

  test('a user with no keyword set gets the same response too', async () => {
    seedActive();
    users.set(OWNER, { safetyKeywordHash: null, mustSetKeyword: true });
    const none = await resolve(OWNER, 'anything');
    alerts.store.clear(); seedActive();
    users.set(OWNER, { safetyKeywordHash: hash });
    const right = await resolve(OWNER, KEYWORD);
    assert.equal(none.body, right.body);
  });

  test('an already-resolved alert answers identically — a replay confirms nothing', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'resolved' });
    const replay = await resolve(OWNER, KEYWORD);
    alerts.store.clear(); seedActive();
    const fresh = await resolve(OWNER, KEYWORD);
    assert.equal(replay.body, fresh.body);
  });

  test('the response carries no state at all', async () => {
    seedActive();
    const res = await resolve(OWNER, KEYWORD);
    assert.deepEqual(res.json(), { acknowledged: true });
  });
});

describe('correct keyword', () => {
  test('resolves the alert', async () => {
    seedActive();
    await resolve(OWNER, KEYWORD);
    assert.equal(alerts.store.get(OWNER)!.status, 'resolved');
    assert.equal(alerts.store.get(OWNER)!.resolvedBy, 'owner');
  });

  test('cancels the safety check and the expiry backstop', async () => {
    const a = seedActive();
    await queue.schedule({ key: taskKeys.safetyCheck(a), runAt: new Date(), payload: {} });
    await queue.schedule({ key: taskKeys.expiry(a), runAt: new Date(), payload: {} });
    await resolve(OWNER, KEYWORD);
    assert.equal(queue.scheduled.size, 0);
  });

  test('a late answer on an escalated alert resolves as owner_late', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'escalated' });
    await resolve(OWNER, KEYWORD);
    const a = alerts.store.get(OWNER)!;
    assert.equal(a.status, 'resolved');
    assert.equal(a.resolvedBy, 'owner_late');
  });

  test('accepts despite case and whitespace', async () => {
    seedActive();
    await resolve(OWNER, '  SUNFLOWER ');
    assert.equal(alerts.store.get(OWNER)!.status, 'resolved');
  });
});

describe('wrong keyword', () => {
  test('escalates rather than doing nothing — this did not exist before', async () => {
    seedActive();
    await resolve(OWNER, 'wrong');
    const a = alerts.store.get(OWNER)!;
    assert.equal(a.status, 'escalated');
    assert.equal(a.escalationReason, 'wrong_keyword');
  });

  test('queues the contact notification', async () => {
    seedActive();
    await resolve(OWNER, 'wrong');
    const keys = [...queue.scheduled.keys()];
    assert.equal(keys.filter((k) => k.startsWith('notify-contacts:')).length, 1);
  });

  test('records the attempt — a cluster of these is evidence', async () => {
    seedActive();
    await resolve(OWNER, 'wrong');
    assert.equal(alerts.store.get(OWNER)!.attemptCount, 1);
  });

  test('never deletes the alert', async () => {
    seedActive();
    await resolve(OWNER, 'wrong');
    assert.ok(alerts.store.has(OWNER));
  });
});

describe('CRIT-05 regressions', () => {
  test('no keyword configured does NOT resolve — any string used to work', async () => {
    // alert_service.dart:301 — matched = (input == 'milo' || input.isNotEmpty)
    seedActive();
    users.set(OWNER, { safetyKeywordHash: null, mustSetKeyword: true });
    await resolve(OWNER, 'literally anything');
    assert.notEqual(alerts.store.get(OWNER)!.status, 'resolved');
  });

  test('the shipped default does not resolve a real keyword', async () => {
    seedActive();
    await resolve(OWNER, 'milo');
    assert.notEqual(alerts.store.get(OWNER)!.status, 'resolved');
  });

  test('verification happens server-side — the client cannot assert success', async () => {
    seedActive();
    const res = await app.inject({
      method: 'POST', url: `/v1/alerts/${OWNER}/resolve`, headers: authAs(OWNER),
      payload: { keyword: 'wrong', resolved: true, status: 'resolved' },
    });
    assert.equal(res.statusCode, 400); // additionalProperties rejected
    assert.equal(alerts.store.get(OWNER)!.status, 'active');
  });
});

describe('throttling — bounded, but never a lockout', () => {
  test('attempts past the cap are silently not processed', async () => {
    alerts.seed({
      id: OWNER, ownerId: OWNER, status: 'escalated',
      attemptCount: 3, lastAttemptAt: new Date(),
    });
    const res = await resolve(OWNER, KEYWORD);
    assert.equal(res.statusCode, 200);
    // correct keyword, but throttled — deliberately not resolved
    assert.equal(alerts.store.get(OWNER)!.status, 'escalated');
  });

  test('throttling is invisible — same response as a processed attempt', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'escalated', attemptCount: 3, lastAttemptAt: new Date() });
    const throttled = await resolve(OWNER, 'wrong');
    alerts.store.clear(); seedActive();
    const processed = await resolve(OWNER, 'wrong');
    assert.equal(throttled.statusCode, processed.statusCode);
    assert.equal(throttled.body, processed.body);
  });

  test('she is never locked out — once the cooldown passes, the keyword works', async () => {
    alerts.seed({
      id: OWNER, ownerId: OWNER, status: 'escalated', attemptCount: 99,
      lastAttemptAt: new Date(Date.now() - testConfig.keywordAttemptCooldownMs - 1000),
    });
    await resolve(OWNER, KEYWORD);
    assert.equal(alerts.store.get(OWNER)!.status, 'resolved');
  });
});

describe('timing', () => {
  test('a missing keyword costs the same as a real check — no timing oracle', async () => {
    seedActive();
    const t0 = Date.now();
    await resolve(OWNER, 'wrong');
    const withHash = Date.now() - t0;

    alerts.store.clear(); seedActive();
    users.set(OWNER, { safetyKeywordHash: null, mustSetKeyword: true });
    const t1 = Date.now();
    await resolve(OWNER, 'wrong');
    const withoutHash = Date.now() - t1;

    // Both must actually run scrypt. Without the dummy hash the second path
    // would return in ~1ms and tell a coercer there is no secret to guess.
    assert.ok(withHash > 20, `expected real work, got ${withHash}ms`);
    assert.ok(withoutHash > 20, `expected dummy work, got ${withoutHash}ms`);
  });
});
