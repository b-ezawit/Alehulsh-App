import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { Alert } from '../src/repositories/types.js';
import type { Logger } from '../src/logger.js';
import { requiredAlertWork, expediteAlertWork } from '../src/services/alertWork.js';
import { prepareAlertWork, relayAlertWork, ALERT_WORK_COLLECTION } from '../src/queue/FirestoreAlertWork.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';

const CREATED = new Date('2026-10-24T08:00:00Z');
const DELAY = 120_000;
function alert(fields: Partial<Alert> = {}): Alert {
  return {
    id: 'owner-slot', key: 'incident-one', ownerId: 'owner', status: 'active',
    createdAt: CREATED, expiresAt: new Date(CREATED.getTime() + 7_200_000),
    latitude: null, longitude: null, geohash: null,
    locationQuality: 'unavailable', attemptCount: 0,
    ...fields,
  };
}

describe('required emergency work uses immutable incident deadlines', () => {
  test('a replay reconstructs every required task without postponing it', () => {
    const original = requiredAlertWork(alert(), DELAY);
    const retry = requiredAlertWork(alert({ attemptCount: 3 }), DELAY);
    assert.deepEqual(retry, original);
    assert.deepEqual(original.map((t) => [t.payload['kind'], t.runAt.toISOString()]), [
      ['safety-check', '2026-10-24T08:02:00.000Z'],
      ['expiry', '2026-10-24T10:00:00.000Z'],
      ['notify-contacts', '2026-10-24T08:00:00.000Z'],
    ]);
    assert.ok(original.every((t) => t.payload['alertKey'] === 'incident-one'));
  });

  test('escalation includes missing initialization and its own durable notification', () => {
    const escalatedAt = new Date(CREATED.getTime() + 30_000);
    const work = requiredAlertWork(alert({ status: 'escalated', escalatedAt }), DELAY);
    assert.equal(work.length, 4);
    assert.equal(work.find((t) => t.key.endsWith(':escalation'))?.runAt, escalatedAt);
    assert.equal(work.filter((t) => t.payload['kind'] === 'notify-contacts').length, 2);
    assert.equal(work.find((t) => t.payload['kind'] === 'safety-check')?.runAt.getTime(), CREATED.getTime() + DELAY);
  });

  test('every terminal state schedules only incident-scoped retraction', () => {
    for (const status of ['resolved', 'cancelled', 'expired'] as const) {
      const work = requiredAlertWork(alert({ status }), DELAY);
      assert.equal(work.length, 1);
      assert.equal(work[0]!.payload['kind'], 'retract-inbox');
      assert.equal(work[0]!.payload['alertKey'], 'incident-one');
      assert.equal(work[0]!.key, 'retract-inbox:incident-one');
    }
  });

  test('slot reuse gets separate notification and retraction identities', () => {
    const first = requiredAlertWork(alert(), DELAY);
    const second = requiredAlertWork(alert({ key: 'incident-two', createdAt: CREATED }), DELAY);
    assert.equal(new Set([...first, ...second].map((t) => t.key)).size, first.length + second.length);
  });
});

describe('expedited dispatch cannot lose durable emergency work', () => {
  test('failure scheduling one task does not skip later tasks or fail the SOS', async () => {
    const attempted: string[] = [];
    const logs: unknown[] = [];
    const queue = new InMemoryTaskQueue();
    const schedule = queue.schedule.bind(queue);
    queue.schedule = async (task) => {
      attempted.push(String(task.payload['kind']));
      if (task.payload['kind'] === 'safety-check') throw new Error('secret provider detail');
      await schedule(task);
    };
    const logger: Logger = {
      debug() {}, info() {}, warn() {}, error: (message, context) => { logs.push({ message, context }); },
    };
    await expediteAlertWork(alert(), DELAY, queue, logger);
    assert.deepEqual(attempted, ['safety-check', 'expiry', 'notify-contacts']);
    assert.equal(queue.scheduled.size, 2);
    assert.equal(logs.length, 1);
    assert.ok(!JSON.stringify(logs).includes('secret provider detail'));
  });

  test('retry repairs partial dispatch with the original deadlines and keys', async () => {
    const queue = new InMemoryTaskQueue();
    const schedule = queue.schedule.bind(queue);
    let failing = true;
    queue.schedule = async (task) => {
      if (failing && task.payload['kind'] === 'expiry') throw new Error('unavailable');
      await schedule(task);
    };
    const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    await expediteAlertWork(alert(), DELAY, queue, logger);
    assert.equal(queue.scheduled.size, 2);
    failing = false;
    await expediteAlertWork(alert(), DELAY, queue, logger);
    assert.equal(queue.scheduled.size, 3);
    assert.deepEqual([...queue.scheduled.values()].sort((a, b) => a.key.localeCompare(b.key)),
      requiredAlertWork(alert(), DELAY).sort((a, b) => a.key.localeCompare(b.key)));
  });
});

