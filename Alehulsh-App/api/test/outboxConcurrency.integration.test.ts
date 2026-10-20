/**
 * Outbox behaviour under real concurrency.  (audit §7)
 *
 * Every connection here is INDEPENDENT - separate pools, so claims genuinely
 * race in the database rather than being serialised by one client. Mocked
 * function calls cannot show FOR UPDATE SKIP LOCKED working.
 *
 * NO WORKER EXISTS. claim_outbox and complete_outbox have no production
 * caller; the dispatcher is unbuilt. So this suite tests the DATABASE
 * primitives a future worker will rely on, and the requirements that worker
 * must meet are recorded at the end of this file rather than asserted as if
 * they were already met.
 *
 * Delivery is AT-LEAST-ONCE and nothing here claims otherwise: a worker that
 * hands a payload to a provider and crashes before completing will claim it
 * again after the lease expires, and the provider will have sent it twice.
 * That is why the dedupe key exists and why every task handler is idempotent
 * (src/routes/tasks.ts).
 *
 * Synthetic data only.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, loadDbConfig, closePool } from '../src/db/pool.js';

/** Fixture setup and inspection. */
let admin: Pool | null = null;
/** Independent pools, so claims actually contend. */
let workers: Pool[] = [];
let available = false;
let skipReason = '';

const OWNER = randomUUID();
const RECIPIENT = randomUUID();
const SUBJECT = `obx${randomUUID().replace(/-/g, '').slice(0, 25)}`;

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
  admin = createPool(cfg, { max: 3 });
  // Four separate pools, each with its own connection.
  workers = [0, 1, 2, 3].map(() => createPool(cfg!, { max: 1 }));

  await admin.query(
    `INSERT INTO users (id, display_name) VALUES ($1,'OutboxOwner'),($2,'OutboxRecipient')
     ON CONFLICT (id) DO NOTHING`, [OWNER, RECIPIENT]);
  await admin.query(
    `INSERT INTO identity_map (firebase_uid, user_id) VALUES ($1,$2)
     ON CONFLICT (firebase_uid) DO NOTHING`, [SUBJECT, OWNER]);
  available = true;
});

