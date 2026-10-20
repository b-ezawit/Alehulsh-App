/**
 * M-07 durable task queue, against real PostgreSQL.
 *
 * Every mechanism is exercised through the real SQL functions on the real
 * table. Workers use INDEPENDENT pools so claims genuinely contend in the
 * database - a single client would serialise them and prove nothing.
 *
 * NO NOTIFICATION IS SENT and no network call is made. Where a route must be
 * exercised, `fetch` is replaced with a shim that forwards to Fastify's
 * `inject`, so the real dispatcher drives the real route through its real
 * `x-task-secret` guard, in-process. `notify-contacts` is deliberately NOT
 * routed and is asserted to fail loudly.
 *
 * Synthetic data only.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { createPool, loadDbConfig, closePool, withTransaction } from '../src/db/pool.js';
import { PostgresTaskQueue, type ClaimedTask } from '../src/queue/PostgresTaskQueue.js';
import { TaskWorker, httpTaskDispatcher, type TaskDispatcher } from '../src/queue/TaskWorker.js';
import { PostgresAlertRepository } from '../src/repositories/postgres/PostgresAlertRepository.js';
import { buildServer } from '../src/server.js';
import { createLogger } from '../src/logger.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';
import { makeDeps, ACTIVE_WINDOW } from './fakes.js';

const logger = createLogger('error');

let admin: Pool | null = null;
let pools: Pool[] = [];
let available = false;
let skipReason = '';

const OWNER_UUID = randomUUID();
const SUBJECT = `tq${randomUUID().replace(/-/g, '').slice(0, 26)}`;

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
  pools = [0, 1, 2].map(() => createPool(cfg!, { max: 1 }));
  await admin.query(
    `INSERT INTO users (id, display_name) VALUES ($1,'TaskQueueOwner')
     ON CONFLICT (id) DO NOTHING`, [OWNER_UUID]);
  await admin.query(
    `INSERT INTO identity_map (firebase_uid, user_id) VALUES ($1,$2)
     ON CONFLICT (firebase_uid) DO NOTHING`, [SUBJECT, OWNER_UUID]);
  available = true;
});

after(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM task_queue WHERE task_key LIKE 'tq-%'`);
  await admin.query(`DELETE FROM outbox WHERE dedupe_key LIKE 'tq-%'`);
  await admin.query(`DELETE FROM alerts WHERE owner_id = $1`, [OWNER_UUID]);
  // Nothing cascades to alert_history; clean up our own.
  await admin.query(`DELETE FROM alert_history WHERE owner_id = $1`, [OWNER_UUID]);
  await admin.query(`DELETE FROM users WHERE id = $1`, [OWNER_UUID]);
  for (const p of pools) await closePool(p);
  await closePool(admin);
});


/**
 * Serialise against the other suite that claims from task_queue.
 *
 * `claim_tasks` claims ANY due row, so two suites polling the same table in
 * parallel processes steal each other's work and complete it under the wrong
 * worker id. Filtering results is not enough - the claim itself is the
 * interference.
 *
 * A session advisory lock on a shared key makes the two take turns. Both
 * taskQueue.integration and worker.integration use key 918271354; neither reaches
 * into the other's data, and neither has to know the other exists beyond this
 * number.
 */
const QUEUE_SUITE_LOCK = 918_271_354;

async function withQueueLock<T>(pool: Pool, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [QUEUE_SUITE_LOCK]);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [QUEUE_SUITE_LOCK]);
    }
  } finally {
    client.release();
  }
}

function qtest(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) { t.skip(skipReason); return; }
    // Scoped to this suite's keys. An earlier version truncated and asserted
    // the table started empty; that assumption was wrong and the guard caught
    // it - restrictedRole.integration.test.ts legitimately writes to
    // task_queue too (it asserts the API role may enqueue), and runs in a
    // parallel process against the same database.
    //
    // So this suite OWNS a key prefix and never assumes exclusivity. Claims
    // are filtered through claimMine for the same reason: claim_tasks claims
    // any due task, and a foreign row must not land inside an assertion about
    // this suite's behaviour.
    // Serialised against worker.integration, which also claims from this
    // table. Taken BEFORE the cleanup, so the other suite cannot schedule
    // between our delete and our first claim.
    await withQueueLock(admin!, async () => {
      await admin!.query(`DELETE FROM task_queue WHERE task_key LIKE 'tq-%'`);
      // Alerts are committed by the transaction tests, and one-live-alert-per-
      // owner would make the next create fold onto a leftover instead of
      // creating. Nothing cascades to alert_history, so that goes too.
      await admin!.query(`DELETE FROM alerts WHERE owner_id = $1`, [OWNER_UUID]);
      await admin!.query(`DELETE FROM alert_history WHERE owner_id = $1`, [OWNER_UUID]);
      await fn();
    });
  });
}

const queueOn = (p: Pool) => new PostgresTaskQueue(p);

/** Claim, reporting only the tasks this suite owns. See the note in qtest. */
async function claimMine(
  q: PostgresTaskQueue, worker: string, limit = 10, leaseMs = 60_000,
): Promise<ClaimedTask[]> {
  const claimed = await q.claim(worker, limit, leaseMs);
  return claimed.filter((t) => t.taskKey.startsWith('tq-'));
}
const due = (msAgo = 1000) => new Date(Date.now() - msAgo);

/**
 * Expire a held lease, deterministically.
 *
 * NOT done by passing a negative leaseMs: `claim` clamps the lease to at least
 * one second, which is correct - a negative lease is nonsense and production
 * must not be able to create one. So the clock is moved on the row instead,
 * which also keeps these tests free of sleeps and the races a sleep hides.
 */
