import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeGeohash } from '../src/geo.js';

describe('encodeGeohash', () => {
  test('matches a known reference value', () => {
    // Standard geohash fixture.
    assert.equal(encodeGeohash(57.64911, 10.40744, 11), 'u4pruydqqvj');
  });

  test('agrees with the Dart implementation for Addis Ababa', () => {
    // Pinned on both sides — lib/utils/geohash_util.dart carries the same
    // fixture. If these drift, the client and the server disagree about who is
    // nearby and the fan-out selects the wrong responders.
    assert.equal(encodeGeohash(9.0125, 38.7636, 9), 'scee60dv9');
  });

  test('nearby points share a prefix, distant points do not', () => {
    const a = encodeGeohash(9.0125, 38.7636, 9);
    const b = encodeGeohash(9.0126, 38.7637, 9);
    const far = encodeGeohash(-33.86, 151.20, 9);
    assert.equal(a.slice(0, 5), b.slice(0, 5));
    assert.notEqual(a.slice(0, 1), far.slice(0, 1));
  });

  test('rejects non-finite coordinates', () => {
    assert.throws(() => encodeGeohash(NaN, 0), RangeError);
    assert.throws(() => encodeGeohash(0, Infinity), RangeError);
  });
});
