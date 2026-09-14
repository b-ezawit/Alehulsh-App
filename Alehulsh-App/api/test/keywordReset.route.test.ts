import { test, describe, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { hashKeyword, verifyKeyword } from '../src/crypto/keyword.js';
import { RESET_DELAY_MS, keywordResetDeletableStore } from '../src/routes/keywordReset.js';
import { AccountDeleter } from '../src/services/AccountDeleter.js';
import { createLogger } from '../src/logger.js';
import {
  makeDeps, FakeAlertRepository, FakeUserRepository, FakeKeywordResetRepository,
  authAs, OWNER, PEPPER,
} from './fakes.js';

const FORGOTTEN = 'sunflower';
const NEW = 'blue-teacup';

let alerts: FakeAlertRepository;
let users: FakeUserRepository;
let keywordResets: FakeKeywordResetRepository;
let app: ReturnType<typeof buildServer>;
let oldHash: string;

before(async () => { oldHash = await hashKeyword(FORGOTTEN, PEPPER); });

beforeEach(() => {
  alerts = new FakeAlertRepository();
  users = new FakeUserRepository();
  keywordResets = new FakeKeywordResetRepository();
  app = buildServer(makeDeps({ alerts, users, keywordResets }));
  users.set(OWNER, { safetyKeywordHash: oldHash });
});

const request = (uid = OWNER) =>
  app.inject({ method: 'POST', url: '/v1/me/keyword/reset', headers: authAs(uid), payload: {} });
const status = (uid = OWNER) =>
  app.inject({ method: 'GET', url: '/v1/me/keyword/reset', headers: authAs(uid) });
const cancel = (uid = OWNER) =>
  app.inject({ method: 'DELETE', url: '/v1/me/keyword/reset', headers: authAs(uid) });
const confirm = (keyword = NEW, uid = OWNER) =>
  app.inject({
    method: 'POST', url: '/v1/me/keyword/reset/confirm', headers: authAs(uid), payload: { keyword },
  });

/** Move the window into the past, as if 72 hours had elapsed. */
const elapse = () => {
  const r = keywordResets.store.get(OWNER)!;
  keywordResets.store.set(OWNER, { ...r, eligibleAt: new Date(Date.now() - 1000) });
};

describe('the delay is the defence', () => {
  test('requesting changes nothing — the old keyword still works', async () => {
    const res = await request();
    assert.equal(res.statusCode, 202);
    assert.equal(res.json().currentKeywordStillWorks, true);
    // Unchanged. A pending reset must not weaken the mechanism while she waits.
    assert.equal(users.store.get(OWNER)!.safetyKeywordHash, oldHash);
  });

  test('confirming before the window elapses is refused', async () => {
    await request();
    const res = await confirm();
    assert.equal(res.statusCode, 409);
    assert.equal(users.store.get(OWNER)!.safetyKeywordHash, oldHash);
  });

  test('the window is 72 hours', async () => {
    await request();
    const r = keywordResets.store.get(OWNER)!;
    assert.equal(r.eligibleAt.getTime() - r.requestedAt.getTime(), RESET_DELAY_MS);
  });

  test('re-requesting does not restart the clock', async () => {
    await request();
    const first = keywordResets.store.get(OWNER)!.eligibleAt.getTime();
    await new Promise((r) => setTimeout(r, 5));
    await request();
    // Otherwise asking repeatedly would hold the window open indefinitely.
    assert.equal(keywordResets.store.get(OWNER)!.eligibleAt.getTime(), first);
  });

  test('after the window, the new keyword takes effect', async () => {
    await request();
    elapse();
    const res = await confirm();
    assert.equal(res.statusCode, 200);
    const stored = users.store.get(OWNER)!.safetyKeywordHash!;
    assert.ok(await verifyKeyword(NEW, stored, PEPPER));
    assert.equal(await verifyKeyword(FORGOTTEN, stored, PEPPER), false);
  });

  test('she never has to know the forgotten keyword', async () => {
    // The entire point. Nothing in this flow asks for the old one.
    await request();
    elapse();
    assert.equal((await confirm()).statusCode, 200);
  });
});

describe('danger voids a pending reset', () => {
  test('raising an alert during the window kills it', async () => {
    await request();
    await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'sos-request-1' },
    });
    // Closes the obvious attack: start a reset, wait it out, then coerce her.
    assert.equal(keywordResets.store.get(OWNER)!.status, 'voided_by_alert');
    assert.equal((await status()).json().pending, false);
  });

  test('a voided reset stays dead once the emergency is over', async () => {
    await request();
    await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'sos-request-1' },
    });
    // Resolve it, so the live-alert refusal is out of the way and the only
    // thing left standing between him and the keyword is the voiding itself.
    await alerts.updateStatus(OWNER, 'resolved', { resolvedAt: new Date() });
    elapse();

    const res = await confirm();
    assert.equal(res.statusCode, 404);
    assert.equal(users.store.get(OWNER)!.safetyKeywordHash, oldHash);
  });

  test('a live alert refuses the confirm before anything else is considered', async () => {
    await request();
    await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'sos-request-1' },
    });
    elapse();
    assert.equal((await confirm()).statusCode, 409);
  });
});

