/**
 * The repository, run as the role it will actually run as.  (audit §4)
 *
 * Every other PostgreSQL suite connects as the owning superuser, which
 * bypasses table GRANTs and is exempt from RLS. So a green run there proves
 * the SQL is correct and proves NOTHING about whether the deployed role may
 * execute it. Sprint 3 found one such gap by accident - the API role had no
 * DELETE on alerts, so deleteAllForOwner would have failed in production with
 * every integration test passing. This suite exists so the next one is found
 * here instead.
 *
 * HOW THE ROLE IS APPLIED: `options: '-c role=alehulsh_api'` is sent at
 * connection startup, so every connection in the restricted pool begins
 * already restricted. current_user becomes alehulsh_api while session_user
 * stays postgres.
 *
 * WHAT THIS DOES AND DOES NOT PROVE:
 *   proves    - table/column GRANTs, function EXECUTE grants, and RLS as they
 *               apply to alehulsh_api, against the real repository code.
 *   does NOT  - authentication. alehulsh_api is NOLOGIN (see the hosting
 *               checklist), so it cannot be connected to directly, and this
 *               harness could issue RESET ROLE to escape. The repository never
 *               does, and assertRestricted() below fails the whole suite if the
 *               restriction is not actually in force - so the suite cannot
 *               silently pass as a superuser.
 *
 * Fixtures are created with the PRIVILEGED pool, because provisioning is a
 * privileged operation and the API role deliberately cannot do it. The
 * operation under test always runs on the restricted pool.
 *
 * Synthetic data only.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, loadDbConfig, closePool, withTransaction } from '../src/db/pool.js';
import {
  PostgresAlertRepository, IdentityNotMappedError,
} from '../src/repositories/postgres/PostgresAlertRepository.js';
import { createAlertWithOutbox } from '../src/services/AlertWithOutbox.js';
import { AbandonedTaskMonitor } from '../src/queue/AbandonedTaskMonitor.js';
import { OverduePendingProbe } from '../src/queue/OverduePendingProbe.js';
import type { Logger } from '../src/logger.js';

const ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Fixtures and teardown only. Never the operation under test. */
let privileged: Pool | null = null;
/** current_user = alehulsh_api. Everything under test runs here. */
let restricted: Pool | null = null;
let repo: PostgresAlertRepository;
let available = false;
let skipReason = '';

const OWNER_UUID = randomUUID();
const OTHER_UUID = randomUUID();
const OWNER = `rrOwner${randomUUID().replace(/-/g, '').slice(0, 21)}`;
const OTHER = `rrOther${randomUUID().replace(/-/g, '').slice(0, 21)}`;
const UNMAPPED = `rrGhost${randomUUID().replace(/-/g, '').slice(0, 21)}`;

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

  privileged = createPool(cfg, { max: 3 });
  restricted = createPool(cfg, { max: 4, options: '-c role=alehulsh_api' });
  repo = new PostgresAlertRepository(restricted, ACTIVE_WINDOW_MS);

  await privileged.query(
    `INSERT INTO users (id, display_name) VALUES ($1,'Owner'),($2,'Other')
     ON CONFLICT (id) DO NOTHING`, [OWNER_UUID, OTHER_UUID]);
  await privileged.query(
    `INSERT INTO identity_map (firebase_uid, user_id) VALUES ($1,$2),($3,$4)
     ON CONFLICT (firebase_uid) DO NOTHING`, [OWNER, OWNER_UUID, OTHER, OTHER_UUID]);

  available = true;
});

async function clearOwnRows(): Promise<void> {
  const owners = [[OWNER_UUID, OTHER_UUID]];
  await privileged!.query(`DELETE FROM outbox WHERE recipient_id = ANY($1::uuid[])`, owners);
  await privileged!.query(`DELETE FROM evidence WHERE owner_id = ANY($1::uuid[])`, owners);
  await privileged!.query(`DELETE FROM alerts WHERE owner_id = ANY($1::uuid[])`, owners);
}

