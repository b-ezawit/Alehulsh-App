/**
 * The TypeScript rules and the SQL rules must agree, case for case.
 *
 * The location rules exist twice on the server: in src/domain/location.ts,
 * where the route and the Firestore path use them, and in SQL, where
 * create_alert derives the stored quality so no writer can bypass it. Two
 * implementations of one rule drift. This runs ONE table of cases through
 * both and fails if they ever disagree, which is cheaper than discovering the
 * disagreement through a responder sent to the wrong place.
 *
 * The Kotlin third copy (SosLocationDecision, 33 tests) cannot be reached
 * from here. Its cases are mirrored in location.test.ts by hand, and the
 * threshold it shares with this module is asserted below.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, loadDbConfig, closePool } from '../src/db/pool.js';
import {
  FRESH_FIX_MS, deriveLocationQuality, isUsableCoordinate, hasMeasurementEvidence,
} from '../src/domain/location.js';

let pool: Pool | null = null;
let available = false;
let skipReason = '';

function reachable(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

before(async () => {
  let cfg;
  try { cfg = loadDbConfig(); } catch {
    skipReason = 'PG* environment not configured (fail-closed, not assumed)';
    return;
  }
  if (!(await reachable(cfg.host, cfg.port))) {
    skipReason = 'no PostgreSQL reachable on the configured host:port';
    return;
  }
  pool = createPool(cfg);
  available = true;
});

after(async () => { if (pool) await closePool(pool); });

/**
 * Every case both engines must agree on.
 *
 * Postgres `double precision` can hold NaN and Infinity, and JSON cannot, so
 * those are passed as SQL literals rather than parameters - which is also the
 * only way a direct SQL caller could ever present them.
 */
const CASES: { label: string; lat: string; lng: string; age: string; acc: string; delay?: string }[] = [
  { label: 'fresh 30s fix',             lat: '8.9956', lng: '38.7897', age: '30000',   acc: '12.0' },
  { label: 'at the threshold',          lat: '8.9956', lng: '38.7897', age: String(FRESH_FIX_MS), acc: '12.0' },
  { label: 'one ms past it',            lat: '8.9956', lng: '38.7897', age: String(FRESH_FIX_MS + 1), acc: '12.0' },
  { label: 'stale 20 min',              lat: '8.9956', lng: '38.7897', age: '1200000', acc: '12.0' },
  { label: 'age null',                  lat: '8.9956', lng: '38.7897', age: 'NULL',    acc: '12.0' },
  { label: 'age negative',              lat: '8.9956', lng: '38.7897', age: '-5000',   acc: '12.0' },
  { label: 'no accuracy',               lat: '8.9956', lng: '38.7897', age: '30000',   acc: 'NULL' },
  { label: 'zero accuracy',             lat: '8.9956', lng: '38.7897', age: '30000',   acc: '0' },
  { label: 'huge accuracy',             lat: '8.9956', lng: '38.7897', age: '30000',   acc: '20000' },
  { label: 'no coordinates',            lat: 'NULL',   lng: 'NULL',    age: '30000',   acc: '12.0' },
  { label: 'half a pair (lat only)',    lat: '8.9956', lng: 'NULL',    age: '30000',   acc: '12.0' },
  { label: 'half a pair (lng only)',    lat: 'NULL',   lng: '38.7897', age: '30000',   acc: '12.0' },
  { label: '(0,0) with accuracy',       lat: '0',      lng: '0',       age: '30000',   acc: '12.0' },
  { label: '(0,0) no accuracy',         lat: '0',      lng: '0',       age: '30000',   acc: 'NULL' },
  { label: '(0,0) zero accuracy',       lat: '0',      lng: '0',       age: '30000',   acc: '0' },
  { label: '(0,0) NaN accuracy',        lat: '0',      lng: '0',       age: '30000',   acc: "'NaN'" },
  { label: '(0,0) Inf accuracy',        lat: '0',      lng: '0',       age: '30000',   acc: "'Infinity'" },
  { label: 'zero latitude only',        lat: '0',      lng: '38.7897', age: '30000',   acc: 'NULL' },
  { label: 'zero longitude only',       lat: '8.9956', lng: '0',       age: '30000',   acc: 'NULL' },
  { label: 'north pole',                lat: '90',     lng: '0',       age: '30000',   acc: 'NULL' },
  { label: 'south pole',                lat: '-90',    lng: '0',       age: '30000',   acc: 'NULL' },
  { label: 'antimeridian +180',         lat: '8.9956', lng: '180',     age: '30000',   acc: 'NULL' },
  { label: 'antimeridian -180',         lat: '8.9956', lng: '-180',    age: '30000',   acc: 'NULL' },
  { label: 'lat just over 90',          lat: '90.0001', lng: '0',      age: '30000',   acc: '12.0' },
  { label: 'lat under -90',             lat: '-91',    lng: '0',       age: '30000',   acc: '12.0' },
  { label: 'lng just over 180',         lat: '0',      lng: '180.0001', age: '30000',  acc: '12.0' },
  { label: 'NaN latitude',              lat: "'NaN'",  lng: '38.7897', age: '30000',   acc: '12.0' },
  { label: 'NaN longitude',             lat: '8.9956', lng: "'NaN'",   age: '30000',   acc: '12.0' },
  { label: 'Infinity latitude',         lat: "'Infinity'", lng: '0',   age: '30000',   acc: '12.0' },
  { label: '-Infinity longitude',       lat: '0',      lng: "'-Infinity'", age: '30000', acc: '12.0' },
  { label: 'age zero',                  lat: '8.9956', lng: '38.7897', age: '0',       acc: '12.0' },
  { label: 'age enormous',              lat: '8.9956', lng: '38.7897', age: '999999999', acc: '12.0' },
  // Transit delay (0007): a fix is only as fresh as the moment it arrives.
  { label: 'fresh fix, no delay',       lat: '8.9956', lng: '38.7897', age: '30000',   acc: '12.0', delay: '0' },
  { label: 'fresh fix, 3h queue',       lat: '8.9956', lng: '38.7897', age: '30000',   acc: '12.0', delay: '10800000' },
  { label: 'fresh fix, 5s in flight',   lat: '8.9956', lng: '38.7897', age: '10000',   acc: '12.0', delay: '5000' },
  { label: 'combined crosses boundary', lat: '8.9956', lng: '38.7897', age: '90000',   acc: '12.0', delay: '60000' },
  { label: 'combined exactly at bound', lat: '8.9956', lng: '38.7897', age: '60000',   acc: '12.0', delay: '60000' },
  { label: 'delay alone past bound',    lat: '8.9956', lng: '38.7897', age: '0',       acc: '12.0', delay: '120001' },
  { label: 'negative delay ignored',    lat: '8.9956', lng: '38.7897', age: '30000',   acc: '12.0', delay: '-999999' },
  { label: 'delay NULL means none',     lat: '8.9956', lng: '38.7897', age: '30000',   acc: '12.0', delay: 'NULL' },
  { label: 'unknown age stays unknown', lat: '8.9956', lng: '38.7897', age: 'NULL',    acc: '12.0', delay: '10800000' },
  { label: 'no position, long delay',   lat: 'NULL',   lng: 'NULL',    age: '30000',   acc: '12.0', delay: '10800000' },
];

