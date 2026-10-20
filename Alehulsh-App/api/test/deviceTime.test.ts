/**
 * occurredAt handling (sprint 3, P4).
 *
 * The contract: optional, informational, and a bad value must never cost her
 * the alert. An ambiguous value is unknown rather than a guess.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readDeviceTime } from '../src/domain/deviceTime.js';

describe('timestamps that are usable', () => {
  test('a UTC timestamp is accepted', () => {
    const r = readDeviceTime('2026-10-17T15:56:00.000Z');
    assert.equal(r.rejection, null);
    assert.equal(r.at?.toISOString(), '2026-10-17T15:56:00.000Z');
  });

  test('an offset-bearing timestamp is accepted and converted', () => {
    const r = readDeviceTime('2026-10-17T15:56:00+03:00');   // Addis
    assert.equal(r.rejection, null);
    assert.equal(r.at?.toISOString(), '2026-10-17T12:56:00.000Z');
  });

  /**
   * Exactly where the boundary falls, measured rather than assumed.
   *
   * V8 is more lenient than RFC3339: it reads the colon-less '-0800' but not
   * the hour-only '+03'. Neither form is emitted by any client we have -
   * Dart's DateTime is either local (no offset at all) or UTC (trailing 'Z') -
   * so this is pinned for the record, not relied on.
   */
  test('a colon-less offset happens to parse', () => {
    const r = readDeviceTime('2026-10-17T15:56:00-0800');
    assert.equal(r.rejection, null);
    assert.equal(r.at?.toISOString(), '2026-10-17T23:56:00.000Z');
  });

  test('an hour-only offset does not, and is reported as unparseable', () => {
    // Truthful: an offset WAS present, so 'no_offset' would be the wrong
    // reason to report. We saw one and still could not read the instant.
    assert.deepEqual(readDeviceTime('2026-10-17T15:56:00+03'),
      { at: null, rejection: 'unparseable' });
  });

  test('lowercase z is accepted', () => {
    assert.equal(readDeviceTime('2026-10-17T15:56:00.000z').rejection, null);
  });
});

describe('timestamps that stay unknown', () => {
  test("Dart's local toIso8601String has no offset, so it is NOT guessed", () => {
    // This is the exact string DateTime.now().toIso8601String() produces.
    // new Date() would read it in the SERVER's timezone - three hours off for
    // a device in Addis - and report a delay that is quietly wrong.
    const r = readDeviceTime('2026-10-17T15:56:00.000');
    assert.equal(r.at, null);
    assert.equal(r.rejection, 'no_offset');
  });

  test('a malformed value is unknown, not an error', () => {
    assert.deepEqual(readDeviceTime('not-a-date'), { at: null, rejection: 'no_offset' });
    assert.deepEqual(readDeviceTime('2026-13-45T99:99:99Z'), { at: null, rejection: 'unparseable' });
  });

  test('absent, null and empty are simply unknown', () => {
    assert.deepEqual(readDeviceTime(undefined), { at: null, rejection: 'absent' });
    assert.deepEqual(readDeviceTime(null), { at: null, rejection: 'absent' });
    assert.deepEqual(readDeviceTime('   '), { at: null, rejection: 'absent' });
  });

  test('a non-string is unknown rather than coerced', () => {
    assert.equal(readDeviceTime(1760716560000).rejection, 'unparseable');
    assert.equal(readDeviceTime({}).rejection, 'unparseable');
  });

  test('it never throws, whatever it is handed', () => {
    for (const v of [NaN, [], Symbol('x'), () => {}, new Date()]) {
      assert.doesNotThrow(() => readDeviceTime(v));
    }
  });

  test('the reason is reported, the value is never echoed', () => {
    const rawValue = '2026-10-17T15:56:00.000';
    const r = readDeviceTime(rawValue);
    assert.equal(r.rejection, 'no_offset');
    assert.ok(!JSON.stringify(r).includes(rawValue),
      'the raw value must not travel with the reason');
  });
});