after(async () => {
  if (!privileged) return;
  await clearOwnRows();
  // alert_history has no FK and nothing cascades to it (audit §5), so this
  // suite removes its own rows rather than adding to the pile.
  await privileged.query(
    `DELETE FROM alert_history WHERE owner_id = ANY($1::uuid[])`, [[OWNER_UUID, OTHER_UUID]]);
  // task_queue has no FK to users (0008), so nothing cascades to it.
  await privileged.query(`DELETE FROM task_queue WHERE task_key LIKE 'rr-task-%'`);
  // 0011's ledger cascades from task_queue, so the line above takes its rows
  // with it. These are this suite's monitor fixtures.
  await privileged.query(`DELETE FROM task_queue WHERE task_key LIKE 'rr-mon-%'`);
  await privileged.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[OWNER_UUID, OTHER_UUID]]);
  if (restricted) await closePool(restricted);
  await closePool(privileged);
});

/**
 * The guard that makes this suite meaningful.
 *
 * If the restricted pool were somehow a superuser, every "denied" assertion
 * below would fail - but every "allowed" one would pass, and a careless reader
 * would see green. This asserts the restriction positively, and runs as the
 * first test so a misconfigured harness is reported as a failure here rather
 * than as a confusing cascade.
 */
async function assertRestricted(): Promise<void> {
  const { rows } = await restricted!.query<{
    current_user: string; is_super: boolean;
  }>(`SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS is_super`);
  assert.equal(rows[0]!.current_user, 'alehulsh_api');
  assert.equal(rows[0]!.is_super, false);
}

function rtest(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) { t.skip(skipReason); return; }
    await assertRestricted();
    await clearOwnRows();
    await fn();
  });
}

/** Postgres SQLSTATE 42501. */
function isInsufficientPrivilege(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '42501';
}

describe('the harness is genuinely restricted', () => {
  rtest('current_user is alehulsh_api and is not a superuser', async () => {
    await assertRestricted();
    // And the restriction is enforced, not merely reported.
    await assert.rejects(
      () => restricted!.query(
        `INSERT INTO identity_map (firebase_uid, user_id) VALUES ('probe', $1)`, [OWNER_UUID]),
      isInsufficientPrivilege,
      'if this is ALLOWED, every denial assertion in this file is worthless');
  });

  rtest('the privileged pool really is privileged, so fixtures are not a false negative', async () => {
    const { rows } = await privileged!.query<{ is_super: boolean }>(
      `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS is_super`);
    assert.equal(rows[0]!.is_super, true);
  });
});

