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
