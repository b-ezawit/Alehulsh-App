/**
 * The HTTP routes over a REAL PostgreSQL+PostGIS alert store.
 *
 * postgresAlertRepository.integration.test.ts proves the repository. This
 * proves the layer above it: Fastify, the body schema, the rate limiter's
 * emergency bypass, idempotency and the safety-check scheduling all running
 * against PostGIS instead of Firestore. A repository that satisfies its
 * interface in isolation can still be wrong for the routes that call it, and
 * that is the gap this closes.
 *
 * REAL here:   buildServer, every route, PostgresAlertRepository, PostGIS.
 * SUBSTITUTED: tokenVerifier, task queue, rate limiter and every repository
 *              other than `alerts` - named so no reader mistakes this for an
 *              end-to-end test of the deployed system.
 *
 * NOTE ON IDENTITY: the owner uid here is a UUID, because the schema types
 * owner_id as uuid while Firebase issues 28-character ids. Translating one to
 * the other is identity_map's job and NOTHING IMPLEMENTS IT YET - see the
 * `unmapped identity` test below, which pins that boundary deliberately.
 *
 * Synthetic data only. Skips when no PG* environment is configured.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';
import { createPool, loadDbConfig } from '../src/db/pool.js';
import { PostgresAlertRepository } from '../src/repositories/postgres/PostgresAlertRepository.js';
import { hashKeyword } from '../src/crypto/keyword.js';
import { InMemorySlidingWindowLimiter, type RateLimiter } from '../src/rate/RateLimiter.js';
import { makeDeps, authAs, PEPPER, ACTIVE_WINDOW, FakeUserRepository } from './fakes.js';

/**
 * Subjects, as the token verifier produces them, plus the internal uuids they
 * map to. The routes only ever see the subjects.
 */
const OWNER_UUID = randomUUID();
const STRANGER_UUID = randomUUID();
const OWNER = `rtOwner${randomUUID().replace(/-/g, '').slice(0, 21)}`;
const STRANGER = `rtStrng${randomUUID().replace(/-/g, '').slice(0, 21)}`;
/** Authenticated, but with no internal account. */
const UNMAPPED = `rtGhost${randomUUID().replace(/-/g, '').slice(0, 21)}`;
const KEYWORD = 'ethiopia-synthetic-keyword';

let pool: Pool | null = null;
let app: FastifyInstance;
let users: FakeUserRepository;
let queue: InMemoryTaskQueue;
/**
 * Replaced between tests.
 *
 * The in-memory limiter has no reset and counts per subject for the lifetime
 * of the app instance, so the deliberate 26-request bypass test below would
 * otherwise exhaust the abuse ceiling for every test after it. The app holds
 * a delegating limiter so the instance can be swapped without rebuilding it.
 */
let limiter = new InMemorySlidingWindowLimiter();
const delegatingLimiter: RateLimiter = {
  hit: (key, cap, windowMs) => limiter.hit(key, cap, windowMs),
};
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
  try {
    cfg = loadDbConfig();
  } catch {
    skipReason = 'PG* environment not configured (fail-closed, not assumed)';
    return;
  }
  if (!(await reachable(cfg.host, cfg.port))) {
    skipReason = 'no PostgreSQL reachable on the configured host:port';
    return;
  }
  pool = createPool(cfg);
  await pool.query(
    `INSERT INTO users (id, display_name) VALUES ($1,'Owner'),($2,'Stranger')
     ON CONFLICT (id) DO NOTHING`, [OWNER_UUID, STRANGER_UUID]);
  await pool.query(
    `INSERT INTO identity_map (firebase_uid, user_id) VALUES ($1,$2),($3,$4)
     ON CONFLICT (firebase_uid) DO NOTHING`,
    [OWNER, OWNER_UUID, STRANGER, STRANGER_UUID]);

  users = new FakeUserRepository();
  users.set(OWNER, { safetyKeywordHash: await hashKeyword(KEYWORD, PEPPER) });
  queue = new InMemoryTaskQueue();

  app = buildServer(makeDeps({
    alerts: new PostgresAlertRepository(pool, ACTIVE_WINDOW),
    users,
    queue,
    limiter: delegatingLimiter,
  }));
  available = true;
});