describe('permitted: the repository operations the API must perform', () => {
  rtest('create an alert through the subject-resolving function', async () => {
    const { alert, created } = await repo.create({
      requestId: 'rr-create-001', ownerId: OWNER,
      latitude: 8.9956, longitude: 38.7897, locationAgeMs: 30_000, accuracyMeters: 12.5,
    });
    assert.equal(created, true);
    assert.equal(alert.ownerId, OWNER);
    assert.equal(alert.locationQuality, 'live');
  });

  rtest('read it back, and find the live alert by subject', async () => {
    const { alert } = await repo.create({
      requestId: 'rr-read-0001', ownerId: OWNER, latitude: null, longitude: null,
    });
    assert.equal((await repo.findById(alert.id))?.id, alert.id);
    assert.equal((await repo.findActiveByOwner(OWNER))?.id, alert.id);
  });

  rtest('transition it: escalate then resolve', async () => {
    const { alert } = await repo.create({
      requestId: 'rr-trans-001', ownerId: OWNER, latitude: null, longitude: null,
    });
    const esc = await repo.updateStatus(alert.id, 'escalated', { escalationReason: 'wrong_keyword' });
    assert.equal(esc.status, 'escalated');
    const res = await repo.updateStatus(alert.id, 'resolved', { resolvedBy: 'owner_late' });
    assert.equal(res.status, 'resolved');
    assert.equal(res.resolvedBy, 'owner_late');
  });

  rtest('record failed keyword attempts', async () => {
    const { alert } = await repo.create({
      requestId: 'rr-attempt-01', ownerId: OWNER, latitude: null, longitude: null,
    });
    assert.equal((await repo.recordFailedAttempt(alert.id, new Date())).attemptCount, 1);
    assert.equal((await repo.recordFailedAttempt(alert.id, new Date())).attemptCount, 2);
  });

  rtest('list her history', async () => {
    const a = await repo.create({ requestId: 'rr-hist-0001', ownerId: OWNER, latitude: null, longitude: null });
    await repo.updateStatus(a.alert.id, 'cancelled', {});
    await repo.create({ requestId: 'rr-hist-0002', ownerId: OWNER, latitude: null, longitude: null });
    assert.equal((await repo.listHistoryForOwner(OWNER)).length, 2);
  });

  rtest('delete her alerts — the grant sprint 3 added', async () => {
    // Without GRANT DELETE ON alerts this raises 42501, and account deletion
    // fails in production while every superuser test passes.
    const { alert } = await repo.create({
      requestId: 'rr-delete-001', ownerId: OWNER, latitude: null, longitude: null,
    });
    await repo.updateStatus(alert.id, 'resolved', { resolvedBy: 'owner' });
    assert.equal(await repo.deleteAllForOwner(OWNER), 1);
  });

  rtest('read the identity map (resolve a subject)', async () => {
    const { rows } = await restricted!.query<{ u: string }>(
      `SELECT resolve_identity($1) AS u`, [OWNER]);
    assert.equal(rows[0]!.u, OWNER_UUID);
  });

  rtest('write an alert and its outbox work in one transaction', async () => {
    const result = await createAlertWithOutbox(
      restricted!, repo,
      { requestId: 'rr-outbox-001', ownerId: OWNER, latitude: null, longitude: null },
      [OTHER],
    );
    assert.equal(result.created, true);
    assert.deepEqual(result.enqueued, [OTHER]);
  });

  /**
   * This suite asks "may the API role do this?", not "does the mechanism
   * work?" - the mechanics are covered by outboxConcurrency.integration.test.ts
   * against isolated data.
   *
   * The distinction matters here. The original version seeded a row, claimed,
   * and asserted it got at least one back. But claim_outbox claims ANY due
   * row, and outboxConcurrency runs in a parallel process against the same
   * table: it could take this row first, leaving this assertion to fail for a
   * reason that has nothing to do with privileges. Asserting EXECUTABILITY
   * instead tests exactly the thing this suite exists for, and is immune to
   * what else is in the table.
   */
  rtest('claim_outbox and complete_outbox are executable by the API role', async () => {
    const result = await createAlertWithOutbox(
      restricted!, repo,
      { requestId: 'rr-claim-0001', ownerId: OWNER, latitude: null, longitude: null },
      [OTHER],
    );
    assert.ok(result.alert.id);

    // LIMIT 0, for the same reason as claim_tasks below: this suite needs the
    // PRIVILEGE, and claiming real rows would compete with
    // outboxConcurrency.integration.test.ts in a parallel process.
    const claimed = await restricted!.query<{ id: string }>(
      `SELECT id FROM claim_outbox($1::text, 0, interval '60 seconds')`, ['worker-restricted']);
    assert.equal(claimed.rows.length, 0, 'claim_outbox must not be refused, and takes nothing');

    // A non-existent id still proves the grant: it returns false rather than
    // raising insufficient_privilege.
    const done = await restricted!.query<{ complete_outbox: boolean }>(
      `SELECT complete_outbox($1::bigint, $2::text, true, NULL)`, ['-1', 'worker-restricted']);
    assert.equal(done.rows[0]!.complete_outbox, false,
      'complete_outbox must not be refused');
  });

  rtest('claim_tasks, complete_task, enqueue_task and cancel_task are executable (M-07)', async () => {
    // Same reasoning: the privilege, not the mechanism. 0008 granted these.
    // Deliberately non-interfering with taskQueue.integration.test.ts, which
    // runs in a parallel process against this same table:
    //
    //   * the task is scheduled a DAY out, so it is never due and that suite's
    //     workers can never claim it;
    //   * claim_tasks is called with LIMIT 0, which proves EXECUTE without
    //     taking anyone's work.
    //
    // Filtering results by key prefix was not enough: claim_tasks claims
    // globally, so a claim here would still steal rows from that suite and
    // fill its batch limits. Not competing at all is the only reliable fix,
    // and this suite only needs the PRIVILEGE anyway.
    const key = `rr-task-${randomUUID().slice(0, 8)}`;
    const enq = await restricted!.query<{ enqueue_task: boolean }>(
      `SELECT enqueue_task($1::text, 'safety-check', '{"alertId":"x"}'::jsonb,
                           now() + interval '1 day')`, [key]);
    assert.equal(enq.rows[0]!.enqueue_task, true, 'the API role must be able to enqueue');

    const claimed = await restricted!.query<{ id: string }>(
      `SELECT id FROM claim_tasks($1::text, 0, interval '60 seconds')`, ['worker-restricted']);
    assert.equal(claimed.rows.length, 0, 'claim_tasks must not be refused, and takes nothing');

    // A non-existent id still proves the grant: it returns false rather than
    // raising insufficient_privilege.
    const done = await restricted!.query<{ complete_task: boolean }>(
      `SELECT complete_task($1::bigint, $2::text, true, NULL)`, ['-1', 'worker-restricted']);
    assert.equal(done.rows[0]!.complete_task, false);

    const cancelled = await restricted!.query<{ cancel_task: boolean }>(
      `SELECT cancel_task($1::text)`, [key]);
    assert.equal(cancelled.rows[0]!.cancel_task, true, 'and it can cancel its own task');
  });

  rtest('the API role cannot DELETE task history (M-07)', async () => {
    await assert.rejects(
      () => restricted!.query(`DELETE FROM task_queue`), isInsufficientPrivilege);
  });
});

