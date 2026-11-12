import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkersApp } from '../src/workers/app.js';
import { buildServer } from '../src/server.js';
import { makeDeps, OWNER, PEPPER, authAs, FakeUserRepository, FakeKeywordResetRepository, FakeAlertRepository, FakeEvidenceRepository, FakeEvidenceStore } from './fakes.js';
import { hashKeyword, verifyKeyword } from '../src/crypto/keyword.js';

function harness() {
  const users = new FakeUserRepository(); users.set(OWNER, { safetyKeywordHash: null });
  const alerts = new FakeAlertRepository(), resets = new FakeKeywordResetRepository();
  const evidence = new FakeEvidenceRepository(), evidenceStore = new FakeEvidenceStore();
  const deps = makeDeps({ users, alerts, keywordResets: resets, evidence, evidenceStore });
  const app = createWorkersApp({
    sessionIsActive: async () => true,
    tokenVerifier: () => ({ verify: async () => ({ uid: OWNER, sessionId: 'synthetic-session' }) }),
    withRepositories: async (_env, _subject, run) => run({ alerts, inbox: deps.inbox, writes: deps })
  });
  const send = (path: string, body: unknown, method = 'POST', pepper: string | undefined = PEPPER) => app.request(path, {
    method, headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, pepper === undefined ? {} : { KEYWORD_PEPPER: pepper });
  return { app, deps, users, alerts, resets, send, evidence, evidenceStore };
}
describe('Workers write gates and strict schema parity', () => {
  test('missing authoritative pepper leaves SOS unavailable without creating state', async () => {
    const h = harness(); const r = await h.app.request('/v1/alerts', { method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'request-valid' }) }, {});
    assert.equal(r.status, 503); assert.equal(h.alerts.store.size, 0);
  });
  for (const body of [{}, { requestId: 'short' }, { requestId: 'request-valid', ownerId: 'another' },
  { requestId: 'request-valid', latitude: '9', longitude: 38 }, { requestId: 'request-valid', latitude: 91, longitude: 38 },
  { requestId: 'request-valid', latitude: 9 }, { requestId: 'request-valid', accuracyMeters: 0 },
  { requestId: 'request-valid', locationAgeMs: -1 }, { requestId: 'request-valid', occurredAt: 'x'.repeat(65) }]) {
    test(`rejects the same invalid SOS as Fastify: ${JSON.stringify(body)}`, async () => {
      const h = harness(); const fast = buildServer(h.deps);
      try {
        assert.equal((await h.send('/v1/alerts', body)).status, 400);
        assert.equal((await fast.inject({ method: 'POST', url: '/v1/alerts', headers: authAs(OWNER), payload: body })).statusCode, 400);
        assert.equal(h.alerts.store.size, 0);
      } finally { await fast.close(); }
    });
  }
  test('malformed JSON and oversized streams cannot create an SOS', async () => {
    const h = harness(); for (const body of ['{', JSON.stringify({ requestId: 'request-valid', occurredAt: 'x'.repeat(70000) })]) {
      const r = await h.app.request('/v1/alerts', { method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, body }, { KEYWORD_PEPPER: PEPPER });
      assert.equal(r.status, 400); assert.equal(h.alerts.store.size, 0);
    }
  });
  test('valid SOS accepts unknown location and an unusable timestamp; retry reuses incident', async () => {
    const h = harness(); const body = { requestId: 'request-valid', occurredAt: 'bad-clock', latitude: null, longitude: null };
    const first = await h.send('/v1/alerts', body), again = await h.send('/v1/alerts', body);
    assert.equal(first.status, 201); assert.equal(again.status, 200);
    const a = await first.json() as { alert: { id: string; hasLocation: boolean; }; };
    assert.equal(a.alert.hasLocation, false); assert.equal(a.alert.id, OWNER); assert.equal(h.alerts.store.size, 1);
  });
  test('wrong and correct keyword responses remain indistinguishable', async () => {
    const h = harness(); h.users.set(OWNER, { safetyKeywordHash: await hashKeyword('teacup', PEPPER) });
    h.alerts.seed({ id: OWNER, ownerId: OWNER });
    const wrong = await h.send(`/v1/alerts/${OWNER}/resolve`, { keyword: 'incorrect' });
    assert.equal(h.alerts.store.get(OWNER)?.status, 'escalated');
    const correct = await h.send(`/v1/alerts/${OWNER}/resolve`, { keyword: 'teacup' });
    assert.equal(h.alerts.store.get(OWNER)?.status, 'resolved');
    assert.equal(wrong.status, correct.status); assert.deepEqual(await wrong.json(), await correct.json());
  });
  test('another owner cannot resolve an incident', async () => {
    const h = harness(); h.alerts.seed({ id: 'other', ownerId: 'other' });
    assert.equal((await h.send('/v1/alerts/other/resolve', { keyword: 'teacup' })).status, 404);
    assert.equal(h.alerts.store.get('other')?.status, 'active');
  });
  test('keyword recovery confirms through its atomic repository operation', async () => {
    const h = harness(); assert.equal((await h.send('/v1/me/keyword/reset', {})).status, 202);
    const r = h.resets.store.get(OWNER)!; h.resets.store.set(OWNER, { ...r, eligibleAt: new Date(0) });
    assert.equal((await h.send('/v1/me/keyword/reset/confirm', { keyword: 'tangerine' })).status, 200);
    assert.ok(await verifyKeyword('tangerine', h.users.store.get(OWNER)!.safetyKeywordHash!, PEPPER));
    assert.equal(h.resets.store.get(OWNER)?.status, 'confirmed');
  });
});


