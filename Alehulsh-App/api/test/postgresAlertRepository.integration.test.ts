/**
 * PostgresAlertRepository against a REAL local PostgreSQL+PostGIS instance.
 *
 * Synthetic data only. Connects solely through environment configuration, so
 * it cannot reach a hosted database by default - with no PG* variables set it
 * skips rather than guessing.
 *
 * Start the database with:  npm run db:up && npm run db:reset
 * Then:                     PGHOST=127.0.0.1 PGPORT=55432 PGDATABASE=alehulsh_test \
 *                           PGUSER=postgres PGPASSWORD=... npm test
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, loadDbConfig, withTransaction, closePool, type Queryable } from '../src/db/pool.js';
import {
  PostgresAlertRepository, AlertNotFoundError, IdentityNotMappedError,
  alertRepositoryFromPool,
} from '../src/repositories/postgres/PostgresAlertRepository.js';
import { createAlertWithOutbox } from '../src/services/AlertWithOutbox.js';
import { FRESH_FIX_MS } from '../src/domain/location.js';

const ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000;

let pool: Pool | null = null;
let repo: PostgresAlertRepository;
let available = false;
let skipReason = '';

/**
 * Internal uuids, and the external subjects that map to them.
 *
 * The repository speaks SUBJECTS now (sprint 3): the internal uuid never
 * crosses its boundary in either direction, so these tests pass OWNER/OTHER
 * and reach for the uuids only to inspect rows directly in SQL.
 *
 * Fresh per run, and NOT the well-known 1111.../2222... ids: the SQL suites
 * in db/tests use those and leave rows behind, so a fixed id shared a
 * namespace with them and the two suites corrupted each other's state.
 */
const OWNER_UUID = randomUUID();
const OTHER_UUID = randomUUID();
/** Firebase-shaped: 28 characters, not a uuid. */
const OWNER = `pgOwner${randomUUID().replace(/-/g, '').slice(0, 21)}`;
const OTHER = `pgOther${randomUUID().replace(/-/g, '').slice(0, 21)}`;
/** Mapped to nothing, deliberately. */
const UNMAPPED = `pgGhost${randomUUID().replace(/-/g, '').slice(0, 21)}`;

/** Plain TCP probe: a wrong host must not cost the suite its timeout. */
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
  } catch (e) {
    skipReason = 'PG* environment not configured (fail-closed, not assumed)';
    return;
  }
  if (!(await reachable(cfg.host, cfg.port))) {
    skipReason = `no PostgreSQL reachable on the configured host:port`;
    return;
  }
  pool = createPool(cfg);
  repo = alertRepositoryFromPool(pool, ACTIVE_WINDOW_MS);
  await pool.query(
    `INSERT INTO users (id, display_name) VALUES ($1,'Owner'),($2,'Other')
     ON CONFLICT (id) DO NOTHING`, [OWNER_UUID, OTHER_UUID]);
  // Seeded as the owning superuser, which is what provisioning would be. The
  // API role cannot do this: 0005 revoked its INSERT on identity_map, and the
  // denial suite asserts that.
  await pool.query(
    `INSERT INTO identity_map (firebase_uid, user_id) VALUES ($1,$2),($3,$4)
     ON CONFLICT (firebase_uid) DO NOTHING`, [OWNER, OWNER_UUID, OTHER, OTHER_UUID]);
  available = true;
});

/**
 * Remove only this suite's rows, children first.
 *
 * evidence -> alerts is ON DELETE RESTRICT by design (an alert must not be
 * erasable while recordings still point at it), so evidence has to go first
 * or the teardown itself fails.
 */
async function clearOwnRows(): Promise<void> {
  const owners = [[OWNER_UUID, OTHER_UUID]];
  // outbox -> alerts is ON DELETE CASCADE, but evidence -> alerts is RESTRICT,
  // so evidence goes first or the teardown fails on its own fixtures.
  await pool!.query(`DELETE FROM evidence WHERE owner_id = ANY($1::uuid[])`, owners);
  await pool!.query(`DELETE FROM alerts WHERE owner_id = ANY($1::uuid[])`, owners);
}

after(async () => {
  if (!pool) return;
  await clearOwnRows();
  // alert_history and reveal_log have NO foreign key, so nothing cascades to
  // them (audit §5). This suite removes its own rows rather than adding to a
  // pile that a future retention decision will have to account for - the
  // earlier "107 orphaned rows" figure was exactly this kind of residue.
  await pool.query(
    `DELETE FROM alert_history WHERE owner_id = ANY($1::uuid[])`, [[OWNER_UUID, OTHER_UUID]]);
  // identity_map cascades from users.
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[OWNER_UUID, OTHER_UUID]]);
  await pool.end();
});

function dbtest(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) { t.skip(skipReason); return; }
    await clearOwnRows();
    await fn();
  });
}

describe('create and read back', () => {
  dbtest('creates an alert and maps it into the domain type', async () => {
    const { alert, created } = await repo.create({
      requestId: 'pg-create-001', ownerId: OWNER, latitude: 8.9956, longitude: 38.7897,
    });
    assert.equal(created, true);
    assert.equal(alert.ownerId, OWNER);
    assert.equal(alert.status, 'active');
    assert.ok(Math.abs(alert.latitude! - 8.9956) < 1e-6);
    assert.ok(Math.abs(alert.longitude! - 38.7897) < 1e-6);
    assert.ok(alert.createdAt instanceof Date);
    assert.ok(alert.expiresAt instanceof Date);
    assert.equal(alert.attemptCount, 0);

    const read = await repo.findById(alert.id);
    assert.deepEqual(read?.id, alert.id);
    assert.equal(read?.ownerId, OWNER);
  });

  dbtest('findActiveByOwner returns the live alert, and nothing after it ends', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-active-001', ownerId: OWNER, latitude: null, longitude: null,
    });
    assert.equal((await repo.findActiveByOwner(OWNER))?.id, alert.id);
    await repo.updateStatus(alert.id, 'resolved', { resolvedBy: 'owner' });
    assert.equal(await repo.findActiveByOwner(OWNER), null);
  });

  dbtest('findById returns null for an unknown id rather than throwing', async () => {
    assert.equal(await repo.findById('99999999-9999-9999-9999-999999999999'), null);
  });
});

