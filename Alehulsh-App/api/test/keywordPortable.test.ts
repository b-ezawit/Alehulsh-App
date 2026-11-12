import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashKeyword, verifyKeyword } from '../src/crypto/keyword.js';
import {
  hashKeywordPortable, verifyKeywordPortable,
} from '../src/crypto/keywordPortable.js';

/**
 * The Workers-portable keyword KDF must be the SAME KDF.
 *
 * The point of these tests is interchangeability. If a hash written by one
 * implementation did not verify under the other, a cutover would lock every
 * woman out of cancelling her own alert — and the fallback is typing the
 * keyword under duress, so a false negative here is a safety failure, not an
 * inconvenience.
 *
 * Slow by nature: scrypt at N=65536 is ~0.3 s native and ~0.5 s in pure JS, and
 * that cost is the protection.
 */
const PEPPER = 'pepper-for-tests-only';

describe('the two implementations are interchangeable', () => {
  test('a hash written by node:crypto verifies under the portable one', async () => {
    const stored = await hashKeyword('Milo Was Here', PEPPER);
    assert.equal(await verifyKeywordPortable('Milo Was Here', stored, PEPPER), true);
  });

  test('a hash written by the portable one verifies under node:crypto', async () => {
    // The direction that matters at cutover: hashes written on Workers must
    // still verify if we ever have to run the Node path again.
    const stored = await hashKeywordPortable('Milo Was Here', PEPPER);
    assert.equal(await verifyKeyword('Milo Was Here', stored, PEPPER), true);
  });

  test('both write the same self-describing format', async () => {
    const a = await hashKeyword('abay', PEPPER);
    const b = await hashKeywordPortable('abay', PEPPER);
    const [algoA, nA, rA, pA] = a.split('$');
    const [algoB, nB, rB, pB] = b.split('$');

    assert.deepEqual([algoA, nA, rA, pA], ['scrypt', '65536', '8', '1']);
    assert.deepEqual([algoB, nB, rB, pB], ['scrypt', '65536', '8', '1']);
    assert.equal(a.split('$').length, 6);
    assert.equal(b.split('$').length, 6);
    // Different salts, so the digests must differ even for the same word.
    assert.notEqual(a, b);
  });

  test('base64url round-trips through both encoders', async () => {
    // A padding or alphabet mismatch would break verification for a fraction
    // of salts rather than all of them — the worst kind of bug to ship.
    for (let i = 0; i < 6; i += 1) {
      const stored = await hashKeywordPortable(`word-${i}`, PEPPER);
      assert.equal(await verifyKeyword(`word-${i}`, stored, PEPPER), true);
      const other = await hashKeyword(`word-${i}`, PEPPER);
      assert.equal(await verifyKeywordPortable(`word-${i}`, other, PEPPER), true);
      assert.ok(!/[+/=]/.test(stored), 'must be base64url, not base64');
    }
  });
});

describe('the portable implementation rejects what the original rejects', () => {
  test('a wrong keyword is refused', async () => {
    const stored = await hashKeyword('correct', PEPPER);
    assert.equal(await verifyKeywordPortable('wrong', stored, PEPPER), false);
  });

  test('a wrong pepper is refused', async () => {
    // The pepper is what makes a stolen database insufficient.
    const stored = await hashKeyword('correct', PEPPER);
    assert.equal(await verifyKeywordPortable('correct', stored, 'other-pepper'), false);
  });

  test('normalisation matches — case, whitespace and NFKC', async () => {
    const stored = await hashKeyword('Milo', PEPPER);
    for (const variant of ['milo', 'MILO', '  Milo  ', 'Milo\t']) {
      assert.equal(
        await verifyKeywordPortable(variant, stored, PEPPER), true,
        `${JSON.stringify(variant)} must still verify`,
      );
    }
  });

  test('an Amharic keyword round-trips', async () => {
    const stored = await hashKeywordPortable('አባይ', PEPPER);
    assert.equal(await verifyKeyword('አባይ', stored, PEPPER), true);
    assert.equal(await verifyKeywordPortable('አባይ', stored, PEPPER), true);
  });

  test('a malformed record is false, never a bypass and never a throw', async () => {
    for (const bad of [
      '', 'scrypt', 'scrypt$1$2$3', 'bcrypt$65536$8$1$aa$bb',
      'scrypt$65536$8$1$$', 'scrypt$notanumber$8$1$aa$bb',
      'scrypt$65536$8$1$aa', '$$$$$', 'plaintext-keyword',
    ]) {
      assert.equal(
        await verifyKeywordPortable('anything', bad, PEPPER), false,
        `${JSON.stringify(bad)} must be refused`,
      );
    }
  });

  test('absurd parameters are refused rather than exhausting memory', async () => {
    // A tampered record must not be able to request 2^30 rounds — on Workers
    // the memory ceiling is 128 MiB and far harder than on Node.
    for (const bad of [
      'scrypt$1073741824$8$1$YWJj$YWJj',
      'scrypt$512$8$1$YWJj$YWJj',
      'scrypt$65536$64$1$YWJj$YWJj',
      'scrypt$65536$8$32$YWJj$YWJj',
    ]) {
      assert.equal(await verifyKeywordPortable('x', bad, PEPPER), false);
    }
  });

  test('an empty keyword is refused on both sides', async () => {
    await assert.rejects(() => hashKeywordPortable('   ', PEPPER), /empty/);
    const stored = await hashKeyword('real', PEPPER);
    assert.equal(await verifyKeywordPortable('', stored, PEPPER), false);
  });
});

describe('what it costs, measured', () => {
  test('a verify is deliberately slow — that is the protection', async () => {
    const stored = await hashKeywordPortable('timing', PEPPER);
    const t0 = performance.now();
    assert.equal(await verifyKeywordPortable('timing', stored, PEPPER), true);
    const ms = performance.now() - t0;

    // Asserted as a floor, not a ceiling: a verify that got fast would mean
    // the parameters had been weakened. The Workers CPU consequence is in the
    // module header.
    assert.ok(ms > 50, `a verify took only ${ms.toFixed(0)}ms — parameters weakened?`);
  });
});
