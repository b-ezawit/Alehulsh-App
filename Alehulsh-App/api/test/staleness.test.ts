import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reportedDelayMs, isStale, STALE_AFTER_MS, MAX_BELIEVABLE_DELAY_MS } from '../src/staleness.js';

const at = (iso: string) => new Date(iso);
const RECEIVED = at('2026-09-11T12:00:00Z');

describe('reportedDelayMs — the device clock is never believed blindly', () => {
  test('a queued alert reports how long it sat', () => {
    assert.equal(reportedDelayMs(RECEIVED, at('2026-09-11T09:00:00Z')), 3 * 60 * 60 * 1000);
  });

  test('no reported time means unknown', () => {
    assert.equal(reportedDelayMs(RECEIVED, null), null);
    assert.equal(reportedDelayMs(RECEIVED, undefined), null);
  });

  test('a clock running ahead means unknown, not a future alert', () => {
    assert.equal(reportedDelayMs(RECEIVED, at('2026-09-11T13:00:00Z')), null);
  });

  test('a claim too old to believe is discarded', () => {
    // A device weeks behind is far likelier than a two-week-old queued SOS,
    // and believing it would label a live emergency as ancient.
    assert.equal(reportedDelayMs(RECEIVED, at('2026-08-20T12:00:00Z')), null);
    assert.ok(reportedDelayMs(RECEIVED, new Date(RECEIVED.getTime() - MAX_BELIEVABLE_DELAY_MS + 1000)) !== null);
  });

  test('an invalid date is unknown', () => {
    assert.equal(reportedDelayMs(RECEIVED, new Date('not a date')), null);
  });
});

describe('isStale — unknown means assume current', () => {
  test('unknown is never stale', () => {
    // The safe default: it can never cause a real emergency to be dismissed
    // as old news.
    assert.equal(isStale(null), false);
  });

  test('a fresh alert is not stale', () => {
    assert.equal(isStale(1000), false);
  });

  test('past the threshold it is', () => {
    assert.equal(isStale(STALE_AFTER_MS), true);
    assert.equal(isStale(3 * 60 * 60 * 1000), true);
  });
});
