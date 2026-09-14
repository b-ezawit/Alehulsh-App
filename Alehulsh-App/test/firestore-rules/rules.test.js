/**
 * Firestore security rules — regression suite (P1-25).
 *
 * Every CRIT finding from the audit has a test here that fails against the
 * ruleset that shipped. Run before any rules deploy.
 *
 * Runs entirely against the local emulator under a throwaway project id, so it
 * can never touch the real alehulsh-app project.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test, before, after, describe } = require('node:test');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, getDocs,
} = require('firebase/firestore');

const ALICE = 'alice_uid';
const BOB = 'bob_uid';

let env;
let alice;   // authenticated as ALICE
let bob;     // authenticated as BOB — a signed-in stranger
let nobody;  // unauthenticated

const profile = (uid) => ({
  uid,
  fullName: `User ${uid}`,
  phoneNumber: '+251911000000',
  homeAddress: 'Bole, Addis Ababa',
  catName: 'secret-keyword',
  emergencyContacts: [{ name: 'Sister', phone: '+251911222333' }],
});

const alert = (uid) => ({
  id: uid,
  userId: uid,
  userName: `User ${uid}`,
  latitude: 9.0125,
  longitude: 38.7636,
  geohash: 'sc04zjw4b',
  status: 'active',
  voiceNotes: [],
  responders: [],
  alerterPhone: '+251911000000',
  emergencyContactPhones: ['+251911222333'],
});

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'alehulsh-rules-test',
    firestore: {
      rules: readFileSync(join(__dirname, '..', '..', 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });

  // Seed with rules bypassed.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', ALICE), profile(ALICE));
    await setDoc(doc(db, 'users', BOB), profile(BOB));
    await setDoc(doc(db, 'active_alerts', ALICE), alert(ALICE));
  });

  alice = env.authenticatedContext(ALICE).firestore();
  bob = env.authenticatedContext(BOB).firestore();
  nobody = env.unauthenticatedContext().firestore();
});

after(async () => { await env?.cleanup(); });

/* ------------------------------------------------------------------ */
describe('unauthenticated — the ruleset that was actually deployed', () => {
  // The live project had `allow read, write: if true` on both collections.
  // These four are the regression tests for that.
  test('cannot read a profile', () =>
    assertFails(getDoc(doc(nobody, 'users', ALICE))));

  test('cannot write a profile', () =>
    assertFails(setDoc(doc(nobody, 'users', ALICE), { fullName: 'hacked' })));

  test('cannot read an alert', () =>
    assertFails(getDoc(doc(nobody, 'active_alerts', ALICE))));

  test('cannot delete an alert', () =>
    assertFails(deleteDoc(doc(nobody, 'active_alerts', ALICE))));
});

/* ------------------------------------------------------------------ */
describe('signed-in stranger — CRIT-01, CRIT-02, CRIT-04', () => {
  test('CRIT-01: cannot read another user profile', () =>
    assertFails(getDoc(doc(bob, 'users', ALICE))));

  test('CRIT-01: cannot write another user profile', () =>
    assertFails(setDoc(doc(bob, 'users', ALICE), { fullName: 'hacked' })));

  test('CRIT-02: cannot read another user alert', () =>
    assertFails(getDoc(doc(bob, 'active_alerts', ALICE))));

  test('CRIT-04: cannot overwrite voiceNotes on another user alert', () =>
    assertFails(updateDoc(doc(bob, 'active_alerts', ALICE), { voiceNotes: [] })));

  test('CRIT-04: cannot append to responders on another user alert', () =>
    assertFails(updateDoc(doc(bob, 'active_alerts', ALICE), { responders: [BOB] })));

  test('cannot delete another user alert', () =>
    assertFails(deleteDoc(doc(bob, 'active_alerts', ALICE))));

  test('cannot plant an alert in another user slot', () =>
    assertFails(setDoc(doc(bob, 'active_alerts', ALICE), alert(BOB))));
});