describe('denied: operations the API role must NOT be able to perform', () => {
  rtest('minting an identity mapping', async () => {
    await assert.rejects(
      () => restricted!.query(
        `INSERT INTO identity_map (firebase_uid, user_id) VALUES ($1,$2)`, [UNMAPPED, OWNER_UUID]),
      isInsufficientPrivilege);
  });

  rtest('repointing a mapping at another account — alert redirection', async () => {
    // The attack this blocks: change OWNER's mapping to OTHER's uuid and every
    // subsequent alert she raises lands on an account someone else controls.
    await assert.rejects(
      () => restricted!.query(
        `UPDATE identity_map SET user_id = $1 WHERE firebase_uid = $2`, [OTHER_UUID, OWNER]),
      isInsufficientPrivilege);
  });

  rtest('deleting a mapping', async () => {
    await assert.rejects(
      () => restricted!.query(`DELETE FROM identity_map WHERE firebase_uid = $1`, [OWNER]),
      isInsufficientPrivilege);
  });

  rtest('calling create_alert directly with a chosen internal uuid', async () => {
    // The whole point of the subject boundary: if the API role could call this,
    // a bug could place an alert on any account by naming its uuid.
    await assert.rejects(
      () => restricted!.query(
        `SELECT create_alert($1::uuid, 'rr-direct-001')`, [OTHER_UUID]),
      isInsufficientPrivilege);
  });

  rtest('deleting alert history — the audit trail is append-only to the API', async () => {
    await assert.rejects(
      () => restricted!.query(`DELETE FROM alert_history WHERE owner_id = $1`, [OWNER_UUID]),
      isInsufficientPrivilege);
  });

  rtest('updating alert history — a recorded transition cannot be rewritten', async () => {
    await assert.rejects(
      () => restricted!.query(`UPDATE alert_history SET actor = 'forged'`),
      isInsufficientPrivilege);
  });

  rtest('deleting the audit log of location reveals', async () => {
    await assert.rejects(
      () => restricted!.query(`DELETE FROM reveal_log`), isInsufficientPrivilege);
    await assert.rejects(
      () => restricted!.query(`UPDATE reveal_log SET granted = false`), isInsufficientPrivilege);
  });

  rtest('deleting evidence rows — recordings must not be erasable by the API', async () => {
    await assert.rejects(
      () => restricted!.query(`DELETE FROM evidence`), isInsufficientPrivilege);
  });

  rtest('deleting queued notification work', async () => {
    await assert.rejects(
      () => restricted!.query(`DELETE FROM outbox`), isInsufficientPrivilege);
  });

  rtest('deleting notification attempts', async () => {
    await assert.rejects(
      () => restricted!.query(`DELETE FROM notification_attempts`), isInsufficientPrivilege);
  });

  rtest('altering a row-level security policy', async () => {
    await assert.rejects(() => restricted!.query(
      `ALTER TABLE alerts DISABLE ROW LEVEL SECURITY`));
    await assert.rejects(() => restricted!.query(
      `CREATE POLICY rr_evil ON alerts FOR ALL TO alehulsh_api USING (true)`));
  });

  rtest('granting itself more privilege gains nothing', async () => {
    // A GRANT by a role with no grant option is a silent NO-OP in Postgres - a
    // warning, not an error. So the assertion that matters is the EFFECT, not
    // the rejection: asserting a throw here would have been testing the wrong
    // mechanism and would break the day Postgres changes its warning.
    await restricted!.query(`GRANT INSERT ON identity_map TO alehulsh_api`);
    const { rows } = await restricted!.query<{ can_insert: boolean }>(
      `SELECT has_table_privilege('alehulsh_api','identity_map','INSERT') AS can_insert`);
    assert.equal(rows[0]!.can_insert, false, 'the no-op GRANT must not have taken effect');

    // And it still cannot actually insert.
    await assert.rejects(
      () => restricted!.query(
        `INSERT INTO identity_map (firebase_uid, user_id) VALUES ('rr-escalate', $1)`,
        [OWNER_UUID]),
      isInsufficientPrivilege);
  });

  rtest('altering its own role attributes is refused outright', async () => {
    await assert.rejects(
      () => restricted!.query(`ALTER ROLE alehulsh_api BYPASSRLS`), isInsufficientPrivilege);
    await assert.rejects(
      () => restricted!.query(`ALTER ROLE alehulsh_api SUPERUSER`), isInsufficientPrivilege);
    const { rows } = await restricted!.query<{ b: boolean }>(
      `SELECT rolbypassrls AS b FROM pg_roles WHERE rolname='alehulsh_api'`);
    assert.equal(rows[0]!.b, false);
  });

  rtest('reading the keyword pepper or anything outside its schema', async () => {
    // Not a privilege the API should hold even though it is only metadata.
    await assert.rejects(() => restricted!.query(`SELECT * FROM pg_authid`));
  });
});

