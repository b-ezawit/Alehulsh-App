import { before, after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { createPool, loadDbConfig, createApiDatabase, withApiTransaction, isLoopbackHost } from '../src/db/pool.js';
import { PostgresKeywordResetRepository } from '../src/repositories/postgres/PostgresKeywordResetRepository.js';
import { PostgresUserRepository } from '../src/repositories/postgres/PostgresUserRepository.js';
import { PostgresAlertRepository } from '../src/repositories/postgres/PostgresAlertRepository.js';
import { FirestoreKeywordResetRepository } from '../src/repositories/firestore/FirestoreKeywordResetRepository.js';
import { FirestoreUserRepository } from '../src/repositories/firestore/FirestoreUserRepository.js';
import { FirestoreAlertRepository } from '../src/repositories/firestore/FirestoreAlertRepository.js';
import type { AlertRepository, KeywordResetRepository, UserRepository } from '../src/repositories/types.js';

const DELAY = 72 * 60 * 60 * 1000;
interface Fixture { uid: string; resets: KeywordResetRepository; users: UserRepository; alerts: AlertRepository; abortConfirm(): Promise<void>; }
for (const backend of ['postgres', 'firestore'] as const) describe(`${backend} atomic keyword operations`, () => {
  let pool: Pool | undefined, db: Firestore | undefined, app: App | undefined;
  const owners: string[] = [];
  before(async () => {
    if (backend === 'postgres') {
      if (process.env['ALEHULSH_LOCAL_DB_TESTS'] !== '1') return;
      const config = loadDbConfig(); if (!isLoopbackHost(config.host)) throw Error('local fixture only');
      pool = createPool(config); await pool.query('SELECT 1');
    } else {
      const host = process.env['FIRESTORE_EMULATOR_HOST']; if (!host) return;
      if (!/^127\.0\.0\.1:\d+$/.test(host)) throw Error('loopback emulator only');
      process.env['METADATA_SERVER_DETECTION'] = 'none';
      app = initializeApp({ projectId: `demo-keyword-${randomUUID().slice(0, 8)}` }, randomUUID()); db = getFirestore(app);
      await db.collection('users').limit(1).get();
    }
  });
  after(async () => {
    if (pool) { await pool.query('DELETE FROM alert_history WHERE owner_id=ANY($1::uuid[])', [owners]); await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [owners]); await pool.end(); }
    if (db) { for (const col of ['users', 'active_alerts', 'keyword_resets', 'alert_requests', 'alert_task_outbox']) for (const ref of await db.collection(col).listDocuments()) await ref.delete(); await db.terminate(); }
    if (app) await deleteApp(app);
  });
  async function fixture(): Promise<Fixture> {
    const id = randomUUID(), uid = `keyword-${id}`;
    if (pool) {
      owners.push(id); await pool.query("INSERT INTO users(id,keyword_hash,must_set_keyword)VALUES($1,'old',false)", [id]);
      await pool.query('INSERT INTO identity_map(firebase_uid,user_id)VALUES($1,$2)', [uid, id]);
      const scoped = createApiDatabase(pool, uid);
      return {
        uid, resets: new PostgresKeywordResetRepository(scoped), users: new PostgresUserRepository(scoped), alerts: new PostgresAlertRepository(scoped, 7200000),
        abortConfirm: async () => { await assert.rejects(withApiTransaction(pool!, uid, async tx => { const repo = new PostgresKeywordResetRepository(tx); const pending = await repo.findPending(uid); await repo.confirm(uid, pending!.requestedAt, 'new', new Date()); throw Error('synthetic abort'); }), /synthetic abort/); }
      };
    }
    await db!.collection('users').doc(uid).set({ safetyKeywordHash: 'old', mustSetKeyword: false });
    const broken = new Proxy(db!, { get(target, key) { if (key === 'runTransaction') return (fn: (tx: Transaction) => Promise<unknown>) => target.runTransaction(async tx => { await fn(tx); throw Error('synthetic abort'); }, { maxAttempts: 1 }); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
    return {
      uid, resets: new FirestoreKeywordResetRepository(db!), users: new FirestoreUserRepository(db!), alerts: new FirestoreAlertRepository(db!, 7200000),
      abortConfirm: async () => { const pending = await new FirestoreKeywordResetRepository(db!).findPending(uid); await assert.rejects(new FirestoreKeywordResetRepository(broken).confirm(uid, pending!.requestedAt, 'new', new Date()), /synthetic abort/); }
    };
  }
  const request = (f: Fixture, at = new Date(Date.now() - DELAY - 1000)) => f.resets.create({ uid: f.uid, requestedAt: at, eligibleAt: new Date(at.getTime() + DELAY), status: 'pending' });
  const alert = (f: Fixture) => f.alerts.create({ ownerId: f.uid, requestId: randomUUID(), latitude: null, longitude: null });
  function check(name: string, fn: (f: Fixture) => Promise<void>) { test(name, async t => { if (!pool && !db) { t.skip('isolated local fixture not configured'); return; } await fn(await fixture()); }); }
  check('confirmation commits reset and keyword together', async f => { const r = await request(f); await f.resets.confirm(f.uid, r.requestedAt, 'new', new Date()); assert.equal((await f.users.findByUid(f.uid))?.safetyKeywordHash, 'new'); assert.equal(await f.resets.findPending(f.uid), null); });
  check('an aborted confirmation commits neither state nor hash', async f => { await request(f); await f.abortConfirm(); assert.equal((await f.users.findByUid(f.uid))?.safetyKeywordHash, 'old'); assert.ok(await f.resets.findPending(f.uid)); });
  check('eligibility and reset generation are checked at final write', async f => { const r = await request(f, new Date()); await assert.rejects(f.resets.confirm(f.uid, r.requestedAt, 'new', new Date())); await f.resets.update(f.uid, { status: 'cancelled' }); const next = await request(f); await assert.rejects(f.resets.confirm(f.uid, r.requestedAt, 'new', new Date())); assert.ok(await f.resets.findPending(f.uid)); assert.notEqual(r.requestedAt.getTime(), next.requestedAt.getTime()); });
  check('an incident racing confirmation cannot leave a live bypass', async f => { const r = await request(f); const [confirmed] = await Promise.allSettled([f.resets.confirm(f.uid, r.requestedAt, 'new', new Date()), alert(f)]); assert.ok(await f.alerts.findActiveByOwner(f.uid)); assert.equal((await f.users.findByUid(f.uid))?.safetyKeywordHash, confirmed.status === 'fulfilled' ? 'new' : 'old'); assert.equal(await f.resets.findPending(f.uid), null); });
  check('a reset request racing an incident never remains pending', async f => { await Promise.allSettled([request(f, new Date()), alert(f)]); assert.ok(await f.alerts.findActiveByOwner(f.uid)); assert.equal(await f.resets.findPending(f.uid), null); });
  check('ordinary keyword compare-and-set refuses stale hashes and live incidents', async f => { await f.users.compareAndSetSafetyKeyword(f.uid, 'old', 'new'); await assert.rejects(f.users.compareAndSetSafetyKeyword(f.uid, 'old', 'stale')); await alert(f); await assert.rejects(f.users.compareAndSetSafetyKeyword(f.uid, 'new', 'bypass')); assert.equal((await f.users.findByUid(f.uid))?.safetyKeywordHash, 'new'); });
  check('late cancellation cannot rewrite a confirmed reset outcome', async f => {
    const r = await request(f); await f.resets.confirm(f.uid, r.requestedAt, 'new', new Date());
    await f.resets.update(f.uid, { status: 'cancelled', cancelledAt: new Date(), cancelledReason: 'user' });
    const status = pool ? (await pool.query('SELECT status FROM keyword_resets WHERE user_id=(SELECT user_id FROM identity_map WHERE firebase_uid=$1)', [f.uid])).rows[0].status
      : (await db!.collection('keyword_resets').doc(f.uid).get()).get('status');
    assert.equal(status, 'confirmed');
  });
  check('repeated requests preserve the first deadline', async f => { const first = await request(f, new Date()); const second = await request(f, new Date(Date.now() + 1000)); assert.equal(first.eligibleAt.getTime(), second.eligibleAt.getTime()); });
});
