import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, type Deps } from '../src/server.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';
import { createLogger } from '../src/logger.js';
import type { Alert, AlertRepository, AlertStatus, UserRepository } from '../src/repositories/types.js';
import type { TokenVerifier } from '../src/auth/TokenVerifier.js';

const OWNER = 'alice_uid';
const ACTIVE_WINDOW = 2 * 60 * 60 * 1000;
const SAFETY_DELAY = 2 * 60 * 1000;

/** Mirrors the Firestore repository's contract without needing Firestore. */
class FakeAlertRepository implements AlertRepository {
  readonly store = new Map<string, Alert>();
  createCalls = 0;

  async findById(id: string) { return this.store.get(id) ?? null; }
  async findActiveByOwner(ownerId: string) {
    const a = this.store.get(ownerId);
    return a && (a.status === 'active' || a.status === 'escalated') ? a : null;
  }
  async create(input: { requestId: string; ownerId: string; latitude: number | null; longitude: number | null }) {
    this.createCalls++;
    const existing = this.store.get(input.ownerId);
    if (existing && (existing.status === 'active' || existing.status === 'escalated')) {
      return { alert: existing, created: false };
    }
    const now = new Date();
    const alert: Alert = {
      id: input.ownerId,
      ownerId: input.ownerId,
      status: 'active',
      createdAt: now,
      expiresAt: new Date(now.getTime() + ACTIVE_WINDOW),
      latitude: input.latitude,
      longitude: input.longitude,
      geohash: input.latitude !== null ? 'sc04zjw4b' : null,
    };
    this.store.set(alert.id, alert);
    return { alert, created: true };
  }
  async updateStatus(id: string, next: AlertStatus, fields: Partial<Alert>) {
    const a = this.store.get(id)!;
    const updated = { ...a, ...fields, status: next };
    this.store.set(id, updated);
    return updated;
  }
}

const verifier: TokenVerifier = {
  verify: async (t) => {
    if (t !== 'good-token') throw new Error('bad token');
    return { uid: OWNER };
  },
};

let repo: FakeAlertRepository;
let queue: InMemoryTaskQueue;

function server() {
  repo = new FakeAlertRepository();
  queue = new InMemoryTaskQueue();
  const deps: Deps = {
    config: {
      port: 0, logLevel: 'error', firebaseProjectId: 'test',
      env: 'development', activeWindowMs: ACTIVE_WINDOW, safetyCheckDelayMs: SAFETY_DELAY,
    },
    logger: createLogger('error'),
    tokenVerifier: verifier,
    alerts: repo,
    users: {} as UserRepository,
    queue,
  };
  return buildServer(deps);
}

const AUTH = { authorization: 'Bearer good-token' };
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