async function clearOwnRows(): Promise<void> {
  const owners = [[OWNER_UUID, STRANGER_UUID]];
  await pool!.query(`DELETE FROM evidence WHERE owner_id = ANY($1::uuid[])`, owners);
  await pool!.query(`DELETE FROM alerts WHERE owner_id = ANY($1::uuid[])`, owners);
}

after(async () => {
  if (!pool) return;
  await app?.close();
  await clearOwnRows();
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[OWNER_UUID, STRANGER_UUID]]);
  await pool.end();
});

function rtest(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) { t.skip(skipReason); return; }
    await clearOwnRows();
    limiter = new InMemorySlidingWindowLimiter();
    await fn();
  });
}

/** How many alert rows this owner actually has in PostGIS. */
async function rowCount(owner = OWNER_UUID): Promise<number> {
  const { rows } = await pool!.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM alerts WHERE owner_id = $1`, [owner]);
  return rows[0]!.n;
}

describe('POST /v1/alerts against PostGIS', () => {
  rtest('a request creates exactly one row, and the position is readable back', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-create-0001', latitude: 8.9956, longitude: 38.7897 },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(await rowCount(), 1);

    // Read through SQL, not through the repository: this checks the row that
    // actually landed, not the mapping that produced the response.
    const { rows } = await pool!.query(
      `SELECT status, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
         FROM alerts WHERE owner_id = $1`, [OWNER_UUID]);
    assert.equal(rows[0].status, 'active');
    assert.ok(Math.abs(Number(rows[0].lat) - 8.9956) < 1e-6);
    assert.ok(Math.abs(Number(rows[0].lng) - 38.7897) < 1e-6);
  });

  rtest('the response never carries another account identifier', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-leak-00001', latitude: null, longitude: null },
    });
    const body = res.payload;
    assert.ok(!body.includes(STRANGER), 'no unrelated account id may appear');
    assert.ok(!body.includes(PEPPER), 'the keyword pepper must never be serialised');
    // And the internal uuid is not reachable through the HTTP surface either.
    assert.ok(!body.includes(OWNER_UUID), 'her own internal account id must not be exposed');
    assert.ok(!body.includes(STRANGER_UUID));
  });

  rtest('a retried requestId returns the same alert and schedules no second check', async () => {
    const payload = { requestId: 'rt-retry-0001', latitude: null, longitude: null };
    const first = await app.inject({ method: 'POST', url: '/v1/alerts', headers: authAs(OWNER), payload });
    const keysAfterFirst = [...queue.scheduled.keys()].sort();
    const safetyCheck = [...queue.scheduled.values()]
      .find((task) => task.key.startsWith('safety-check:'));
    assert.ok(safetyCheck, 'the first alert must schedule a safety check at all');
    const firstRunAt = safetyCheck.runAt.getTime();

    const retry = await app.inject({ method: 'POST', url: '/v1/alerts', headers: authAs(OWNER), payload });

    assert.equal(retry.json().alert.id, first.json().alert.id);
    assert.equal(await rowCount(), 1, 'a retry must not raise a second alarm');
    assert.deepEqual([...queue.scheduled.keys()].sort(), keysAfterFirst,
      'a retry must not enqueue anything new');
    // The real hazard is not a duplicate task - the key would dedupe one - but
    // a LATER one. If a retry pushed runAt back, someone re-tapping SOS would
    // postpone her own escalation indefinitely.
    const after = [...queue.scheduled.values()]
      .find((task) => task.key.startsWith('safety-check:'));
    assert.equal(after?.runAt.getTime(), firstRunAt,
      'a retry must never postpone the safety check');
  });

  rtest('re-triggering during a live emergency is never refused', async () => {
    // The limiter is skipped entirely while an alert is live. Exceeding the cap
    // on purpose proves the bypass, not the cap.
    await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-live-00001', latitude: null, longitude: null },
    });
    for (let i = 0; i < 25; i += 1) {
      const res = await app.inject({
        method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
        payload: { requestId: `rt-live-1${String(i).padStart(4, '0')}`, latitude: null, longitude: null },
      });
      assert.notEqual(res.statusCode, 429, `re-trigger ${i} was throttled during a live emergency`);
    }
    assert.equal(await rowCount(), 1, 'and all of them folded into the one alert');
  });

  rtest('half a coordinate is refused by the route before the database is touched', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-half-0001', latitude: 8.9956 },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(await rowCount(), 0, 'nothing may be persisted for a rejected request');
  });

  rtest('an out-of-range coordinate is refused by the schema', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-range-001', latitude: 999, longitude: 999 },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(await rowCount(), 0);
  });

  rtest('an unauthenticated request creates nothing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts',
      payload: { requestId: 'rt-noauth-001', latitude: null, longitude: null },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(await rowCount(), 0);
  });

  rtest('a device-reported time does not make the alert arrive pre-expired', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: {
        requestId: 'rt-queued-001', latitude: null, longitude: null,
        occurredAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      },
    });
    assert.equal(res.statusCode, 201);
    const { rows } = await pool!.query(
      `SELECT expires_at > now() AS live, reported_delay_ms FROM alerts WHERE owner_id = $1`,
      [OWNER_UUID]);
    assert.equal(rows[0].live, true, 'an alert queued offline must still dispatch');
    assert.ok(Number(rows[0].reported_delay_ms) > 5 * 60 * 60 * 1000,
      'and the delay must be visible rather than hidden');
  });

  // The sprint 2 test that pinned the 400-on-malformed-occurredAt defect was
  // REMOVED here, not weakened: the defect is fixed, so an assertion that it
  // still happens would be false. Its replacements are in the
  // 'occurredAt through the route (P4)' suite below, which covers the same
  // inputs and asserts the corrected behaviour.
});

describe('resolution against PostGIS', () => {
  rtest('the owner resolves her alert and the row reaches a terminal state', async () => {
    const created = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-resolve-01', latitude: null, longitude: null },
    });
    const id = created.json().alert.id;

    const res = await app.inject({
      method: 'POST', url: `/v1/alerts/${id}/resolve`, headers: authAs(OWNER),
      payload: { keyword: KEYWORD },
    });
    assert.equal(res.statusCode, 200);

    const { rows } = await pool!.query(
      `SELECT status, end_reason, ended_at IS NOT NULL AS ended, resolved_by
         FROM alerts WHERE id = $1`, [id]);
    assert.equal(rows[0].status, 'resolved');
    assert.equal(rows[0].ended, true, 'a resolved alert must carry when it ended');
    assert.equal(rows[0].end_reason, 'resolved', 'status and end_reason must agree');
  });

  rtest('a wrong keyword escalates rather than ending the alert', async () => {
    const created = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-wrongkw-01', latitude: null, longitude: null },
    });
    const id = created.json().alert.id;

    await app.inject({
      method: 'POST', url: `/v1/alerts/${id}/resolve`, headers: authAs(OWNER),
      payload: { keyword: 'definitely-not-her-keyword' },
    });

    const { rows } = await pool!.query(
      `SELECT status, attempt_count, escalation_reason, ended_at FROM alerts WHERE id = $1`, [id]);

    // 'escalated', not 'active': a wrong keyword is treated as possible
    // coercion, so the alert is raised rather than left as it was. The safety
    // property is that it is NOT terminal - someone guessing at her shoulder
    // must not be able to end it.
    assert.equal(rows[0].status, 'escalated');
    assert.equal(rows[0].ended_at, null, 'guessing must never end an alert');
    assert.equal(rows[0].escalation_reason, 'wrong_keyword');
    assert.ok(Number(rows[0].attempt_count) >= 1, 'and the failed attempt is itself recorded evidence');
  });

  rtest('a stranger cannot resolve her alert, and learns nothing by trying', async () => {
    const created = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-stranger-1', latitude: null, longitude: null },
    });
    const id = created.json().alert.id;

    const real = await app.inject({
      method: 'POST', url: `/v1/alerts/${id}/resolve`, headers: authAs(STRANGER),
      payload: { keyword: KEYWORD },
    });
    const absent = await app.inject({
      method: 'POST', url: `/v1/alerts/${randomUUID()}/resolve`, headers: authAs(STRANGER),
      payload: { keyword: KEYWORD },
    });

    assert.equal(real.statusCode, absent.statusCode,
      'an existing alert and a nonexistent one must be indistinguishable to a stranger');
    assert.equal(real.json().error?.code, absent.json().error?.code);

    const { rows } = await pool!.query(`SELECT status FROM alerts WHERE id = $1`, [id]);
    assert.equal(rows[0].status, 'active', 'and her alert is untouched');
  });
});

describe('identity translation through the route (P1)', () => {
  rtest('a mapped subject lands on its own internal account', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-ident-0001', latitude: null, longitude: null },
    });
    assert.equal(res.statusCode, 201);
    const { rows } = await pool!.query(
      `SELECT owner_id FROM alerts WHERE request_id = $1`, ['rt-ident-0001']);
    assert.equal(rows[0].owner_id, OWNER_UUID);
    // The response names the alert, never the account.
    assert.ok(!res.payload.includes(OWNER_UUID));
  });

  rtest('an authenticated but unmapped subject is refused, and nothing is created', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(UNMAPPED),
      payload: { requestId: 'rt-ghost-0001', latitude: null, longitude: null },
    });

    assert.equal(res.statusCode, 403,
      'a deliberate refusal, not a 500 - this is not our fault and must not page anyone');
    assert.equal(res.json().error.code, 'forbidden');
    assert.equal(await rowCount(), 0);
    // Asserting the MAPPING is absent, not that a global user count held
    // steady. Other test files create and delete users in parallel processes
    // against this same database, so a global count changes for reasons that
    // have nothing to do with this request. "No mapping was minted for this
    // subject" is also the property that actually matters: an invented account
    // is only reachable through identity_map.
    const mapped = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity_map WHERE firebase_uid = $1`, [UNMAPPED]);
    assert.equal(mapped.rows[0]!.n, 0, 'no account is invented to receive it');
  });

  rtest('the refusal leaks no schema, SQLSTATE or subject', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(UNMAPPED),
      payload: { requestId: 'rt-ghost-0002', latitude: null, longitude: null },
    });
    const body = res.payload.toLowerCase();
    for (const forbidden of ['al001', 'identity_map', 'uuid', 'firebase_uid',
                             'create_alert', 'postgres', 'syntax', '22p02']) {
      assert.ok(!body.includes(forbidden), `response must not mention ${forbidden}`);
    }
    assert.ok(!res.payload.includes(UNMAPPED), 'nor echo the subject back');
  });

  rtest('the refusal is indistinguishable from any other forbidden request', async () => {
    // A prober must not be able to tell "this subject has no account" from
    // "this subject may not do that", or they could enumerate which identities
    // are provisioned.
    const unmapped = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(UNMAPPED),
      payload: { requestId: 'rt-probe-0001', latitude: null, longitude: null },
    });
    // A mapped subject forbidden for an unrelated reason: resolving an alert
    // that is not hers.
    const notHers = await app.inject({
      method: 'POST', url: `/v1/alerts/${randomUUID()}/resolve`, headers: authAs(STRANGER),
      payload: { keyword: KEYWORD },
    });
    assert.equal(unmapped.json().error.message, 'Not available.');
    assert.equal(notHers.json().error.message, 'Not available.',
      'one public message for both, so neither reveals which case it was');
  });

  rtest('presenting an internal uuid as a credential achieves nothing', async () => {
    // The spoof: authenticate as the uuid string itself. The token verifier
    // accepts any subject in tests, which is exactly the right place to make
    // this assertion - it isolates the IDENTITY MAP as the control, rather
    // than relying on Firebase to refuse the shape.
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER_UUID),
      payload: { requestId: 'rt-spoof-0001', latitude: 8.9956, longitude: 38.7897 },
    });
    assert.notEqual(res.statusCode, 201);
    assert.equal(await rowCount(), 0, "and nothing lands on the owner's account");
  });

  rtest('a malformed subject cannot reach the database layer', async () => {
    for (const bad of ['x', "'; DROP TABLE alerts; --", 'a'.repeat(300)]) {
      const res = await app.inject({
        method: 'POST', url: '/v1/alerts', headers: authAs(bad),
        payload: { requestId: `rt-bad-${Math.random().toString(36).slice(2, 8)}`,
                   latitude: null, longitude: null },
      });
      assert.notEqual(res.statusCode, 201, `subject ${JSON.stringify(bad)} must not succeed`);
    }
    const { rows } = await pool!.query<{ n: number }>(`SELECT count(*)::int AS n FROM alerts`);
    assert.ok(Number.isInteger(rows[0]!.n), 'alerts still exists');
  });
});

