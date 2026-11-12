/** Real emulator transactions; synthetic data in a unique demo project only. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { FirestoreAlertRepository } from '../src/repositories/firestore/FirestoreAlertRepository.js';
import { ALERT_WORK_COLLECTION } from '../src/queue/FirestoreAlertWork.js';
import { AppError } from '../src/errors.js';
import { buildServer } from '../src/server.js';
import { makeDeps } from './fakes.js';

const PROJECT = `demo-workflow-${randomUUID().slice(0, 8)}`;
const WINDOW = 7_200_000;
const DELAY = 47_000;
let app: App | undefined;
let db: Firestore | undefined;
let available = false;

before(async () => {
  const endpoint = process.env['FIRESTORE_EMULATOR_HOST'];
  if (!endpoint) return;
  const url = new URL(`http://${endpoint}`);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'only loopback emulator is allowed');
  // Google client libraries otherwise probe the GCE metadata IP even when
  // application traffic is pointed at the emulator.
  process.env['METADATA_SERVER_DETECTION'] = 'none';
  app = initializeApp({ projectId: PROJECT }, PROJECT);
  db = getFirestore(app);
  // A configured but broken emulator must fail this suite, not silently skip.
  await db.collection('active_alerts').limit(1).get();
  available = true;
});

after(async () => {
  if (db) {
    for (const name of ['active_alerts', 'alert_history', ALERT_WORK_COLLECTION, 'keyword_resets', 'alert_requests']) {
      for (const ref of await db.collection(name).listDocuments()) await ref.delete();
    }
    await db.terminate();
  }
  if (app) await deleteApp(app);
});

function emulatorTest(name: string, fn: () => Promise<void>) {
  test(name, async (t) => {
    if (!available) { t.skip('FIRESTORE_EMULATOR_HOST not configured'); return; }
    await fn();
  });
}

function owner() { return `workflow-${randomUUID()}`; }
function repository(connection: Firestore = db!) {
  return new FirestoreAlertRepository(connection, WINDOW, DELAY);
}
function createInput(uid: string, requestId = 'workflow-request-one') {
  return { requestId, ownerId: uid, latitude: null, longitude: null };
}
async function work(uid: string) {
  const snap = await db!.collection(ALERT_WORK_COLLECTION).where('payload.alertId', '==', uid).get();
  return snap.docs.map((doc) => ({
    ref: doc.ref, key: doc.get('key') as string,
    payload: doc.get('payload') as Record<string, unknown>, runAt: doc.get('runAt') as Timestamp,
  }));
}

/** Execute actual transaction reads/writes, then abort before SDK commit. */
function abortBeforeCommit(): Firestore {
  return new Proxy(db!, {
    get(target, key) {
      if (key === 'runTransaction') {
        return (update: (tx: Transaction) => Promise<unknown>) => target.runTransaction(async (tx) => {
          let wrote = false;
          const tracked = new Proxy(tx, { get(transaction, method) {
            const value = Reflect.get(transaction, method);
            if (['create', 'set', 'update', 'delete'].includes(String(method))) {
              return (...args: unknown[]) => {
                wrote = true;
                return Reflect.apply(value, transaction, args);
              };
            }
            return typeof value === 'function' ? value.bind(transaction) : value;
          } });
          const result = await update(tracked);
          if (wrote) throw new Error('synthetic abort before commit');
          return result;
        }, { maxAttempts: 1 });
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('Firestore emergency state and required work are atomic', () => {
  emulatorTest('aborting creation commits neither alert nor task intents', async () => {
    const uid = owner();
    await assert.rejects(repository(abortBeforeCommit()).create(createInput(uid)), /synthetic abort/);
    assert.equal((await db!.collection('active_alerts').doc(uid).get()).exists, false);
    assert.equal((await work(uid)).length, 0);
    assert.equal((await db!.collection('alert_requests').where('ownerId', '==', uid).get()).size, 0);
    assert.equal((await repository().create(createInput(uid))).created, true);
    assert.equal((await work(uid)).length, 3);
  });

  emulatorTest('aborting escalation leaves original state and no escalation intent', async () => {
    const uid = owner();
    const { alert } = await repository().create(createInput(uid));
    const before = await work(uid);
    await assert.rejects(repository(abortBeforeCommit()).updateStatus(uid, 'escalated', {
      escalatedAt: new Date(), escalationReason: 'no_answer',
    }, alert.key), /synthetic abort/);
    assert.equal((await repository().findById(uid))!.status, 'active');
    assert.equal((await repository().findById(uid))!.escalatedAt, undefined);
    assert.deepEqual((await work(uid)).map((row) => row['key']).sort(), before.map((row) => row['key']).sort());
    await repository().updateStatus(uid, 'escalated', {
      escalatedAt: new Date(), escalationReason: 'no_answer',
    }, alert.key);
    assert.equal((await work(uid)).filter((row) => String(row['key']).endsWith(':escalation')).length, 1);
  });

  emulatorTest('aborting a failed keyword rolls back its attempt, escalation, and notification work', async () => {
    const uid = owner();
    const initial = (await repository().create(createInput(uid))).alert;
    const before = await work(uid);
    await assert.rejects(repository(abortBeforeCommit()).failKeywordAttempt(uid, new Date(), initial.key), /synthetic abort/);
    const unchanged = (await repository().findById(uid))!;
    assert.equal(unchanged.attemptCount, 0);
    assert.equal(unchanged.lastAttemptAt, undefined);
    assert.equal(unchanged.status, 'active');
    assert.equal(unchanged.escalatedAt, undefined);
    assert.deepEqual((await work(uid)).map((row) => row.key).sort(), before.map((row) => row.key).sort());
  });

  emulatorTest('a failed keyword atomically increments, escalates, and creates one notification intent', async () => {
    const uid = owner();
    const initial = (await repository().create(createInput(uid))).alert;
    const attemptedAt = new Date();
    const updated = await repository().failKeywordAttempt(uid, attemptedAt, initial.key);
    assert.equal(updated.attemptCount, 1);
    assert.equal(updated.lastAttemptAt?.getTime(), attemptedAt.getTime());
    assert.equal(updated.status, 'escalated');
    assert.equal(updated.escalationReason, 'wrong_keyword');
    assert.equal(updated.escalatedAt?.getTime(), attemptedAt.getTime());
    const intents = (await work(uid)).filter((row) => row.key.endsWith(':escalation'));
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.payload['alertKey'], initial.key);
  });

  emulatorTest('a later failed keyword preserves an earlier escalation reason and repairs missing work', async () => {
    const uid = owner();
    const initial = (await repository().create(createInput(uid))).alert;
    const escalatedAt = new Date();
    await repository().updateStatus(uid, 'escalated', { escalatedAt, escalationReason: 'no_answer' }, initial.key);
    const prior = (await work(uid)).find((row) => row.key.endsWith(':escalation'))!;
    await prior.ref.delete();
    const updated = await repository().failKeywordAttempt(uid, new Date(escalatedAt.getTime() + 1000), initial.key);
    assert.equal(updated.attemptCount, 1);
    assert.equal(updated.escalationReason, 'no_answer');
    assert.equal(updated.escalatedAt?.getTime(), escalatedAt.getTime());
    const repaired = (await work(uid)).filter((row) => row.key.endsWith(':escalation'));
    assert.equal(repaired.length, 1);
    assert.equal(repaired[0]!.runAt.toMillis(), prior.runAt.toMillis());
  });

  emulatorTest('failed keywords cannot increment or notify after any terminal state', async () => {
    for (const status of ['resolved', 'cancelled', 'expired'] as const) {
      const uid = owner();
      const initial = (await repository().create(createInput(uid))).alert;
      await repository().updateStatus(uid, status, {
        ...(status === 'resolved' ? { resolvedAt: new Date(), resolvedBy: 'owner' as const } : {}),
      }, initial.key);
      const before = await work(uid);
      const unchanged = await repository().failKeywordAttempt(uid, new Date(), initial.key);
      assert.equal(unchanged.status, status);
      assert.equal(unchanged.attemptCount, 0);
      assert.equal(unchanged.lastAttemptAt, undefined);
      assert.deepEqual((await work(uid)).map((row) => row.key).sort(), before.map((row) => row.key).sort());
    }
  });

  emulatorTest('an existing alert retry repairs missing work without moving deadlines', async () => {
    const uid = owner();
    const { alert } = await repository().create(createInput(uid));
    const original = await work(uid);
    const safety = original.find((row) => (row['payload'] as { kind: string }).kind === 'safety-check')!;
    await safety.ref.delete();
    const retry = await repository().create(createInput(uid));
    assert.equal(retry.created, false);
    assert.equal(retry.alert.key, alert.key);
    const repaired = await work(uid);
    assert.equal(repaired.length, 3);
    const fixed = repaired.find((row) => (row['payload'] as { kind: string }).kind === 'safety-check')!;
    assert.equal(fixed['key'], safety['key']);
    assert.equal((fixed['runAt'] as Timestamp).toMillis(), alert.createdAt.getTime() + DELAY);
    assert.equal((fixed['runAt'] as Timestamp).toMillis(), (safety['runAt'] as Timestamp).toMillis());
  });

  emulatorTest('a stale incident key cannot transition or add failed attempts to a reused slot', async () => {
    const uid = owner();
    const first = (await repository().create(createInput(uid))).alert;
    await repository().updateStatus(uid, 'resolved', { resolvedAt: new Date(), resolvedBy: 'owner' }, first.key);
    const second = (await repository().create(createInput(uid, 'workflow-request-two'))).alert;
    assert.notEqual(second.key, first.key);
    await assert.rejects(repository().updateStatus(uid, 'escalated', {
      escalationReason: 'no_answer', escalatedAt: new Date(),
    }, first.key), (error: unknown) => error instanceof AppError && error.code === 'conflict');
    await assert.rejects(repository().recordFailedAttempt(uid, new Date(), first.key),
      (error: unknown) => error instanceof AppError && error.code === 'conflict');
    const current = (await repository().findById(uid))!;
    assert.equal(current.key, second.key);
    assert.equal(current.status, 'active');
    assert.equal(current.attemptCount, 0);
  });

  emulatorTest('a terminal same-request retry neither reopens the alert nor voids a later reset', async () => {
    const uid = owner();
    const first = (await repository().create(createInput(uid))).alert;
    await repository().updateStatus(uid, 'resolved', { resolvedAt: new Date(), resolvedBy: 'owner' }, first.key);
    await db!.collection('keyword_resets').doc(uid).set({
      uid, status: 'pending', requestedAt: Timestamp.now(), eligibleAt: Timestamp.now(),
    });
    const retry = await repository().create(createInput(uid));
    assert.equal(retry.created, false);
    assert.equal(retry.alert.status, 'resolved');
    assert.equal(retry.alert.key, first.key);
    assert.equal((await db!.collection('keyword_resets').doc(uid).get()).get('status'), 'pending');
    const retractions = (await work(uid)).filter((row) => (row['payload'] as { kind: string }).kind === 'retract-inbox');
    assert.equal(retractions.length, 1);
  });

  emulatorTest('legacy native timestamp-string alerts adopt a fixed server time rather than device time', async () => {
    const uid = owner();
    const created = new Date(Date.now() - 60_000);
    const expires = new Date(created.getTime() + WINDOW);
    await db!.collection('active_alerts').doc(uid).set({
      userId: uid, status: 'active', timestamp: created.toISOString(),
      expiresAt: expires.toISOString(), expiresAtTimestamp: Timestamp.fromDate(expires),
      latitude: null, longitude: null, voiceNotes: [], responders: [],
    });
    const original = await db!.collection('active_alerts').doc(uid).get();
    // Firestore's toDate rounds nanoseconds while toMillis floors them.
    const serverTime = original.updateTime!.toDate().getTime();
    const serverExpiry = original.updateTime!.toMillis() + WINDOW;
    await repository().ensureWorkflow(uid);
    const stored = await db!.collection('active_alerts').doc(uid).get();
    const adopted = (await repository().findById(uid))!;
    assert.equal(adopted.createdAt.getTime(), serverTime);
    assert.equal(adopted.expiresAt.getTime(), serverExpiry);
    assert.ok(stored.get('createdAt') instanceof Timestamp);
    assert.equal(typeof stored.get('alertKey'), 'string');
    assert.notEqual(adopted.key, uid, 'adoption must establish an incident identity distinct from the reusable slot');
    const initialized = await work(uid);
    assert.equal(initialized.length, 3);
    const safety = initialized.find((row) => (row['payload'] as { kind: string }).kind === 'safety-check')!;
    assert.equal((safety['runAt'] as Timestamp).toMillis(), serverTime + DELAY);
    await repository().ensureWorkflow(uid);
    assert.equal((await repository().findById(uid))!.key, adopted.key);
    assert.equal((await work(uid)).length, 3);
  });

  emulatorTest('an old keyless task cannot act on an unadopted legacy slot; new keyed work can', async () => {
    const uid = owner();
    await db!.collection('active_alerts').doc(uid).set({
      userId: uid, status: 'active', timestamp: new Date().toISOString(),
      expiresAtTimestamp: Timestamp.fromMillis(Date.now() + WINDOW), latitude: null, longitude: null,
    });
    const alerts = repository();
    const deps = makeDeps({ alerts });
    const api = buildServer(deps);
    try {
      const oldTask = await api.inject({
        method: 'POST', url: '/internal/tasks/safety-check',
        headers: { 'x-task-secret': deps.config.taskRunnerSecret }, payload: { alertId: uid },
      });
      assert.equal(oldTask.statusCode, 200);
      assert.deepEqual(oldTask.json(), { handled: false });
      assert.equal((await alerts.findById(uid))!.status, 'active');
      assert.equal((await work(uid)).length, 0);
      await alerts.ensureWorkflow(uid);
      const adopted = (await alerts.findById(uid))!;
      const keyedTask = await api.inject({
        method: 'POST', url: '/internal/tasks/safety-check',
        headers: { 'x-task-secret': deps.config.taskRunnerSecret },
        payload: { alertId: uid, alertKey: adopted.key },
      });
      assert.equal(keyedTask.statusCode, 200);
      assert.deepEqual(keyedTask.json(), { handled: true });
      assert.equal((await alerts.findById(uid))!.status, 'escalated');
    } finally { await api.close(); }
  });

  emulatorTest('generic mutations cannot treat an uninitialized slot identity as a valid incident key', async () => {
    const uid = owner();
    await db!.collection('active_alerts').doc(uid).set({
      userId: uid, status: 'active', timestamp: new Date().toISOString(),
      expiresAtTimestamp: Timestamp.fromMillis(Date.now() + WINDOW), latitude: null, longitude: null,
    });
    const repo = repository();
    const uninitialized = (await repo.findById(uid))!;
    const conflict = (error: unknown) => error instanceof AppError && error.code === 'conflict';
    await assert.rejects(repo.updateStatus(uid, 'expired', {}, uninitialized.key), conflict);
    await assert.rejects(repo.failKeywordAttempt(uid, new Date(), uninitialized.key), conflict);
    await assert.rejects(repo.recordFailedAttempt(uid, new Date(), uninitialized.key), conflict);
    const unchanged = (await repo.findById(uid))!;
    assert.equal(unchanged.status, 'active');
    assert.equal(unchanged.attemptCount, 0);
    assert.equal((await work(uid)).length, 0);
  });

  emulatorTest('an old request replay after a newer terminal incident returns the archive without reopening', async () => {
    const uid = owner();
    const first = (await repository().create(createInput(uid, 'original-request'))).alert;
    await repository().updateStatus(uid, 'resolved', { resolvedAt: new Date(), resolvedBy: 'owner' }, first.key);
    const second = (await repository().create(createInput(uid, 'newer-request'))).alert;
    await repository().updateStatus(uid, 'expired', {}, second.key);
    await db!.collection('keyword_resets').doc(uid).set({ status: 'pending' });
    const replay = await repository().create(createInput(uid, 'original-request'));
    assert.equal(replay.created, false);
    assert.equal(replay.alert.key, first.key);
    assert.equal(replay.alert.status, 'resolved');
    const current = (await repository().findById(uid))!;
    assert.equal(current.key, second.key);
    assert.equal(current.status, 'expired');
    assert.equal((await db!.collection('keyword_resets').doc(uid).get()).get('status'), 'pending');
    assert.equal((await db!.collection('alert_requests').where('ownerId', '==', uid).get()).size, 2);
  });

  emulatorTest('account erasure removes request receipts and durable task intents as well as alerts', async () => {
    const uid = owner();
    const first = (await repository().create(createInput(uid))).alert;
    await repository().updateStatus(uid, 'resolved', { resolvedAt: new Date(), resolvedBy: 'owner' }, first.key);
    await repository().create(createInput(uid, 'second-request'));
    assert.equal((await db!.collection('alert_requests').where('ownerId', '==', uid).get()).size, 2);
    assert.ok((await work(uid)).length > 0);
    await repository().deleteAllForOwner(uid);
    assert.equal((await db!.collection('active_alerts').doc(uid).get()).exists, false);
    assert.equal((await db!.collection('alert_history').where('userId', '==', uid).get()).size, 0);
    assert.equal((await db!.collection('alert_requests').where('ownerId', '==', uid).get()).size, 0);
    assert.equal((await work(uid)).length, 0);
  });
});

emulatorTest('parallel keyword checks reserve only the cap, recover after the window, and reject old keys', async () => {
  const repo=repository(), uid=owner(); const {alert}=await repo.create(createInput(uid));
  const results=await Promise.all(Array.from({length:12},()=>repo.admitKeywordVerification(alert.id,alert.key,3,30000)));
  assert.equal(results.filter(Boolean).length,3);
  assert.equal((await repo.findById(alert.id))!.attemptCount,0);
  await db!.collection('active_alerts').doc(alert.id).update({keywordAdmissionAt:Timestamp.fromMillis(Date.now()-31000)});
  assert.equal(await repo.admitKeywordVerification(alert.id,alert.key,3,30000),true);
  assert.equal(await repo.admitKeywordVerification(alert.id,'stale-key',3,30000),false);
  await repo.updateStatus(alert.id,'resolved',{},alert.key);
  assert.equal(await repo.admitKeywordVerification(alert.id,alert.key,3,30000),false);
});