async function expireLease(key: string): Promise<void> {
  await admin!.query(
    `UPDATE task_queue SET claimed_until = now() - interval '1 second'
      WHERE task_key = $1 AND state = 'claimed'`, [key]);
}

/** Counts a task's state directly, bypassing the queue's own mapping. */
async function stateOf(key: string): Promise<string | null> {
  const { rows } = await admin!.query<{ state: string }>(
    `SELECT state FROM task_queue WHERE task_key = $1`, [key]);
  return rows[0]?.state ?? null;
}

describe('1. enqueue and durable persistence', () => {
  qtest('a scheduled task is a row, not a process memory entry', async () => {
    await queueOn(admin!).schedule({
      key: 'tq-persist-1', runAt: due(), payload: { kind: 'safety-check', alertId: 'a1' },
    });
    const { rows } = await admin!.query<{
      task_key: string; kind: string; state: string; payload: Record<string, unknown>;
    }>(`SELECT task_key, kind, state, payload FROM task_queue WHERE task_key = $1`,
      ['tq-persist-1']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, 'safety-check', 'kind is denormalised for logging');
    assert.equal(rows[0]!.state, 'pending');
    assert.deepEqual(rows[0]!.payload, { kind: 'safety-check', alertId: 'a1' });
  });

  qtest('a task with no kind in its payload is stored, not refused', async () => {
    // Losing a safety check over a metadata field would be the wrong trade.
    await queueOn(admin!).schedule({
      key: 'tq-nokind-1', runAt: due(), payload: { alertId: 'a1' },
    });
    const { rows } = await admin!.query<{ kind: string }>(
      `SELECT kind FROM task_queue WHERE task_key = $1`, ['tq-nokind-1']);
    assert.equal(rows[0]!.kind, 'unknown');
  });

  qtest('a future task is persisted but not yet claimable', async () => {
    const q = queueOn(admin!);
    await q.schedule({
      key: 'tq-future-1', runAt: new Date(Date.now() + 60_000),
      payload: { kind: 'safety-check', alertId: 'a1' },
    });
    assert.equal(await stateOf('tq-future-1'), 'pending');
    assert.deepEqual((await claimMine(q, 'w')).map((t) => t.taskKey), [],
      'scheduled delivery is the point — it must not fire early');
  });

  qtest('cancel removes it from eligibility', async () => {
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-cancel-1', runAt: due(), payload: { kind: 'safety-check' } });
    await q.cancel('tq-cancel-1');
    assert.equal(await stateOf('tq-cancel-1'), 'cancelled');
    assert.equal((await claimMine(q, 'w')).length, 0);
  });

  qtest('cancelling something already gone is silent, not an error', async () => {
    // A resolve arriving after the check already ran is normal.
    await assert.doesNotReject(() => queueOn(admin!).cancel('tq-never-existed'));
  });
});

describe('2. recovery after a process restart', () => {
  qtest('a task survives the process that scheduled it', async () => {
    // "Restart" = a brand new queue instance on a new connection. The point is
    // that nothing was held in the first instance.
    await queueOn(admin!).schedule({
      key: 'tq-restart-1', runAt: due(), payload: { kind: 'safety-check', alertId: 'a1' },
    });

    const claimed = await claimMine(queueOn(pools[0]!), 'worker-after-restart');
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.taskKey, 'tq-restart-1');
  });

  qtest('work a crashed worker was holding comes back after its lease', async () => {
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-crash-1', runAt: due(), payload: { kind: 'expiry', alertId: 'a1' } });

    // The worker claims, then dies mid-task and its lease runs out.
    const dead = await claimMine(q, 'dead-worker');
    assert.equal(dead.length, 1);
    assert.equal(await stateOf('tq-crash-1'), 'claimed');
    await expireLease('tq-crash-1');

    const live = await claimMine(queueOn(pools[1]!), 'live-worker');
    assert.equal(live.length, 1, 'a dead worker must not strand the task forever');
    const { rows } = await admin!.query<{ claimed_by: string; attempts: number }>(
      `SELECT claimed_by, attempts FROM task_queue WHERE task_key = $1`, ['tq-crash-1']);
    assert.equal(rows[0]!.claimed_by, 'live-worker');
    assert.equal(Number(rows[0]!.attempts), 2, 'the reclaim counts as an attempt');
  });
});

describe('3 & 4. concurrency — independent connections', () => {
  qtest('three workers racing never claim the same task twice', async () => {
    const q = queueOn(admin!);
    for (let i = 0; i < 9; i += 1) {
      await q.schedule({
        key: `tq-race-${i}`, runAt: due(), payload: { kind: 'safety-check', alertId: `a${i}` },
      });
    }
    const results = await Promise.all(
      pools.map((p, i) => claimMine(queueOn(p), `racer-${i}`, 9)));

    const claimed = results.flat();
    assert.ok(claimed.every((t) => t.taskKey.startsWith('tq-race-')),
      'only this test\'s tasks may appear');
    const ids = claimed.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length,
      'FOR UPDATE SKIP LOCKED must give each task to exactly one worker');
    assert.equal(ids.length, 9, 'and between them they take all the work');
  });

  qtest('held leases are not handed out again', async () => {
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-held-1', runAt: due(), payload: { kind: 'expiry' } });
    assert.equal((await claimMine(queueOn(pools[0]!), 'first')).length, 1);
    assert.equal((await claimMine(queueOn(pools[1]!), 'second')).length, 0);
  });

  qtest('the batch size is a real bound', async () => {
    const q = queueOn(admin!);
    for (let i = 0; i < 7; i += 1) {
      await q.schedule({ key: `tq-batch-${i}`, runAt: due(), payload: { kind: 'expiry' } });
    }
    // The RAW length, deliberately. The limit is enforced by SQL regardless
    // of whose rows are due, so filtering by ownership here would turn a
    // foreign row into a false failure while testing nothing extra. Seven of
    // this suite's tasks are due, so a correct limit can only return 3.
    const claimed = await q.claim('bounded', 3, 60_000);
    assert.equal(claimed.length, 3, 'the limit is a real bound');
    assert.ok(claimed.some((t) => t.taskKey.startsWith('tq-batch-')),
      'and it claimed this suite\'s work');
  });
});

