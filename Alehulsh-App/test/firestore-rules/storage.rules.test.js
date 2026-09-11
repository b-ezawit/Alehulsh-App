/**
 * Object storage access rules.  (P2-11)
 *
 * Evidence is the most sensitive data in this system — recordings made during
 * an assault. CLAUDE.md §11 applies in full.
 *
 * The model is total client denial. Uploads and playback both go through the
 * API, which issues short-lived signed URLs with the admin credential; that
 * credential bypasses these rules, so denying everything here costs the
 * product nothing and removes the entire class of "authenticated stranger
 * reads her recording" bug.
 *
 * These tests exist because storage.rules did not exist at all until P2-10,
 * meaning whatever was deployed was unreviewed — the same situation P0-02
 * found on Firestore, where the live ruleset turned out to be far worse than
 * the repo's.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test, before, after, describe } = require('node:test');
const {
  initializeTestEnvironment, assertFails,
} = require('@firebase/rules-unit-testing');
const { ref, uploadBytes, getBytes, deleteObject, listAll } = require('firebase/storage');

const ALICE = 'alice_uid';
const BOB = 'bob_uid';
const RECORDING = new Uint8Array([0, 1, 2, 3]);
const HER_PATH = `evidence/${ALICE}/alert_1/e1`;

let env;
let alice;   // signed in as ALICE — the owner of the recording
let bob;     // signed in as BOB — any other account
let nobody;  // unauthenticated

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'alehulsh-rules-test',
    storage: {
      rules: readFileSync(join(__dirname, '..', '..', 'storage.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 9199,
    },
  });

  // Seed with rules bypassed — this is the API's admin credential standing in.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), HER_PATH), RECORDING);
  });

  alice = env.authenticatedContext(ALICE).storage();
  bob = env.authenticatedContext(BOB).storage();
  nobody = env.unauthenticatedContext().storage();
});

after(async () => { await env?.cleanup(); });

describe('reads — no client may fetch a recording', () => {
  test('a signed-in stranger cannot read it', () =>
    assertFails(getBytes(ref(bob, HER_PATH))));

  test('an unauthenticated caller cannot read it', () =>
    assertFails(getBytes(ref(nobody, HER_PATH))));

  test('even the owner cannot read it directly', () =>
    // Not an oversight. She reaches her own recording through the API, which
    // issues a signed URL that expires. Direct bucket access for the owner
    // would mean a permanent, unrevocable grant tied to her session.
    assertFails(getBytes(ref(alice, HER_PATH))));
});

describe('writes — no client may put anything in the bucket', () => {
  test('a stranger cannot overwrite her recording', () =>
    // This is CRIT-04's shape moved into storage: a writer who can overwrite
    // can destroy evidence from their own phone.
    assertFails(uploadBytes(ref(bob, HER_PATH), new Uint8Array([9, 9]))));

  test('the owner cannot write directly either — uploads use a signed ticket', () =>
    assertFails(uploadBytes(ref(alice, HER_PATH), RECORDING)));

  test('nobody can write to an arbitrary path', () =>
    assertFails(uploadBytes(ref(bob, 'evidence/anything/else/x'), RECORDING)));

  test('nobody can write outside the evidence prefix', () =>
    assertFails(uploadBytes(ref(bob, 'public/free-for-all'), RECORDING)));
});

describe('deletes — evidence cannot be destroyed from a client', () => {
  test('a stranger cannot delete her recording', () =>
    assertFails(deleteObject(ref(bob, HER_PATH))));

  test('the owner cannot delete it directly', () =>
    assertFails(deleteObject(ref(alice, HER_PATH))));
});

describe('enumeration — the bucket must not be browsable', () => {
  test('a stranger cannot list her evidence folder', () =>
    // Listing alone would reveal that she raised alerts, when, and how many,
    // without reading a single byte.
    assertFails(listAll(ref(bob, `evidence/${ALICE}`))));

  test('nobody can list the bucket root', () =>
    assertFails(listAll(ref(nobody, ''))));
});
