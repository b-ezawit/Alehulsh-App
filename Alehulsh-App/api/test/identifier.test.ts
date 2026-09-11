import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhone, normalizeEmail, hashPhone, hashEmail, identifiersMatch,
} from '../src/crypto/identifier.js';

const PEPPER = 'pepper-for-tests-only';

describe('normalizePhone — the four shapes are the same person', () => {
  const same = ['+251 91 123 4567', '251911234567', '0911234567', '911234567', '+251-91-123-4567'];
  for (const form of same) {
    test(`${form} -> +251911234567`, () => {
      assert.equal(normalizePhone(form), '+251911234567');
    });
  }

  test('accepts a Safaricom Ethiopia prefix', () => {
    assert.equal(normalizePhone('0712345678'), '+251712345678');
  });

  test('rejects what is not an Ethiopian mobile', () => {
    assert.equal(normalizePhone('12345'), null);           // too short
    assert.equal(normalizePhone('+1 415 555 0100'), null); // wrong country
    assert.equal(normalizePhone('0112345678'), null);      // landline prefix
    assert.equal(normalizePhone(''), null);
    assert.equal(normalizePhone('not a number'), null);
  });
});

describe('normalizeEmail', () => {
  test('trims and lowercases', () => {
    assert.equal(normalizeEmail('  Saba@Example.COM '), 'saba@example.com');
  });
  test('rejects the obviously unusable', () => {
    assert.equal(normalizeEmail('nope'), null);
    assert.equal(normalizeEmail(''), null);
  });
});

describe('hashing', () => {
  test('every written form of a number produces one hash', () => {
    // If these diverge, her contact is silently never notified.
    const hashes = new Set(
      ['+251 91 123 4567', '0911234567', '251911234567', '911234567']
        .map((f) => hashPhone(f, PEPPER)),
    );
    assert.equal(hashes.size, 1);
  });

  test('different numbers produce different hashes', () => {
    assert.notEqual(hashPhone('0911234567', PEPPER), hashPhone('0911234568', PEPPER));
  });

  test('the hash does not contain the number', () => {
    const h = hashPhone('0911234567', PEPPER)!;
    assert.ok(!h.includes('911234567'));
  });

  test('a stolen database is useless without the pepper', () => {
    assert.notEqual(hashPhone('0911234567', PEPPER), hashPhone('0911234567', 'other-pepper'));
  });

  test('phone and email are domain-separated', () => {
    // Without separation a crafted email could collide with a phone hash.
    assert.notEqual(hashPhone('0911234567', PEPPER), hashEmail('+251911234567@x.com', PEPPER));
  });

  test('unusable input hashes to nothing rather than to something wrong', () => {
    assert.equal(hashPhone('garbage', PEPPER), null);
    assert.equal(hashEmail('garbage', PEPPER), null);
  });
});

describe('identifiersMatch', () => {
  test('matches equal hashes', () => {
    const h = hashPhone('0911234567', PEPPER)!;
    assert.equal(identifiersMatch(h, h), true);
  });
  test('rejects different hashes and different lengths', () => {
    assert.equal(identifiersMatch(hashPhone('0911234567', PEPPER)!, hashPhone('0911234568', PEPPER)!), false);
    assert.equal(identifiersMatch('short', 'much longer value'), false);
  });
});