describe('Workers evidence and acceptance integration', () => {
  test('an owner finalizes immutable evidence, replay is safe and cross-owner access is denied', async () => {
    const h = harness(); h.alerts.seed({ id: OWNER, ownerId: OWNER });
    const ticket = await h.send(`/v1/alerts/${OWNER}/evidence`, { contentType: 'audio/aac', kind: 'deliberate' });
    assert.equal(ticket.status, 201);
    const { evidenceId } = await ticket.json() as { evidenceId: string; };
    const record = (await h.deps.evidence.findById(evidenceId))!;
    h.evidenceStore.land(record.storagePath, new TextEncoder().encode('immutable bytes'));
    assert.equal((await h.send(`/v1/evidence/${evidenceId}/complete`, {})).status, 200);
    const published = (await h.deps.evidence.findById(evidenceId))!; assert.ok(published.sha256);
    h.evidenceStore.land(record.storagePath, new TextEncoder().encode('replacement'));
    assert.equal((await h.send(`/v1/evidence/${evidenceId}/complete`, {})).status, 200);
    assert.equal((await h.deps.evidence.findById(evidenceId))!.storagePath, published.storagePath);
    h.alerts.seed({ id: 'other', ownerId: 'other' });
    assert.equal((await h.send('/v1/alerts/other/evidence', { contentType: 'audio/aac' })).status, 404);
  });
  test('missing storage configuration returns 503 before evidence metadata is created', async () => {
    const h = harness(); h.alerts.seed({ id: OWNER, ownerId: OWNER });
    const app = createWorkersApp({
      sessionIsActive: async () => true, tokenVerifier: () => ({ verify: async () => ({ uid: OWNER, sessionId: 'session' }) }),
      withRepositories: async (_env, _actor, run) => run({ alerts: h.alerts, inbox: h.deps.inbox, writes: { ...h.deps, evidenceStore: undefined } as unknown as import('../src/workers/app.js').MutationRepositories })
    });
    const response = await app.request(`/v1/alerts/${OWNER}/evidence`, { method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, body: '{"contentType":"audio/aac"}' }, { KEYWORD_PEPPER: PEPPER });
    assert.equal(response.status, 503); assert.equal(h.evidence.store.size, 0);
  });
  test('acceptance requires selection, is idempotent and does not resolve the incident', async () => {
    const h = harness(); h.alerts.seed({ id: 'incident', ownerId: 'other' });
    assert.equal((await h.send('/v1/alerts/incident/accept', {})).status, 404);
    await h.deps.inbox.put(OWNER, {
      alertId: 'incident', displayName: '', fuzzedLat: 9, fuzzedLng: 38, fuzzedPrecision: 'geohash7',
      isUrgent: false, status: 'active', createdAt: new Date(), hasVoiceNote: false, reportedDelayMs: null, audience: 'contact'
    });
    const accepted = await h.send('/v1/alerts/incident/accept', {}), replay = await h.send('/v1/alerts/incident/accept', {});
    assert.equal(accepted.status, 201); assert.equal(replay.status, 200); assert.deepEqual(await accepted.json(), await replay.json());
    assert.equal(h.alerts.store.get('incident')!.status, 'active');
  });
  test('policy-blocked reveal and responder playback are explicit 503s', async () => {
    const h = harness();
    assert.equal((await h.send('/v1/alerts/incident/reveal', {})).status, 503);
    for (const path of ['/v1/alerts/incident/evidence/responder']) assert.equal((await h.send(path, undefined, 'GET')).status, 503);
  });
});


test('Workers owner export uses verified identity, scoped repositories and expiring links', async () => {
  const h = harness(); h.alerts.seed({ id: OWNER, ownerId: OWNER });
  const response = await h.send('/v1/me/export', undefined, 'GET'); assert.equal(response.status, 200);
  const body = await response.json() as { uid: string; profile: Record<string, unknown>; }; assert.equal(body.uid, OWNER);
  assert.equal(JSON.stringify(body).includes('safetyKeywordHash'), false);
  assert.match(response.headers.get('content-disposition')!, /attachment/);
  assert.equal((await h.send('/v1/me/export?uid=other', undefined, 'GET')).status, 400);
});
test('public Worker app policy works without login, refuses selectors, and allows launch during outages', async () => {
  const app = createWorkersApp({ clientPolicy: async () => ({ android: { minVersion: '2.0.0', latestVersion: '3.0.0' }, ios: { minVersion: null, latestVersion: null } }) });
  const response = await app.request('/v1/app/policy?platform=android&version=1.0.0', {}, {});
  assert.equal(response.status, 200); assert.equal((await response.json() as { mustUpgrade: boolean; }).mustUpgrade, true);
  const unavailable = createWorkersApp({ clientPolicy: async () => { throw Error('synthetic DB failure'); } });
  assert.equal((await (await unavailable.request('/v1/app/policy?platform=android&version=1.0.0', {}, {})).json() as { mustUpgrade: boolean; }).mustUpgrade, false);
  assert.equal((await app.request('/v1/app/policy?platform=android&uid=other', {}, {})).status, 400);
});
