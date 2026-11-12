import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { FirestoreEvidenceRepository } from '../src/repositories/firestore/FirestoreEvidenceRepository.js';
import type { EvidenceRecord } from '../src/repositories/types.js';
let app: App | undefined, db: Firestore | undefined, repo: FirestoreEvidenceRepository;
before(async () => {
  const host = process.env['FIRESTORE_EMULATOR_HOST']; if (!host) return;
  assert.match(host, /^127\.0\.0\.1:\d+$/);
  app = initializeApp({ projectId: `demo-evidence-${randomUUID().slice(0, 8)}` }, randomUUID()); db = getFirestore(app);
  repo = new FirestoreEvidenceRepository(db); await db.collection('evidence').limit(1).get();
  await db.collection('active_alerts').doc('incident').set({ alertKey: 'incident-key', userId: 'synthetic-owner', status: 'active', expiresAtTimestamp: Timestamp.fromMillis(Date.now()+3600000) });
});
after(async () => { if (db) { for (const ref of await db.collection('evidence').listDocuments()) await ref.delete(); await db.terminate(); } if (app) await deleteApp(app); });
const record = (): EvidenceRecord => ({
  id: randomUUID(), ownerUid: 'synthetic-owner', alertId: 'incident', alertKey: 'incident-key',
  kind: 'deliberate', storagePath: `evidence/synthetic-owner/incident/${randomUUID()}`, contentType: 'audio/aac',
  sizeBytes: null, durationMs: null, createdAt: new Date(), uploaded: false
});
function local(name: string, fn: () => Promise<void>) { test(name, async t => { if (!db) { t.skip('local Firestore emulator required'); return; } await fn(); }); }
local('metadata creation retries cannot overwrite finalized evidence', async () => {
  const r = record(); await repo.create(r);
  const pub = { storagePath: `${r.storagePath}/published/${randomUUID()}`, sha256: 'a'.repeat(64), sizeBytes: 7 };
  await repo.markPublished(r.id, r.storagePath, pub);
  const replay = await repo.create(r); assert.equal(replay.uploaded, true); assert.equal(replay.storagePath, pub.storagePath);
  await assert.rejects(repo.create({ ...r, ownerUid: 'someone-else' }));
  await assert.rejects(repo.create({ ...r, kind: 'automatic' }));
  assert.equal((await repo.findById(r.id))!.sha256, pub.sha256);
});
local('concurrent publication has one immutable winner and rejects different bytes', async () => {
  const r = record(); await repo.create(r);
  const one = { storagePath: `${r.storagePath}/published/${randomUUID()}`, sha256: 'a'.repeat(64), sizeBytes: 7 };
  const two = { ...one, storagePath: `${r.storagePath}/published/${randomUUID()}` };
  const [a, b] = await Promise.all([repo.markPublished(r.id, r.storagePath, one), repo.markPublished(r.id, r.storagePath, two)]);
  assert.equal(a.storagePath, b.storagePath);
  await assert.rejects(repo.markPublished(r.id, r.storagePath, { ...two, sha256: 'b'.repeat(64) }));
  assert.equal((await repo.findById(r.id))!.storagePath, a.storagePath);
});
local('legacy size-only finalization and client-declared completed rows are refused', async () => {
  const r = record(); await assert.rejects(repo.create({ ...r, uploaded: true, sha256: 'a'.repeat(64) }));
  assert.equal(await repo.findById(r.id), null);
  await repo.create(r); await assert.rejects(repo.markUploaded(r.id, 100));
  assert.equal((await repo.findById(r.id))!.uploaded, false);
});

local('concurrent evidence admissions cannot exceed the incident limit; replay still succeeds at capacity', async () => {
  const key = randomUUID(), id = randomUUID();
  await db!.collection('active_alerts').doc(id).set({ alertKey: key, userId: 'synthetic-owner', status: 'active', expiresAtTimestamp: Timestamp.fromMillis(Date.now()+3600000) });
  // Fill to one slot below capacity, then race several distinct IDs for it.
  for (let i=0; i<19; i++) await repo.create({ ...record(), alertId: id, alertKey: key });
  const attempts = Array.from({ length: 6 }, () => ({ ...record(), alertId: id, alertKey: key }));
  const outcomes = await Promise.allSettled(attempts.map(r => repo.create(r)));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await repo.listForAlert(id)).length, 20);
  const winner = attempts[outcomes.findIndex(r => r.status === 'fulfilled')];
  assert.equal((await repo.create(winner!)).id, winner!.id);
  for (const outcome of outcomes) if (outcome.status === 'rejected') assert.equal(outcome.reason.code, 'rate_limited');
});
local('terminal or replaced Firestore incident cannot admit new evidence', async () => {
  const id = randomUUID(), key = randomUUID();
  await db!.collection('active_alerts').doc(id).set({ alertKey: key, userId: 'synthetic-owner', status: 'resolved', expiresAtTimestamp: Timestamp.fromMillis(Date.now()+3600000) });
  await assert.rejects(repo.create({ ...record(), alertId: id, alertKey: key }), { code: 'alert_closed' });
  await db!.collection('active_alerts').doc(id).update({ status: 'active', alertKey: randomUUID() });
  await assert.rejects(repo.create({ ...record(), alertId: id, alertKey: key }), { code: 'alert_closed' });
});
