/**
 * Abandoned-task monitoring against real PostgreSQL.  (P2-17)
 *
 * The point of doing this on the real database rather than a stub is that the
 * two properties that matter are DATABASE properties: abandonment is reached
 * by two different SQL paths, and deduplication is a unique index. Neither can
 * be proven against a fake.
 *
 * NO NOTIFICATION IS SENT and no network call is made - `fetch` is replaced
 * with a function that fails the test if anything calls it.
 *
 * Synthetic data only. Every row this suite creates is keyed `mon-%`.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, loadDbConfig, closePool } from '../src/db/pool.js';
import { AbandonedTaskMonitor } from '../src/queue/AbandonedTaskMonitor.js';
import { PostgresTaskQueue } from '../src/queue/PostgresTaskQueue.js';
import type { Logger } from '../src/logger.js';

let admin: Pool | null = null;
let second: Pool | null = null;
let available = false;
let skipReason = '';

interface Line { level: string; msg: string; ctx: Record<string, unknown> | undefined }

function recordingLogger(): Logger & { lines: Line[] } {
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, ctx?: Record<string, unknown>) => {
    lines.push({ level, msg, ctx });
  };
  return {
    lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'),
  } as Logger & { lines: Line[] };
}

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

// Nothing in the monitoring path may reach outside the process.
const realFetch = globalThis.fetch;
let fetchCalls = 0;

before(async () => {
  globalThis.fetch = (() => {
    fetchCalls += 1; throw new Error('fetch must not be called');
  }) as typeof fetch;

  let cfg;
  try { cfg = loadDbConfig(); } catch {
    skipReason = 'PG* environment not configured (fail-closed, not assumed)';
    return;
  }
  if (!(await reachable(cfg.host, cfg.port))) {
    skipReason = 'no PostgreSQL reachable on the configured host:port';
    return;
  }
  admin = createPool(cfg, { max: 4 });
  // An independent pool, so two monitors genuinely contend in the database
  // rather than being serialised by one client.
  second = createPool(cfg, { max: 1 });
  available = true;
});

after(async () => {
  globalThis.fetch = realFetch;
  assert.equal(fetchCalls, 0, 'the monitoring path made a network call');
  if (!admin) return;
  // ON DELETE CASCADE takes the ledger rows with them.
  await admin.query(`DELETE FROM task_queue WHERE task_key LIKE 'mon-%'`);
  if (second) await closePool(second);
  await closePool(admin);
});

/**
 * The same session lock taskQueue.integration and worker.integration use.
 *
 * Needed in both directions here. `claim_tasks` claims and sweeps ANY due row,
 * so this suite must not run while another is mid-claim; and a monitor scan
 * announces ANY unreported abandoned task, so no other monitor may announce a
 * row between this suite creating it and asserting on it.
 */
const QUEUE_SUITE_LOCK = 918_271_354;

async function withQueueLock<T>(pool: Pool, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [QUEUE_SUITE_LOCK]);
    try { return await fn(); } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [QUEUE_SUITE_LOCK]);
    }
  } finally { client.release(); }
}

function mtest(name: string, fn: (db: Pool) => Promise<void>): void {
  test(name, async (t) => {
    if (!available || !admin) { t.skip(skipReason); return; }
    const db = admin;
    await withQueueLock(db, () => fn(db));
  });
}

/** A task already in the `abandoned` state, as a restarted process would find it. */
async function seedAbandoned(db: Pool, over: {
  kind?: string; lastError?: string | null; attempts?: number;
} = {}): Promise<string> {
  const key = `mon-${randomUUID()}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO task_queue
       (task_key, kind, payload, run_at, state, attempts, max_attempts,
        last_error, completed_at)
     VALUES ($1, $2, $3::jsonb, now() - interval '5 minutes', 'abandoned',
             $4, 5, $5, now() - interval '1 minute')
     RETURNING id`,
    [
      key, over.kind ?? 'safety-check',
      // A payload carrying exactly what must never be logged.
      JSON.stringify({ kind: over.kind ?? 'safety-check', alertId: `al-${randomUUID()}` }),
      over.attempts ?? 5,
      over.lastError === undefined ? 'task route returned 500' : over.lastError,
    ],
  );
  return String(rows[0]?.id);
}