describe('idempotency and the one-live-alert invariant', () => {
  dbtest('the same requestId folds onto the original', async () => {
    const first = await repo.create({
      requestId: 'pg-idem-0001', ownerId: OWNER, latitude: 8.9956, longitude: 38.7897,
    });
    const retry = await repo.create({
      requestId: 'pg-idem-0001', ownerId: OWNER, latitude: 8.9956, longitude: 38.7897,
    });
    assert.equal(retry.created, false);
    assert.equal(retry.alert.id, first.alert.id);
  });

  dbtest('a DIFFERENT requestId while one is live folds onto the live alert', async () => {
    const first = await repo.create({
      requestId: 'pg-fold-0001', ownerId: OWNER, latitude: null, longitude: null,
    });
    const second = await repo.create({
      requestId: 'pg-fold-0002', ownerId: OWNER, latitude: null, longitude: null,
    });
    assert.equal(second.created, false, 'a second tap must not raise a second alarm');
    assert.equal(second.alert.id, first.alert.id);
  });

  dbtest('concurrent creation yields exactly one live alert', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        repo.create({ requestId: `pg-conc-000${i}`, ownerId: OWNER, latitude: null, longitude: null })),
    );
    const createdCount = attempts.filter((a) => a.created).length;
    assert.equal(createdCount, 1, 'exactly one request may create');
    const ids = new Set(attempts.map((a) => a.alert.id));
    assert.equal(ids.size, 1, 'every caller receives the same alert');

    const { rows } = await pool!.query(
      `SELECT count(*)::int AS n FROM alerts WHERE owner_id = $1`, [OWNER_UUID]);
    assert.equal(rows[0].n, 1, 'and only one row exists');
  });

  dbtest('two owners may each hold a live alert', async () => {
    await repo.create({ requestId: 'pg-two-00001', ownerId: OWNER, latitude: null, longitude: null });
    const other = await repo.create({ requestId: 'pg-two-00002', ownerId: OTHER, latitude: null, longitude: null });
    assert.equal(other.created, true, 'the invariant is per owner, not global');
  });
});

describe('location mapping', () => {
  dbtest('a missing fix stays missing - never zero, never fabricated', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-noloc-001', ownerId: OWNER, latitude: null, longitude: null,
    });
    assert.equal(alert.latitude, null);
    assert.equal(alert.longitude, null);
    const { rows } = await pool!.query(
      `SELECT location IS NULL AS no_loc, location_quality FROM alerts WHERE id = $1`, [alert.id]);
    assert.equal(rows[0].no_loc, true);
    assert.equal(rows[0].location_quality, 'unavailable');
  });

  dbtest('(0,0) is rejected as an uninitialised reading', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-zero-0001', ownerId: OWNER, latitude: 0, longitude: 0,
    });
    assert.equal(alert.latitude, null, '(0,0) must not be published as a position');
  });

  dbtest('out-of-range coordinates are rejected', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-range-001', ownerId: OWNER, latitude: 91, longitude: 200,
    });
    assert.equal(alert.latitude, null);
  });

  dbtest('half a coordinate is not a location', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-half-0001', ownerId: OWNER, latitude: 8.9956, longitude: null,
    });
    assert.equal(alert.latitude, null);
    assert.equal(alert.longitude, null);
  });
});

describe('server-owned timestamps', () => {
  dbtest('expiry is stamped by the server, not the caller', async () => {
    const before = Date.now();
    const { alert } = await repo.create({
      requestId: 'pg-expiry-01', ownerId: OWNER, latitude: null, longitude: null,
    });
    const delta = alert.expiresAt.getTime() - before;
    assert.ok(delta > ACTIVE_WINDOW_MS - 60_000 && delta < ACTIVE_WINDOW_MS + 60_000,
      `expiry must be ~the active window ahead, was ${delta}ms`);
  });

  dbtest('a device-reported time is stored and the delay computed server-side', async () => {
    const occurred = new Date(Date.now() - 3 * 60 * 60 * 1000);   // 3h ago
    const { alert } = await repo.create({
      requestId: 'pg-delay-001', ownerId: OWNER, latitude: null, longitude: null,
      occurredAt: occurred,
    });
    assert.ok(alert.deviceReportedAt instanceof Date);
    assert.ok(alert.reportedDelayMs! > 2.9 * 60 * 60 * 1000,
      'a long offline queue must be visible as a delay, not hidden');
    assert.ok(alert.expiresAt.getTime() > Date.now(),
      'expiry runs from server receipt, so a delayed alert is NOT born expired');
  });

  dbtest('a future device clock does not produce a negative delay', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-future-01', ownerId: OWNER, latitude: null, longitude: null,
      occurredAt: new Date(Date.now() + 60_000),
    });
    assert.ok((alert.reportedDelayMs ?? 0) >= 0);
  });
});

describe('transitions', () => {
  dbtest('resolve records who resolved it', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-res-00001', ownerId: OWNER, latitude: null, longitude: null,
    });
    const resolved = await repo.updateStatus(alert.id, 'resolved', { resolvedBy: 'owner' });
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.resolvedBy, 'owner');
    assert.ok(resolved.resolvedAt instanceof Date);
  });

  dbtest('cancellation is its own terminal state, not resolution', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-can-00001', ownerId: OWNER, latitude: null, longitude: null,
    });
    const cancelled = await repo.updateStatus(alert.id, 'cancelled', {});
    assert.equal(cancelled.status, 'cancelled');
    assert.notEqual(cancelled.status, 'resolved');
    assert.equal(cancelled.resolvedBy, undefined, 'a cancellation has no resolver');
  });

  dbtest('escalation records its reason', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-esc-00001', ownerId: OWNER, latitude: null, longitude: null,
    });
    const esc = await repo.updateStatus(alert.id, 'escalated', { escalationReason: 'no_answer' });
    assert.equal(esc.status, 'escalated');
    assert.equal(esc.escalationReason, 'no_answer');
    assert.ok(esc.escalatedAt instanceof Date);
  });

  dbtest('a terminal alert cannot be transitioned again', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-term-0001', ownerId: OWNER, latitude: null, longitude: null,
    });
    await repo.updateStatus(alert.id, 'resolved', { resolvedBy: 'owner' });
    const after = await repo.updateStatus(alert.id, 'expired', {});
    assert.equal(after.status, 'resolved', 'expiry must not overwrite a resolved alert');
  });

  dbtest('cancel racing resolve leaves exactly one consistent terminal state', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-race-0001', ownerId: OWNER, latitude: null, longitude: null,
    });
    const [a, b] = await Promise.all([
      repo.updateStatus(alert.id, 'resolved', { resolvedBy: 'owner' }),
      repo.updateStatus(alert.id, 'cancelled', {}),
    ]);
    assert.equal(a.status, b.status, 'both callers must observe the same outcome');
    assert.ok(['resolved', 'cancelled'].includes(a.status));
    const { rows } = await pool!.query(
      `SELECT status, end_reason, ended_at IS NOT NULL AS ended FROM alerts WHERE id=$1`, [alert.id]);
    assert.equal(rows[0].status, rows[0].end_reason, 'status and end_reason must agree');
    assert.equal(rows[0].ended, true);
  });

  dbtest('updateStatus on a missing alert raises, never a fabricated success', async () => {
    await assert.rejects(
      () => repo.updateStatus('99999999-9999-9999-9999-999999999999', 'resolved', {}),
      AlertNotFoundError);
  });
});

describe('failed keyword attempts', () => {
  dbtest('attempts accumulate and are never reset', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-att-00001', ownerId: OWNER, latitude: null, longitude: null,
    });
    const a1 = await repo.recordFailedAttempt(alert.id, new Date());
    assert.equal(a1.attemptCount, 1);
    const a2 = await repo.recordFailedAttempt(alert.id, new Date());
    assert.equal(a2.attemptCount, 2, 'a cluster of failures is itself evidence');
    assert.ok(a2.lastAttemptAt instanceof Date);
  });

  dbtest('recording against a missing alert raises', async () => {
    await assert.rejects(
      () => repo.recordFailedAttempt('99999999-9999-9999-9999-999999999999', new Date()),
      AlertNotFoundError);
  });
});

