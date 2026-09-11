import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';
import { makeDeps, FakeAlertRepository, authAs, OWNER, ACTIVE_WINDOW, SAFETY_DELAY, testConfig } from './fakes.js';

let repo: FakeAlertRepository;
let queue: InMemoryTaskQueue;

function server() {
  repo = new FakeAlertRepository();
  queue = new InMemoryTaskQueue();
  return buildServer(makeDeps({ alerts: repo, queue }));
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

describe('P1-15 — abuse ceiling on alert creation', () => {
  test('a live emergency is never rate limited, however many retries', async () => {
    const app = server();
    // First creates; the rest fold into it. None of them consult the limiter,
    // because she already has an alert running.
    for (let i = 0; i < testConfig.alertCreateCap + 5; i++) {
      const res = await app.inject({
        method: 'POST', url: '/v1/alerts', headers: AUTH,
        payload: { requestId: `retry-request-${i}` },
      });
      assert.ok(res.statusCode === 200 || res.statusCode === 201, `retry ${i} -> ${res.statusCode}`);
    }
  });

  test('distinct alerts past the ceiling are refused', async () => {
    const app = server();
    const raise = async (i: number) => {
      const res = await app.inject({
        method: 'POST', url: '/v1/alerts', headers: AUTH, payload: { requestId: `sos-request-${i}` },
      });
      // Resolve it so the next one is a genuinely new alert rather than a fold.
      await repo.updateStatus(OWNER, 'resolved', {});
      return res;
    };
    for (let i = 0; i < testConfig.alertCreateCap; i++) {
      assert.equal((await raise(i)).statusCode, 201, `alert ${i}`);
    }
    const refused = await raise(999);
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.json().error.code, 'rate_limited');
  });

  test('the ceiling is per user', async () => {
    const app = server();
    for (let i = 0; i < testConfig.alertCreateCap; i++) {
      await app.inject({ method: 'POST', url: '/v1/alerts', headers: AUTH, payload: { requestId: `alpha-request-${i}` } });
      await repo.updateStatus(OWNER, 'resolved', {});
    }
    const other = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs('someone_else'), payload: { requestId: 'beta-request-1' },
    });
    assert.equal(other.statusCode, 201);
  });
});

describe('P3-13 — expiry is the server clock, staleness is labelled', () => {
  const raise = (app: ReturnType<typeof server>, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/alerts', headers: AUTH, payload: body });

  test('an alert queued offline beyond the window still dispatches', async () => {
    const app = server();
    // Triggered three hours ago with no signal, replayed now. Under a
    // device-stamped expiry this arrives already expired and is discarded.
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const res = await raise(app, { requestId: 'queued-request-1', occurredAt: threeHoursAgo });

    assert.equal(res.statusCode, 201);
    const alert = repo.store.get(OWNER)!;
    // Its window starts from arrival, not from when she pressed the button.
    assert.ok(alert.expiresAt.getTime() > Date.now());
    assert.ok(alert.expiresAt.getTime() - alert.createdAt.getTime() === ACTIVE_WINDOW);
  });

  test('the delay is reported so nobody thinks a three-hour-old position is current', async () => {
    const app = server();
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const res = await raise(app, {
      requestId: 'queued-request-2', occurredAt: threeHoursAgo, latitude: 9.01, longitude: 38.76,
    });
    const delay = res.json().alert.reportedDelayMs as number;
    assert.ok(delay >= 3 * 60 * 60 * 1000 - 5000, `got ${delay}`);
  });

  test('a fresh alert reports no meaningful delay', async () => {
    const app = server();
    const res = await raise(app, { requestId: 'fresh-request-1', occurredAt: new Date().toISOString() });
    assert.ok((res.json().alert.reportedDelayMs as number) < 5000);
  });

  test('no reported time is fine — the alert is what matters', async () => {
    const app = server();
    const res = await raise(app, { requestId: 'no-time-request-1' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().alert.reportedDelayMs, null);
  });

  test('a device clock running ahead does not produce a negative age', async () => {
    const app = server();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await raise(app, { requestId: 'future-request-1', occurredAt: future });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().alert.reportedDelayMs, null);
  });

  test('a malformed occurredAt is rejected rather than guessed at', async () => {
    const app = server();
    const res = await raise(app, { requestId: 'bad-time-request-1', occurredAt: 'yesterday-ish' });
    assert.equal(res.statusCode, 400);
  });

  test('the device clock never shortens the window', async () => {
    const app = server();
    const ancient = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    await raise(app, { requestId: 'ancient-request-1', occurredAt: ancient });
    const alert = repo.store.get(OWNER)!;
    assert.equal(alert.expiresAt.getTime() - alert.createdAt.getTime(), ACTIVE_WINDOW);
  });
});