after(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM outbox WHERE recipient_id = $1`, [RECIPIENT]);
  await admin.query(`DELETE FROM alerts WHERE owner_id = $1`, [OWNER]);
  // Nothing cascades to alert_history (audit §5); clean up our own.
  await admin.query(`DELETE FROM alert_history WHERE owner_id = $1`, [OWNER]);
  await admin.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[OWNER, RECIPIENT]]);
  for (const w of workers) await closePool(w);
  await closePool(admin);
});

/** A fresh alert with `n` queued notifications. Returns the alert id. */
async function seedWork(n: number, requestId: string): Promise<string> {
  await admin!.query(`DELETE FROM outbox WHERE recipient_id = $1`, [RECIPIENT]);
  await admin!.query(`DELETE FROM alerts WHERE owner_id = $1`, [OWNER]);
  const { rows } = await admin!.query<{ alert_id: string }>(
    `SELECT alert_id FROM create_alert_for_subject($1::text, $2::text)`, [SUBJECT, requestId]);
  const alertId = rows[0]!.alert_id;
  for (let i = 0; i < n; i += 1) {
    await admin!.query(
      `SELECT enqueue_outbox($1::text, $2::uuid, $3::uuid, 'fcm', '{}'::jsonb)`,
      [`obx:${alertId}:${i}`, alertId, RECIPIENT]);
  }
  return alertId;
}

/**
 * Claim, and report only the rows this suite owns.
 *
 * claim_outbox claims ANY due row, and other test files create outbox rows
 * concurrently (restrictedRole.integration.test.ts does, via
 * createAlertWithOutbox). An assertion on the raw row count therefore fails
 * intermittently under load for reasons that have nothing to do with the
 * behaviour under test - a flake this suite shipped with and that only showed
 * up once the task-queue suite added parallel load.
 *
 * Filtering here rather than deleting other suites' rows: this suite must not
 * reach into another's data. Claiming a foreign row is harmless - that suite's
 * own assertions count rows rather than inspect their claim state.
 */
async function claimMine(
  pool: Pool, worker: string, limit = 10, lease = '60 seconds',
): Promise<{ id: string; dedupe_key: string }[]> {
  const { rows } = await pool.query<{ id: string; dedupe_key: string }>(
    `SELECT id, dedupe_key FROM claim_outbox($1::text, $2::int, $3::interval)`,
    [worker, limit, lease]);
  return rows.filter((r) => r.dedupe_key.startsWith('obx:'));
}

/**
 * Expire a held lease, deterministically.
 *
 * NOT done with a negative lease: 0010 rejects that, because a claim whose
 * lease has already expired can be taken by another worker immediately and
 * run the same work twice. These tests previously used `interval '-1 seconds'`
 * as a shortcut for expiry; the clock is moved on the row instead, which also
 * keeps them free of sleeps and the races a sleep hides.
 */
async function expireLease(alertId: string): Promise<void> {
  await admin!.query(
    `UPDATE outbox SET claimed_until = now() - interval '1 second'
      WHERE alert_id = $1 AND state = 'claimed'`, [alertId]);
}

function otest(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) { t.skip(skipReason); return; }
    await fn();
  });
}

describe('concurrent claiming', () => {
  otest('four independent workers never claim the same job twice', async () => {
    const alertId = await seedWork(12, 'obx-claim-0001');

    // All four fire at once on separate connections.
    const results = await Promise.all(workers.map((w, i) => claimMine(w, `worker-${i}`)));

    const claimed = results.flat().map((x) => x.id);
    assert.equal(new Set(claimed).size, claimed.length,
      'FOR UPDATE SKIP LOCKED must give each job to exactly one worker');
    assert.equal(claimed.length, 12, 'and between them they take all the work');

    // The database agrees: no row is claimed by two workers.
    const { rows } = await admin!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox
        WHERE alert_id = $1 AND state = 'claimed' AND claimed_by IS NOT NULL`, [alertId]);
    assert.equal(rows[0]!.n, 12);
  });

  otest('a second pass claims nothing while the leases are live', async () => {
    await seedWork(4, 'obx-claim-0002');
    assert.equal((await claimMine(workers[0]!, 'worker-a')).length, 4);
    assert.equal((await claimMine(workers[1]!, 'worker-b')).length, 0,
      'held work must not be handed out again');
  });

  otest('the batch limit is a real bound — it was not, until 0009', async () => {
    // This test did not exist, which is why the defect survived from sprint 1:
    // every other claim here asks for 10 against at most 12 rows and asserts
    // the TOTAL, never the bound.
    //
    // The bug: `UPDATE ... WHERE id IN (SELECT ... LIMIT n)` has the planner
    // turn the sublink into a semi-join, and the LIMIT stops bounding the
    // update. Measured at the time: 7 due rows, limit 3, all 7 claimed. A
    // single dispatcher would take the whole backlog and hold a lease on work
    // it would not reach for minutes, while other workers idled.
    const alertId = await seedWork(7, 'obx-limit-0001');
    const claimed = await workers[0]!.query(
      `SELECT id FROM claim_outbox('bounded-worker', 3, interval '60 seconds')`);
    assert.equal(claimed.rows.length, 3, 'the limit must bound the claim');

    const { rows } = await admin!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox
        WHERE alert_id = $1 AND state = 'pending'`, [alertId]);
    assert.equal(rows[0]!.n, 4, 'and the rest must be left for other workers');
  });

  otest('each claim increments the attempt counter exactly once', async () => {
    const alertId = await seedWork(3, 'obx-claim-0003');
    await workers[0]!.query(`SELECT id FROM claim_outbox('worker-a', 10, interval '60 seconds')`);
    const { rows } = await admin!.query<{ attempts: number }>(
      `SELECT attempts FROM outbox WHERE alert_id = $1`, [alertId]);
    for (const r of rows) assert.equal(r.attempts, 1);
  });
});

describe('leases', () => {
  otest('an expired lease is reclaimable, so a dead worker does not strand work', async () => {
    const alertId = await seedWork(2, 'obx-lease-0001');
    // The worker claims, then dies and its lease runs out.
    await claimMine(workers[0]!, 'dead-worker');
    await expireLease(alertId);

    const { rows: held } = await admin!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox
        WHERE alert_id = $1 AND claimed_by = 'dead-worker'`, [alertId]);
    assert.equal(held[0]!.n, 2);

    const reclaimed = await claimMine(workers[1]!, 'live-worker');
    assert.equal(reclaimed.length, 2, 'work whose lease expired must be picked up');

    const { rows: now } = await admin!.query<{ claimed_by: string }>(
      `SELECT claimed_by FROM outbox WHERE alert_id = $1`, [alertId]);
    for (const r of now) assert.equal(r.claimed_by, 'live-worker');
  });

  otest('a stale worker cannot complete work that was reclaimed', async () => {
    // The dangerous case: the first worker was slow, not dead. It wakes up and
    // reports success for a job another worker now owns. If that succeeded,
    // the new owner's claim would be destroyed and the work could be lost.
    const alertId = await seedWork(1, 'obx-lease-0002');
    await claimMine(workers[0]!, 'slow-worker');
    await expireLease(alertId);          // the slow worker is still running
    await claimMine(workers[1]!, 'new-worker');

    const { rows: ids } = await admin!.query<{ id: string }>(
      `SELECT id FROM outbox WHERE alert_id = $1`, [alertId]);
    const jobId = ids[0]!.id;

    const stale = await workers[0]!.query<{ complete_outbox: boolean }>(
      `SELECT complete_outbox($1::bigint, 'slow-worker', true, NULL)`, [jobId]);
    assert.equal(stale.rows[0]!.complete_outbox, false,
      'the stale worker must be told it no longer owns the job');

    const { rows: after } = await admin!.query<{ state: string; claimed_by: string }>(
      `SELECT state, claimed_by FROM outbox WHERE id = $1`, [jobId]);
    assert.equal(after[0]!.state, 'claimed', 'the newer claim survives');
    assert.equal(after[0]!.claimed_by, 'new-worker');

    const owner = await workers[1]!.query<{ complete_outbox: boolean }>(
      `SELECT complete_outbox($1::bigint, 'new-worker', true, NULL)`, [jobId]);
    assert.equal(owner.rows[0]!.complete_outbox, true, 'and the real owner can finish it');
  });

  otest('completing an unclaimed job is refused', async () => {
    const alertId = await seedWork(1, 'obx-lease-0003');
    const { rows: ids } = await admin!.query<{ id: string }>(
      `SELECT id FROM outbox WHERE alert_id = $1`, [alertId]);
    const done = await workers[0]!.query<{ complete_outbox: boolean }>(
      `SELECT complete_outbox($1::bigint, 'nobody', true, NULL)`, [ids[0]!.id]);
    assert.equal(done.rows[0]!.complete_outbox, false);
  });
});