describe('5. a stale worker cannot complete reclaimed work', () => {
  qtest('the slow worker is told it no longer owns the task', async () => {
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-stale-1', runAt: due(), payload: { kind: 'safety-check' } });

    const slow = await claimMine(queueOn(pools[0]!), 'slow-worker');
    await expireLease('tq-stale-1');   // the slow worker is still running
    const taken = await claimMine(queueOn(pools[1]!), 'new-worker');
    assert.equal(slow.length, 1);
    assert.equal(taken.length, 1);

    const stale = await queueOn(pools[0]!).complete(slow[0]!.id, 'slow-worker', true);
    assert.equal(stale, false, 'its result must be discarded, not applied');
    assert.equal(await stateOf('tq-stale-1'), 'claimed', 'the newer claim survives');

    const owner = await queueOn(pools[1]!).complete(taken[0]!.id, 'new-worker', true);
    assert.equal(owner, true, 'and the real owner can finish it');
    assert.equal(await stateOf('tq-stale-1'), 'done');
  });

  qtest('completing a task nobody claimed is refused', async () => {
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-unclaimed-1', runAt: due(), payload: { kind: 'expiry' } });
    const { rows } = await admin!.query<{ id: string }>(
      `SELECT id FROM task_queue WHERE task_key = $1`, ['tq-unclaimed-1']);
    assert.equal(await q.complete(rows[0]!.id, 'nobody', true), false);
  });

  qtest('a cancelled task cannot be completed by its holder', async () => {
    // Two independent reasons the notification cannot happen: the state guard
    // here, and the handler re-reading the alert.
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-cancelrace-1', runAt: due(), payload: { kind: 'safety-check' } });
    const claimed = await claimMine(q, 'holder');
    await q.cancel('tq-cancelrace-1');

    assert.equal(await q.complete(claimed[0]!.id, 'holder', true), false);
    assert.equal(await stateOf('tq-cancelrace-1'), 'cancelled');
  });
});