/** The SQL literal as a JS value, including the float specials. */
function asNumber(literal: string): number | null {
  if (literal === 'NULL') return null;
  const bare = literal.replace(/'/g, '');
  if (bare === 'NaN') return NaN;
  if (bare === 'Infinity') return Infinity;
  if (bare === '-Infinity') return -Infinity;
  return Number(bare);
}

describe('TypeScript and SQL derive the same quality', () => {
  test('every case agrees', async (t) => {
    if (!available) { t.skip(skipReason); return; }

    // One round trip for the whole table: a VALUES list evaluated by the same
    // functions create_alert uses.
    const values = CASES.map((c, i) =>
      `(${i}, ${c.lat}::double precision, ${c.lng}::double precision,` +
      ` ${c.age}::bigint, ${c.acc}::double precision,` +
      ` ${c.delay ?? '0'}::bigint)`).join(',\n');

    const { rows } = await pool!.query<{
      i: number; quality: string; usable: boolean; evidence: boolean;
    }>(`
      SELECT i,
             derive_location_quality(lat, lng, age, acc, $1::bigint, delay) AS quality,
             usable_coordinate(lat, lng, acc)                               AS usable,
             measurement_evidence(acc)                                      AS evidence
        FROM (VALUES\n${values}\n) AS t(i, lat, lng, age, acc, delay)
       ORDER BY i`, [FRESH_FIX_MS]);

    assert.equal(rows.length, CASES.length, 'every case must come back');

    const disagreements: string[] = [];
    for (const row of rows) {
      const c = CASES[row.i]!;
      const lat = asNumber(c.lat);
      const lng = asNumber(c.lng);
      const age = asNumber(c.age);
      const acc = asNumber(c.acc);

      const delay = c.delay === undefined ? 0 : asNumber(c.delay);
      const tsQuality = deriveLocationQuality(lat, lng, age, acc, FRESH_FIX_MS, delay);
      const tsUsable = isUsableCoordinate(lat, lng, acc);
      const tsEvidence = hasMeasurementEvidence(acc);

      if (tsQuality !== row.quality) {
        disagreements.push(`${c.label}: quality ts=${tsQuality} sql=${row.quality}`);
      }
      if (tsUsable !== row.usable) {
        disagreements.push(`${c.label}: usable ts=${tsUsable} sql=${row.usable}`);
      }
      if (tsEvidence !== row.evidence) {
        disagreements.push(`${c.label}: evidence ts=${tsEvidence} sql=${row.evidence}`);
      }
    }

    assert.deepEqual(disagreements, [],
      `the two implementations of the location rules have drifted:\n${disagreements.join('\n')}`);
  });

  test('the case table actually covers the interesting shapes', async (t) => {
    if (!available) { t.skip(skipReason); return; }
    // A parity suite that only ever produced one answer would pass while
    // proving nothing.
    const produced = new Set(CASES.map((c) => deriveLocationQuality(
      asNumber(c.lat), asNumber(c.lng), asNumber(c.age), asNumber(c.acc), FRESH_FIX_MS,
      c.delay === undefined ? 0 : asNumber(c.delay))));
    assert.deepEqual([...produced].sort(),
      ['age_unknown', 'live', 'stale', 'unavailable'],
      'all four qualities must be exercised');
  });
});

describe('the threshold is one value, not two', () => {
  test('the server passes its own threshold into SQL rather than trusting the default', async (t) => {
    if (!available) { t.skip(skipReason); return; }
    // The SQL default exists as a fallback for a direct caller. The
    // repository always passes FRESH_FIX_MS explicitly, so if the two ever
    // differ the server's value is the one that applies - which is what makes
    // this a single threshold rather than a race between two.
    const { rows } = await pool!.query<{ default_fresh: string }>(`
      SELECT pg_get_function_arg_default(p.oid, 9) AS default_fresh
        FROM pg_proc p WHERE p.proname = 'create_alert'`);
    assert.equal(rows[0]?.default_fresh, '120000',
      'the SQL fallback should still match the documented product threshold');
    assert.equal(FRESH_FIX_MS, 120000,
      'and so should the server constant, which mirrors SosLocationDecision.FRESH_FIX_MS');
  });

  test('an explicit threshold overrides the default end to end', async (t) => {
    if (!available) { t.skip(skipReason); return; }
    const { rows } = await pool!.query<{ q: string }>(
      `SELECT derive_location_quality(8.9956, 38.7897, 30000::bigint, 12.0, $1::bigint) AS q`,
      [1000]);
    assert.equal(rows[0]!.q, 'stale', 'a 30s fix is stale under a 1s threshold');
    assert.equal(deriveLocationQuality(8.9956, 38.7897, 30000, 12.0, 1000), 'stale',
      'and the TypeScript side honours it identically');
  });
});

describe('the rule the ROUTE path actually uses, not just the helper', () => {
  test('create_alert stores what derive_location_quality says, delay included', async (t) => {
    if (!available) { t.skip(skipReason); return; }
    // The parity test above compares two implementations of the RULE. This
    // checks that create_alert - the function the repository calls - is wired
    // to that rule rather than carrying its own copy. Without this, both
    // implementations could agree while production used a third.
    const owner = randomUUID();
    const subject = `parity${randomUUID().replace(/-/g, '').slice(0, 22)}`;
    await pool!.query(`INSERT INTO users (id, display_name) VALUES ($1,'Parity')`, [owner]);
    await pool!.query(
      `INSERT INTO identity_map (firebase_uid, user_id) VALUES ($1,$2)`, [subject, owner]);
    try {
      const cases: { label: string; age: number; delayHours: number; expect: string }[] = [
        { label: 'fresh, no queue',  age: 30_000, delayHours: 0, expect: 'live' },
        { label: 'fresh, 3h queue',  age: 30_000, delayHours: 3, expect: 'stale' },
      ];
      for (const c of cases) {
        const occurredAt = new Date(Date.now() - c.delayHours * 3600_000);
        const { rows } = await pool!.query<{ alert_id: string }>(
          `SELECT alert_id FROM create_alert_for_subject(
             $1::text, $2::text, 8.9956, 38.7897, $3::bigint, 12.5,
             interval '2 hours', $4::timestamptz, $5::bigint)`,
          [subject, `parity-${c.label.slice(0, 6).replace(/[^a-z]/gi, '')}-x`,
           c.age, occurredAt, FRESH_FIX_MS]);

        const stored = await pool!.query<{ q: string; delay: string }>(
          `SELECT location_quality AS q, reported_delay_ms AS delay FROM alerts WHERE id = $1`,
          [rows[0]!.alert_id]);

        assert.equal(stored.rows[0]!.q, c.expect, c.label);
        // And the TypeScript rule, given the same evidence, agrees.
        assert.equal(
          deriveLocationQuality(8.9956, 38.7897, c.age, 12.5, FRESH_FIX_MS,
            Number(stored.rows[0]!.delay ?? 0)),
          c.expect, `${c.label}: TypeScript must agree with the stored row`);

        await pool!.query(`DELETE FROM alerts WHERE id = $1`, [rows[0]!.alert_id]);
        await pool!.query(`DELETE FROM alert_history WHERE alert_id = $1`, [rows[0]!.alert_id]);
      }
    } finally {
      await pool!.query(`DELETE FROM alert_history WHERE owner_id = $1`, [owner]);
      await pool!.query(`DELETE FROM users WHERE id = $1`, [owner]);
    }
  });
});