describe('retries are bounded', () => {
  otest('a job that keeps failing is abandoned, not retried forever', async () => {
    const alertId = await seedWork(1, 'obx-retry-0001');
    const { rows: ids } = await admin!.query<{ id: string; max_attempts: number }>(
      `SELECT id, max_attempts FROM outbox WHERE alert_id = $1`, [alertId]);
    const jobId = ids[0]!.id;
    const max = ids[0]!.max_attempts;

    let state = '';
    // One more round than the cap, each time clearing the backoff so the job
    // is claimable again immediately. A hot loop here is exactly what bounded
    // retries prevent in production.
    for (let i = 0; i < max + 1; i += 1) {
      await admin!.query(`UPDATE outbox SET next_retry_at = now() WHERE id = $1`, [jobId]);
      const claimed = await claimMine(workers[0]!, 'retry-worker');
      if (claimed.length === 0) break;
      await workers[0]!.query(
        `SELECT complete_outbox($1::bigint, 'retry-worker', false, 'synthetic failure')`, [jobId]);
      const { rows } = await admin!.query<{ state: string }>(
        `SELECT state FROM outbox WHERE id = $1`, [jobId]);
      state = rows[0]!.state;
      if (state === 'abandoned') break;
    }
    assert.equal(state, 'abandoned', `must stop after max_attempts (${max})`);

    // And an abandoned job is not handed out again.
    await admin!.query(`UPDATE outbox SET next_retry_at = now() WHERE id = $1`, [jobId]);
    assert.equal((await claimMine(workers[1]!, 'another-worker')).length, 0,
      'abandoned work must stay abandoned');
  });

  otest('a failure pushes the next attempt further out', async () => {
    const alertId = await seedWork(1, 'obx-retry-0002');
    const { rows: ids } = await admin!.query<{ id: string }>(
      `SELECT id FROM outbox WHERE alert_id = $1`, [alertId]);
    const jobId = ids[0]!.id;

    await workers[0]!.query(`SELECT id FROM claim_outbox('backoff-worker', 10, interval '60 seconds')`);
    await workers[0]!.query(
      `SELECT complete_outbox($1::bigint, 'backoff-worker', false, 'synthetic')`, [jobId]);

    const { rows } = await admin!.query<{ future: boolean; state: string }>(
      `SELECT next_retry_at > now() AS future, state FROM outbox WHERE id = $1`, [jobId]);
    assert.equal(rows[0]!.state, 'pending', 'it is retryable, not finished');
    assert.equal(rows[0]!.future, true, 'but not immediately — otherwise it is a hot loop');

    // It is genuinely not claimable yet.
    assert.equal((await claimMine(workers[1]!, 'eager-worker')).length, 0);
  });

  otest('the error is recorded, and the claim released', async () => {
    const alertId = await seedWork(1, 'obx-retry-0003');
    const { rows: ids } = await admin!.query<{ id: string }>(
      `SELECT id FROM outbox WHERE alert_id = $1`, [alertId]);
    await workers[0]!.query(`SELECT id FROM claim_outbox('err-worker', 10, interval '60 seconds')`);
    await workers[0]!.query(
      `SELECT complete_outbox($1::bigint, 'err-worker', false, 'provider timeout')`, [ids[0]!.id]);

    const { rows } = await admin!.query<{ last_error: string; claimed_by: string | null }>(
      `SELECT last_error, claimed_by FROM outbox WHERE id = $1`, [ids[0]!.id]);
    assert.equal(rows[0]!.last_error, 'provider timeout');
    assert.equal(rows[0]!.claimed_by, null, 'a released job must not look held');
  });
});

