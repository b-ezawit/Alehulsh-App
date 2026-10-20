/**
 * The location rules, on their own, with no database.
 *
 * These mirror SosLocationDecisionTest.kt case for case. Two implementations
 * of one rule is a drift risk; location.parity.integration.test.ts proves this
 * module and the SQL functions agree, and this file proves the module is
 * right in the first place.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRESH_FIX_MS, deriveLocationQuality, hasMeasurementEvidence,
  isUsableCoordinate, normalizeLocation,
} from '../src/domain/location.js';

const ADDIS = { lat: 8.9956, lng: 38.7897 };

describe('measurement evidence', () => {
  test('a positive finite accuracy is evidence', () => {
    assert.equal(hasMeasurementEvidence(12.5), true);
    assert.equal(hasMeasurementEvidence(2000), true, 'imprecise is still measured');
    assert.equal(hasMeasurementEvidence(0.0001), true);
  });

  test('nothing, zero, NaN and infinity are not', () => {
    for (const v of [null, undefined, 0, -1, NaN, Infinity, -Infinity]) {
      assert.equal(hasMeasurementEvidence(v as number), false, `${String(v)} is not evidence`);
    }
  });
});

describe('usable coordinates — structural', () => {
  test('a real position is usable', () => {
    assert.equal(isUsableCoordinate(ADDIS.lat, ADDIS.lng), true);
  });

  test('NaN and infinity are not points on Earth', () => {
    assert.equal(isUsableCoordinate(NaN, ADDIS.lng), false);
    assert.equal(isUsableCoordinate(ADDIS.lat, NaN), false);
    assert.equal(isUsableCoordinate(Infinity, ADDIS.lng), false);
    assert.equal(isUsableCoordinate(ADDIS.lat, -Infinity), false);
  });

  test('out of range is rejected', () => {
    assert.equal(isUsableCoordinate(91, 0, 10), false);
    assert.equal(isUsableCoordinate(-91, 0, 10), false);
    assert.equal(isUsableCoordinate(0, 181, 10), false);
    assert.equal(isUsableCoordinate(0, -181, 10), false);
  });

  test('half a pair is not a position', () => {
    assert.equal(isUsableCoordinate(ADDIS.lat, null), false);
    assert.equal(isUsableCoordinate(null, ADDIS.lng), false);
    assert.equal(isUsableCoordinate(undefined, undefined), false);
  });

  test('no geography is assumed: poles and the antimeridian are real places', () => {
    assert.equal(isUsableCoordinate(90, 0), true, 'north pole');
    assert.equal(isUsableCoordinate(-90, 0), true, 'south pole');
    assert.equal(isUsableCoordinate(0, 180), true, 'antimeridian');
    assert.equal(isUsableCoordinate(0, -180), true);
  });

  test('a zero on ONE axis is legitimate and kept', () => {
    assert.equal(isUsableCoordinate(0, ADDIS.lng), true, 'on the equator');
    assert.equal(isUsableCoordinate(ADDIS.lat, 0), true, 'on the prime meridian');
  });
});

describe('usable coordinates — evidential, (0,0) only', () => {
  test('a bare (0,0) is an uninitialised reading, not a position', () => {
    assert.equal(isUsableCoordinate(0, 0), false);
    assert.equal(isUsableCoordinate(0, 0, null), false);
    assert.equal(isUsableCoordinate(0, 0, 0), false, 'zero accuracy is not a measurement');
    assert.equal(isUsableCoordinate(0, 0, NaN), false);
  });

  test('a (0,0) WITH accuracy is a real place and is kept', () => {
    // Rejected for lack of evidence, never for being geographically unlikely.
    assert.equal(isUsableCoordinate(0, 0, 12.5), true);
  });
});

describe('quality derivation', () => {
  test('no usable coordinate is unavailable', () => {
    assert.equal(deriveLocationQuality(null, null, 1000, 10), 'unavailable');
    assert.equal(deriveLocationQuality(ADDIS.lat, null, 1000, 10), 'unavailable');
    assert.equal(deriveLocationQuality(0, 0, 1000, null), 'unavailable');
    assert.equal(deriveLocationQuality(91, 0, 1000, 10), 'unavailable');
  });

  test('a fresh fix is live, inclusive at the boundary', () => {
    assert.equal(deriveLocationQuality(ADDIS.lat, ADDIS.lng, 0, 10), 'live');
    assert.equal(deriveLocationQuality(ADDIS.lat, ADDIS.lng, 30_000, 10), 'live');
    assert.equal(deriveLocationQuality(ADDIS.lat, ADDIS.lng, FRESH_FIX_MS, 10), 'live',
      'exactly at the threshold still counts as live');
  });

  test('one millisecond past the boundary is stale', () => {
    assert.equal(deriveLocationQuality(ADDIS.lat, ADDIS.lng, FRESH_FIX_MS + 1, 10), 'stale');
    assert.equal(deriveLocationQuality(ADDIS.lat, ADDIS.lng, 20 * 60_000, 10), 'stale');
  });

  test('an unknown or impossible age keeps the position but withdraws the claim', () => {
    // Discarding the position would throw away a real starting point;
    // calling it live would be a lie.
    assert.equal(deriveLocationQuality(ADDIS.lat, ADDIS.lng, null, 10), 'age_unknown');
    assert.equal(deriveLocationQuality(ADDIS.lat, ADDIS.lng, undefined, 10), 'age_unknown');
    assert.equal(deriveLocationQuality(ADDIS.lat, ADDIS.lng, -5000, 10), 'age_unknown',
      'a negative age means the device clock moved');
    assert.equal(deriveLocationQuality(ADDIS.lat, ADDIS.lng, NaN, 10), 'age_unknown');
  });

  test('a claimed quality in the input is ignored entirely', () => {
    // A hostile client sending the strongest claim it can, with evidence that
    // supports nothing. "Live" sends someone running to a position; it must
    // come from the evidence or not at all.
    const spoofed = {
      latitude: ADDIS.lat, longitude: ADDIS.lng,
      locationAgeMs: 6 * 60 * 60 * 1000,        // six hours old
      accuracyMeters: 12.5,
      locationQuality: 'live',                   // the lie
      quality: 'live',                           // and the other spelling of it
    } as Parameters<typeof normalizeLocation>[0];

    assert.equal(normalizeLocation(spoofed).quality, 'stale',
      'the age decides, not the claim');
  });

  test('a claim cannot conjure a position that is not there', () => {
    const spoofed = {
      latitude: null, longitude: null,
      locationQuality: 'live', accuracyMeters: 12.5, locationAgeMs: 0,
    } as Parameters<typeof normalizeLocation>[0];

    const n = normalizeLocation(spoofed);
    assert.equal(n.quality, 'unavailable');
    assert.equal(n.latitude, null);
  });
});

describe('transit delay — a fix is only as fresh as the moment it arrives', () => {
  test('a queued alert is stale however fresh the fix was when taken', () => {
    // The defect this closes: a 30-second fix queued for three hours was
    // labelled 'live', and a responder trusting that would go where she was
    // three hours ago.
    assert.equal(
      deriveLocationQuality(ADDIS.lat, ADDIS.lng, 30_000, 12.5, FRESH_FIX_MS, 3 * 3600_000),
      'stale');
  });

  test('a short transit delay does not wrongly age a fresh fix', () => {
    assert.equal(
      deriveLocationQuality(ADDIS.lat, ADDIS.lng, 10_000, 12.5, FRESH_FIX_MS, 5_000),
      'live');
  });

  test('age and delay combine, and the sum is what the threshold sees', () => {
    // Neither 90s nor 60s exceeds the 120s threshold; together they do.
    assert.equal(
      deriveLocationQuality(ADDIS.lat, ADDIS.lng, 90_000, 12.5, FRESH_FIX_MS, 60_000),
      'stale');
    assert.equal(
      deriveLocationQuality(ADDIS.lat, ADDIS.lng, 60_000, 12.5, FRESH_FIX_MS, 60_000),
      'live', 'exactly at the threshold is still live');
  });

  test('a negative delay cannot buy freshness', () => {
    // A device clock running ahead must not be able to subtract from the fix
    // age. Floored at zero rather than trusted.
    assert.equal(
      deriveLocationQuality(ADDIS.lat, ADDIS.lng, 20 * 60_000, 12.5, FRESH_FIX_MS, -99_999_999),
      'stale');
  });

  test('an unknown age stays unknown however long the queue was', () => {
    // Adding a known delay to an unknown age does not produce knowledge.
    assert.equal(
      deriveLocationQuality(ADDIS.lat, ADDIS.lng, null, 12.5, FRESH_FIX_MS, 3 * 3600_000),
      'age_unknown');
  });

  test('a missing position stays unavailable, delay or not', () => {
    assert.equal(
      deriveLocationQuality(null, null, 30_000, 12.5, FRESH_FIX_MS, 3 * 3600_000),
      'unavailable');
  });

  test('normalizeLocation threads the delay through and keeps the position', () => {
    const n = normalizeLocation({
      latitude: ADDIS.lat, longitude: ADDIS.lng,
      locationAgeMs: 30_000, accuracyMeters: 12.5, queuedDelayMs: 3 * 3600_000,
    });
    assert.equal(n.quality, 'stale');
    assert.equal(n.latitude, ADDIS.lat, 'a stale position is still a starting point');
    assert.equal(n.ageMs, 30_000,
      "the device's own claim is preserved as evidence, not overwritten");
  });

  test('omitting the delay behaves as no delay, so a live request is unaffected', () => {
    assert.equal(
      normalizeLocation({
        latitude: ADDIS.lat, longitude: ADDIS.lng, locationAgeMs: 30_000, accuracyMeters: 12.5,
      }).quality,
      'live');
  });
});

describe('normalisation for storage', () => {
  test('a fresh, accurate fix is preserved whole', () => {
    const n = normalizeLocation({
      latitude: ADDIS.lat, longitude: ADDIS.lng, locationAgeMs: 30_000, accuracyMeters: 12.5,
    });
    assert.deepEqual(n, {
      latitude: ADDIS.lat, longitude: ADDIS.lng,
      quality: 'live', ageMs: 30_000, accuracyMeters: 12.5,
    });
  });

  test('a stale fix keeps its position and its age', () => {
    const n = normalizeLocation({
      latitude: ADDIS.lat, longitude: ADDIS.lng, locationAgeMs: 1_200_000, accuracyMeters: 40,
    });
    assert.equal(n.quality, 'stale');
    assert.equal(n.ageMs, 1_200_000, 'how old it is, is the point of a stale fix');
    assert.equal(n.latitude, ADDIS.lat);
  });

  test('an unusable coordinate carries NO metadata that implies a position', () => {
    const n = normalizeLocation({
      latitude: 0, longitude: 0, locationAgeMs: 30_000, accuracyMeters: null,
    });
    assert.deepEqual(n, {
      latitude: null, longitude: null,
      quality: 'unavailable', ageMs: null, accuracyMeters: null,
    });
  });

  test('nothing is ever substituted for a missing position', () => {
    const n = normalizeLocation({ latitude: null, longitude: null });
    assert.equal(n.latitude, null);
    assert.equal(n.longitude, null);
    assert.notEqual(n.latitude, 0, 'not zero, not Addis, not anything');
  });

  test('metadata is normalised to what the constraints accept, never passed through', () => {
    // age_not_negative and accuracy_positive would otherwise reject the row,
    // and the alert would be lost to preserve a field nobody needs.
    const n = normalizeLocation({
      latitude: ADDIS.lat, longitude: ADDIS.lng, locationAgeMs: -1, accuracyMeters: 0,
    });
    assert.equal(n.ageMs, null);
    assert.equal(n.accuracyMeters, null);
    assert.equal(n.quality, 'age_unknown');
  });

  test('a missing accuracy does not discard a position that needs none', () => {
    const n = normalizeLocation({
      latitude: ADDIS.lat, longitude: ADDIS.lng, locationAgeMs: 30_000,
    });
    assert.equal(n.quality, 'live', 'accuracy is evidence, not a requirement');
    assert.equal(n.accuracyMeters, null);
  });

  test('a missing age does not discard the position either', () => {
    const n = normalizeLocation({
      latitude: ADDIS.lat, longitude: ADDIS.lng, accuracyMeters: 12.5,
    });
    assert.equal(n.quality, 'age_unknown');
    assert.equal(n.ageMs, null);
    assert.equal(n.accuracyMeters, 12.5);
  });
});