/** The announcements a scan produced, by task id. */
function announcedIds(logger: Logger & { lines: Line[] }): string[] {
  return logger.lines
    .filter((l) => l.msg.startsWith('ABANDONED') || l.msg === 'abandoned background task')
    .map((l) => String(l.ctx?.['taskId']));
}

describe('detection — both abandonment paths, and across a restart', () => {
  mtest('a task abandoned by a reported failure is detected', async (db) => {
    const queue = new PostgresTaskQueue(db);
    const key = `mon-${randomUUID()}`;
    await db.query(
      `INSERT INTO task_queue (task_key, kind, payload, run_at, max_attempts)
       VALUES ($1,'safety-check','{"alertId":"x"}'::jsonb, now() - interval '1 s', 1)`,
      [key],
    );
    // The real path: claim it, then report a failure that exhausts its budget.
    const claimed = await queue.claim('mon-worker', 50, 60_000);
    const mine = claimed.find((c) => c.taskKey === key);
    assert.ok(mine, 'the fixture task was claimed');
    await queue.complete(mine.id, 'mon-worker', false, 'task route returned 503');

    const { rows } = await db.query<{ state: string }>(
      `SELECT state FROM task_queue WHERE task_key = $1`, [key]);
    assert.equal(rows[0]?.state, 'abandoned', 'precondition: complete_task abandoned it');

    const logger = recordingLogger();
    await new AbandonedTaskMonitor(db, logger).scan();

    assert.ok(announcedIds(logger).includes(mine.id));
    const line = logger.lines.find((l) => l.ctx?.['taskId'] === mine.id);
    assert.equal(line?.level, 'error');
    assert.equal(line?.ctx?.['errorClass'], 'route_rejected');
    assert.equal(line?.ctx?.['httpStatus'], 503);
  });

  mtest('a task abandoned by the LEASE SWEEP is detected — the worker died', async (db) => {
    // This is the path an in-process hook cannot see: the process that was
    // running the task is gone, and a different worker's next claim retires
    // the row.
    const queue = new PostgresTaskQueue(db);
    const key = `mon-${randomUUID()}`;
    await db.query(
      `INSERT INTO task_queue (task_key, kind, payload, run_at, max_attempts)
       VALUES ($1,'expiry','{"alertId":"x"}'::jsonb, now() - interval '1 s', 1)`,
      [key],
    );
    const claimed = await queue.claim('mon-dead-worker', 50, 60_000);
    const mine = claimed.find((c) => c.taskKey === key);
    assert.ok(mine);
    // The worker dies: never reports, and its lease runs out.
    await db.query(
      `UPDATE task_queue SET claimed_until = now() - interval '1 s' WHERE id = $1`,
      [mine.id],
    );
    // A limit of 0 runs the sweep without claiming anything, so this cannot
    // steal rows from another suite.
    await db.query(`SELECT * FROM claim_tasks('mon-sweeper', 0, interval '60 s')`);

    const { rows } = await db.query<{ state: string; last_error: string }>(
      `SELECT state, last_error FROM task_queue WHERE id = $1`, [mine.id]);
    assert.equal(rows[0]?.state, 'abandoned');
    assert.equal(rows[0]?.last_error, 'lease expired with attempts exhausted');

    const logger = recordingLogger();
    await new AbandonedTaskMonitor(db, logger).scan();

    const line = logger.lines.find((l) => l.ctx?.['taskId'] === mine.id);
    assert.equal(line?.level, 'error', 'a dead worker must be as loud as a reported failure');
    assert.equal(line?.ctx?.['errorClass'], 'lease_expired');
  });

  mtest('an abandonment that PREDATES the process is detected', async (db) => {
    // Restart recovery. The monitor is constructed fresh, after the fact, and
    // never witnessed the transition.
    const id = await seedAbandoned(db);
    const logger = recordingLogger();
    const freshProcess = new AbandonedTaskMonitor(db, logger);

    const result = await freshProcess.scan();

    assert.ok(result.reported >= 1);
    assert.ok(announcedIds(logger).includes(id));
  });

  mtest('pending, claimed, done and cancelled tasks are never reported', async (db) => {
    const keys = { pending: `mon-${randomUUID()}`, done: `mon-${randomUUID()}`, cancelled: `mon-${randomUUID()}` };
    await db.query(
      `INSERT INTO task_queue (task_key, kind, payload, run_at, state, completed_at)
       VALUES ($1,'safety-check','{}'::jsonb, now() + interval '1 day','pending', NULL),
              ($2,'safety-check','{}'::jsonb, now(),'done', now()),
              ($3,'safety-check','{}'::jsonb, now(),'cancelled', now())`,
      [keys.pending, keys.done, keys.cancelled],
    );
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM task_queue WHERE task_key = ANY($1)`,
      [Object.values(keys)],
    );
    const logger = recordingLogger();
    await new AbandonedTaskMonitor(db, logger).scan();

    const announced = announcedIds(logger);
    for (const r of rows) {
      assert.ok(!announced.includes(String(r.id)), `non-abandoned task ${r.id} was announced`);
    }
  });
});

describe('deduplication — the unique index is the arbiter', () => {
  mtest('a second scan does not announce the same task again', async (db) => {
    const id = await seedAbandoned(db);
    const logger = recordingLogger();
    const monitor = new AbandonedTaskMonitor(db, logger);

    await monitor.scan();
    await monitor.scan();
    await monitor.scan();

    assert.equal(
      announcedIds(logger).filter((x) => x === id).length, 1,
      'three scans, one announcement',
    );
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM task_alert_log WHERE task_id = $1`, [id]);
    assert.equal(rows[0]?.n, '1');
  });

  mtest('a restarted process does not re-announce what the old one reported', async (db) => {
    const id = await seedAbandoned(db);
    const first = recordingLogger();
    await new AbandonedTaskMonitor(db, first).scan();
    assert.ok(announcedIds(first).includes(id));

    // A new process, with no memory of the first.
    const afterRestart = recordingLogger();
    await new AbandonedTaskMonitor(db, afterRestart).scan();

    assert.ok(!announcedIds(afterRestart).includes(id),
      'the ledger, not process memory, is what suppresses the repeat');
  });

  mtest('two concurrent monitors announce it exactly once between them', async (db) => {
    assert.ok(second);
    const id = await seedAbandoned(db);
    const logA = recordingLogger();
    const logB = recordingLogger();

    await Promise.all([
      new AbandonedTaskMonitor(db, logA).scan(),
      new AbandonedTaskMonitor(second, logB).scan(),
    ]);

    const total = announcedIds(logA).filter((x) => x === id).length
      + announcedIds(logB).filter((x) => x === id).length;
    assert.equal(total, 1, 'exactly one of the two monitors owns the announcement');
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM task_alert_log WHERE task_id = $1`, [id]);
    assert.equal(rows[0]?.n, '1');
  });

  mtest('the ledger records the detection, not the announcement', async (db) => {
    const id = await seedAbandoned(db, { kind: 'notify-contacts', lastError: "no handler registered for task kind 'notify-contacts'" });
    await new AbandonedTaskMonitor(db, recordingLogger()).scan();

    const { rows } = await db.query(
      `SELECT kind, attempts, max_attempts, error_class, severity, kind_registered,
              abandoned_at IS NOT NULL AS has_abandoned, noticed_at >= abandoned_at AS ordered
         FROM task_alert_log WHERE task_id = $1`, [id]);
    assert.deepEqual(rows[0], {
      kind: 'notify-contacts', attempts: 5, max_attempts: 5,
      error_class: 'no_handler', severity: 'safety', kind_registered: true,
      has_abandoned: true, ordered: true,
    });
  });
});

describe('it does not touch the work it watches', () => {
  mtest('the task row is byte-identical after a scan', async (db) => {
    const id = await seedAbandoned(db);
    const snapshot = async () => (await db.query(
      `SELECT task_key, kind, payload, run_at, state, claimed_by, claimed_until,
              attempts, max_attempts, last_error, created_at, completed_at
         FROM task_queue WHERE id = $1`, [id])).rows[0];

    const before = await snapshot();
    await new AbandonedTaskMonitor(db, recordingLogger()).scan();
    const after = await snapshot();

    assert.deepEqual(after, before, 'the monitor must not mutate task state');
  });

  mtest('an abandoned task is not requeued, reset or marked done', async (db) => {
    const id = await seedAbandoned(db, { attempts: 5 });
    await new AbandonedTaskMonitor(db, recordingLogger()).scan();

    const { rows } = await db.query<{ state: string; attempts: number }>(
      `SELECT state, attempts FROM task_queue WHERE id = $1`, [id]);
    assert.equal(rows[0]?.state, 'abandoned', 'still abandoned — reporting is not recovery');
    assert.equal(rows[0]?.attempts, 5);
  });

  mtest('the ledger cannot record an alert for a task that is not abandoned', async (db) => {
    const key = `mon-${randomUUID()}`;
    const { rows: ins } = await db.query<{ id: string }>(
      `INSERT INTO task_queue (task_key, kind, payload, run_at)
       VALUES ($1,'safety-check','{}'::jsonb, now()) RETURNING id`, [key]);
    const id = String(ins[0]?.id);

    const { rows } = await db.query(
      `SELECT record_task_alerts($1::bigint[], $2::text[], $3::int[], $4::int[],
                                 $5::timestamptz[], $6::text[], $7::text[], $8::boolean[])`,
      [[id], ['safety-check'], [0], [5], [new Date()], ['none'], ['safety'], [true]],
    );
    assert.equal(rows.length, 0, 'abandonment cannot be fabricated');
    const { rows: log } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM task_alert_log WHERE task_id = $1`, [id]);
    assert.equal(log[0]?.n, '0');
  });

  mtest('the ledger refuses free text in place of a classification', async (db) => {
    const id = await seedAbandoned(db);
    await assert.rejects(
      () => db.query(
        `SELECT record_task_alerts($1::bigint[], $2::text[], $3::int[], $4::int[],
                                   $5::timestamptz[], $6::text[], $7::text[], $8::boolean[])`,
        [[id], ['safety-check'], [5], [5], [new Date()],
          ['connect ECONNREFUSED 10.0.0.5:5432'], ['safety'], [true]],
      ),
      /check constraint|violates/i,
      'a raw error message must not be storable as a classification',
    );
  });

  mtest('mismatched arrays are refused rather than pairing the wrong rows', async (db) => {
    await assert.rejects(
      () => db.query(
        `SELECT record_task_alerts($1::bigint[], $2::text[], $3::int[], $4::int[],
                                   $5::timestamptz[], $6::text[], $7::text[], $8::boolean[])`,
        [['1', '2'], ['a'], [1, 1], [5, 5], [new Date(), new Date()],
          ['none', 'none'], ['safety', 'safety'], [true, true]],
      ),
      /same length/,
    );
  });
});