describe('history and deletion', () => {
  dbtest('history is newest first and includes terminal alerts', async () => {
    const a = await repo.create({ requestId: 'pg-hist-0001', ownerId: OWNER, latitude: null, longitude: null });
    await repo.updateStatus(a.alert.id, 'resolved', { resolvedBy: 'owner' });
    const b = await repo.create({ requestId: 'pg-hist-0002', ownerId: OWNER, latitude: null, longitude: null });

    const history = await repo.listHistoryForOwner(OWNER);
    assert.equal(history.length, 2, 'a terminal alert stays in the record');
    assert.equal(history[0]!.id, b.alert.id, 'newest first');
  });

  dbtest('history is scoped to its owner', async () => {
    await repo.create({ requestId: 'pg-iso-00001', ownerId: OWNER, latitude: null, longitude: null });
    await repo.create({ requestId: 'pg-iso-00002', ownerId: OTHER, latitude: null, longitude: null });
    const mine = await repo.listHistoryForOwner(OWNER);
    assert.equal(mine.length, 1);
    assert.ok(mine.every((x) => x.ownerId === OWNER), 'no cross-owner leakage');
  });

  dbtest('deleteAllForOwner removes only that owner', async () => {
    await repo.create({ requestId: 'pg-del-00001', ownerId: OWNER, latitude: null, longitude: null });
    await repo.updateStatus((await repo.findActiveByOwner(OWNER))!.id, 'resolved', { resolvedBy: 'owner' });
    await repo.create({ requestId: 'pg-del-00002', ownerId: OWNER, latitude: null, longitude: null });
    await repo.create({ requestId: 'pg-del-00003', ownerId: OTHER, latitude: null, longitude: null });

    const removed = await repo.deleteAllForOwner(OWNER);
    assert.equal(removed, 2);
    assert.equal((await repo.listHistoryForOwner(OWNER)).length, 0);
    assert.equal((await repo.listHistoryForOwner(OTHER)).length, 1, 'another owner is untouched');
  });

  dbtest('evidence blocks a bare alert delete rather than being orphaned', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-ev-000001', ownerId: OWNER, latitude: null, longitude: null,
    });
    await pool!.query(
      `INSERT INTO evidence (alert_id, owner_id, r2_key, content_type)
       VALUES ($1,$2,$3,'audio/m4a')`, [alert.id, OWNER_UUID, `evidence/${alert.id}/obj`]);
    // ON DELETE RESTRICT: account deletion must clear R2 objects and evidence
    // rows FIRST. Deleting the alert would strand objects with no index.
    await assert.rejects(() => repo.deleteAllForOwner(OWNER));
    await pool!.query(`DELETE FROM evidence WHERE alert_id = $1`, [alert.id]);
    assert.equal(await repo.deleteAllForOwner(OWNER), 1);
  });
});

