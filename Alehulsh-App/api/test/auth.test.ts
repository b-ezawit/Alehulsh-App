import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { requireSubject } from '../src/auth/middleware.js';
import { AppError } from '../src/errors.js';
import type { TokenVerifier } from '../src/auth/TokenVerifier.js';

const ok: TokenVerifier = { verify: async (t) => ({ uid: `uid-for-${t}` }) };
const bad: TokenVerifier = {
  verify: async () => { throw new AppError('unauthenticated', 'bad token'); },
};

const req = (authorization?: string) =>
  ({ headers: authorization ? { authorization } : {} }) as any;

describe('requireSubject', () => {
  test('rejects a missing Authorization header', async () => {
    await assert.rejects(() => requireSubject(ok)(req(), {} as any), /Sign in required/);
  });

  test('rejects a non-Bearer scheme', async () => {
    await assert.rejects(() => requireSubject(ok)(req('Basic abc'), {} as any));
  });

  test('rejects an empty bearer token', async () => {
    await assert.rejects(() => requireSubject(ok)(req('Bearer   '), {} as any));
  });

  test('rejects a token the verifier refuses', async () => {
    await assert.rejects(() => requireSubject(bad)(req('Bearer xyz'), {} as any));
  });

  test('attaches the subject on a valid token', async () => {
    const r = req('Bearer abc');
    await requireSubject(ok)(r, {} as any);
    assert.deepEqual(r.subject, { uid: 'uid-for-abc' });
  });

  test('the client cannot assert its own uid', async () => {
    // A body-supplied uid must be ignored — the subject comes from the token.
    const r = req('Bearer abc');
    r.body = { uid: 'victim_uid' };
    await requireSubject(ok)(r, {} as any);
    assert.equal(r.subject.uid, 'uid-for-abc');
  });
});