describe('failure and redaction', () => {
  mtest('a dead database makes the monitor loud, not fatal', async (db) => {
    const cfg = loadDbConfig();
    const doomed = createPool(cfg, { max: 1 });
    await doomed.query('SELECT 1');
    await closePool(doomed);

    const logger = recordingLogger();
    const monitor = new AbandonedTaskMonitor(doomed, logger);
    const result = await monitor.scan();

    assert.equal(result.failed, true);
    assert.equal(result.reported, 0);
    assert.equal(monitor.stats.consecutiveFailures, 1);
    assert.ok(logger.lines.some((l) =>
      l.level === 'error' && l.msg.startsWith('abandoned-task scan FAILED')));
    // And the real database is untouched by the failure.
    const ok = await new AbandonedTaskMonitor(db, recordingLogger()).scan();
    assert.equal(ok.failed, false);
  });

  mtest('no log line carries the payload or the alert id it contains', async (db) => {
    const alertId = `al-${randomUUID()}`;
    const key = `mon-${randomUUID()}`;
    await db.query(
      `INSERT INTO task_queue (task_key, kind, payload, run_at, state, attempts,
                               max_attempts, last_error, completed_at)
       VALUES ($1,'safety-check',$2::jsonb, now(),'abandoned',5,5,
               $3, now())`,
      [key, JSON.stringify({
        kind: 'safety-check', alertId,
        phone: '+251911223344', latitude: 8.9956, longitude: 38.7897,
      }), `POST https://api.example?token=sk-live-1 failed for ${alertId}`],
    );

    const logger = recordingLogger();
    await new AbandonedTaskMonitor(db, logger).scan();

    const dump = JSON.stringify(logger.lines);
    for (const forbidden of [
      alertId, 'sk-live-1', '251911223344', '8.9956', '38.7897',
      'payload', 'token', 'api.example',
    ]) {
      assert.ok(!dump.includes(forbidden), `a log line leaked ${forbidden}`);
    }
    // And the ledger holds none of it either.
    const { rows } = await db.query<{ row: string }>(
      `SELECT l::text AS row FROM task_alert_log l
         JOIN task_queue t ON t.id = l.task_id WHERE t.task_key = $1`, [key]);
    assert.ok(rows[0]);
    for (const forbidden of [alertId, 'sk-live-1', '251911223344', '8.9956']) {
      assert.ok(!rows[0].row.includes(forbidden), `the ledger stored ${forbidden}`);
    }
  });

  mtest('the liveness line is emitted on every completed scan', async (db) => {
    const logger = recordingLogger();
    const monitor = new AbandonedTaskMonitor(db, logger);
    await monitor.scan();
    await monitor.scan();

    const liveness = logger.lines.filter((l) => l.msg === 'abandoned-task scan');
    assert.equal(liveness.length, 2);
    assert.equal(liveness[0]?.level, 'info');
    assert.equal(liveness[1]?.ctx?.['scans'], 2, 'the counter is the heartbeat');
  });

  mtest('a safety abandonment and a background one are told apart end to end', async (db) => {
    const safetyId = await seedAbandoned(db, { kind: 'safety-check' });
    const backgroundId = await seedAbandoned(db, { kind: 'metrics-rollup' });

    const logger = recordingLogger();
    await new AbandonedTaskMonitor(db, logger, {
      nonSafetyKinds: new Set(['metrics-rollup']),
    }).scan();

    const safetyLine = logger.lines.find((l) => l.ctx?.['taskId'] === safetyId);
    const backgroundLine = logger.lines.find((l) => l.ctx?.['taskId'] === backgroundId);
    assert.equal(safetyLine?.level, 'error');
    assert.equal(backgroundLine?.level, 'warn');

    const { rows } = await db.query<{ task_id: string; severity: string }>(
      `SELECT task_id::text, severity FROM task_alert_log WHERE task_id = ANY($1)
        ORDER BY task_id`, [[safetyId, backgroundId].sort()]);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      new Map(rows.map((r) => [r.task_id, r.severity])),
      new Map([[safetyId, 'safety'], [backgroundId, 'background']]),
    );
  });

  mtest('the batch is bounded, and the remainder is picked up next scan', async (db) => {
    const ids = [
      await seedAbandoned(db), await seedAbandoned(db), await seedAbandoned(db),
    ];
    const logger = recordingLogger();
    const monitor = new AbandonedTaskMonitor(db, logger, { batchSize: 1 });

    const first = await monitor.scan();
    assert.equal(first.candidates, 1);
    assert.equal(first.truncated, true);

    await monitor.scan();
    await monitor.scan();
    await monitor.scan();

    const announced = announcedIds(logger);
    for (const id of ids) {
      assert.equal(announced.filter((x) => x === id).length, 1,
        `task ${id} must be announced exactly once across the scans`);
    }
  });
});
