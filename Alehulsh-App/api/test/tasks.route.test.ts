import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';
import { createLogger } from '../src/logger.js';
import { taskKeys } from '../src/tasks.js';
import { FakeAlertRepository, FakeUserRepository, FakeInboxRepository, FakeAcceptanceRepository, FakeLocationRevealRepository, fakeVerifier, authAs, OWNER, testConfig } from './fakes.js';

let alerts: FakeAlertRepository;
let queue: InMemoryTaskQueue;
let app: ReturnType<typeof buildServer>;

beforeEach(() => {
  alerts = new FakeAlertRepository();
  queue = new InMemoryTaskQueue();
  app = buildServer({
    config: testConfig, logger: createLogger('error'), tokenVerifier: fakeVerifier,
    alerts, users: new FakeUserRepository(), queue,
    inbox: new FakeInboxRepository(), acceptances: new FakeAcceptanceRepository(),
    reveals: new FakeLocationRevealRepository(),
  });
});

const TASK_AUTH = { 'x-task-secret': testConfig.taskRunnerSecret };
const fire = (path: string, headers: Record<string, string> = TASK_AUTH) =>
  app.inject({ method: 'POST', url: `/internal/tasks/${path}`, headers, payload: { alertId: OWNER } });

describe('task endpoints are not user-callable', () => {
  test('no secret is rejected', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'active' });
    assert.equal((await fire('safety-check', {})).statusCode, 401);
    assert.equal(alerts.store.get(OWNER)!.status, 'active');
  });

  test('a wrong secret is rejected', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'active' });
    assert.equal((await fire('safety-check', { 'x-task-secret': 'nope' })).statusCode, 401);
  });

  test('a user bearer token is not a task credential', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'active' });
    const res = await fire('safety-check', authAs(OWNER) as unknown as Record<string, string>);
    assert.equal(res.statusCode, 401);
    // She must not be able to escalate her own alert without a failed check —
    // and neither can someone holding her phone.
    assert.equal(alerts.store.get(OWNER)!.status, 'active');
  });
});

describe('safety-check — silence is not consent', () => {
  test('escalates an alert still active when the window elapses', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'active' });
    const res = await fire('safety-check');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().handled, true);
    const a = alerts.store.get(OWNER)!;
    assert.equal(a.status, 'escalated');
    assert.equal(a.escalationReason, 'no_answer');
  });

  test('queues the contact notification', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'active' });
    await fire('safety-check');
    assert.equal([...queue.scheduled.keys()].filter((k) => k.startsWith('notify-contacts:')).length, 1);
  });

  test('does not drag a resolved alert back — she answered in time', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'resolved' });
    const res = await fire('safety-check');
    assert.equal(res.json().handled, false);
    assert.equal(alerts.store.get(OWNER)!.status, 'resolved');
  });

  test('does not re-escalate an already-escalated alert', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'escalated' });
    const res = await fire('safety-check');
    assert.equal(res.json().handled, false);
  });

  test('tolerates a missing alert', async () => {
    assert.equal((await fire('safety-check')).json().handled, false);
  });

  test('redelivery is idempotent — contacts are not told twice', async () => {
    // At-least-once delivery is normal for any queue.
    const a = alerts.seed({ id: OWNER, ownerId: OWNER, status: 'active' });
    await fire('safety-check');
    const afterFirst = [...queue.scheduled.keys()];
    alerts.seed({ ...a, status: 'active' });   // simulate redelivery before the write settled
    await fire('safety-check');
    assert.deepEqual([...queue.scheduled.keys()], afterFirst);
  });
});

describe('expiry — the backstop', () => {
  test('expires an escalated alert that was never resolved', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'escalated' });
    const res = await fire('expiry');
    assert.equal(res.json().handled, true);
    assert.equal(alerts.store.get(OWNER)!.status, 'expired');
  });

  test('expires an alert still active — this means escalation never ran', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'active' });
    await fire('expiry');
    assert.equal(alerts.store.get(OWNER)!.status, 'expired');
  });

  test('leaves a resolved alert alone', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'resolved' });
    assert.equal((await fire('expiry')).json().handled, false);
    assert.equal(alerts.store.get(OWNER)!.status, 'resolved');
  });

  test('notifies nobody — a late warning is worse than none', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'active' });
    await fire('expiry');
    assert.equal(queue.scheduled.size, 0);
  });

  test('redelivery is idempotent', async () => {
    alerts.seed({ id: OWNER, ownerId: OWNER, status: 'active' });
    await fire('expiry');
    assert.equal((await fire('expiry')).json().handled, false);
  });
});

describe('validation', () => {
  test('rejects a missing alertId', async () => {
    const res = await app.inject({
      method: 'POST', url: '/internal/tasks/safety-check', headers: TASK_AUTH, payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  test('task key construction is shared, so schedule and cancel agree', () => {
    const a = { id: 'x', createdAt: new Date(1700000000000) };
    assert.equal(taskKeys.safetyCheck(a), 'safety-check:x:1700000000000');
    assert.equal(taskKeys.expiry(a), 'expiry:x:1700000000000');
  });
});
