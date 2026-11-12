import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { FirestoreAcceptanceRepository } from '../src/repositories/firestore/FirestoreAcceptanceRepository.js';
import {FirestoreAlertRepository} from '../src/repositories/firestore/FirestoreAlertRepository.js';
let app: App | undefined, db: Firestore | undefined, repo: FirestoreAcceptanceRepository;
before(async () => {
  const host = process.env['FIRESTORE_EMULATOR_HOST']; if (!host) return;
  assert.match(host, /^127\.0\.0\.1:\d+$/); app = initializeApp({ projectId: `demo-accept-${randomUUID().slice(0, 8)}` }, randomUUID());
  db = getFirestore(app); repo = new FirestoreAcceptanceRepository(db); await db.collection('active_alerts').limit(1).get();
});
after(async () => { if (db) { await db.recursiveDelete(db.collection('alert_acceptances')); await db.recursiveDelete(db.collection('active_alerts')); await db.recursiveDelete(db.collection('inbox')); await db.terminate(); } if (app) await deleteApp(app); });
const owner = 'synthetic-owner', helper = 'synthetic-helper';
async function incident(key: string) { await db!.collection('active_alerts').doc(owner).set({userId:owner, alertKey: key, status: 'active', expiresAtTimestamp: Timestamp.fromMillis(Date.now() + 60000) }); await db!.collection('inbox').doc(helper).collection('alerts').doc(owner).set({alertId:owner, alertKey: key, audience: 'contact' }); }
const accept = (key: string) => repo.record({ alertId: owner, alertKey: key, responderUid: helper, acceptedAt: new Date(), audience: 'responder' });
function local(name: string, fn: () => Promise<void>) { test(name, async t => { if (!db) { t.skip('local Firestore emulator required'); return; } await fn(); }); }
local('reused owner slots require a fresh acceptance while preserving the prior incident record', async () => {
  await incident('first'); const a = await accept('first'); assert.equal(a.acceptance.audience, 'contact'); assert.ok(await repo.findFor(owner, helper));
  await incident('second'); assert.equal(await repo.findFor(owner, helper), null); await assert.rejects(accept('first'));
  const b = await accept('second'); assert.equal(b.created, true); assert.equal(b.acceptance.alertKey, 'second');
  assert.equal((await db!.collection('alert_acceptances').doc('first').collection('responders').doc(helper).get()).exists, true);
});
local('legacy acceptance, terminal state, expiry and removed selection never authorize access', async () => {
  await incident('new'); await db!.collection('alert_acceptances').doc(owner).collection('responders').doc(helper).set({ alertId: owner, responderUid: helper, acceptedAt: Timestamp.now(), audience: 'contact' });
  assert.equal(await repo.findFor(owner, helper), null);
  await accept('new'); await db!.collection('active_alerts').doc(owner).update({ status: 'resolved' });
  assert.equal(await repo.findFor(owner, helper), null); await assert.rejects(accept('new'));
  await incident('expired'); await db!.collection('active_alerts').doc(owner).update({ expiresAtTimestamp: Timestamp.fromMillis(Date.now() - 1) });
  await assert.rejects(accept('expired')); assert.equal(await repo.findFor(owner, helper), null);
  await incident('unselected'); await db!.collection('inbox').doc(helper).collection('alerts').doc(owner).delete(); await assert.rejects(accept('unselected'));
});
local('acceptance racing closure cannot become an authorization after closure', async () => {
  await incident('racing'); await Promise.allSettled([accept('racing'), db!.collection('active_alerts').doc(owner).update({ status: 'cancelled' })]);
  assert.equal(await repo.findFor(owner, helper), null);
});
local('owned details require token owner and immutable incident; urgency refreshes projections without sharing a private note',async()=>{
 await incident('details');const alerts=new FirestoreAlertRepository(db!,7200000);
 await assert.rejects(alerts.updateOwnedDetails('third-user',owner,'details',{message:'unauthorized'}));
 await assert.rejects(alerts.updateOwnedDetails(owner,owner,'older-incident',{message:'wrong incident'}));
 await alerts.updateOwnedDetails(owner,owner,'details',{isUrgent:true,message:'Synthetic private note'});
 const projection=await db!.collection('inbox').doc(helper).collection('alerts').doc(owner).get();
 assert.equal(projection.get('isUrgent'),true);assert.equal(projection.get('message'),undefined);
 await db!.collection('active_alerts').doc(owner).update({status:'resolved'});
 await assert.rejects(alerts.updateOwnedDetails(owner,owner,'details',{isUrgent:false}));
});
local('withdrawal preserves the original acknowledgment, is account/incident bound and may be reactivated',async()=>{
 await incident('withdraw-old');const first=await accept('withdraw-old');
 await repo.withdraw(owner,'unrelated-recipient','withdraw-old');assert.ok(await repo.findFor(owner,helper));
 await repo.withdraw(owner,helper,'withdraw-old');await repo.withdraw(owner,helper,'withdraw-old');
 assert.equal(await repo.findFor(owner,helper),null);assert.equal((await repo.listForAlert(owner)).length,0);
 const row=await db!.collection('alert_acceptances').doc('withdraw-old').collection('responders').doc(helper).get();
 assert.ok(row.get('withdrawnAt'));assert.equal(row.get('acceptedAt').toMillis(),first.acceptance.acceptedAt.getTime());
 await accept('withdraw-old');assert.ok(await repo.findFor(owner,helper));
 await incident('withdraw-new');await accept('withdraw-new');await repo.withdraw(owner,helper,'withdraw-old');
 assert.equal((await repo.findFor(owner,helper))?.alertKey,'withdraw-new');
});