describe('occurredAt through the route (P4)', () => {
  /** What the row recorded for the device clock. */
  async function stored() {
    const { rows } = await pool!.query(
      `SELECT device_reported_at, reported_delay_ms, expires_at > now() AS live
         FROM alerts WHERE owner_id = $1`, [OWNER_UUID]);
    return rows[0];
  }

  rtest('a UTC timestamp is accepted and recorded', async () => {
    const occurred = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-oa-utc001', latitude: null, longitude: null, occurredAt: occurred },
    });
    assert.equal(res.statusCode, 201);
    const row = await stored();
    assert.notEqual(row.device_reported_at, null);
    assert.ok(Number(row.reported_delay_ms) > 2.9 * 60 * 60 * 1000);
  });

  rtest('an offset-bearing timestamp is accepted', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: {
        requestId: 'rt-oa-off001', latitude: null, longitude: null,
        occurredAt: '2026-10-17T15:56:00+03:00',
      },
    });
    assert.equal(res.statusCode, 201);
    assert.notEqual((await stored()).device_reported_at, null);
  });

  rtest("Dart's timezone-less timestamp no longer costs her the alert", async () => {
    // THIS IS THE SPRINT 2 DEFECT. It used to return 400 and lose the SOS.
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: {
        requestId: 'rt-oa-dart01', latitude: 8.9956, longitude: 38.7897,
        locationAgeMs: 30_000, accuracyMeters: 12.5,
        occurredAt: '2026-10-17T15:56:00.000',
      },
    });
    assert.equal(res.statusCode, 201, 'the alert is accepted');

    const row = await stored();
    // And the ambiguous value is NOT reinterpreted. Reading it in the
    // server's timezone would misreport how old her position is by the offset
    // between there and Addis.
    assert.equal(row.device_reported_at, null, 'ambiguous means unknown, not guessed');
    assert.equal(row.reported_delay_ms, null);
  });

  rtest('a malformed timestamp is ignored, not fatal', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-oa-bad001', latitude: null, longitude: null,
                 occurredAt: 'not-a-date' },
    });
    assert.equal(res.statusCode, 201);
    assert.equal((await stored()).device_reported_at, null);
  });

  rtest('a missing or null timestamp is simply absent', async () => {
    const absent = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-oa-none01', latitude: null, longitude: null },
    });
    assert.equal(absent.statusCode, 201);
    assert.equal((await stored()).device_reported_at, null);

    await clearOwnRows();
    const explicit = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-oa-null01', latitude: null, longitude: null, occurredAt: null },
    });
    assert.equal(explicit.statusCode, 201);
  });

  rtest('expiry is stamped by the server whatever the device claims', async () => {
    // A device claiming the trigger happened six hours ago must not produce an
    // alert that is already expired - that is what lets a queued SOS dispatch.
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: {
        requestId: 'rt-oa-expiry1', latitude: null, longitude: null,
        occurredAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      },
    });
    assert.equal(res.statusCode, 201);
    assert.equal((await stored()).live, true, 'expiry runs from server receipt');
  });

  rtest('a device clock in the future does not produce a negative delay', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: {
        requestId: 'rt-oa-future1', latitude: null, longitude: null,
        occurredAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    assert.equal(res.statusCode, 201);
    assert.ok(Number((await stored()).reported_delay_ms) >= 0);
  });

  rtest('an absurdly long value is refused by the schema, not by the parser', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-oa-long001', latitude: null, longitude: null,
                 occurredAt: 'Z'.repeat(5000) },
    });
    // maxLength stays: an unbounded string is a different problem from an
    // ambiguous timestamp, and bounding it is cheap.
    assert.equal(res.statusCode, 400);
    assert.equal(await rowCount(), 0);
  });
});