describe('atomicity', () => {
  dbtest('create writes the alert and its history row, or neither', async () => {
    // create_alert inserts into TWO tables: alerts, then alert_history. If the
    // second fails and the first stood, an alert would exist with no record of
    // having started - the audit trail a protection order rests on (P2-22)
    // would have a hole exactly where someone's emergency was.
    const { alert } = await repo.create({
      requestId: 'pg-atom-0001', ownerId: OWNER, latitude: null, longitude: null,
    });
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alert_history
        WHERE alert_id = $1 AND to_status = 'active' AND from_status IS NULL`, [alert.id]);
    assert.equal(rows[0]!.n, 1, 'the opening history row must exist');
  });

  dbtest('a failure in the second insert rolls the first one back', async () => {
    // Everything here happens on ONE connection inside ONE transaction, and
    // the trigger is created inside it. Postgres DDL is transactional, so the
    // trigger is gone on ROLLBACK and never becomes visible to a committed
    // state. The earlier version created it on the pool, where it was global
    // DDL: for as long as it existed, ANY concurrent insert into alert_history
    // from another test file failed. That is a CI flake by construction, in a
    // suite whose whole purpose is trustworthy results.
    //
    // The cost of the isolation is that create_alert is called directly rather
    // than through the repository, because the repository talks to the Pool and
    // would take a different connection - the limitation the next test pins.
    // What is under test is the FUNCTION's atomicity across its two inserts,
    // which is where the hazard actually lives.
    const client = await pool!.connect();
    try {
      // Fail fast and loudly rather than hanging if another session happens to
      // be holding alert_history.
      await client.query(`SET LOCAL lock_timeout = '5s'`).catch(() => {});
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`
        CREATE FUNCTION pg_test_break_history() RETURNS trigger
        LANGUAGE plpgsql AS $fn$ BEGIN
          RAISE EXCEPTION 'synthetic failure in alert_history';
        END $fn$;
        CREATE TRIGGER pg_test_break_history_trg
          BEFORE INSERT ON alert_history
          FOR EACH ROW EXECUTE FUNCTION pg_test_break_history();
      `);

      await assert.rejects(
        () => client.query(
          `SELECT alert_id, created FROM create_alert(
             $1::uuid, $2::text, 8.9956::double precision, 38.7897::double precision,
             NULL::bigint, NULL::double precision,
             '2 hours'::interval, NULL::timestamptz, 120000::bigint)`,
          [OWNER_UUID, 'pg-rollback-1'],
        ),
        /synthetic failure in alert_history/,
        'the failure must surface, not be swallowed',
      );
    } finally {
      // ROLLBACK undoes the trigger, the function and any partial insert in
      // one step - nothing is left for another session to trip over.
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }

    const { rows } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alerts WHERE owner_id = $1`, [OWNER_UUID]);
    assert.equal(rows[0]!.n, 0, 'no half-written alert may remain');

    // And the store still works afterwards, so nothing was left behind.
    const ok = await repo.create({
      requestId: 'pg-rollback-2', ownerId: OWNER, latitude: null, longitude: null,
    });
    assert.equal(ok.created, true);

    const { rows: hist } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alert_history WHERE alert_id = $1`, [ok.alert.id]);
    assert.equal(hist[0]!.n, 1, 'and the history trigger is no longer in the way');
  });

  dbtest('the repository does NOT join a caller-managed transaction', async () => {
    // Documented limitation, pinned so it is not discovered by surprise.
    //
    // The repository issues queries against the Pool, so each call takes an
    // arbitrary pooled connection and commits on its own. A caller that opens
    // a transaction and rolls back does NOT undo the repository's write.
    //
    // Harmless today - every alert route makes exactly one repository call -
    // but it means an alert and an outbox row CANNOT yet be written
    // atomically. Closing that needs the repository to accept a ClientBase
    // instead of a Pool. See the sprint report.
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      const { alert } = await repo.create({
        requestId: 'pg-txn-00001', ownerId: OWNER, latitude: null, longitude: null,
      });
      await client.query('ROLLBACK');
      assert.notEqual(await repo.findById(alert.id), null,
        'the write survived the rollback: the repository is not transactional with its caller');
    } finally {
      client.release();
    }
  });
});

describe('identity translation (P1)', () => {
  dbtest('a verified subject resolves to its own internal account', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-ident-001', ownerId: OWNER, latitude: null, longitude: null,
    });
    // The domain object speaks SUBJECTS...
    assert.equal(alert.ownerId, OWNER);
    // ...while the row holds the internal uuid, which never crossed the
    // repository boundary in either direction.
    const { rows } = await pool!.query(`SELECT owner_id FROM alerts WHERE id = $1`, [alert.id]);
    assert.equal(rows[0].owner_id, OWNER_UUID);
  });

  dbtest('the internal uuid never appears in anything the repository returns', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-ident-002', ownerId: OWNER, latitude: 8.9956, longitude: 38.7897,
      locationAgeMs: 30_000, accuracyMeters: 12.5,
    });
    const serialised = JSON.stringify([alert, await repo.findById(alert.id),
      await repo.findActiveByOwner(OWNER), await repo.listHistoryForOwner(OWNER)]);
    assert.ok(!serialised.includes(OWNER_UUID),
      'the internal account id must not be reachable through the domain object');
    assert.ok(!serialised.includes(OTHER_UUID));
  });

  dbtest('an unknown subject cannot raise an alert, and no user is invented', async () => {
    await assert.rejects(
      () => repo.create({
        requestId: 'pg-ghost-001', ownerId: UNMAPPED, latitude: null, longitude: null,
      }),
      IdentityNotMappedError);
    // Asserting the MAPPING is absent, not that a global user count held
    // steady. Other test files create and delete users in parallel processes
    // against this same database, so a global count changes for reasons that
    // have nothing to do with this request. "No mapping was minted for this
    // subject" is also the property that actually matters: an invented account
    // is only reachable through identity_map.
    const mapped = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity_map WHERE firebase_uid = $1`, [UNMAPPED]);
    assert.equal(mapped.rows[0]!.n, 0,
      'an unknown uid must not cause an account or a mapping to be created');
  });

  dbtest('the unmapped error carries no subject, no SQLSTATE and no column type', async () => {
    const err = await repo.create({
      requestId: 'pg-ghost-002', ownerId: UNMAPPED, latitude: null, longitude: null,
    }).then(() => null, (e: unknown) => e);

    assert.ok(err instanceof IdentityNotMappedError);
    const text = `${(err as Error).name}: ${(err as Error).message}`;
    assert.ok(!text.includes(UNMAPPED), 'a uid identifies a person; it does not belong in logs');
    assert.ok(!text.includes('AL001'));
    assert.ok(!text.toLowerCase().includes('uuid'));
    assert.ok(!text.toLowerCase().includes('identity_map'));
  });

  dbtest('a malformed subject is refused like any other unknown one', async () => {
    // No shape is assumed of a subject: it is whatever the IdP issued. So
    // these are rejected for being UNMAPPED, not for being malformed - which
    // is why none of them can probe the schema.
    for (const bad of ['', '   ', 'x', "'; DROP TABLE alerts; --",
                       '00000000-0000-0000-0000-000000000000',
                       'a'.repeat(512), '\u0000null-byte']) {
      await assert.rejects(
        () => repo.create({
          requestId: `pg-bad-${Math.random().toString(36).slice(2, 8)}`,
          ownerId: bad, latitude: null, longitude: null,
        }),
        IdentityNotMappedError,
        `subject ${JSON.stringify(bad)} must be refused`);
    }
    // And the table it tried to drop is still there.
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alerts`);
    assert.ok(Number.isInteger(rows[0]!.n), 'alerts still exists and is queryable');
  });

  dbtest('a subject cannot reach another account by naming its uuid', async () => {
    // The spoofing attempt: present the internal uuid as the subject. It is
    // not a mapped subject, so it resolves to nothing.
    await assert.rejects(
      () => repo.create({
        requestId: 'pg-spoof-001', ownerId: OTHER_UUID, latitude: null, longitude: null,
      }),
      IdentityNotMappedError,
      'an internal uuid is not a credential');
  });

  dbtest("one subject's reads never cross into another's", async () => {
    await repo.create({ requestId: 'pg-iso-sub-01', ownerId: OWNER, latitude: null, longitude: null });
    await repo.create({ requestId: 'pg-iso-sub-02', ownerId: OTHER, latitude: null, longitude: null });

    const mine = await repo.listHistoryForOwner(OWNER);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.ownerId, OWNER);
    assert.equal(await repo.findActiveByOwner(UNMAPPED), null,
      'an unmapped subject sees nothing rather than everything');
  });

  dbtest('deleting for an unmapped subject raises instead of reporting success', async () => {
    // "We deleted everything" and "we could not find who you meant" must
    // never look the same on a privacy operation.
    await assert.rejects(() => repo.deleteAllForOwner(UNMAPPED), IdentityNotMappedError);
  });

  dbtest('an alert whose owner has no mapping is not visible through this repository', async () => {
    // A Supabase-native user, once they exist. The contract here is
    // Firebase-subject-shaped, so such a row cannot be described by it - and
    // returning it with a placeholder owner would hand the authorization
    // check `alert.ownerId !== uid` a value to get wrong.
    const orphanUuid = randomUUID();
    await pool!.query(`INSERT INTO users (id, display_name) VALUES ($1,'NoMapping')`, [orphanUuid]);
    const { rows } = await pool!.query<{ alert_id: string }>(
      `SELECT alert_id FROM create_alert($1::uuid, 'pg-orphan-001')`, [orphanUuid]);
    const orphanAlert = rows[0]!.alert_id;
    try {
      assert.equal(await repo.findById(orphanAlert), null, 'fails closed, not open');
    } finally {
      await pool!.query(`DELETE FROM users WHERE id = $1`, [orphanUuid]);
    }
  });
});

describe('location quality, request through persistence (P2)', () => {
  /** What actually landed in the row, read back through SQL. */
  async function storedFix(id: string) {
    const { rows } = await pool!.query(
      `SELECT location_quality, location_age_ms, accuracy_m,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
         FROM alerts WHERE id = $1`, [id]);
    return rows[0];
  }

  dbtest('a fresh accurate fix is stored as live, with its age and accuracy', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-loc-fresh1', ownerId: OWNER,
      latitude: 8.9956, longitude: 38.7897, locationAgeMs: 30_000, accuracyMeters: 12.5,
    });
    assert.equal(alert.locationQuality, 'live');
    assert.equal(alert.locationAgeMs, 30_000);
    assert.equal(alert.accuracyMeters, 12.5);

    const row = await storedFix(alert.id);
    assert.equal(row.location_quality, 'live');
    assert.equal(Number(row.location_age_ms), 30_000);
    assert.equal(Number(row.accuracy_m), 12.5);
  });

  dbtest('a stale fix keeps its position and says how old it is', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-loc-stale1', ownerId: OWNER,
      latitude: 8.9956, longitude: 38.7897, locationAgeMs: 20 * 60_000, accuracyMeters: 40,
    });
    assert.equal(alert.locationQuality, 'stale');
    assert.equal(alert.locationAgeMs, 20 * 60_000);
    assert.ok(alert.latitude !== null, 'a stale position is still a starting point');
  });

  dbtest('the freshness boundary is the server threshold, inclusive', async () => {
    const at = await repo.create({
      requestId: 'pg-loc-bound1', ownerId: OWNER,
      latitude: 8.9956, longitude: 38.7897, locationAgeMs: FRESH_FIX_MS, accuracyMeters: 10,
    });
    assert.equal(at.alert.locationQuality, 'live', 'exactly at the threshold is still live');
    await repo.updateStatus(at.alert.id, 'resolved', { resolvedBy: 'owner' });

    const past = await repo.create({
      requestId: 'pg-loc-bound2', ownerId: OWNER,
      latitude: 8.9956, longitude: 38.7897, locationAgeMs: FRESH_FIX_MS + 1, accuracyMeters: 10,
    });
    assert.equal(past.alert.locationQuality, 'stale', 'one millisecond past it is not');
  });

  dbtest('a missing fix is unavailable and carries no metadata', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-loc-none01', ownerId: OWNER, latitude: null, longitude: null,
      locationAgeMs: 30_000, accuracyMeters: 12.5,
    });
    assert.equal(alert.locationQuality, 'unavailable');
    assert.equal(alert.locationAgeMs, null, 'no age for a position we do not have');
    assert.equal(alert.accuracyMeters, null);

    const row = await storedFix(alert.id);
    assert.equal(row.location_quality, 'unavailable');
    assert.equal(row.lat, null);
    assert.equal(row.location_age_ms, null);
    assert.equal(row.accuracy_m, null);
  });

  dbtest('an age with no accuracy still yields a quality', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-loc-noacc1', ownerId: OWNER,
      latitude: 8.9956, longitude: 38.7897, locationAgeMs: 30_000,
    });
    assert.equal(alert.locationQuality, 'live', 'accuracy is evidence, not a requirement');
    assert.equal(alert.accuracyMeters, null);
  });

  dbtest('accuracy with no age withdraws the freshness claim but keeps the position', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-loc-noage1', ownerId: OWNER,
      latitude: 8.9956, longitude: 38.7897, accuracyMeters: 12.5,
    });
    assert.equal(alert.locationQuality, 'age_unknown');
    assert.equal(alert.locationAgeMs, null);
    assert.ok(alert.latitude !== null);
    assert.equal(alert.accuracyMeters, 12.5);
  });

  dbtest('a negative age is unknown, and does not cost her the alert', async () => {
    // age_not_negative would reject the row. Normalising rather than failing
    // is the point: an alert must not be lost to preserve a metadata field.
    const { alert } = await repo.create({
      requestId: 'pg-loc-negage', ownerId: OWNER,
      latitude: 8.9956, longitude: 38.7897, locationAgeMs: -5000, accuracyMeters: 12.5,
    });
    assert.equal(alert.locationQuality, 'age_unknown');
    assert.equal(alert.locationAgeMs, null);
  });

  dbtest('a zero accuracy is not a measurement, and does not cost her the alert', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-loc-zeroacc', ownerId: OWNER,
      latitude: 8.9956, longitude: 38.7897, locationAgeMs: 30_000, accuracyMeters: 0,
    });
    assert.equal(alert.locationQuality, 'live');
    assert.equal(alert.accuracyMeters, null, 'accuracy_positive would have rejected the row');
  });

  dbtest('(0,0) WITH accuracy is a real place and is kept', async () => {
    // The evidential rule, matching SosLocationDecision: rejected only for
    // lack of evidence, never for being geographically unlikely.
    const { alert } = await repo.create({
      requestId: 'pg-loc-zero-ev', ownerId: OWNER,
      latitude: 0, longitude: 0, locationAgeMs: 30_000, accuracyMeters: 12.5,
    });
    assert.equal(alert.locationQuality, 'live');
    assert.equal(alert.latitude, 0);
    assert.equal(alert.longitude, 0);
  });

  dbtest('(0,0) with NO accuracy is an uninitialised reading', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-loc-zero-no', ownerId: OWNER,
      latitude: 0, longitude: 0, locationAgeMs: 30_000,
    });
    assert.equal(alert.locationQuality, 'unavailable');
    assert.equal(alert.latitude, null);
  });

  dbtest('a zero on ONE axis is a legitimate position', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-loc-oneaxis', ownerId: OWNER,
      latitude: 0, longitude: 38.7897, locationAgeMs: 30_000,
    });
    assert.equal(alert.locationQuality, 'live', 'the equator is a place');
    assert.equal(alert.latitude, 0);
  });

  dbtest('invalid coordinates and half a pair both become no position', async () => {
    for (const [label, lat, lng] of [
      ['out of range lat', 91, 38.7897],
      ['out of range lng', 8.9956, 181],
      ['half a pair', 8.9956, null],
      ['other half', null, 38.7897],
    ] as [string, number | null, number | null][]) {
      const { alert } = await repo.create({
        requestId: `pg-loc-inv-${label.slice(0, 5).replace(/ /g, '')}x`,
        ownerId: OWNER, latitude: lat, longitude: lng,
        locationAgeMs: 30_000, accuracyMeters: 12.5,
      });
      assert.equal(alert.locationQuality, 'unavailable', label);
      assert.equal(alert.latitude, null, label);
      await repo.updateStatus(alert.id, 'cancelled', {});
    }
  });

  /**
   * A fix is only as fresh as the moment it ARRIVES, not the moment it was
   * taken.  (audit finding, HIGH)
   *
   * locationAgeMs is how old the fix was when the device captured it. If the
   * alert then sat in the offline queue for three hours, the position is three
   * hours older than that by the time anyone can act on it. Deriving quality
   * from the device-reported age alone labelled such an alert 'live', and a
   * responder trusting that label would go where she was three hours ago.
   *
   * Neither half was wrong on its own - this is the interaction between the
   * freshness rule and the offline queue.
   */
  dbtest('an offline-queued fix is NOT live, however fresh it was when taken', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-loc-queued1', ownerId: OWNER,
      latitude: 8.9956, longitude: 38.7897,
      locationAgeMs: 30_000,                                   // fresh when captured
      accuracyMeters: 12.5,
      occurredAt: new Date(Date.now() - 3 * 60 * 60 * 1000),   // queued 3h
    });

    assert.equal(alert.locationQuality, 'stale',
      'three hours in a queue makes a 30-second fix stale');
    assert.ok(alert.latitude !== null, 'but the position is still kept — it is a starting point');
    // The device's own claim is preserved as evidence, unchanged.
    assert.equal(alert.locationAgeMs, 30_000);
    assert.ok((alert.reportedDelayMs ?? 0) > 2.9 * 60 * 60 * 1000);
  });

  dbtest('a short queue delay does not wrongly age a genuinely fresh fix', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-loc-quick01', ownerId: OWNER,
      latitude: 8.9956, longitude: 38.7897,
      locationAgeMs: 10_000, accuracyMeters: 12.5,
      occurredAt: new Date(Date.now() - 5_000),                // 5s in flight
    });
    assert.equal(alert.locationQuality, 'live',
      '15s effective age is still within the threshold');
  });

  dbtest('the combined age crosses the threshold at the right point', async () => {
    // 90s fix + 60s queue = 150s effective, past the 120s threshold, even
    // though neither number alone exceeds it.
    const { alert } = await repo.create({
      requestId: 'pg-loc-combo01', ownerId: OWNER,
      latitude: 8.9956, longitude: 38.7897,
      locationAgeMs: 90_000, accuracyMeters: 12.5,
      occurredAt: new Date(Date.now() - 60_000),
    });
    assert.equal(alert.locationQuality, 'stale');
  });

  dbtest('a future device clock cannot be used to make a stale fix look live', async () => {
    // reported_delay_ms is floored at 0, so a device claiming the trigger is in
    // the future gets no credit - it cannot subtract from the fix age.
    const { alert } = await repo.create({
      requestId: 'pg-loc-future1', ownerId: OWNER,
      latitude: 8.9956, longitude: 38.7897,
      locationAgeMs: 20 * 60_000,                              // genuinely stale
      accuracyMeters: 12.5,
      occurredAt: new Date(Date.now() + 60 * 60 * 1000),       // "it's an hour from now"
    });
    assert.equal(alert.locationQuality, 'stale',
      'a dishonest clock must not buy freshness');
  });

  dbtest('the database constraint keeps quality and coordinates consistent', async () => {
    // Belt and braces: even if a future writer bypassed derivation, the row
    // could not claim a position it does not hold.
    // An age is supplied so live_requires_age is satisfied and the row can
    // only fail on the constraint this case is about: claiming a quality while
    // holding no position.
    await assert.rejects(
      () => pool!.query(
        `INSERT INTO alerts (owner_id, request_id, expires_at, location, location_quality,
                             location_age_ms)
         VALUES ($1, 'pg-constraint-1', now() + interval '2 hours', NULL, 'live', 30000)`,
        [OWNER_UUID]),
      /location_quality_agrees/);

    // And the reverse: holding a position while claiming none.
    await assert.rejects(
      () => pool!.query(
        `INSERT INTO alerts (owner_id, request_id, expires_at, location, location_quality)
         VALUES ($1, 'pg-constraint-3', now() + interval '2 hours',
                 ST_SetSRID(ST_MakePoint(38.7897, 8.9956),4326)::geography, 'unavailable')`,
        [OWNER_UUID]),
      /location_quality_agrees/);

    await assert.rejects(
      () => pool!.query(
        `INSERT INTO alerts (owner_id, request_id, expires_at, location, location_quality,
                             location_age_ms)
         VALUES ($1, 'pg-constraint-2', now() + interval '2 hours',
                 ST_SetSRID(ST_MakePoint(38.7897, 8.9956),4326)::geography, 'live', NULL)`,
        [OWNER_UUID]),
      /live_requires_age/);
  });
});

describe('caller-managed transactions and the outbox (P3)', () => {
  async function outboxFor(alertId: string): Promise<number> {
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE alert_id = $1`, [alertId]);
    return rows[0]!.n;
  }

  dbtest('the alert and its notification work commit together', async () => {
    const result = await createAlertWithOutbox(
      pool!, repo,
      { requestId: 'pg-tx-both-01', ownerId: OWNER, latitude: 8.9956, longitude: 38.7897,
        locationAgeMs: 30_000, accuracyMeters: 12.5 },
      [OTHER],
    );
    assert.equal(result.created, true);
    assert.deepEqual(result.enqueued, [OTHER]);
    assert.deepEqual(result.unresolved, []);
    assert.equal(await outboxFor(result.alert.id), 1);

    // And the queued row points at the internal recipient, not the subject.
    const { rows } = await pool!.query(
      `SELECT recipient_id, channel, state FROM outbox WHERE alert_id = $1`, [result.alert.id]);
    assert.equal(rows[0].recipient_id, OTHER_UUID);
    assert.equal(rows[0].state, 'pending');
  });

  dbtest('a rollback leaves neither the alert nor the outbox work', async () => {
    const failure = new Error('synthetic failure after both writes');
    await assert.rejects(
      () => withTransaction(pool!, async (tx) => {
        const txRepo = repo.withQueryable(tx);
        const { alert } = await txRepo.create({
          requestId: 'pg-tx-roll-01', ownerId: OWNER, latitude: 8.9956, longitude: 38.7897,
          locationAgeMs: 30_000, accuracyMeters: 12.5,
        });
        await tx.query(
          `SELECT enqueue_outbox($1::text, $2::uuid, $3::uuid, 'fcm', '{}'::jsonb)`,
          [`alert:${alert.id}:${OTHER_UUID}:fcm`, alert.id, OTHER_UUID]);

        // Both rows exist INSIDE the transaction...
        const seen = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM outbox WHERE alert_id = $1`, [alert.id]);
        assert.equal(seen.rows[0]!.n, 1);
        throw failure;
      }),
      (e: unknown) => e === failure,
      'the original error must propagate, not one from cleanup');

    // ...and neither survives.
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alerts WHERE owner_id = $1`, [OWNER_UUID]);
    assert.equal(rows[0]!.n, 0, 'no alert');
    // Scoped to THIS suite's recipient: the 'alert:%' prefix is produced by
    // createAlertWithOutbox wherever it is used, including in a test file that
    // runs in parallel against the same database.
    const orphans = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE recipient_id = $1`, [OTHER_UUID]);
    assert.equal(orphans.rows[0]!.n, 0, 'and no notification work for an alert that never existed');
  });

  dbtest('the repository never ends a transaction it does not own', async () => {
    // Several repository calls inside ONE transaction, then a rollback. If any
    // of them committed on its own, something would survive.
    let abandoned = '';
    await assert.rejects(
      () => withTransaction(pool!, async (tx) => {
        const txRepo = repo.withQueryable(tx);
        const { alert } = await txRepo.create({
          requestId: 'pg-tx-multi-1', ownerId: OWNER, latitude: null, longitude: null,
        });
        await txRepo.recordFailedAttempt(alert.id, new Date());
        await txRepo.recordFailedAttempt(alert.id, new Date());
        await txRepo.updateStatus(alert.id, 'escalated', { escalationReason: 'wrong_keyword' });
        abandoned = alert.id;
        throw new Error('abandon the unit of work');
      }));

    const { rows } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alerts WHERE owner_id = $1`, [OWNER_UUID]);
    assert.equal(rows[0]!.n, 0, 'the whole unit of work is gone, not part of it');

    // Scoped to THIS alert on purpose. alert_history has no foreign key to
    // alerts (or to users), so rows from other tests in this file are still
    // present - see the retention test below, which is about exactly that.
    const hist = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alert_history WHERE alert_id = $1`, [abandoned]);
    assert.equal(hist.rows[0]!.n, 0, 'including the history rows it wrote');
  });

  dbtest('a pool-backed call still commits on its own, as it must', async () => {
    // The other half of the contract: without a caller-managed transaction,
    // an ordinary call is its own unit of work and persists immediately.
    const { alert } = await repo.create({
      requestId: 'pg-tx-pool-01', ownerId: OWNER, latitude: null, longitude: null,
    });
    assert.notEqual(await repo.findById(alert.id), null);
  });

  dbtest('idempotency holds through the transactional path', async () => {
    const input = {
      requestId: 'pg-tx-idem-01', ownerId: OWNER, latitude: null, longitude: null,
    };
    const first = await createAlertWithOutbox(pool!, repo, input, [OTHER]);
    const retry = await createAlertWithOutbox(pool!, repo, input, [OTHER]);

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.alert.id, first.alert.id);
    assert.equal(await outboxFor(first.alert.id), 1,
      'a retry must not queue a second notification for one emergency');
    assert.deepEqual(retry.enqueued, [],
      'and must report that it queued nothing');
  });

  dbtest('concurrent transactional creates yield one alert and one queued notification', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createAlertWithOutbox(
        pool!, repo,
        { requestId: `pg-tx-conc-0${i}`, ownerId: OWNER, latitude: null, longitude: null },
        [OTHER],
      ).catch((e: unknown) => e as Error)),
    );
    const ok = attempts.filter((a): a is Awaited<ReturnType<typeof createAlertWithOutbox>> =>
      !(a instanceof Error));
    assert.ok(ok.length >= 1, 'at least one caller must succeed');

    const { rows } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alerts WHERE owner_id = $1`, [OWNER_UUID]);
    assert.equal(rows[0]!.n, 1, 'exactly one alert');

    const ids = new Set(ok.map((a) => a.alert.id));
    assert.equal(ids.size, 1, 'and every successful caller saw the same one');
    assert.equal(await outboxFor([...ids][0]!), 1, 'with one notification queued, not six');
  });

  dbtest('an unresolvable recipient costs neither the alert nor the other recipients', async () => {
    const result = await createAlertWithOutbox(
      pool!, repo,
      { requestId: 'pg-tx-unres-1', ownerId: OWNER, latitude: null, longitude: null },
      [OTHER, UNMAPPED],
    );
    assert.equal(result.created, true, 'the alert still exists');
    assert.deepEqual(result.enqueued, [OTHER], 'the reachable contact is still queued');
    assert.deepEqual(result.unresolved, [UNMAPPED], 'and the gap is reported, not swallowed');
  });

  dbtest('an unmapped OWNER rolls the whole unit of work back', async () => {
    await assert.rejects(
      () => createAlertWithOutbox(
        pool!, repo,
        { requestId: 'pg-tx-ghost-1', ownerId: UNMAPPED, latitude: null, longitude: null },
        [OTHER],
      ),
      IdentityNotMappedError);

    const { rows } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE recipient_id = $1`, [OTHER_UUID]);
    assert.equal(rows[0]!.n, 0, 'nothing queued for an alert that was never created');
  });
});

describe('audit-trail retention — a gap, pinned not fixed', () => {
  /**
   * alert_history has NO foreign keys: not to alerts, not to users.
   *
   * So deleting an alert leaves its history, and deleting the USER leaves rows
   * carrying her owner_id in a table nothing cleans. On a live database this
   * is already true of a hundred-odd rows whose users no longer exist.
   *
   * Surviving alert deletion is defensible for an audit trail - you want to
   * know an alert existed. Surviving ACCOUNT deletion is a retention decision
   * nobody has made, and CLAUDE.md s6/s7 put it outside what an engineer
   * settles alone: the audit trail is also the evidence a protection order
   * rests on, so erasing it is not obviously the safe default either.
   *
   * These assertions therefore describe what happens today. They are written
   * to FAIL if the behaviour changes, so the decision is taken deliberately
   * rather than discovered later.
   */
  dbtest('deleting her alerts leaves the audit trail behind', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-retain-001', ownerId: OWNER, latitude: null, longitude: null,
    });
    await repo.updateStatus(alert.id, 'resolved', { resolvedBy: 'owner' });

    const before = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alert_history WHERE alert_id = $1`, [alert.id]);
    assert.ok(before.rows[0]!.n >= 2, 'creation and resolution were both recorded');

    assert.equal(await repo.deleteAllForOwner(OWNER), 1);

    const after = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alert_history WHERE alert_id = $1`, [alert.id]);
    assert.equal(after.rows[0]!.n, before.rows[0]!.n,
      'CURRENT BEHAVIOUR: history outlives the alert it describes');

    const stillNamed = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alert_history WHERE owner_id = $1`, [OWNER_UUID]);
    assert.ok(stillNamed.rows[0]!.n > 0,
      'CURRENT BEHAVIOUR: and still carries her internal id — a retention decision is owed');
  });

  dbtest('reveal_log survives too — and it is a record about a THIRD party', async () => {
    // reveal_log records that a responder or institution was shown someone's
    // location. Deleting it when SHE deletes her account would erase the only
    // record of what a third party was given - which protects her, not us.
    // Whether that is right is an open retention decision, not one this
    // test makes.
    const { alert } = await repo.create({
      requestId: 'pg-reveal-001', ownerId: OWNER, latitude: null, longitude: null,
    });
    await pool!.query(
      `INSERT INTO reveal_log (alert_id, actor_id, granted, reason)
       VALUES ($1, $2, true, 'audit-regression')`, [alert.id, OTHER_UUID]);

    await repo.updateStatus(alert.id, 'resolved', { resolvedBy: 'owner' });
    assert.equal(await repo.deleteAllForOwner(OWNER), 1);

    const { rows } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reveal_log WHERE alert_id = $1`, [alert.id]);
    assert.equal(rows[0]!.n, 1,
      'CURRENT BEHAVIOUR: the reveal record outlives the alert it describes');

    // This suite cleans up after itself; nothing else will.
    await pool!.query(`DELETE FROM reveal_log WHERE alert_id = $1`, [alert.id]);
  });

  dbtest('an account cannot be deleted while evidence remains — fail-closed', async () => {
    // The decided ordering (data-decisions.md s2): objects before rows, because
    // an orphaned row is recoverable and an orphaned recording is not. The
    // schema enforces it rather than trusting the caller to remember.
    const { alert } = await repo.create({
      requestId: 'pg-evdel-001', ownerId: OWNER, latitude: null, longitude: null,
    });
    await pool!.query(
      `INSERT INTO evidence (alert_id, owner_id, r2_key, content_type)
       VALUES ($1,$2,$3,'audio/m4a')`, [alert.id, OWNER_UUID, `evidence/${alert.id}/audit`]);

    await assert.rejects(
      () => pool!.query(`DELETE FROM users WHERE id = $1`, [OWNER_UUID]),
      /foreign key constraint/,
      'deleting the account must be refused while a recording is still indexed');

    await pool!.query(`DELETE FROM evidence WHERE alert_id = $1`, [alert.id]);
  });

  dbtest('nothing cascades from users to the audit trail either', async () => {
    const tempUuid = randomUUID();
    const tempSubject = `pgTemp${randomUUID().replace(/-/g, '').slice(0, 22)}`;
    await pool!.query(`INSERT INTO users (id, display_name) VALUES ($1,'Temp')`, [tempUuid]);
    await pool!.query(
      `INSERT INTO identity_map (firebase_uid, user_id) VALUES ($1,$2)`,
      [tempSubject, tempUuid]);
    const { alert } = await repo.create({
      requestId: 'pg-retain-002', ownerId: tempSubject, latitude: null, longitude: null,
    });

    // Deleting the user cascades to alerts and identity_map...
    await pool!.query(`DELETE FROM users WHERE id = $1`, [tempUuid]);
    assert.equal(await repo.findById(alert.id), null, 'the alert is gone');

    // ...but not to alert_history.
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alert_history WHERE owner_id = $1`, [tempUuid]);
    assert.ok(rows[0]!.n > 0,
      'CURRENT BEHAVIOUR: the deleted account is still named in the audit trail');

    // Clean up this test's own residue, since nothing else will.
    await pool!.query(`DELETE FROM alert_history WHERE owner_id = $1`, [tempUuid]);
  });
});