/* ------------------------------------------------------------------ */
describe('owner — the SOS path must keep working', () => {
  test('reads her own profile', () =>
    assertSucceeds(getDoc(doc(alice, 'users', ALICE))));

  test('writes her own profile', () =>
    assertSucceeds(setDoc(doc(alice, 'users', ALICE), profile(ALICE))));

  test('reads her own alert', () =>
    assertSucceeds(getDoc(doc(alice, 'active_alerts', ALICE))));

  test('updates her own alert', () =>
    assertSucceeds(updateDoc(doc(alice, 'active_alerts', ALICE), { message: 'help' })));

  test('appends her own voice note', () =>
    assertSucceeds(updateDoc(doc(alice, 'active_alerts', ALICE), {
      voiceNotes: [{ id: 'v1', title: 'note', duration: '0:05' }],
    })));

  test('creates an alert at her own id with her own userId', async () => {
    await env.withSecurityRulesDisabled(async (ctx) =>
      deleteDoc(doc(ctx.firestore(), 'active_alerts', BOB)));
    const bobDb = env.authenticatedContext(BOB).firestore();
    await assertSucceeds(setDoc(doc(bobDb, 'active_alerts', BOB), alert(BOB)));
  });

  test('cannot create an alert carrying someone else userId', async () => {
    await env.withSecurityRulesDisabled(async (ctx) =>
      deleteDoc(doc(ctx.firestore(), 'active_alerts', BOB)));
    const bobDb = env.authenticatedContext(BOB).firestore();
    await assertFails(setDoc(doc(bobDb, 'active_alerts', BOB), alert(ALICE)));
  });

  test('deletes her own alert', () =>
    assertSucceeds(deleteDoc(doc(alice, 'active_alerts', ALICE))));
});

/* ------------------------------------------------------------------ */
describe('queries — what the rules allow at collection level', () => {
  // Claimed in the merge commit and previously unverified.
  test('owner-scoped cleanup query is allowed', () =>
    assertSucceeds(getDocs(query(
      collection(alice, 'active_alerts'), where('userId', '==', ALICE)))));

  test('the global active-alerts query is denied (this was the leak)', () =>
    assertFails(getDocs(query(
      collection(alice, 'active_alerts'), where('status', '==', 'active')))));

  test('reading the whole collection is denied', () =>
    assertFails(getDocs(collection(alice, 'active_alerts'))));
});

