/**
 * What leaves the process when something goes wrong.  (audit §8)
 *
 * Two separate audiences with opposite requirements:
 *
 *   the CLIENT gets a generic code and nothing else, because an error message
 *   is an oracle - "which alert ids exist", "is this person provisioned",
 *   "what is the schema";
 *
 *   the OPERATOR needs enough to diagnose an outage, because an error that
 *   reveals nothing to anyone is how a database failure gets mistaken for a
 *   quiet afternoon.
 *
 * The property that must not regress: a PostgreSQL error carries the failing
 * ROW in `err.detail`, which for this schema means coordinates, and for
 * `users` means the keyword hash. `toClientError` logs `err.message` only, so
 * none of that is recorded. That is load-bearing and currently incidental -
 * one `JSON.stringify(err)` in a catch block would undo it - so it is pinned
 * here.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, loadDbConfig, closePool } from '../src/db/pool.js';
import { toClientError } from '../src/errors.js';
import { IdentityNotMappedError } from '../src/repositories/types.js';
import { PostgresAlertRepository } from '../src/repositories/postgres/PostgresAlertRepository.js';

let pool: Pool | null = null;
let available = false;
let skipReason = '';
const OWNER_UUID = randomUUID();
const SUBJECT = `esOwner${randomUUID().replace(/-/g, '').slice(0, 21)}`;

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
  pool = createPool(cfg, { max: 2 });
  await pool.query(
    `INSERT INTO users (id, display_name) VALUES ($1,'ErrSurface')
     ON CONFLICT (id) DO NOTHING`, [OWNER_UUID]);
  await pool.query(
    `INSERT INTO identity_map (firebase_uid, user_id) VALUES ($1,$2)
     ON CONFLICT (firebase_uid) DO NOTHING`, [SUBJECT, OWNER_UUID]);
  available = true;
});

after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM alerts WHERE owner_id = $1`, [OWNER_UUID]);
  await pool.query(`DELETE FROM alert_history WHERE owner_id = $1`, [OWNER_UUID]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [OWNER_UUID]);
  await closePool(pool);
});

function etest(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) { t.skip(skipReason); return; }
    await fn();
  });
}

describe('a PostgreSQL error never carries the row off the box', () => {
  etest('a constraint violation leaks neither coordinates nor the row', async () => {
    const err = await pool!.query(
      `INSERT INTO alerts (owner_id, request_id, expires_at, location, location_quality,
                           location_age_ms)
       VALUES ($1,'err-coords-1', now()+interval '2 hours',
               ST_SetSRID(ST_MakePoint(38.7897, 8.9956),4326)::geography, 'live', NULL)`,
      [OWNER_UUID],
    ).then(() => null, (e: unknown) => e);

    assert.ok(err, 'the insert must have been refused');
    const detail = String((err as { detail?: string }).detail);

    // Assert the row IS in `detail` before asserting it does not escape -
    // otherwise this test could pass because there was nothing to leak.
    assert.match(detail, /Failing row contains/);
    assert.ok(detail.includes(OWNER_UUID),
      'the internal account id is in err.detail in plain text');
    // The geography arrives as WKB hex rather than decimal degrees. That is
    // NOT protection: 0101000020E6100000... decodes to the coordinate in one
    // line. Treat it as the position it is.
    const wkb = detail.match(/\b0101000020E6100000[0-9A-F]+\b/)?.[0];
    assert.ok(wkb, 'the position IS in err.detail, WKB-encoded — hence this test');

    const { status, body, internal } = toClientError(err);
    assert.equal(status, 500);
    assert.deepEqual(body, {
      error: { code: 'internal', message: 'Something went wrong on our side.' },
    });

    const toClient = JSON.stringify(body);
    const toLog = JSON.stringify(internal);
    for (const secret of [wkb, 'Failing row', OWNER_UUID, '8.9956']) {
      assert.ok(!toClient.includes(secret), `client body must not contain ${secret}`);
      assert.ok(!toLog.includes(secret), `log line must not contain ${secret}`);
    }
    // But the operator still learns what broke.
    assert.match(toLog, /live_requires_age/,
      'an operator must be able to tell which constraint failed');
  });

  etest('a users constraint violation does not record the keyword hash', async () => {
    const err = await pool!.query(
      `INSERT INTO users (id, display_name, phone_hash, keyword_hash)
       VALUES ($1, 'LeakProbe', 'SYNTHETIC-PHONE', 'SYNTHETIC-KEYWORD')`,
      [randomUUID()],
    ).then(() => null, (e: unknown) => e);

    assert.ok(err, 'phone_hash_requires_verification must refuse this');
    const toLog = JSON.stringify(toClientError(err).internal);
    assert.ok(!toLog.includes('SYNTHETIC-KEYWORD'),
      'the safety keyword hash must never reach a log line');
    assert.ok(!toLog.includes('SYNTHETIC-PHONE'));
  });

  etest('a type-cast failure does not echo the value that caused it', async () => {
    // The uuid cast error names the offending value, which for owner_id would
    // be somebody's subject.
    const err = await pool!.query(
      `SELECT * FROM alerts WHERE id = $1::uuid`, ['not-a-uuid-at-all'],
    ).then(() => null, (e: unknown) => e);

    const { body } = toClientError(err);
    assert.ok(!JSON.stringify(body).includes('not-a-uuid-at-all'));
    assert.equal((body as { error: { code: string } }).error.code, 'internal');
  });
});

describe('an outage is not disguised as an authorization failure', () => {
  etest('a database that is down produces 500, not 403', async () => {
    // If a connection failure were reported as "forbidden", every alert would
    // be refused during an outage and the dashboards would show a spike in
    // authorization failures rather than a database down. Operators would be
    // looking in the wrong place during an emergency.
    const dead = createPool(
      { host: '127.0.0.1', port: 1, database: 'x', user: 'x', password: 'x' },
      { connectionTimeoutMillis: 500 });
    const repo = new PostgresAlertRepository(dead, 7_200_000);
    try {
      const err = await repo.create({
        requestId: 'err-outage-01', ownerId: SUBJECT, latitude: null, longitude: null,
      }).then(() => null, (e: unknown) => e);

      assert.ok(err, 'it must fail');
      assert.ok(!(err instanceof IdentityNotMappedError),
        'a connection failure is not an identity problem');
      const { status, body } = toClientError(err);
      assert.equal(status, 500, 'an outage must look like an outage');
      assert.equal((body as { error: { code: string } }).error.code, 'internal');
    } finally {
      await closePool(dead);
    }
  });

  etest('an unmapped identity produces 403 and is internally distinguishable', async () => {
    const err = new IdentityNotMappedError();
    const { status, body, internal } = toClientError(err);

    assert.equal(status, 403);
    // Public: identical to any other refusal, so it is not an oracle.
    assert.equal((body as { error: { message: string } }).error.message, 'Not available.');
    // Internal: distinguishable, so an operator can tell a provisioning gap
    // from an outage without the client learning anything.
    assert.match(JSON.stringify(internal), /identity not mapped/);
  });

  etest('neither carries the subject that triggered it', async () => {
    const err = new IdentityNotMappedError();
    const whole = JSON.stringify(toClientError(err));
    assert.ok(!whole.includes(SUBJECT));
    assert.ok(!whole.includes(OWNER_UUID));
  });
});

describe('connection errors do not carry credentials', () => {
  etest('a failed connection never serialises the password', async () => {
    const dead = createPool(
      { host: '127.0.0.1', port: 1, database: 'synthetic', user: 'synthetic',
        password: 'sentinel-not-a-real-secret' },
      { connectionTimeoutMillis: 500 });
    try {
      const err = await dead.query(`SELECT 1`).then(() => null, (e: unknown) => e);
      const everything = [
        String(err),
        JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})),
        JSON.stringify(toClientError(err)),
      ].join('|');
      assert.ok(!everything.includes('sentinel-not-a-real-secret'),
        'a credential must not travel with a connection error');
    } finally {
      await closePool(dead);
    }
  });
});