describe('no bypass while an alert is live', () => {
  test('a reset cannot be requested during an alert', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'active' });
    assert.equal((await request()).statusCode, 409);
    assert.equal(keywordResets.store.size, 0);
  });

  test('a reset cannot be confirmed during an alert', async () => {
    await request();
    elapse();
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'escalated' });
    // A coercer who can trigger this mid-emergency has defeated the mechanism.
    assert.equal((await confirm()).statusCode, 409);
    assert.equal(users.store.get(OWNER)!.safetyKeywordHash, oldHash);
  });
});

describe('visibility and cancellation', () => {
  test('a pending reset is visible, so a secret one is impossible', async () => {
    await request();
    const body = (await status()).json();
    assert.equal(body.pending, true);
    assert.ok(body.eligibleAt);
  });

  test('she can cancel without knowing the keyword', async () => {
    // She has forgotten it. Requiring it to cancel would make the escape hatch
    // as locked as the door.
    await request();
    assert.equal((await cancel()).statusCode, 200);
    assert.equal((await status()).json().pending, false);
    assert.equal(keywordResets.store.get(OWNER)!.cancelledReason, 'user');
  });

  test('a cancelled reset cannot be confirmed', async () => {
    await request();
    await cancel();
    elapse();
    assert.equal((await confirm()).statusCode, 404);
  });
});

describe('the new keyword still has to be a real one', () => {
  test('the shipped default is refused at confirm', async () => {
    await request();
    elapse();
    assert.equal((await confirm('Milo')).statusCode, 400);
    assert.equal(users.store.get(OWNER)!.safetyKeywordHash, oldHash);
  });

  test('something too short is refused', async () => {
    await request();
    elapse();
    assert.equal((await confirm('ab')).statusCode, 400);
  });
});

describe('access control and deletion', () => {
  test('unauthenticated is rejected on every step', async () => {
    for (const [method, url] of [
      ['POST', '/v1/me/keyword/reset'],
      ['GET', '/v1/me/keyword/reset'],
      ['DELETE', '/v1/me/keyword/reset'],
      ['POST', '/v1/me/keyword/reset/confirm'],
    ] as const) {
      const res = await app.inject({ method, url, payload: { keyword: NEW } });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
    }
  });

  test('confirming with no pending reset is refused', async () => {
    assert.equal((await confirm()).statusCode, 404);
  });

  test('deletion reaches a pending reset', async () => {
    await request();
    const deleter = new AccountDeleter(
      [keywordResetDeletableStore(keywordResets)], createLogger('error'),
    );
    const receipt = await deleter.deleteAccount(OWNER);
    assert.equal(receipt.purged.keyword_resets, 1);
    assert.equal(keywordResets.store.size, 0);
  });
});
