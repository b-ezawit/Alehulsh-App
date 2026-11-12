import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { FirestoreInboxRepository } from '../src/repositories/firestore/FirestoreInboxRepository.js';
import type { AlertProjection } from '../src/repositories/types.js';

// This suite can only contact a loopback emulator. It must never use ADC or a
// project credential even when the developer's ordinary environment has one.
const endpoint = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080';
const prefix = `privacy_${randomUUID().replace(/-/g, '')}`;
const recipient = `${prefix}_recipient`;
const slot = `${prefix}_owner`;
let db: Firestore;
let inbox: FirestoreInboxRepository;
let firebase: ReturnType<typeof initializeApp> | undefined;

before(async () => {
  process.env['METADATA_SERVER_DETECTION'] = 'none';
  if (!/^127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error('inbox privacy tests require a loopback emulator');
  const port = Number(endpoint.split(':')[1]);
  const available = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
  if (!available) return;
  process.env['FIRESTORE_EMULATOR_HOST'] = endpoint;
  firebase = initializeApp({ projectId: 'demo-alehulsh-inbox-privacy' }, prefix);
  db = getFirestore(firebase);
  inbox = new FirestoreInboxRepository(db);
});

after(async () => {
  if (!firebase) return;
  await db.collection('active_alerts').doc(slot).delete();
  await db.collection('inbox').doc(recipient).collection('alerts').doc(slot).delete();
  await db.terminate();
  await deleteApp(firebase);
});

function projection(key = 'incident-1'): AlertProjection {
  return {
    alertId: slot, alertKey: key, displayName: '', fuzzedLat: 9.01,
    fuzzedLng: 38.76, fuzzedPrecision: 'exact', isUrgent: false,
    status: 'active', createdAt: new Date(), hasVoiceNote: false,
    reportedDelayMs: null, audience: 'contact',
  };
}

async function source(patch: Record<string, unknown> = {}): Promise<void> {
  await db.collection('active_alerts').doc(slot).set({
    alertKey: 'incident-1', status: 'active',
    expiresAtTimestamp: Timestamp.fromMillis(Date.now() + 60_000), ...patch,
  });
}

function it(name: string, body: () => Promise<void>): void {
  test(name, async (t) => {
    if (!firebase) { t.skip('loopback Firestore emulator not running'); return; }
    await db.collection('inbox').doc(recipient).collection('alerts').doc(slot).delete();
    await source();
    await body();
  });
}

it('a live incident round-trips and another recipient cannot read its projection', async () => {
  await inbox.put(recipient, projection());
  assert.equal((await inbox.get(recipient, slot))?.alertKey, 'incident-1');
  assert.equal(await inbox.get(`${recipient}_stranger`, slot), null);
});

it('terminal and elapsed incidents reject late fan-out writes', async () => {
  for (const patch of [
    { status: 'resolved' }, { status: 'cancelled' }, { status: 'expired' },
    { expiresAtTimestamp: Timestamp.fromMillis(0) },
  ]) {
    await source(patch);
    await inbox.put(recipient, projection());
    assert.equal((await db.collection('inbox').doc(recipient).collection('alerts').doc(slot).get()).exists, false);
  }
});

it('reads hide stale exact coordinates before asynchronous retraction finishes', async () => {
  await inbox.put(recipient, projection());
  await source({ status: 'resolved' });
  assert.equal(await inbox.get(recipient, slot), null);
  assert.deepEqual(await inbox.listForRecipient(recipient, 25), []);
});

it('slot replacement rejects old fan-out and old reads', async () => {
  await inbox.put(recipient, projection());
  await source({ alertKey: 'incident-2' });
  assert.equal(await inbox.get(recipient, slot), null);
  await inbox.put(recipient, projection());
  assert.equal(await inbox.get(recipient, slot), null);
  await inbox.put(recipient, projection('incident-2'));
  assert.equal((await inbox.get(recipient, slot))?.alertKey, 'incident-2');
});

it('old incident retraction cannot delete the replacement projection', async () => {
  await source({ alertKey: 'incident-2' });
  await inbox.put(recipient, projection('incident-2'));
  await inbox.remove(recipient, slot, 'incident-1');
  assert.equal((await inbox.get(recipient, slot))?.alertKey, 'incident-2');
  await inbox.remove(recipient, slot, 'incident-2');
  assert.equal(await inbox.get(recipient, slot), null);
});

it('missing instance keys fail closed rather than granting a new incident', async () => {
  const { alertKey: _key, ...legacy } = projection();
  await inbox.put(recipient, legacy);
  assert.equal(await inbox.get(recipient, slot), null);
});

it('concurrent closure and fan-out never leave a readable terminal projection', async () => {
  await Promise.all([
    inbox.put(recipient, projection()),
    db.collection('active_alerts').doc(slot).update({ status: 'resolved' }),
  ]);
  assert.equal(await inbox.get(recipient, slot), null);
  assert.deepEqual(await inbox.listForRecipient(recipient, 25), []);
});
it('Firestore contact projections require current provider proof; revocation, outages and missing provenance cannot expose location',async()=>{
 const hash='a'.repeat(43);let verified=true;
 const protectedInbox=new FirestoreInboxRepository(db,{proves:async(uid,value)=>uid===recipient&&value===hash&&verified});
 await protectedInbox.put(recipient,{...projection(),contactIdentifierHashes:[hash]});
 assert.equal((await protectedInbox.get(recipient,slot))?.fuzzedLat,9.01);
 verified=false;assert.equal(await protectedInbox.get(recipient,slot),null);assert.deepEqual(await protectedInbox.listForRecipient(recipient,25),[]);
 const unavailable=new FirestoreInboxRepository(db,{proves:async()=>{throw Error('synthetic provider outage');}});
 await assert.rejects(unavailable.get(recipient,slot));
 await inbox.put(recipient,projection());verified=true;assert.equal(await protectedInbox.get(recipient,slot),null);
});