describe('identity isolation under the restricted role', () => {
  rtest('an unmapped subject cannot create an alert and no account appears', async () => {
    await assert.rejects(
      () => repo.create({
        requestId: 'rr-ghost-001', ownerId: UNMAPPED, latitude: null, longitude: null,
      }),
      IdentityNotMappedError);
    // Asserting the MAPPING is absent, not that a global user count held
    // steady. Other test files create and delete users in parallel processes
    // against this same database, so a global count changes for reasons that
    // have nothing to do with this request. "No mapping was minted for this
    // subject" is also the property that actually matters: an invented account
    // is only reachable through identity_map.
    const mapped = await privileged!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity_map WHERE firebase_uid = $1`, [UNMAPPED]);
    assert.equal(mapped.rows[0]!.n, 0);
  });

  rtest("one subject cannot reach another's alerts", async () => {
    await repo.create({ requestId: 'rr-iso-00001', ownerId: OWNER, latitude: null, longitude: null });
    await repo.create({ requestId: 'rr-iso-00002', ownerId: OTHER, latitude: null, longitude: null });

    const mine = await repo.listHistoryForOwner(OWNER);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.ownerId, OWNER);
  });

  rtest('presenting an internal uuid as a subject resolves to nothing', async () => {
    await assert.rejects(
      () => repo.create({
        requestId: 'rr-spoof-001', ownerId: OTHER_UUID, latitude: null, longitude: null,
      }),
      IdentityNotMappedError);
  });

  rtest('no internal uuid is reachable through anything the repository returns', async () => {
    const { alert } = await repo.create({
      requestId: 'rr-noleak-01', ownerId: OWNER, latitude: 8.9956, longitude: 38.7897,
      locationAgeMs: 30_000, accuracyMeters: 12.5,
    });
    const serialised = JSON.stringify([
      alert, await repo.findById(alert.id), await repo.findActiveByOwner(OWNER),
      await repo.listHistoryForOwner(OWNER),
    ]);
    assert.ok(!serialised.includes(OWNER_UUID));
    assert.ok(!serialised.includes(OTHER_UUID));
  });
});

describe('transactions under the restricted role', () => {
  rtest('a rollback leaves neither the alert nor its outbox work', async () => {
    const boom = new Error('synthetic');
    await assert.rejects(
      () => withTransaction(restricted!, async (tx) => {
        const txRepo = repo.withQueryable(tx);
        const { alert } = await txRepo.create({
          requestId: 'rr-roll-0001', ownerId: OWNER, latitude: null, longitude: null,
        });
        await tx.query(
          `SELECT enqueue_outbox($1::text, $2::uuid, $3::uuid, 'fcm', '{}'::jsonb)`,
          [`alert:${alert.id}:${OTHER_UUID}:fcm`, alert.id, OTHER_UUID]);
        throw boom;
      }),
      (e: unknown) => e === boom);

    const alerts = await privileged!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alerts WHERE owner_id = $1`, [OWNER_UUID]);
    assert.equal(alerts.rows[0]!.n, 0);
    const work = await privileged!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE recipient_id = $1`, [OTHER_UUID]);
    assert.equal(work.rows[0]!.n, 0);
  });

  rtest('idempotency holds: a retry queues no second notification', async () => {
    const input = { requestId: 'rr-idem-0001', ownerId: OWNER, latitude: null, longitude: null };
    const first = await createAlertWithOutbox(restricted!, repo, input, [OTHER]);
    const retry = await createAlertWithOutbox(restricted!, repo, input, [OTHER]);
    assert.equal(retry.created, false);
    assert.equal(retry.alert.id, first.alert.id);

    const { rows } = await privileged!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE alert_id = $1`, [first.alert.id]);
    assert.equal(rows[0]!.n, 1);
  });
});

