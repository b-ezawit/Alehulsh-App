import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, type Deps } from '../src/server.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';
import { createLogger } from '../src/logger.js';
import { FakeAlertRepository, FakeUserRepository, fakeVerifier, authAs, OWNER, ACTIVE_WINDOW, SAFETY_DELAY, testConfig } from './fakes.js';

let repo: FakeAlertRepository;
let queue: InMemoryTaskQueue;

function server() {
  repo = new FakeAlertRepository();
  queue = new InMemoryTaskQueue();
  const deps: Deps = {
    config: testConfig,
    logger: createLogger('error'),
    tokenVerifier: fakeVerifier,
    alerts: repo,
    users: new FakeUserRepository(),
    queue,
  };
  return buildServer(deps);
}

const AUTH = authAs(OWNER);
let app: ReturnType<typeof server>;
beforeEach(() => { app = server(); });

describe('POST /v1/alerts', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/alerts', payload: { requestId: 'req-00000001' } });
    assert.equal(res.statusCode, 401);
    assert.equal(repo.createCalls, 0);
  });

  test('creates an alert and returns 201', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: AUTH,
      payload: { requestId: 'req-00000001', latitude: 9.0125, longitude: 38.7636 },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.alert.status, 'active');
    assert.equal(body.alert.hasLocation, true);
  });

  test('is idempotent — a retry returns 200 and does not duplicate', async () => {
    const p = { requestId: 'req-00000001', latitude: 9.0125, longitude: 38.7636 };
    const first = await app.inject({ method: 'POST', url: '/v1/alerts', headers: AUTH, payload: p });
    const retry = await app.inject({ method: 'POST', url: '/v1/alerts', headers: AUTH, payload: p });
    assert.equal(first.statusCode, 201);
    assert.equal(retry.statusCode, 200);
    assert.equal(repo.store.size, 1);
  });

  test('a re-trigger does NOT reschedule the safety check', async () => {
    // alert-lifecycle.md §7 — otherwise repeated triggering postpones
    // escalation indefinitely, which is exactly what a coercer would do.
    await app.inject({ method: 'POST', url: '/v1/alerts', headers: AUTH, payload: { requestId: 'req-00000001' } });
    const afterFirst = [...queue.scheduled.keys()];
    await app.inject({ method: 'POST', url: '/v1/alerts', headers: AUTH, payload: { requestId: 'req-00000002' } });
    assert.deepEqual([...queue.scheduled.keys()], afterFirst);
  });

  test('schedules both the safety check and the expiry backstop', async () => {
    await app.inject({ method: 'POST', url: '/v1/alerts', headers: AUTH, payload: { requestId: 'req-00000001' } });
    const keys = [...queue.scheduled.keys()];
    assert.equal(keys.filter((k) => k.startsWith('safety-check:')).length, 1);
    assert.equal(keys.filter((k) => k.startsWith('expiry:')).length, 1);
    const check = [...queue.scheduled.values()].find((t) => t.payload['kind'] === 'safety-check')!;
    const alert = repo.store.get(OWNER)!;
    assert.equal(check.runAt.getTime() - alert.createdAt.getTime(), SAFETY_DELAY);
  });

  test('accepts an alert with no location', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: AUTH,
      payload: { requestId: 'req-00000001', latitude: null, longitude: null },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().alert.hasLocation, false);
  });

  test('rejects half a fix', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: AUTH,
      payload: { requestId: 'req-00000001', latitude: 9.0125, longitude: null },
    });
    assert.equal(res.statusCode, 400);
  });

  test('rejects an out-of-range latitude', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: AUTH,
      payload: { requestId: 'req-00000001', latitude: 999, longitude: 38.7 },
    });
    assert.equal(res.statusCode, 400);
  });

  test('rejects unknown body fields', async () => {
    // Mass assignment: a client must not be able to set status or ownerId.
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: AUTH,
      payload: { requestId: 'req-00000001', status: 'resolved', userId: 'victim_uid' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('timestamps come from the server, not the client', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: AUTH,
      payload: { requestId: 'req-00000001' },
    });
    const { createdAt, expiresAt } = res.json().alert;
    assert.equal(new Date(expiresAt).getTime() - new Date(createdAt).getTime(), ACTIVE_WINDOW);
  });

  test('the response does not echo coordinates back', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: AUTH,
      payload: { requestId: 'req-00000001', latitude: 9.0125, longitude: 38.7636 },
    });
    assert.ok(!res.body.includes('9.0125'));
    assert.ok(!res.body.includes('38.7636'));
  });
});
