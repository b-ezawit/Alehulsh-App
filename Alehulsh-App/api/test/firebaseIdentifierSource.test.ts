import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FirebaseIdentifierSource } from '../src/auth/FirebaseIdentifierSource.js';
import { hashPhone, hashEmail } from '../src/crypto/identifier.js';
const pepper = 'synthetic-test-only', phone = '+251911234567', email = 'sister@test.invalid';
test('provider verified phone owns the matching hash; profile fields are never consulted', async () => {
  const source = new FirebaseIdentifierSource({ getUser: async () => ({ disabled: false, emailVerified: false, phoneNumber: phone }) }, pepper);
  assert.equal(await source.proves('account', hashPhone(phone, pepper)!), true);
  assert.equal(await source.proves('account', hashEmail(email, pepper)!), false);
});
test('unverified email and disabled accounts never prove ownership', async () => {
  for (const user of [{ disabled: false, emailVerified: false, email }, { disabled: true, emailVerified: true, email, phoneNumber: phone }]) {
    const source = new FirebaseIdentifierSource({ getUser: async () => user }, pepper);
    assert.equal(await source.proves('account', hashEmail(email, pepper)!), false);
  }
});
test('verified email must match the current authoritative email', async () => {
  const source = new FirebaseIdentifierSource({ getUser: async () => ({ disabled: false, emailVerified: true, email }) }, pepper);
  assert.equal(await source.proves('account', hashEmail(email, pepper)!), true);
  assert.equal(await source.proves('account', hashEmail('attacker@test.invalid', pepper)!), false);
});
test('deleted identities fail closed while provider outages remain retryable failures', async () => {
  const missing = new FirebaseIdentifierSource({ getUser: async () => { throw { code: 'auth/user-not-found' }; } }, pepper);
  assert.equal(await missing.proves('account', 'hash'), false);
  const down = new FirebaseIdentifierSource({ getUser: async () => { throw Error('sensitive provider error'); } }, pepper);
  await assert.rejects(down.proves('account', 'hash'), /ownership source unavailable/);
});