describe('REVIEW: the claim bound and input validation (0010)', () => {
  otest('max_attempts bounds RECLAIMS here too', async () => {
    // The task queue copied the outbox's shape, so it copied this defect:
    // reclaiming an expired lease incremented `attempts` without the claim
    // predicate ever checking max_attempts. A dispatcher that keeps dying
    // re-claimed the same notification forever and it never reached a
    // terminal state.
    const alertId = await seedWork(1, 'obx-bound-0001');
    const { rows: ids } = await admin!.query<{ id: string; max_attempts: number }>(
      `SELECT id, max_attempts FROM outbox WHERE alert_id = $1`, [alertId]);

    for (let i = 0; i < 10; i += 1) {
      await claimMine(workers[0]!, `dying-${i}`);
      await admin!.query(
        `UPDATE outbox SET claimed_until = now() - interval '1 second'
          WHERE id = $1 AND state = 'claimed'`, [ids[0]!.id]);
    }

    const { rows } = await admin!.query<{ attempts: number; state: string; last_error: string }>(
      `SELECT attempts, state, last_error FROM outbox WHERE id = $1`, [ids[0]!.id]);
    assert.ok(rows[0]!.attempts <= Number(ids[0]!.max_attempts) + 1,
      `attempts must stop at the bound, got ${rows[0]!.attempts}`);
    assert.equal(rows[0]!.state, 'abandoned');
    assert.match(String(rows[0]!.last_error), /attempts exhausted/);
    assert.equal((await claimMine(workers[1]!, 'later')).length, 0,
      'and it is never handed out again');
  });

  otest('the backoff cannot overflow', async () => {
    const alertId = await seedWork(1, 'obx-overflow-01');
    const { rows: ids } = await admin!.query<{ id: string }>(
      `SELECT id FROM outbox WHERE alert_id = $1`, [alertId]);
    for (const attempts of [40, 5000]) {
      await admin!.query(
        `UPDATE outbox SET attempts = $2, state = 'claimed', claimed_by = 'x',
                claimed_until = now() + interval '60 seconds' WHERE id = $1`,
        [ids[0]!.id, attempts]);
      await assert.doesNotReject(
        () => admin!.query(
          `SELECT complete_outbox($1::bigint, 'x', false, 'synthetic')`, [ids[0]!.id]),
        `attempts = ${attempts} must not raise`);
    }
  });

  otest('a non-positive lease, empty worker and negative limit are refused', async () => {
    const alertId = await seedWork(1, 'obx-invalid-01');
    for (const args of [
      `'w', 2, interval '0 seconds'`,
      `'w', 2, interval '-60 seconds'`,
      `'', 2, interval '60 seconds'`,
      `'w', -1, interval '60 seconds'`,
    ]) {
      await assert.rejects(
        () => admin!.query(`SELECT claim_outbox(${args})`),
        (e: unknown) => (e as { code?: string }).code === '22023', args);
    }
    // Asserting that the REFUSED worker holds nothing, rather than that the
    // row is still pending: another suite makes a VALID claim_outbox call
    // against this same table and may legitimately claim it, so its state is
    // not this test's to predict. Whether the refused call wrote anything is.
    const { rows } = await admin!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE claimed_by = 'w'`);
    assert.equal(rows[0]!.n, 0, 'a refused call must not have claimed anything');
    assert.ok(alertId);

    // Zero stays legal: bounded, and claims nothing.
    await assert.doesNotReject(
      () => admin!.query(`SELECT claim_outbox('w', 0, interval '60 seconds')`));
  });
});

describe('terminal alerts and queued work', () => {
  otest('resolving an alert abandons its pending work', async () => {
    const alertId = await seedWork(3, 'obx-term-0001');
    await admin!.query(
      `SELECT transition_alert($1::uuid, 'resolved', 'owner', NULL, 'owner')`, [alertId]);

    const { rows } = await admin!.query<{ state: string; n: number }>(
      `SELECT state, count(*)::int AS n FROM outbox WHERE alert_id = $1 GROUP BY state`, [alertId]);
    assert.deepEqual(rows, [{ state: 'abandoned', n: 3 }],
      'nobody may be sent to an emergency that is over');
  });

  otest('cancelling abandons claimed work as well as pending', async () => {
    const alertId = await seedWork(2, 'obx-term-0002');
    await workers[0]!.query(`SELECT id FROM claim_outbox('mid-flight', 10, interval '60 seconds')`);
    await admin!.query(`SELECT transition_alert($1::uuid, 'cancelled', 'owner')`, [alertId]);

    const { rows } = await admin!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox
        WHERE alert_id = $1 AND state = 'abandoned'`, [alertId]);
    assert.equal(rows[0]!.n, 2, 'work already in flight with a worker is abandoned too');
  });

  otest('abandoned work is not claimable', async () => {
    const alertId = await seedWork(2, 'obx-term-0003');
    await admin!.query(`SELECT transition_alert($1::uuid, 'expired', 'system')`, [alertId]);
    await admin!.query(`UPDATE outbox SET next_retry_at = now() WHERE alert_id = $1`, [alertId]);

    assert.equal((await claimMine(workers[0]!, 'late-worker')).length, 0);
  });

  /**
   * A GAP, pinned rather than fixed.
   *
   * enqueue_outbox does not check alert status, so work queued AFTER an alert
   * went terminal stays pending and IS claimable. transition_alert only
   * abandons what already exists when it runs.
   *
   * Not reachable through the current code: createAlertWithOutbox only ever
   * enqueues for an alert it just created or folded onto, and folding requires
   * active/escalated. But it means the database does not carry this guarantee
   * on its own, so the future worker MUST re-read alert status immediately
   * before delivery rather than trusting that a claimable job is a live one.
   * Recorded in the worker requirements at the foot of this file.
   */
  otest('work queued AFTER a terminal transition is still claimable — worker must recheck', async () => {
    const alertId = await seedWork(0, 'obx-term-0004');
    await admin!.query(
      `SELECT transition_alert($1::uuid, 'resolved', 'owner', NULL, 'owner')`, [alertId]);
    await admin!.query(
      `SELECT enqueue_outbox($1::text, $2::uuid, $3::uuid, 'fcm', '{}'::jsonb)`,
      [`obx:${alertId}:late`, alertId, RECIPIENT]);

    const claimed = await claimMine(workers[0]!, 'post-terminal');
    assert.equal(claimed.length, 1,
      'CURRENT BEHAVIOUR: the queue does not know the alert ended');

    const { rows } = await admin!.query<{ status: string }>(
      `SELECT status FROM alerts WHERE id = $1`, [alertId]);
    assert.equal(rows[0]!.status, 'resolved',
      'so a worker that trusted the claim alone would notify about a resolved alert');
  });
});

