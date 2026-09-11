import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashKeyword, verifyKeyword, normalizeKeyword, isShippedDefault,
} from '../src/crypto/keyword.js';

const PEPPER = 'pepper-for-tests-only';

describe('normalizeKeyword', () => {
  test('matches what the Dart client did — trim and lowercase', () => {
    // alert_service.dart compared .trim().toLowerCase(). If we diverge here,
    // every existing keyword breaks at migration.
    assert.equal(normalizeKeyword('  SunFlower  '), 'sunflower');
  });

  test('applies NFKC so Ethiopic input methods agree', () => {
    const composed = 'ሰላም';
    assert.equal(normalizeKeyword(composed), composed.normalize('NFKC').toLowerCase());
  });

  test('collapses a full-width variant onto the plain form', () => {
    assert.equal(normalizeKeyword('ｓｕｎ'), 'sun');
  });
});

describe('hashKeyword / verifyKeyword', () => {
  test('accepts the correct keyword', async () => {
    const stored = await hashKeyword('sunflower', PEPPER);
    assert.equal(await verifyKeyword('sunflower', stored, PEPPER), true);
  });

  test('rejects the wrong keyword', async () => {
    const stored = await hashKeyword('sunflower', PEPPER);
    assert.equal(await verifyKeyword('rose', stored, PEPPER), false);
  });

  test('accepts despite whitespace and case — she is typing under duress', async () => {
    const stored = await hashKeyword('Sunflower', PEPPER);
    assert.equal(await verifyKeyword('  SUNFLOWER ', stored, PEPPER), true);
  });

  test('salts — the same keyword hashes differently every time', async () => {
    const a = await hashKeyword('sunflower', PEPPER);
    const b = await hashKeyword('sunflower', PEPPER);
    assert.notEqual(a, b);
    assert.equal(await verifyKeyword('sunflower', a, PEPPER), true);
    assert.equal(await verifyKeyword('sunflower', b, PEPPER), true);
  });

  test('a stolen database is useless without the pepper', async () => {
    const stored = await hashKeyword('sunflower', PEPPER);
    assert.equal(await verifyKeyword('sunflower', stored, 'wrong-pepper'), false);
  });

  test('the stored value never contains the keyword', async () => {
    const stored = await hashKeyword('sunflower', PEPPER);
    assert.ok(!stored.includes('sunflower'));
  });

  test('an empty keyword cannot be hashed', async () => {
    await assert.rejects(() => hashKeyword('   ', PEPPER));
  });

  test('an empty attempt never verifies — this was the CRIT-05 bypass', async () => {
    // alert_service.dart:301 accepted ANY non-empty string when no keyword was
    // set. Empty, whitespace and garbage must all fail here.
    const stored = await hashKeyword('sunflower', PEPPER);
    assert.equal(await verifyKeyword('', stored, PEPPER), false);
    assert.equal(await verifyKeyword('   ', stored, PEPPER), false);
  });
});

describe('verifyKeyword — malformed stored values must not become a bypass', () => {
  const cases: Array<[string, string]> = [
    ['empty', ''],
    ['plaintext left over from before migration', 'sunflower'],
    ['wrong algorithm', 'bcrypt$1$2$3$aaaa$bbbb'],
    ['too few fields', 'scrypt$65536$8$1$aaaa'],
    ['non-numeric parameters', 'scrypt$x$y$z$aaaa$bbbb'],
    ['empty salt and hash', 'scrypt$65536$8$1$$'],
    ['absurd N — memory exhaustion vector', 'scrypt$999999999$8$1$aaaa$bbbb'],
  ];
  for (const [name, stored] of cases) {
    test(`rejects: ${name}`, async () => {
      assert.equal(await verifyKeyword('sunflower', stored, PEPPER), false);
    });
  }
});

describe('isShippedDefault', () => {
  test('flags the default every user currently shares', () => {
    assert.equal(isShippedDefault('Milo'), true);
    assert.equal(isShippedDefault('  milo '), true);
    assert.equal(isShippedDefault('sunflower'), false);
  });
});