describe('6 & 7. retries are bounded', () => {
  qtest('a failure backs off instead of spinning', async () => {
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-backoff-1', runAt: due(), payload: { kind: 'expiry' } });
    const claimed = await claimMine(q, 'backoff-worker');
    assert.equal(await q.complete(claimed[0]!.id, 'backoff-worker', false, 'synthetic'), true);

    const { rows } = await admin!.query<{ state: string; future: boolean; last_error: string }>(
      `SELECT state, run_at > now() AS future, last_error
         FROM task_queue WHERE task_key = $1`, ['tq-backoff-1']);
    assert.equal(rows[0]!.state, 'pending', 'retryable, not finished');
    assert.equal(rows[0]!.future, true, 'but not immediately — otherwise a hot loop');
    assert.equal(rows[0]!.last_error, 'synthetic');

    assert.equal((await claimMine(q, 'eager')).length, 0, 'and not yet claimable');
  });

  qtest('it is abandoned at max_attempts, and stays abandoned', async () => {
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-exhaust-1', runAt: due(), payload: { kind: 'expiry' } });
    const { rows: m } = await admin!.query<{ max_attempts: number }>(
      `SELECT max_attempts FROM task_queue WHERE task_key = $1`, ['tq-exhaust-1']);
    const max = Number(m[0]!.max_attempts);

    for (let i = 0; i < max + 2; i += 1) {
      // Clear the backoff so the loop can proceed; in production the backoff
      // is what prevents exactly this tightness.
      await admin!.query(
        `UPDATE task_queue SET run_at = now() WHERE task_key = $1 AND state = 'pending'`,
        ['tq-exhaust-1']);
      const claimed = await claimMine(q, 'doomed');
      if (claimed.length === 0) break;
      await q.complete(claimed[0]!.id, 'doomed', false, 'still broken');
    }
    assert.equal(await stateOf('tq-exhaust-1'), 'abandoned',
      `must stop after max_attempts (${max})`);

    await admin!.query(`UPDATE task_queue SET run_at = now() WHERE task_key = $1`, ['tq-exhaust-1']);
    assert.equal((await claimMine(q, 'another')).length, 0,
      'abandoned work must not be picked up again');
  });

  qtest('an abandoned task records when it ended', async () => {
    const { rows } = await admin!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM task_queue
        WHERE task_key LIKE 'tq-%'
          AND state IN ('done','abandoned','cancelled') AND completed_at IS NULL`);
    assert.equal(rows[0]!.n, 0, 'task_terminal_has_time must hold for every row');
  });
});

describe('REVIEW: the claim bound, the backoff, and input validation', () => {
  qtest('max_attempts bounds RECLAIMS, not just reported failures', async () => {
    // The defect: reclaiming an expired lease incremented `attempts` but the
    // claim predicate never looked at max_attempts, so a task whose worker
    // dies before reporting was re-claimed forever. Measured before the fix:
    // 12 reclaims against max_attempts = 5, still 'claimed'. A reliably
    // crashing handler became a permanent hot loop that never reached a
    // terminal state anyone could alert on.
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-bound-1', runAt: due(), payload: { kind: 'expiry' } });

    for (let i = 0; i < 10; i += 1) {
      await claimMine(q, `dying-worker-${i}`);
      await expireLease('tq-bound-1');   // the worker died without reporting
    }

    const { rows } = await admin!.query<{ attempts: number; state: string }>(
      `SELECT attempts, max_attempts, state FROM task_queue WHERE task_key = $1`, ['tq-bound-1']);
    assert.ok(rows[0]!.attempts <= 5 + 1, `attempts must stop at the bound, got ${rows[0]!.attempts}`);
    assert.equal(rows[0]!.state, 'abandoned',
      'exhausted work is retired to a visible terminal state, not silently excluded');
    assert.equal((await claimMine(q, 'later')).length, 0, 'and never handed out again');
  });

  qtest('an abandoned-by-reclaim task records why', async () => {
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-bound-2', runAt: due(), payload: { kind: 'expiry' } });
    for (let i = 0; i < 8; i += 1) {
      await claimMine(q, `w${i}`);
      await expireLease('tq-bound-2');
    }
    const { rows } = await admin!.query<{ last_error: string; completed_at: Date | null }>(
      `SELECT last_error, completed_at FROM task_queue WHERE task_key = $1`, ['tq-bound-2']);
    assert.match(String(rows[0]!.last_error), /attempts exhausted/);
    assert.notEqual(rows[0]!.completed_at, null, 'a terminal row carries when it ended');
  });

  qtest('the backoff cannot overflow, however high the attempt count', async () => {
    // `interval '10 seconds' * power(2, attempts)` raises 22008 from roughly
    // attempts = 40, and unbounded reclaim made that reachable. Once reached,
    // every failure report raised inside complete_task — and TaskWorker
    // rethrows a completion failure, so one poisoned row aborted the batch.
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-overflow-1', runAt: due(), payload: { kind: 'expiry' } });
    const { rows: ids } = await admin!.query<{ id: string }>(
      `SELECT id FROM task_queue WHERE task_key = $1`, ['tq-overflow-1']);

    for (const attempts of [40, 1024, 5000]) {
      await admin!.query(
        `UPDATE task_queue SET attempts = $2, state = 'claimed', claimed_by = 'x',
                claimed_until = now() + interval '60 seconds', completed_at = NULL
          WHERE task_key = $1`, ['tq-overflow-1', attempts]);
      await assert.doesNotReject(
        () => q.complete(ids[0]!.id, 'x', false, 'synthetic'),
        `attempts = ${attempts} must not raise`);
    }
  });

  qtest('a non-positive lease is refused, not silently honoured', async () => {
    // Measured before the fix: a zero or negative lease claimed rows whose
    // lease had already expired, so another worker could take them
    // immediately and run the same task concurrently.
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-lease-bad-1', runAt: due(), payload: { kind: 'expiry' } });
    for (const lease of ['0 seconds', '-60 seconds']) {
      await assert.rejects(
        () => admin!.query(`SELECT claim_tasks('w', 2, $1::interval)`, [lease]),
        (e: unknown) => (e as { code?: string }).code === '22023',
        `lease '${lease}' must be refused`);
    }
    assert.equal(await stateOf('tq-lease-bad-1'), 'pending', 'and nothing was claimed');
  });

  qtest('an empty worker identity and a negative limit are refused', async () => {
    for (const [args, why] of [
      [`'', 2, interval '60 seconds'`, 'empty worker'],
      [`'   ', 2, interval '60 seconds'`, 'whitespace worker'],
      [`'w', -1, interval '60 seconds'`, 'negative limit'],
    ] as [string, string][]) {
      await assert.rejects(
        () => admin!.query(`SELECT claim_tasks(${args})`),
        (e: unknown) => (e as { code?: string }).code === '22023', why);
    }
    // Zero stays legal: bounded, claims nothing, and is how the
    // restricted-role suite proves EXECUTE without competing for rows.
    await assert.doesNotReject(
      () => admin!.query(`SELECT claim_tasks('w', 0, interval '60 seconds')`));
  });

  qtest('the TypeScript wrapper cannot produce an invalid lease', async () => {
    // claim() clamps to at least a second, so the SQL guard is never reached
    // from this path - both layers hold.
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-lease-clamp-1', runAt: due(), payload: { kind: 'expiry' } });
    await assert.doesNotReject(() => q.claim('clamped', 5, -99_999));
    const { rows } = await admin!.query<{ future: boolean }>(
      `SELECT claimed_until > now() AS future FROM task_queue WHERE task_key = $1`,
      ['tq-lease-clamp-1']);
    assert.equal(rows[0]!.future, true, 'the clamped lease is in the future');
  });
});

describe('8. idempotent enqueue', () => {
  qtest('the same key twice is one row', async () => {
    const q = queueOn(admin!);
    const task = { key: 'tq-idem-1', runAt: due(), payload: { kind: 'safety-check', alertId: 'a1' } };
    await q.schedule(task);
    await q.schedule(task);
    const { rows } = await admin!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM task_queue WHERE task_key = $1`, ['tq-idem-1']);
    assert.equal(rows[0]!.n, 1);
  });

  qtest('a retry must NOT postpone the task', async () => {
    // The safety property: if re-triggering an SOS pushed the safety check
    // back, someone under coercion could be kept from escalating indefinitely
    // by tapping the button again.
    const q = queueOn(admin!);
    const first = new Date(Date.now() + 10_000);
    await q.schedule({ key: 'tq-nopush-1', runAt: first, payload: { kind: 'safety-check' } });
    await q.schedule({
      key: 'tq-nopush-1', runAt: new Date(Date.now() + 3_600_000), payload: { kind: 'safety-check' },
    });
    const { rows } = await admin!.query<{ run_at: Date }>(
      `SELECT run_at FROM task_queue WHERE task_key = $1`, ['tq-nopush-1']);
    assert.ok(Math.abs(rows[0]!.run_at.getTime() - first.getTime()) < 1000,
      'run_at must be the ORIGINAL schedule, not the later one');
  });

  qtest('concurrent schedules of one key produce one row', async () => {
    const task = { key: 'tq-idemrace-1', runAt: due(), payload: { kind: 'expiry' } };
    await Promise.all(pools.map((p) => queueOn(p).schedule(task).catch(() => null)));
    const { rows } = await admin!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM task_queue WHERE task_key = $1`, ['tq-idemrace-1']);
    assert.equal(rows[0]!.n, 1);
  });
});

describe('9. storage failure is loud, never a silent fallback', () => {
  qtest('scheduling against a dead database throws', async () => {
    const dead = createPool(
      { host: '127.0.0.1', port: 1, database: 'x', user: 'x', password: 'x' },
      { connectionTimeoutMillis: 500 });
    try {
      await assert.rejects(() => queueOn(dead).schedule({
        key: 'tq-dead-1', runAt: due(), payload: { kind: 'safety-check' },
      }), 'a queue that cannot persist must not report success');
    } finally {
      await closePool(dead);
    }
  });

  qtest('a worker whose claim fails surfaces the error rather than idling', async () => {
    const dead = createPool(
      { host: '127.0.0.1', port: 1, database: 'x', user: 'x', password: 'x' },
      { connectionTimeoutMillis: 500 });
    const worker = new TaskWorker(queueOn(dead), async () => {}, logger, { worker: 'w' });
    try {
      await assert.rejects(() => worker.runOnce(),
        'an unreachable queue must not look like an empty queue');
    } finally {
      await closePool(dead);
    }
  });

  qtest('a failure recording an outcome is reported, not swallowed', async () => {
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-recfail-1', runAt: due(), payload: { kind: 'expiry' } });
    // A queue whose complete() always fails.
    const broken = Object.create(q) as PostgresTaskQueue;
    Object.defineProperty(broken, 'complete', {
      value: async () => { throw new Error('connection lost'); },
    });
    const worker = new TaskWorker(broken, async () => {}, logger, { worker: 'w' });
    await assert.rejects(() => worker.runOnce(), /connection lost/);
  });
});

describe('10. graceful shutdown', () => {
  qtest('a stopped worker claims nothing new', async () => {
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-stop-1', runAt: due(), payload: { kind: 'expiry' } });
    const worker = new TaskWorker(q, async () => {}, logger, { worker: 'stopper' });

    await worker.stop();
    const result = await worker.runOnce();
    assert.deepEqual(result, { claimed: 0, succeeded: 0, failed: 0, lost: 0 });
    assert.equal(await stateOf('tq-stop-1'), 'pending', 'the task is left for another worker');
  });

  qtest('stop waits for the pass already running', async () => {
    const q = queueOn(admin!);
    for (let i = 0; i < 3; i += 1) {
      await q.schedule({ key: `tq-drain-${i}`, runAt: due(), payload: { kind: 'expiry' } });
    }
    let finished = 0;
    const slow: TaskDispatcher = async () => {
      await new Promise((r) => setTimeout(r, 40));
      finished += 1;
    };
    const worker = new TaskWorker(q, slow, logger, { worker: 'drainer', concurrency: 1 });

    const pass = worker.runOnce();
    await new Promise((r) => setTimeout(r, 10));
    await worker.stop();
    await pass;

    assert.equal(finished, 3, 'in-flight work must be allowed to finish');
    assert.equal(worker.isStopping, true);
  });

  qtest('leases are left to expire rather than force-released', async () => {
    // Releasing a lease early could hand the task to another worker while this
    // one is still mid-dispatch.
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-lease-keep-1', runAt: due(), payload: { kind: 'expiry' } });
    const claimed = await claimMine(q, 'holder');
    assert.equal(claimed.length, 1);
    const worker = new TaskWorker(q, async () => {}, logger, { worker: 'holder' });
    await worker.stop();
    assert.equal(await stateOf('tq-lease-keep-1'), 'claimed',
      'the lease is still held; it expires on its own');
  });
});

describe('11 & 15. the real task routes, through the real dispatcher', () => {
  /**
   * A `fetch` that forwards to Fastify's inject.
   *
   * This runs the REAL httpTaskDispatcher against the REAL route and its real
   * `x-task-secret` guard, in-process. No socket is opened and no notification
   * provider exists to be called.
   */
  function injectFetch(app: FastifyInstance): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await app.inject({
        method: 'POST',
        url: new URL(String(url)).pathname,
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string,
      });
      return { ok: res.statusCode < 400, status: res.statusCode } as Response;
    }) as unknown as typeof fetch;
  }

  async function harness() {
    const deps = makeDeps({ logger });
    const app = buildServer(deps);
    const dispatch = httpTaskDispatcher({
      baseUrl: 'http://queue.invalid',
      secret: deps.config.taskRunnerSecret,
      fetchImpl: injectFetch(app),
    });
    return { app, deps, dispatch };
  }

  qtest('a safety check on a live alert escalates it', async () => {
    const { app, deps, dispatch } = await harness();
    try {
      const { alert } = await deps.alerts.create({
        requestId: 'tq-route-0001', ownerId: 'route-owner', latitude: null, longitude: null,
      });
      await dispatch({
        id: '1', taskKey: 'k', kind: 'safety-check',
        payload: { kind: 'safety-check', alertId: alert.id },
        runAt: new Date(), attempts: 1, maxAttempts: 5,
      });
      assert.equal((await deps.alerts.findById(alert.id))?.status, 'escalated');
    } finally { await app.close(); }
  });

  qtest('a TERMINAL alert is left alone — no notification work happens', async () => {
    const { app, deps, dispatch } = await harness();
    try {
      const { alert } = await deps.alerts.create({
        requestId: 'tq-route-0002', ownerId: 'route-owner-2', latitude: null, longitude: null,
      });
      await deps.alerts.updateStatus(alert.id, 'resolved', { resolvedBy: 'owner' });

      // The task was queued BEFORE she resolved and is delivered after.
      await dispatch({
        id: '2', taskKey: 'k2', kind: 'safety-check',
        payload: { kind: 'safety-check', alertId: alert.id },
        runAt: new Date(), attempts: 1, maxAttempts: 5,
      });

      const after = await deps.alerts.findById(alert.id);
      assert.equal(after?.status, 'resolved',
        'a redelivery after she resolved must not drag her back into escalation');
      assert.equal(after?.escalatedAt, undefined);
    } finally { await app.close(); }
  });

  qtest('a missing alert is handled, not retried forever', async () => {
    const { app, dispatch } = await harness();
    try {
      // The handler returns handled:false with 200, so the task completes.
      await assert.doesNotReject(() => dispatch({
        id: '3', taskKey: 'k3', kind: 'safety-check',
        payload: { kind: 'safety-check', alertId: 'no-such-alert' },
        runAt: new Date(), attempts: 1, maxAttempts: 5,
      }));
    } finally { await app.close(); }
  });

  qtest('the route guard still applies — a wrong secret is refused', async () => {
    const { app } = await harness();
    try {
      const bad = httpTaskDispatcher({
        baseUrl: 'http://queue.invalid', secret: 'not-the-secret',
        fetchImpl: injectFetch(app),
      });
      await assert.rejects(() => bad({
        id: '4', taskKey: 'k4', kind: 'safety-check',
        payload: { kind: 'safety-check', alertId: 'a' },
        runAt: new Date(), attempts: 1, maxAttempts: 5,
      }), /returned 401/, 'the worker must not be able to bypass the guard');
    } finally { await app.close(); }
  });

  qtest('notify-contacts is NOT routed, and fails loudly', async () => {
    // Activating notification delivery is out of scope. An unroutable kind
    // must fail visibly rather than be silently dropped or quietly handled.
    const { app, dispatch } = await harness();
    try {
      await assert.rejects(() => dispatch({
        id: '5', taskKey: 'k5', kind: 'notify-contacts',
        payload: { kind: 'notify-contacts', alertId: 'a', reason: 'no_answer' },
        runAt: new Date(), attempts: 1, maxAttempts: 5,
      }), /no handler registered for task kind 'notify-contacts'/);
    } finally { await app.close(); }
  });

  qtest('REVIEW: a redirect is refused rather than followed', async () => {
    // Verified leak before the fix: fetch follows redirects and forwards
    // custom headers across origins, so a redirect from the task route sent
    // `x-task-secret` to the target. Measured against two local servers — the
    // secret arrived at both.
    const { app } = await harness();
    try {
      let secretsSeen = 0;
      const redirecting = (async (_url: string | URL, init?: RequestInit) => {
        if ((init?.headers as Record<string, string>)['x-task-secret']) secretsSeen += 1;
        // A real fetch with redirect:'error' rejects; emulate that contract.
        throw new TypeError('unexpected redirect');
      }) as unknown as typeof fetch;

      const d = httpTaskDispatcher({
        baseUrl: 'http://queue.invalid', secret: 'SENTINEL', fetchImpl: redirecting,
      });
      await assert.rejects(() => d({
        id: '1', taskKey: 'k', kind: 'expiry', payload: { alertId: 'a' },
        runAt: new Date(), attempts: 1, maxAttempts: 5,
      }), /redirect/);
      assert.equal(secretsSeen, 1, 'the secret goes to the configured origin and nowhere else');
    } finally { await app.close(); }
  });

  qtest('REVIEW: a bad baseUrl fails at construction, not on the first alert', async () => {
    for (const bad of ['not-a-url', 'file:///etc/passwd', 'ftp://host/x', 'gopher://x']) {
      assert.throws(() => httpTaskDispatcher({ baseUrl: bad, secret: 's' }),
        `baseUrl '${bad}' must be refused`);
    }
    // Credentials in a URL end up in logs and process listings.
    assert.throws(
      () => httpTaskDispatcher({ baseUrl: 'http://user:pw@host', secret: 's' }),
      /must not embed credentials/);
    assert.doesNotThrow(
      () => httpTaskDispatcher({ baseUrl: 'https://api.internal:8443', secret: 's' }));
  });

  qtest('a task with no alertId fails rather than calling the route', async () => {
    const { app, dispatch } = await harness();
    try {
      await assert.rejects(() => dispatch({
        id: '6', taskKey: 'k6', kind: 'expiry', payload: { kind: 'expiry' },
        runAt: new Date(), attempts: 1, maxAttempts: 5,
      }), /carries no alertId/);
    } finally { await app.close(); }
  });
});

describe('12. transaction consistency with the alert', () => {
  qtest('an alert and its scheduled task commit together', async () => {
    const repo = new PostgresAlertRepository(admin!, ACTIVE_WINDOW);
    const created = await withTransaction(admin!, async (tx) => {
      const { alert } = await repo.withQueryable(tx).create({
        requestId: 'tq-txn-0001', ownerId: SUBJECT, latitude: null, longitude: null,
      });
      await new PostgresTaskQueue(tx).schedule({
        key: `tq-txn-task-${alert.id}`, runAt: due(),
        payload: { kind: 'safety-check', alertId: alert.id },
      });
      return alert;
    });
    assert.notEqual(await repo.findById(created.id), null);
    assert.equal(await stateOf(`tq-txn-task-${created.id}`), 'pending');
  });

  qtest('a rollback leaves neither the alert nor the task', async () => {
    // The failure this prevents: a scheduled safety check for an alert that
    // does not exist, or an alert whose check was never scheduled.
    const repo = new PostgresAlertRepository(admin!, ACTIVE_WINDOW);
    const boom = new Error('synthetic');
    let taskKey = '';
    await assert.rejects(() => withTransaction(admin!, async (tx) => {
      const { alert } = await repo.withQueryable(tx).create({
        requestId: 'tq-txn-0002', ownerId: SUBJECT, latitude: null, longitude: null,
      });
      taskKey = `tq-txn-task-${alert.id}`;
      await new PostgresTaskQueue(tx).schedule({
        key: taskKey, runAt: due(), payload: { kind: 'safety-check', alertId: alert.id },
      });
      throw boom;
    }), (e: unknown) => e === boom);

    const { rows } = await admin!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alerts WHERE request_id = $1`, ['tq-txn-0002']);
    assert.equal(rows[0]!.n, 0, 'no alert');
    assert.equal(await stateOf(taskKey), null, 'and no task scheduled for it');
  });

  qtest('the queue never ends a transaction it does not own', async () => {
    await assert.rejects(() => withTransaction(admin!, async (tx) => {
      const q = new PostgresTaskQueue(tx);
      await q.schedule({ key: 'tq-txn-own-1', runAt: due(), payload: { kind: 'expiry' } });
      await q.cancel('tq-txn-own-1');
      throw new Error('abandon');
    }));
    assert.equal(await stateOf('tq-txn-own-1'), null, 'both statements rolled back together');
  });
});