describe('malformed alert ids (contract violation, fixed)', () => {
  /** Counts queries, so "did not reach the database" is observable. */
  function countingDb(): { db: Queryable; count: () => number } {
    let n = 0;
    return {
      count: () => n,
      db: {
        query: async (sql: string, params?: readonly unknown[]) => {
          n += 1;
          return pool!.query(sql, params as unknown[]);
        },
      } as Queryable,
    };
  }

  dbtest('a valid existing id returns the alert', async () => {
    const { alert } = await repo.create({
      requestId: 'pg-mal-exists1', ownerId: OWNER, latitude: null, longitude: null,
    });
    assert.equal((await repo.findById(alert.id))?.id, alert.id);
  });

  dbtest('a valid but nonexistent id returns null', async () => {
    // Unchanged behaviour: a well-formed id that names no row.
    assert.equal(await repo.findById(randomUUID()), null);
  });

  dbtest('malformed ids return null instead of raising 22P02', async () => {
    // Before the fix each of these raised `invalid input syntax for type
    // uuid`, which became a 500 and, for a task, a retry cycle ending in
    // `abandoned` - work dropped for an input that cannot name an alert.
    for (const bad of [
      'x', 'not-a-uuid', '', '   ',
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1',            // one hex short
      'zzzzbc99-9c0b-4ef8-bb6d-6bb9bd380a11',           // not hex
      'urn:uuid:a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',  // prefix Postgres rejects
      ' a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11 ',         // padded
      '../../etc/passwd', "'; DROP TABLE alerts; --",
      'a'.repeat(200), '\u0000',
    ]) {
      assert.equal(await repo.findById(bad), null, `findById(${JSON.stringify(bad)})`);
    }
    // And the table it tried to drop is still queryable.
    const { rows } = await pool!.query<{ n: number }>(`SELECT count(*)::int AS n FROM alerts`);
    assert.ok(Number.isInteger(rows[0]!.n));
  });

  dbtest('the guard MIRRORS Postgres rather than tightening it', async () => {
    // Postgres accepts more than the canonical form. A stricter guard would
    // return null for ids that match a real row, so each of these must still
    // reach the query and find the alert.
    const { alert } = await repo.create({
      requestId: 'pg-mal-forms1', ownerId: OWNER, latitude: null, longitude: null,
    });
    const canonical = alert.id;
    for (const form of [
      canonical,
      canonical.toUpperCase(),
      canonical.replace(/-/g, ''),
      `{${canonical}}`,
    ]) {
      assert.equal((await repo.findById(form))?.id, canonical,
        `form ${JSON.stringify(form)} must still resolve`);
    }
  });

  dbtest('an invalid id does NOT execute a query', async () => {
    const { db, count } = countingDb();
    const guarded = new PostgresAlertRepository(db, ACTIVE_WINDOW_MS);

    assert.equal(await guarded.findById('not-a-uuid'), null);
    assert.equal(count(), 0, 'a malformed id must cost no round trip');

    // A well-formed one does reach the database, so the counter is meaningful.
    assert.equal(await guarded.findById(randomUUID()), null);
    assert.equal(count(), 1);
  });

  dbtest('a GENUINE database failure still propagates — never null', async () => {
    // The failure mode this guards against: converting every error to null
    // would hide an outage behind a 404. The alert would appear not to exist,
    // a responder would be told to stand down, and nothing would page.
    const dead = createPool(
      { host: '127.0.0.1', port: 1, database: 'x', user: 'x', password: 'x' },
      { connectionTimeoutMillis: 400 });
    try {
      const offline = new PostgresAlertRepository(dead, ACTIVE_WINDOW_MS);
      await assert.rejects(() => offline.findById(randomUUID()),
        'an unreachable database must not look like a missing alert');
    } finally {
      await closePool(dead);
    }
  });

  dbtest('the methods that return Alert raise instead of returning null', async () => {
    // updateStatus and recordFailedAttempt cannot report absence with null, so
    // they use the signal they already have for a missing alert. Unreachable
    // through any route today - every caller gets its id from findById first -
    // but guarded so a future caller cannot reintroduce 22P02.
    for (const bad of ['x', '', 'not-a-uuid']) {
      await assert.rejects(() => repo.updateStatus(bad, 'resolved', {}), AlertNotFoundError);
      await assert.rejects(() => repo.recordFailedAttempt(bad, new Date()), AlertNotFoundError);
    }
  });
});

