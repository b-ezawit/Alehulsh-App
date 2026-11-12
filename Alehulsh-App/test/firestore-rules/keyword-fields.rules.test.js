const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test, before, after, beforeEach, describe } = require('node:test');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, Timestamp } = require('firebase/firestore');

for (const [index, rules] of ['firestore.rules', 'firestore.rules.closed'].entries()) {
  describe(`${rules}: server identity and terminal privacy`, () => {
    let env, owner, recipient;
    before(async () => {
      const endpoint = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
      if (!/^127\.0\.0\.1:\d+$/.test(endpoint)) throw Error('loopback emulator required');
      env = await initializeTestEnvironment({ projectId: `demo-keyword-fields-${index}`, firestore: {
        host: '127.0.0.1', port: Number(endpoint.split(':')[1]),
        rules: readFileSync(join(__dirname, '../..', rules), 'utf8')
      }});
      owner = env.authenticatedContext('owner').firestore();
      recipient = env.authenticatedContext('recipient').firestore();
    });
    after(async () => env?.cleanup());
    beforeEach(async () => env.withSecurityRulesDisabled(async c => {
      const db = c.firestore();
      await setDoc(doc(db, 'users/owner'), { fullName: 'Synthetic', safetyKeywordHash: 'server-only', mustSetKeyword: false });
      await setDoc(doc(db, 'active_alerts/owner'), { userId: 'owner', alertKey: 'incident-one', status: 'active', expiresAtTimestamp: Timestamp.fromMillis(Date.now() + 60000) });
      await setDoc(doc(db, 'inbox/recipient/alerts/owner'), { alertKey: 'incident-one', fuzzedLat: 9, fuzzedLng: 38 });
    }));
    test('ordinary profile updates remain supported', () => assertSucceeds(updateDoc(doc(owner, 'users/owner'), { fullName: 'Updated' })));
    test('owner cannot replace the server keyword hash', () => assertFails(updateDoc(doc(owner, 'users/owner'), { safetyKeywordHash: 'replacement' })));
    test('owner cannot clear keyword-required state', () => assertFails(updateDoc(doc(owner, 'users/owner'), { mustSetKeyword: true })));
    test('replacement writes cannot remove server keyword fields', () => assertFails(setDoc(doc(owner, 'users/owner'), { fullName: 'Replacement' })));
    test('owner cannot delete the profile to discard protected fields', () => assertFails(deleteDoc(doc(owner, 'users/owner'))));
    test('terminal source revokes an existing exact-location projection', async () => {
      const ref = doc(recipient, 'inbox/recipient/alerts/owner');
      await assertSucceeds(getDoc(ref));
      await env.withSecurityRulesDisabled(c => updateDoc(doc(c.firestore(), 'active_alerts/owner'), { status: 'resolved' }));
      await assertFails(getDoc(ref));
    });
  });
}