describe('the worker end to end, with a fake executor', () => {
  qtest('a full pass claims, runs and records every task', async () => {
    const q = queueOn(admin!);
    for (let i = 0; i < 5; i += 1) {
      await q.schedule({
        key: `tq-e2e-${i}`, runAt: due(), payload: { kind: 'expiry', alertId: `a${i}` },
      });
    }
    const seen: string[] = [];
    const worker = new TaskWorker(q, async (t) => { seen.push(t.taskKey); }, logger,
      { worker: 'e2e', batchSize: 10, concurrency: 2 });

    const result = await worker.runOnce();
    assert.deepEqual(result, { claimed: 5, succeeded: 5, failed: 0, lost: 0 });
    assert.equal(seen.length, 5);
    for (let i = 0; i < 5; i += 1) assert.equal(await stateOf(`tq-e2e-${i}`), 'done');
  });

  qtest('one failing task does not abandon the rest of the batch', async () => {
    const q = queueOn(admin!);
    for (const k of ['ok-1', 'bad', 'ok-2']) {
      await q.schedule({ key: `tq-mixed-${k}`, runAt: due(), payload: { kind: 'expiry' } });
    }
    const worker = new TaskWorker(q, async (t) => {
      if (t.taskKey.includes('bad')) throw new Error('synthetic failure');
    }, logger, { worker: 'mixed', concurrency: 1 });

    const result = await worker.runOnce();
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 1);
    assert.equal(await stateOf('tq-mixed-ok-1'), 'done');
    assert.equal(await stateOf('tq-mixed-ok-2'), 'done');
    assert.equal(await stateOf('tq-mixed-bad'), 'pending', 'the failure is retryable');
  });

  qtest('an empty queue is one cheap pass, not an error', async () => {
    const worker = new TaskWorker(queueOn(admin!), async () => {}, logger, { worker: 'idle' });
    assert.deepEqual(await worker.runOnce(),
      { claimed: 0, succeeded: 0, failed: 0, lost: 0 });
  });

  qtest('concurrency is bounded', async () => {
    const q = queueOn(admin!);
    for (let i = 0; i < 6; i += 1) {
      await q.schedule({ key: `tq-conc-${i}`, runAt: due(), payload: { kind: 'expiry' } });
    }
    let active = 0;
    let peak = 0;
    const worker = new TaskWorker(q, async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
    }, logger, { worker: 'bounded', batchSize: 6, concurrency: 2 });

    await worker.runOnce();
    assert.ok(peak <= 2, `at most 2 in flight, saw ${peak}`);
  });

  qtest('work lost to an expired lease is counted, not reported as success', async () => {
    const q = queueOn(admin!);
    await q.schedule({ key: 'tq-lost-1', runAt: due(), payload: { kind: 'expiry' } });
    const worker = new TaskWorker(q, async () => {
      // This dispatch is slow; its lease runs out and another worker takes
      // the task while it is still in flight.
      await expireLease('tq-lost-1');
      await queueOn(pools[0]!).claim('thief', 10, 60_000);
    }, logger, { worker: 'victim' });

    const result = await worker.runOnce();
    assert.equal(result.lost, 1);
    assert.equal(result.succeeded, 0, 'a discarded result is not a success');
  });
});