describe('location evidence through the route (P2)', () => {
  async function storedFix() {
    const { rows } = await pool!.query(
      `SELECT location_quality, location_age_ms, accuracy_m,
              ST_Y(location::geometry) AS lat
         FROM alerts WHERE owner_id = $1`, [OWNER_UUID]);
    return rows[0];
  }

  rtest('a fresh accurate fix survives the whole path as live', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: {
        requestId: 'rt-loc-fresh1', latitude: 8.9956, longitude: 38.7897,
        locationAgeMs: 30_000, accuracyMeters: 12.5,
      },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().alert.locationQuality, 'live', 'and the response says so');

    const row = await storedFix();
    assert.equal(row.location_quality, 'live');
    assert.equal(Number(row.location_age_ms), 30_000);
    assert.equal(Number(row.accuracy_m), 12.5);
  });

  rtest('a stale fix is reported as stale, not as live', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: {
        requestId: 'rt-loc-stale1', latitude: 8.9956, longitude: 38.7897,
        locationAgeMs: 20 * 60_000, accuracyMeters: 40,
      },
    });
    assert.equal(res.json().alert.locationQuality, 'stale');
    assert.equal((await storedFix()).location_quality, 'stale');
  });

  rtest('a client claiming freshness it cannot justify is overruled', async () => {
    // additionalProperties: false means the claim is refused outright rather
    // than silently dropped - the strongest form of "the server decides".
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: {
        requestId: 'rt-loc-claim1', latitude: 8.9956, longitude: 38.7897,
        locationAgeMs: 6 * 60 * 60 * 1000, accuracyMeters: 12.5,
        locationQuality: 'live',
      },
    });
    assert.equal(res.statusCode, 400, 'there is no field through which to claim a quality');

    // And without the claim, the same evidence yields the honest answer.
    const honest = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: {
        requestId: 'rt-loc-claim2', latitude: 8.9956, longitude: 38.7897,
        locationAgeMs: 6 * 60 * 60 * 1000, accuracyMeters: 12.5,
      },
    });
    assert.equal(honest.json().alert.locationQuality, 'stale');
  });

  rtest('no location at all is unavailable, with no metadata', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-loc-none01', latitude: null, longitude: null,
                 locationAgeMs: 30_000, accuracyMeters: 12.5 },
    });
    assert.equal(res.json().alert.locationQuality, 'unavailable');
    assert.equal(res.json().alert.hasLocation, false);
    const row = await storedFix();
    assert.equal(row.lat, null);
    assert.equal(row.location_age_ms, null);
    assert.equal(row.accuracy_m, null);
  });

  rtest('evidence without an age withdraws the freshness claim', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-loc-noage1', latitude: 8.9956, longitude: 38.7897,
                 accuracyMeters: 12.5 },
    });
    assert.equal(res.json().alert.locationQuality, 'age_unknown');
  });

  rtest('a fix with no accuracy is still a fix', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-loc-noacc1', latitude: 8.9956, longitude: 38.7897,
                 locationAgeMs: 30_000 },
    });
    assert.equal(res.json().alert.locationQuality, 'live',
      'accuracy is evidence of measurement, not a quality bar');
  });

  rtest('a negative age or zero accuracy is refused by the schema', async () => {
    for (const payload of [
      { requestId: 'rt-loc-negage1', latitude: 8.9956, longitude: 38.7897, locationAgeMs: -1 },
      { requestId: 'rt-loc-zeroac1', latitude: 8.9956, longitude: 38.7897, accuracyMeters: 0 },
    ]) {
      const res = await app.inject({
        method: 'POST', url: '/v1/alerts', headers: authAs(OWNER), payload,
      });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(await rowCount(), 0, 'and nothing is persisted');
    }
  });

  rtest('(0,0) with accuracy is kept; without it, it is not', async () => {
    const withEvidence = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-loc-zeroev1', latitude: 0, longitude: 0,
                 locationAgeMs: 30_000, accuracyMeters: 12.5 },
    });
    assert.equal(withEvidence.json().alert.locationQuality, 'live');
    assert.equal(withEvidence.json().alert.hasLocation, true);
    // The coordinates are not echoed in the response - by design - so the row
    // itself is what proves (0,0) was stored rather than discarded.
    const kept = await storedFix();
    assert.equal(Number(kept.lat), 0);

    await clearOwnRows();
    const without = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(OWNER),
      payload: { requestId: 'rt-loc-zeroev2', latitude: 0, longitude: 0,
                 locationAgeMs: 30_000 },
    });
    assert.equal(without.json().alert.locationQuality, 'unavailable');
    assert.equal(without.json().alert.hasLocation, false);
    assert.equal((await storedFix()).lat, null, 'and nothing was stored for it');
  });
});