/* ------------------------------------------------------------------ */
describe('inbox — per-recipient projections (P2-05, P1-10)', () => {
  const projection = {
    alertId: 'alert_1',
    displayName: '',
    fuzzedLat: 9.01,
    fuzzedLng: 38.76,
    fuzzedPrecision: '~150m',
    audience: 'responder',
  };

  const seed = (uid, alertId) =>
    env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), 'inbox', uid, 'alerts', alertId), projection));

  test('a recipient reads her own inbox', async () => {
    await seed(ALICE, 'alert_1');
    await assertSucceeds(getDoc(doc(alice, 'inbox', ALICE, 'alerts', 'alert_1')));
  });

  test('a signed-in stranger cannot read it', async () => {
    await seed(ALICE, 'alert_1');
    await assertFails(getDoc(doc(bob, 'inbox', ALICE, 'alerts', 'alert_1')));
  });

  test('unauthenticated cannot read it', async () => {
    await seed(ALICE, 'alert_1');
    await assertFails(getDoc(doc(nobody, 'inbox', ALICE, 'alerts', 'alert_1')));
  });

  test('listing her own inbox is allowed — this is the responder read path', async () => {
    await seed(ALICE, 'alert_1');
    await assertSucceeds(getDocs(collection(alice, 'inbox', ALICE, 'alerts')));
  });

  test('nobody may write an inbox, not even its owner', async () => {
    // A responder who could write her own inbox could invent an alert that
    // was never raised, or quietly remove one she was asked to answer.
    // Every write comes from the API layer through the admin SDK.
    await assertFails(setDoc(doc(alice, 'inbox', ALICE, 'alerts', 'alert_2'), projection));
  });

  test('nobody may delete from an inbox', async () => {
    await seed(ALICE, 'alert_1');
    await assertFails(deleteDoc(doc(alice, 'inbox', ALICE, 'alerts', 'alert_1')));
  });

  test('acceptances are server-only — no client may read or write them', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), 'alert_acceptances', 'alert_1', 'responders', ALICE), {
        alertId: 'alert_1', responderUid: ALICE, audience: 'responder',
      }));
    await assertFails(getDoc(doc(alice, 'alert_acceptances', 'alert_1', 'responders', ALICE)));
    await assertFails(setDoc(doc(alice, 'alert_acceptances', 'alert_1', 'responders', ALICE), {}));
  });

  test('evidence metadata is server-only — paths must not leak to clients', async () => {
    // The document holds the object's address. A client that could read it
    // could not fetch the object (the bucket denies everything), but it would
    // still learn that a recording exists and where. Playback goes through a
    // signed URL the API issues per request.
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), 'evidence', 'e1'), {
        alertId: 'alert_1', ownerUid: ALICE,
        storagePath: `evidence/${ALICE}/alert_1/e1`, uploaded: true,
      }));
    // Denied even for the owner of the recording.
    await assertFails(getDoc(doc(alice, 'evidence', 'e1')));
    await assertFails(setDoc(doc(alice, 'evidence', 'e2'), {}));
  });

  test('the upgrade floor is server-only — a client must not raise or drop it', async () => {
    // Writable by clients, this is both a denial-of-service (set the minimum
    // absurdly high and every install blocks) and a way to dodge P1-27 (drop
    // it and keep using the old direct-write build).
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), 'app_config', 'client_policy'), {
        android: { minVersion: '1.2.0' },
      }));
    await assertFails(setDoc(doc(alice, 'app_config', 'client_policy'), {
      android: { minVersion: '99.0.0' },
    }));
  });

  test('version telemetry is server-only — adoption numbers gate P1-27', async () => {
    // Closing direct writes is gated on measured adoption. A client that could
    // write this could manufacture the evidence for that decision.
    await assertFails(setDoc(doc(alice, 'client_versions', ALICE), { version: '9.9.9' }));
    await assertFails(getDoc(doc(alice, 'client_versions', ALICE)));
  });

  test('alert history is server-only, and not deletable by a client', async () => {
    // This is her evidence of a pattern of abuse. A client that could write it
    // could fabricate incidents; one that could delete it could erase them —
    // and the account most likely to be compromised is hers.
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), 'alert_history', 'key-1'), {
        userId: ALICE, alertKey: 'key-1', status: 'resolved',
      }));
    await assertFails(getDoc(doc(alice, 'alert_history', 'key-1')));
    await assertFails(setDoc(doc(alice, 'alert_history', 'key-2'), { userId: ALICE }));
    await assertFails(deleteDoc(doc(alice, 'alert_history', 'key-1')));
  });

  test('keyword resets are server-only — the clock must not be client-settable', async () => {
    // A client that could write this could set eligibleAt into the past and
    // turn a 72-hour time lock into no lock at all, which is the entire
    // defence in the recovery flow.
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), 'keyword_resets', ALICE), {
        uid: ALICE, status: 'pending',
      }));
    await assertFails(getDoc(doc(alice, 'keyword_resets', ALICE)));
    await assertFails(setDoc(doc(alice, 'keyword_resets', ALICE), { status: 'confirmed' }));
  });

  test('the reveal audit trail is server-only', async () => {
    // If a responder could read this, he could see who else is nearby and
    // whether anyone has already been given her exact position.
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), 'location_reveals', 'r1'), {
        alertId: 'alert_1', responderUid: ALICE, granted: true,
      }));
    await assertFails(getDoc(doc(alice, 'location_reveals', 'r1')));
    await assertFails(setDoc(doc(alice, 'location_reveals', 'r2'), {}));
  });
});