describe('failure behaviour', () => {
  dbtest('a database that is down surfaces an error, never a fake success', async () => {
    const dead = createPool(
      { host: '127.0.0.1', port: 1, database: 'x', user: 'x', password: 'x' },
      { connectionTimeoutMillis: 500 });
    const deadRepo = new PostgresAlertRepository(dead, ACTIVE_WINDOW_MS);
    await assert.rejects(() => deadRepo.create({
      requestId: 'pg-dead-0001', ownerId: OWNER, latitude: null, longitude: null,
    }));
    await dead.end().catch(() => {});
  });
});

describe('configuration safety', () => {
  test('loadDbConfig fails closed when nothing is configured', () => {
    assert.throws(() => loadDbConfig({} as NodeJS.ProcessEnv), /Missing required/);
  });
  test('loadDbConfig rejects a non-numeric port rather than guessing', () => {
    assert.throws(() => loadDbConfig({
      PGHOST: 'h', PGPORT: 'not-a-port', PGDATABASE: 'd', PGUSER: 'u', PGPASSWORD: 'p',
    } as NodeJS.ProcessEnv));
  });
  test('no default silently selects a database', () => {
    assert.throws(() => loadDbConfig({ PGHOST: 'h' } as NodeJS.ProcessEnv), /Missing required/);
  });
});
