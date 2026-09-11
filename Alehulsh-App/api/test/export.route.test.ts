import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import {
  makeDeps, FakeAlertRepository, FakeUserRepository, FakeContactRepository,
  FakeEvidenceRepository, FakeEvidenceStore, authAs, OWNER, STRANGER,
} from './fakes.js';

let alerts: FakeAlertRepository;
let users: FakeUserRepository;
let contacts: FakeContactRepository;
let evidence: FakeEvidenceRepository;
let evidenceStore: FakeEvidenceStore;
let app: ReturnType<typeof buildServer>;

const KEYWORD_HASH = 'scrypt$65536$8$1$abc$def';

beforeEach(() => {
  alerts = new FakeAlertRepository();
  users = new FakeUserRepository();
  contacts = new FakeContactRepository();
  evidence = new FakeEvidenceRepository();
  evidenceStore = new FakeEvidenceStore();
  app = buildServer(makeDeps({ alerts, users, contacts, evidence, evidenceStore }));

  users.set(OWNER, { safetyKeywordHash: KEYWORD_HASH });
  contacts.set(OWNER, [
    { id: 'c1', ownerUid: OWNER, name: 'Sister', phoneHash: 'h1', emailHash: null, isPrimary: true },
    { id: 'c2', ownerUid: OWNER, name: 'Neighbour', phoneHash: null, emailHash: null, isPrimary: false },
  ]);
});

const exportFor = (uid: string) =>
  app.inject({ method: 'GET', url: '/v1/me/export', headers: authAs(uid) });

describe('P2-21 — she can obtain her own data', () => {
  test('the export contains her contacts and alert', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'resolved' });
    const body = (await exportFor(OWNER)).json();

    assert.equal(body.uid, OWNER);
    assert.equal(body.emergencyContacts.length, 2);
    assert.equal(body.emergencyContacts[0].name, 'Sister');
    assert.equal(body.currentAlert.status, 'resolved');
  });

  test('it is served as a file she can hand to a lawyer', async () => {
    const res = await exportFor(OWNER);
    assert.match(String(res.headers['content-disposition']), /attachment; filename="alehulsh-export-/);
  });

  test('failed keyword attempts are included — a cluster of them is evidence', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'escalated', attemptCount: 4 });
    const body = (await exportFor(OWNER)).json();
    assert.equal(body.currentAlert.failedKeywordAttempts, 4);
  });

  test('recordings come as expiring links, never as bytes or permanent URLs', async () => {
    await evidence.create({
      id: 'e1', alertId: OWNER, ownerUid: OWNER,
      storagePath: `evidence/${OWNER}/${OWNER}/e1`, contentType: 'audio/aac',
      sizeBytes: 2048, durationMs: 30_000, createdAt: new Date(), uploaded: true,
    });
    evidenceStore.land(`evidence/${OWNER}/${OWNER}/e1`, 2048);

    const body = (await exportFor(OWNER)).json();
    const [item] = body.evidence;
    assert.ok(item.downloadUrl);
    // A permanent link inside an exported file would be a standing grant to
    // the most sensitive data we hold, surviving in whatever inbox it lands in.
    assert.ok(new Date(item.downloadUrlExpiresAt).getTime() > Date.now());
    assert.equal(JSON.stringify(body).includes('base64'), false);
  });
});

describe('what the export must not contain', () => {
  test('never the safety keyword or its hash', async () => {
    const body = (await exportFor(OWNER)).json();
    assert.equal(body.profile.safetyKeywordSet, true);
    assert.equal(JSON.stringify(body).includes(KEYWORD_HASH), false);
    assert.equal(JSON.stringify(body).includes('safetyKeywordHash'), false);
  });

  test('never contact identifier hashes', async () => {
    const body = (await exportFor(OWNER)).json();
    // Reachability is useful to her; the hashes are not, and re-exporting them
    // would put a correlatable identifier into a file that leaves our control.
    assert.equal(body.emergencyContacts[0].reachable, true);
    assert.equal(body.emergencyContacts[1].reachable, false);
    assert.equal(JSON.stringify(body).includes('h1'), false);
  });

  test('never the internal storage path', async () => {
    await evidence.create({
      id: 'e1', alertId: OWNER, ownerUid: OWNER,
      storagePath: `evidence/${OWNER}/${OWNER}/e1`, contentType: 'audio/aac',
      sizeBytes: 1, durationMs: null, createdAt: new Date(), uploaded: true,
    });
    const body = (await exportFor(OWNER)).json();
    assert.equal(JSON.stringify(body).includes('storagePath'), false);
  });
});

describe('only ever her own data', () => {
  test('the export is scoped to the token, with no uid to tamper with', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'active' });
    const body = (await exportFor(STRANGER)).json();
    assert.equal(body.uid, STRANGER);
    assert.equal(body.currentAlert, null);
    assert.equal(body.emergencyContacts.length, 0);
  });

  test('unauthenticated is rejected', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me/export' })).statusCode, 401);
  });

  test('repeated exports are rate limited', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await exportFor(OWNER)).statusCode, 200);
    assert.equal((await exportFor(OWNER)).statusCode, 429);
  });
});

describe('the export states its own limits', () => {
  test('it says alert history is not included', async () => {
    // The alert document is keyed by uid, so each SOS overwrites the last. An
    // export must never be mistaken for a complete record when the schema
    // cannot produce one.
    const body = (await exportFor(OWNER)).json();
    assert.ok(body.knownGaps.some((g: string) => /history is not included/i.test(g)));
  });

  test('it names recordings that never finished uploading', async () => {
    await evidence.create({
      id: 'e2', alertId: OWNER, ownerUid: OWNER,
      storagePath: `evidence/${OWNER}/${OWNER}/e2`, contentType: 'audio/aac',
      sizeBytes: null, durationMs: null, createdAt: new Date(), uploaded: false,
    });
    const body = (await exportFor(OWNER)).json();
    assert.equal(body.evidence[0].downloadUrl, null);
    // Named, not silently dropped — a recording that never landed is exactly
    // the thing she would otherwise assume she had.
    assert.ok(body.knownGaps.some((g: string) => /never finished uploading/i.test(g)));
  });
});