describe('REVIEW: the alert-lifecycle race (§6)', () => {
  /**
   * The race, with the REAL PostgreSQL repository behind the REAL route.
   *
   * The fake repository cannot show this: `transition_alert` is what makes a
   * transition conditional, and only the Postgres path has it.
   *
   * Sequence: the handler reads the alert and finds it active; she resolves
   * from another device; the handler writes 'escalated', which does nothing.
   * Before the fix, the handler went on to schedule contact notification -
   * telling her contacts about an emergency that was already over.
   */
  async function pgHarness() {
    const queue = new InMemoryTaskQueue();
    const repo = new PostgresAlertRepository(admin!, ACTIVE_WINDOW);
    const deps = makeDeps({ alerts: repo, queue, logger });
    const app = buildServer(deps);
    const dispatch = httpTaskDispatcher({
      baseUrl: 'http://queue.invalid',
      secret: deps.config.taskRunnerSecret,
      fetchImpl: injectFetchFor(app),
    });
    return { app, repo, queue, dispatch, secret: deps.config.taskRunnerSecret };
  }

  function injectFetchFor(app: FastifyInstance): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
      const res = await app.inject({
        method: 'POST', url: new URL(String(url)).pathname,
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string,
      });
      return { ok: res.statusCode < 400, status: res.statusCode,
        json: async () => res.json() as unknown } as Response;
    }) as unknown as typeof fetch;
  }

  qtest('she resolves mid-handler: no contact notification is queued', async () => {
    const { app, repo, queue, dispatch } = await pgHarness();
    try {
      const { alert } = await repo.create({
        requestId: 'tq-race-0001', ownerId: SUBJECT, latitude: null, longitude: null,
      });
      // She resolves — the window between the handler's read and its write.
      await repo.updateStatus(alert.id, 'resolved', { resolvedBy: 'owner' });

      const before = [...queue.scheduled.keys()];
      await dispatch({
        id: '1', taskKey: 'k', kind: 'safety-check',
        payload: { kind: 'safety-check', alertId: alert.id },
        runAt: new Date(), attempts: 1, maxAttempts: 5,
      });

      const added = [...queue.scheduled.keys()].filter((k) => !before.includes(k));
      assert.deepEqual(added.filter((k) => k.startsWith('notify-contacts')), [],
        'her contacts must NOT be told about an emergency she already resolved');
      assert.equal((await repo.findById(alert.id))?.status, 'resolved',
        'and the alert is untouched');
    } finally { await app.close(); }
  });

  qtest('a genuinely active alert still escalates and still notifies', async () => {
    // The guard must not cost a real escalation. Same path, no race.
    const { app, repo, queue, dispatch } = await pgHarness();
    try {
      const { alert } = await repo.create({
        requestId: 'tq-race-0002', ownerId: SUBJECT, latitude: null, longitude: null,
      });
      await dispatch({
        id: '2', taskKey: 'k2', kind: 'safety-check',
        payload: { kind: 'safety-check', alertId: alert.id },
        runAt: new Date(), attempts: 1, maxAttempts: 5,
      });

      assert.equal((await repo.findById(alert.id))?.status, 'escalated');
      assert.ok([...queue.scheduled.keys()].some((k) => k.startsWith('notify-contacts')),
        'the escalation that did happen must still reach her contacts');
    } finally { await app.close(); }
  });

  qtest('a cancelled alert mid-handler is also left alone', async () => {
    const { app, repo, queue, dispatch } = await pgHarness();
    try {
      const { alert } = await repo.create({
        requestId: 'tq-race-0003', ownerId: SUBJECT, latitude: null, longitude: null,
      });
      await repo.updateStatus(alert.id, 'cancelled', {});

      const before = [...queue.scheduled.keys()];
      await dispatch({
        id: '3', taskKey: 'k3', kind: 'safety-check',
        payload: { kind: 'safety-check', alertId: alert.id },
        runAt: new Date(), attempts: 1, maxAttempts: 5,
      });
      const added = [...queue.scheduled.keys()].filter((k) => !before.includes(k));
      assert.deepEqual(added.filter((k) => k.startsWith('notify-contacts')), []);
    } finally { await app.close(); }
  });

  qtest('updateStatus reports the alert as it stands, and never throws for a no-op', async () => {
    // The contract the handlers now rely on, pinned at the repository.
    const repo = new PostgresAlertRepository(admin!, ACTIVE_WINDOW);
    const { alert } = await repo.create({
      requestId: 'tq-race-0004', ownerId: SUBJECT, latitude: null, longitude: null,
    });
    await repo.updateStatus(alert.id, 'resolved', { resolvedBy: 'owner' });

    const after = await repo.updateStatus(alert.id, 'escalated', { escalationReason: 'no_answer' });
    assert.equal(after.status, 'resolved',
      'the requested transition did not happen, and the caller can see that');
    assert.equal(after.escalatedAt, undefined, 'nothing was written');
  });
});