describe('idempotency of enqueue', () => {
  otest('the dedupe key folds a repeated enqueue onto one row', async () => {
    const alertId = await seedWork(0, 'obx-idem-0001');
    const key = `obx:${alertId}:dedupe`;
    const first = await admin!.query<{ enqueue_outbox: boolean }>(
      `SELECT enqueue_outbox($1::text, $2::uuid, $3::uuid, 'fcm', '{}'::jsonb)`,
      [key, alertId, RECIPIENT]);
    const again = await admin!.query<{ enqueue_outbox: boolean }>(
      `SELECT enqueue_outbox($1::text, $2::uuid, $3::uuid, 'fcm', '{}'::jsonb)`,
      [key, alertId, RECIPIENT]);

    assert.equal(first.rows[0]!.enqueue_outbox, true);
    assert.equal(again.rows[0]!.enqueue_outbox, false, 'and it reports that it added nothing');

    const { rows } = await admin!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE dedupe_key = $1`, [key]);
    assert.equal(rows[0]!.n, 1, 'one notification per logical event');
  });

  otest('concurrent enqueues of the same key produce one row', async () => {
    const alertId = await seedWork(0, 'obx-idem-0002');
    const key = `obx:${alertId}:race`;
    const results = await Promise.all(workers.map((w) =>
      w.query<{ enqueue_outbox: boolean }>(
        `SELECT enqueue_outbox($1::text, $2::uuid, $3::uuid, 'fcm', '{}'::jsonb)`,
        [key, alertId, RECIPIENT]).then((r) => r.rows[0]!.enqueue_outbox, () => null)));

    const inserted = results.filter((r) => r === true);
    assert.equal(inserted.length, 1, 'exactly one caller may insert');
    const { rows } = await admin!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE dedupe_key = $1`, [key]);
    assert.equal(rows[0]!.n, 1);
  });
});

/**
 * REQUIREMENTS FOR THE WORKER THAT DOES NOT EXIST YET.
 *
 * Derived from what this suite shows the database does and does not guarantee.
 * Written here, next to the evidence, rather than in a report nobody will read
 * again:
 *
 *  1. Re-read alert status immediately before delivery. A claimable job is not
 *     proof of a live alert - see the post-terminal test above.
 *  2. Expect at-least-once. Accepting a payload from a provider and then
 *     crashing will re-deliver after the lease expires; the recipient side must
 *     tolerate a duplicate.
 *  3. Keep the lease longer than the provider timeout, or a slow send will be
 *     reclaimed while still in flight and sent twice for no reason.
 *  4. Never treat `published` as delivered. It records that a provider
 *     ACCEPTED it. Device receipt is a separate fact - notification_attempts
 *     has delivered_requires_receipt for exactly this reason.
 *  5. Put no personal data in the payload. The queue row says who to tell about
 *     which alert; what they may see is decided at delivery against the
 *     audience rules.
 *  6. Treat `abandoned` as a page-worthy event. It means someone was not told
 *     about an emergency.
 */