/**
 * Abandoned-task monitoring, under the role that will actually run it.  (P2-17)
 *
 * The audit's lesson applies directly: migration 0011 grants the API role
 * SELECT on the ledger and EXECUTE on one function, and nothing else. If that
 * were wrong, every other suite would still pass - they all connect as the
 * owning superuser, which bypasses GRANTs entirely - and the monitor would
 * fail in production on the first abandoned safety check.
 *
 * Deliberately NOT a global `scan()`: that would announce other suites' rows
 * and make those suites' assertions depend on this one's timing. What is under
 * test here is the PRIVILEGE, proved against the real class and the real
 * function on this suite's own fixture.
 */
describe('abandoned-task monitoring under the API role (P2-17)', () => {
  /** The session lock taskQueue / worker / abandonedTaskMonitor all share. */
  const QUEUE_SUITE_LOCK = 918_271_354;

  async function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
    const client = await privileged!.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [QUEUE_SUITE_LOCK]);
      try { return await fn(); } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [QUEUE_SUITE_LOCK]);
      }
    } finally { client.release(); }
  }

  // Silent: what is under test is the GRANT, not the log line, and the real
  // logger writes to stdout. The emitted signal is asserted in
  // abandonedTaskMonitor.integration.test.ts.
  const monitorLogger: Logger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  };

  /** An abandoned task of this suite's own, created with the privileged pool. */
  async function seedAbandoned(): Promise<string> {
    const { rows } = await privileged!.query<{ id: string }>(
      `INSERT INTO task_queue (task_key, kind, payload, run_at, state, attempts,
                               max_attempts, last_error, completed_at)
       VALUES ($1,'safety-check','{"alertId":"x"}'::jsonb, now(),'abandoned',
               5, 5, 'task route returned 500', now())
       RETURNING id`,
      [`rr-mon-${randomUUID()}`],
    );
    return String(rows[0]!.id);
  }

  rtest('the API role can read the queue and the ledger, and append to it', async () => {
    const id = await seedAbandoned();

    // The monitor's own two statements, issued by the real class on the
    // restricted pool. A missing grant surfaces here as a 42501.
    const candidates = await restricted!.query<{ id: string }>(
      `SELECT t.id FROM task_queue t
        WHERE t.state = 'abandoned'
          AND NOT EXISTS (SELECT 1 FROM task_alert_log l WHERE l.task_id = t.id)
          AND t.id = $1`, [id]);
    assert.equal(candidates.rows.length, 1, 'the API role can run the detection query');

    const appended = await restricted!.query(
      `SELECT record_task_alerts($1::bigint[], $2::text[], $3::int[], $4::int[],
                                 $5::timestamptz[], $6::text[], $7::text[], $8::boolean[])`,
      [[id], ['safety-check'], [5], [5], [new Date()], ['route_rejected'], ['safety'], [true]],
    );
    assert.equal(appended.rows.length, 1, 'the API role can append to the ledger');

    const read = await restricted!.query<{ severity: string }>(
      `SELECT severity FROM task_alert_log WHERE task_id = $1`, [id]);
    assert.equal(read.rows[0]!.severity, 'safety', 'and can read back what it wrote');
  });

  rtest('the real monitor class runs end to end as alehulsh_api', async () => {
    // A scan announces ANY unreported abandoned task, so this one test holds
    // the same lock the queue suites use. Without it, this scan could announce
    // a row abandonedTaskMonitor.integration.test.ts had just created and was
    // about to assert on - a flake in a suite that did nothing wrong.
    await withQueueLock(async () => {
      const id = await seedAbandoned();
      const monitor = new AbandonedTaskMonitor(restricted!, monitorLogger, { batchSize: 500 });

      const result = await monitor.scan();

      assert.equal(result.failed, false, 'a grant gap would surface as a failed scan');
      const { rows } = await privileged!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM task_alert_log WHERE task_id = $1`, [id]);
      assert.equal(rows[0]!.n, 1);
    });
  });

  rtest('the overdue-pending probe runs as alehulsh_api, and writes nothing', async () => {
    // It needs only SELECT on task_queue, which 0008 granted at table level -
    // but a column-level grant regression (as 0006 applied to `users`) would
    // break it, and every superuser-connected suite would still pass.
    await withQueueLock(async () => {
      const { rows: ins } = await privileged!.query<{ id: string }>(
        `INSERT INTO task_queue (task_key, kind, payload, run_at)
         VALUES ($1,'safety-check','{"alertId":"x"}'::jsonb, now() - interval '30 s')
         RETURNING id`, [`rr-mon-${randomUUID()}`]);
      const id = String(ins[0]!.id);

      const probe = new OverduePendingProbe(restricted!, monitorLogger, { kindLimit: 500 });
      const result = await probe.scan({ claimed: 0, capacity: 10 });

      assert.equal(result.failed, false, 'a grant gap would surface as a failed scan');
      assert.ok(result.dueTotal >= 1);

      // Read-only: the row is exactly as it was, and no ledger row appeared.
      const { rows } = await privileged!.query<{ state: string; attempts: number }>(
        `SELECT state, attempts FROM task_queue WHERE id = $1`, [id]);
      assert.equal(rows[0]!.state, 'pending');
      assert.equal(rows[0]!.attempts, 0);
      const { rows: log } = await privileged!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM task_alert_log WHERE task_id = $1`, [id]);
      assert.equal(log[0]!.n, 0);
    });
  });

  rtest('the ledger is APPEND-ONLY, even to the role that appends to it', async () => {
    const id = await seedAbandoned();
    await restricted!.query(
      `SELECT record_task_alerts($1::bigint[], $2::text[], $3::int[], $4::int[],
                                 $5::timestamptz[], $6::text[], $7::text[], $8::boolean[])`,
      [[id], ['safety-check'], [5], [5], [new Date()], ['route_rejected'], ['safety'], [true]],
    );

    // No INSERT grant: it cannot forge a row outside the function's rules.
    await assert.rejects(
      () => restricted!.query(
        `INSERT INTO task_alert_log (task_id, kind, attempts, max_attempts,
                                     abandoned_at, error_class, severity, kind_registered)
         VALUES ($1,'safety-check',1,1,now(),'none','background',true)`, [id]),
      /permission denied/i, 'the API role must not INSERT directly');

    // No UPDATE grant: it cannot rewrite an abandonment into something milder.
    await assert.rejects(
      () => restricted!.query(
        `UPDATE task_alert_log SET severity = 'background' WHERE task_id = $1`, [id]),
      /permission denied/i, 'the API role must not rewrite the ledger');

    // No DELETE grant: it cannot erase the record that work was dropped.
    await assert.rejects(
      () => restricted!.query(`DELETE FROM task_alert_log WHERE task_id = $1`, [id]),
      /permission denied/i, 'the API role must not erase the ledger');

    const { rows } = await privileged!.query<{ severity: string }>(
      `SELECT severity FROM task_alert_log WHERE task_id = $1`, [id]);
    assert.equal(rows[0]!.severity, 'safety', 'the original record survived all three attempts');
  });
});
