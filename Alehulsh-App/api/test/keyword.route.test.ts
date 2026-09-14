import { test, describe, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { hashKeyword, verifyKeyword } from '../src/crypto/keyword.js';
import {
  makeDeps, FakeAlertRepository, FakeUserRepository, authAs, OWNER, PEPPER, testConfig,
} from './fakes.js';

const OLD = 'sunflower';
const NEW = 'blue-teacup';

let alerts: FakeAlertRepository;
let users: FakeUserRepository;
let app: ReturnType<typeof buildServer>;
let oldHash: string;

before(async () => { oldHash = await hashKeyword(OLD, PEPPER); });

beforeEach(() => {
  alerts = new FakeAlertRepository();
  users = new FakeUserRepository();
  app = buildServer(makeDeps({ alerts, users }));
});

const setKeyword = (uid: string, body: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: '/v1/me/keyword', headers: authAs(uid), payload: body });

describe('no bypass for an active alert — coercion-and-escalation.md §6', () => {
  test('the keyword cannot be changed while an alert is active', async () => {
    // Without this, "set it to X, now cancel" takes thirty seconds and voids
    // the entire mechanism.
    users.set(OWNER, { safetyKeywordHash: oldHash });
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'active' });

    const res = await setKeyword(OWNER, { keyword: NEW, currentKeyword: OLD });
    assert.equal(res.statusCode, 409);
    assert.equal(users.store.get(OWNER)!.safetyKeywordHash, oldHash);
  });

  test('nor while one is escalated', async () => {
    users.set(OWNER, { safetyKeywordHash: oldHash });
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'escalated' });
    assert.equal((await setKeyword(OWNER, { keyword: NEW, currentKeyword: OLD })).statusCode, 409);
  });

  test('the live-alert check runs before validation, so nothing leaks about the new value', async () => {
    users.set(OWNER, { safetyKeywordHash: oldHash });
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'active' });
    // An obviously invalid keyword still gets the conflict, not a 400 — the
    // refusal does not depend on what was submitted.
    assert.equal((await setKeyword(OWNER, { keyword: 'x' })).statusCode, 409);
  });

  test('once the alert is resolved it can be changed again', async () => {
    users.set(OWNER, { safetyKeywordHash: oldHash });
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'resolved' });
    assert.equal((await setKeyword(OWNER, { keyword: NEW, currentKeyword: OLD })).statusCode, 200);
  });
});

describe('setting one for the first time', () => {
  test('a user with none can set one without proving anything', async () => {
    const res = await setKeyword(OWNER, { keyword: NEW });
    assert.equal(res.statusCode, 200);
    const stored = users.store.get(OWNER)!.safetyKeywordHash!;
    assert.ok(await verifyKeyword(NEW, stored, PEPPER));
  });

  test('a user forced to reset by the migration does not need the old one', async () => {
    users.set(OWNER, { safetyKeywordHash: oldHash, mustSetKeyword: true });
    const res = await setKeyword(OWNER, { keyword: NEW });
    assert.equal(res.statusCode, 200);
    assert.equal(users.store.get(OWNER)!.mustSetKeyword, false);
  });

  test('the shipped default is refused', async () => {
    // 'Milo' shipped as every user's keyword. Accepting it back would recreate
    // a secret an attacker can guess on the first try.
    const res = await setKeyword(OWNER, { keyword: 'Milo' });
    assert.equal(res.statusCode, 400);
    assert.equal(users.store.get(OWNER), undefined);
  });

  test('something too short to be a secret is refused', async () => {
    assert.equal((await setKeyword(OWNER, { keyword: 'ab' })).statusCode, 400);
  });
});

describe('changing an existing one', () => {
  beforeEach(() => { users.set(OWNER, { safetyKeywordHash: oldHash }); });

  test('requires the current keyword', async () => {
    const res = await setKeyword(OWNER, { keyword: NEW });
    assert.equal(res.statusCode, 400);
    assert.equal(users.store.get(OWNER)!.safetyKeywordHash, oldHash);
  });

  test('a wrong current keyword is refused and changes nothing', async () => {
    // An abuser with her unlocked phone who does not know the keyword cannot
    // quietly take control of the mechanism.
    const res = await setKeyword(OWNER, { keyword: NEW, currentKeyword: 'not-it' });
    assert.equal(res.statusCode, 403);
    assert.equal(users.store.get(OWNER)!.safetyKeywordHash, oldHash);
  });

  test('the correct current keyword replaces it', async () => {
    const res = await setKeyword(OWNER, { keyword: NEW, currentKeyword: OLD });
    assert.equal(res.statusCode, 200);
    const stored = users.store.get(OWNER)!.safetyKeywordHash!;
    assert.ok(await verifyKeyword(NEW, stored, PEPPER));
    assert.equal(await verifyKeyword(OLD, stored, PEPPER), false);
  });

  test('setting it to the same value is refused', async () => {
    const res = await setKeyword(OWNER, { keyword: OLD, currentKeyword: OLD });
    assert.equal(res.statusCode, 400);
  });
});

describe('the plaintext never escapes', () => {
  test('no response body contains the keyword or the hash', async () => {
    const res = await setKeyword(OWNER, { keyword: NEW });
    const body = JSON.stringify(res.json());
    assert.equal(body.includes(NEW), false);
    assert.equal(body.includes('scrypt'), false);
    assert.deepEqual(res.json(), { keywordSet: true });
  });

  test('a rejection does not echo the submitted value back', async () => {
    const res = await setKeyword(OWNER, { keyword: 'Milo' });
    assert.equal(JSON.stringify(res.json()).toLowerCase().includes('milo'), false);
  });

  test('the stored value is a hash, not the keyword', async () => {
    await setKeyword(OWNER, { keyword: NEW });
    const stored = users.store.get(OWNER)!.safetyKeywordHash!;
    assert.equal(stored.includes(NEW), false);
    assert.ok(stored.startsWith('scrypt$'));
  });
});

describe('abuse', () => {
  test('changes are rate limited', async () => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await setKeyword(OWNER, { keyword: `keyword-${i}-value` })).statusCode, 200);
      users.set(OWNER, { safetyKeywordHash: null });
    }
    assert.equal((await setKeyword(OWNER, { keyword: 'one-too-many' })).statusCode, 429);
  });

  test('unauthenticated is rejected', async () => {
    const res = await app.inject({ method: 'PUT', url: '/v1/me/keyword', payload: { keyword: NEW } });
    assert.equal(res.statusCode, 401);
  });

  test('there is no uid parameter to tamper with', async () => {
    const res = await setKeyword(OWNER, { keyword: NEW, uid: 'someone_else' });
    assert.equal(res.statusCode, 400);
  });
});