/** In-memory protocol fixture, not a replacement for emulator transaction tests. */
function outboxFixture() {
  const rows = new Map<string, Record<string, unknown>>();
  let failDelivered = false;
  const reference = (id: string) => ({ id, update: async (patch: Record<string, unknown>) => {
    if (failDelivered) throw new Error('outbox update unavailable');
    Object.assign(rows.get(id)!, patch);
  } });
  const db = { collection(name: string) {
    assert.equal(name, ALERT_WORK_COLLECTION);
    return {
      doc: reference,
      where: (_field: string, _comparison: string, state: string) => ({ limit: (limit: number) => ({
        get: async () => ({ docs: [...rows].filter(([, d]) => d['state'] === state).slice(0, limit)
          .map(([id, d]) => ({ data: () => d, ref: reference(id) })) }),
      }) }),
    };
  } } as unknown as Firestore;
  const tx = {
    getAll: async (...refs: Array<{ id: string }>) => refs.map((ref) => ({ exists: rows.has(ref.id) })),
    create: (ref: { id: string }, data: Record<string, unknown>) => {
      assert.ok(!rows.has(ref.id), 'prepare must not recreate committed outbox entries');
      rows.set(ref.id, data);
    },
  } as unknown as Transaction;
  return { db, tx, rows, failUpdates: (fail: boolean) => { failDelivered = fail; } };
}

describe('Firestore durable handoff survives queue and acknowledgment failures', () => {
  test('preparation performs reads first and retries preserve existing entries', async () => {
    const { db, tx, rows } = outboxFixture();
    const persist = await prepareAlertWork(db, tx, alert(), DELAY);
    assert.equal(rows.size, 0, 'the caller must be able to finish all transaction reads before writing');
    persist();
    assert.equal(rows.size, 3);
    const before = [...rows];
    (await prepareAlertWork(db, tx, alert(), DELAY))();
    assert.deepEqual([...rows], before);
  });

  test('queue outage leaves durable pending work and a later relay delivers it', async () => {
    const { db, tx, rows } = outboxFixture();
    (await prepareAlertWork(db, tx, alert(), DELAY))();
    const queue = new InMemoryTaskQueue();
    const schedule = queue.schedule.bind(queue);
    let unavailable = true;
    queue.schedule = async (task) => {
      if (unavailable) throw new Error('queue unavailable');
      await schedule(task);
    };
    await assert.rejects(relayAlertWork(db, queue), /remains pending/);
    assert.equal([...rows.values()].filter((d) => d['state'] === 'pending').length, 3);
    unavailable = false;
    assert.equal(await relayAlertWork(db, queue), 3);
    assert.equal(queue.scheduled.size, 3);
    assert.equal([...rows.values()].filter((d) => d['state'] === 'delivered').length, 3);
    assert.equal(await relayAlertWork(db, queue), 0);
  });

  test('a crash after enqueue but before acknowledgment replays the same task identity', async () => {
    const { db, tx, rows, failUpdates } = outboxFixture();
    (await prepareAlertWork(db, tx, alert(), DELAY))();
    const queue = new InMemoryTaskQueue();
    failUpdates(true);
    await assert.rejects(relayAlertWork(db, queue), /remains pending/);
    assert.equal(queue.scheduled.size, 3);
    assert.equal([...rows.values()].filter((d) => d['state'] === 'pending').length, 3);
    const firstKey = [...queue.scheduled.keys()][0]!;
    failUpdates(false);
    assert.equal(await relayAlertWork(db, queue), 3);
    assert.equal(queue.scheduled.size, 3, 'retry must collapse the previously enqueued task');
    assert.ok(queue.scheduled.has(firstKey));
  });
});
