/**
 * The TARGET ruleset for P1-27 — firestore.rules.closed.
 *
 * Tested now, deployed later. The point of writing these before the switch is
 * that the switch becomes a deploy rather than a scramble: when adoption
 * clears, the only question left is timing.
 *
 * See docs/closing-direct-writes.md for the preconditions.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test, before, after, describe } = require('node:test');
const {
  initializeTestEnvironment, assertSucceeds, assertFails,
} = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc } = require('firebase/firestore');

const ALICE = 'alice_uid';
const BOB = 'bob_uid';

const alertDoc = (uid) => ({
  id: uid, userId: uid, status: 'active',
  latitude: 9.0125, longitude: 38.7636, voiceNotes: [], responders: [],
});

let env, alice, bob;

before(async () => {
  env = await initializeTestEnvironment({
    // Its own project id so it cannot collide with the live-ruleset suite.
    projectId: 'alehulsh-closed-rules-test',
    firestore: {
      rules: readFileSync(join(__dirname, '..', '..', 'firestore.rules.closed'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'active_alerts', ALICE), alertDoc(ALICE));
  });
  alice = env.authenticatedContext(ALICE).firestore();
  bob = env.authenticatedContext(BOB).firestore();
});

after(async () => { await env?.cleanup(); });

describe('P1-27 — clients cannot write alerts at all', () => {
  test('the owner cannot create her own alert', () =>
    // This is the whole change. Creation goes through POST /v1/alerts, which
    // stamps the server clock, enforces idempotency, and schedules the
    // escalation that the coercion design depends on.
    assertFails(setDoc(doc(alice, 'active_alerts', ALICE), alertDoc(ALICE))));

  test('the owner cannot update her own alert', () =>
    // Cancelling used to be a client-side delete (CRIT-05). Resolution is now
    // POST /v1/alerts/:id/resolve, which verifies the keyword server-side and
    // transitions state instead of destroying evidence.
    assertFails(updateDoc(doc(alice, 'active_alerts', ALICE), { status: 'resolved' })));

  test('the owner cannot delete her own alert', () =>
    assertFails(deleteDoc(doc(alice, 'active_alerts', ALICE))));

  test('a stranger cannot touch it either — CRIT-04 stays shut', () =>
    assertFails(updateDoc(doc(bob, 'active_alerts', ALICE), {
      voiceNotes: [], responders: ['bob_uid'],
    })));

  test('the device clock cannot set expiry any more', () =>
    // P3-13: expiresAtTimestamp was stamped from the device. With no client
    // write there is nothing to stamp it with.
    assertFails(updateDoc(doc(alice, 'active_alerts', ALICE), {
      expiresAtTimestamp: new Date('2030-01-01'),
    })));
});

describe('reads still work — her own screen must not go dark', () => {
  test('the owner reads her own alert', () =>
    assertSucceeds(getDoc(doc(alice, 'active_alerts', ALICE))));

  test('a stranger still cannot read it', () =>
    assertFails(getDoc(doc(bob, 'active_alerts', ALICE))));
});

describe('what this switch deliberately does not close', () => {
  test('the profile stays writable — closing it needs P2-02 first', async () => {
    // Recorded as a test so the gap is visible rather than assumed. The
    // keyword is already out of reach: P1-11 moved it behind an endpoint.
    await assertSucceeds(setDoc(doc(alice, 'users', ALICE), { fullName: 'Alice' }));
  });

  test('the inbox stays readable and unwritable', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), 'inbox', ALICE, 'alerts', 'a1'), { alertId: 'a1' }));
    await assertSucceeds(getDoc(doc(alice, 'inbox', ALICE, 'alerts', 'a1')));
    await assertFails(setDoc(doc(alice, 'inbox', ALICE, 'alerts', 'a2'), { alertId: 'a2' }));
  });
});
