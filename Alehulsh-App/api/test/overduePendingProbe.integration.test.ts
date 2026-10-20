/**
 * The overdue-pending probe against real PostgreSQL.  (P2-17b)
 *
 * Why the real database: the whole claim is that the probe asks the SAME
 * question `claim_tasks` asks. That is only provable against the real
 * predicate, the real enum and the real index.
 *
 * ISOLATION. Every test uses a UNIQUE SYNTHETIC `kind`, and the query groups
 * by kind, so each test owns its own row of the result however many tasks
 * other suites have in flight. The queue advisory lock is still taken,
 * because `claim_tasks` in a parallel suite claims ANY due row and would move
 * these fixtures out of `pending` underneath the assertions.
 *
 * READ-ONLY and NO NETWORK: `fetch` is replaced with a function that fails the
 * test if called. Synthetic data only; every row is keyed `opp-%`.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, loadDbConfig, closePool } from '../src/db/pool.js';
import {
  OverduePendingProbe, type OverdueScanResult,
} from '../src/queue/OverduePendingProbe.js';
import { AbandonedTaskMonitor } from '../src/queue/AbandonedTaskMonitor.js';
import type { Logger } from '../src/logger.js';

let admin: Pool | null = null;
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
  admin = createPool(cfg, { max: 3 });
  available = true;
});

after(async () => {
  globalThis.fetch = realFetch;
  assert.equal(fetchCalls, 0, 'the probe made a network call');
  if (!admin) return;
  await admin.query(`DELETE FROM task_queue WHERE task_key LIKE 'opp-%'`);
  await closePool(admin);
});

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

function ptest(name: string, fn: (db: Pool, kind: string) => Promise<void>): void {
  test(name, async (t) => {
    if (!available || !admin) { t.skip(skipReason); return; }
    const db = admin;
    // A kind no other suite uses, so this test owns its row of the GROUP BY.
    const kind = `opp-${randomUUID().slice(0, 8)}`;
    await withQueueLock(db, () => fn(db, kind));
  });
}

/** Generous, so a unique kind is never truncated out by another suite's kinds. */
const probeFor = (db: Pool, logger: Logger) =>
  new OverduePendingProbe(db, logger, { kindLimit: 500 });

const drained = { claimed: 0, capacity: 10 };
const saturated = { claimed: 10, capacity: 10 };

/** A payload carrying everything that must never reach a diagnostic. */
const sensitivePayload = (kind: string, alertId: string) => JSON.stringify({
  kind, alertId, phone: '+251911223344', latitude: 8.9956, longitude: 38.7897,
  keyword: 'Milo', audioUrl: 'https://example/evidence.m4a',
});

async function seed(db: Pool, kind: string, over: {
  state?: string; runAt?: string; attempts?: number; claimedUntil?: string | null;
  completedAt?: string | null;
} = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO task_queue (task_key, kind, payload, run_at, state, attempts,
                             claimed_by, claimed_until, completed_at)
     VALUES ($1, $2, $3::jsonb, now() + ($4)::interval, $5::task_state, $6,
             CASE WHEN $5 = 'claimed' THEN 'opp-worker' END,
             CASE WHEN $7::text IS NULL THEN NULL ELSE now() + ($7)::interval END,
             CASE WHEN $8::text IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [
      `opp-${randomUUID()}`, kind, sensitivePayload(kind, `al-${randomUUID()}`),
      over.runAt ?? '-30 seconds', over.state ?? 'pending', over.attempts ?? 0,
      over.claimedUntil === undefined ? null : over.claimedUntil,
      over.completedAt === undefined ? null : 'now',
    ],
  );
  return String(rows[0]!.id);
}

const mine = (r: OverdueScanResult, kind: string) =>
  r.kinds.find((k) => k.kind === kind);

/**
 * Warnings about THIS test's kind only.
 *
 * The probe's query is global by design, so a parallel suite's undrained
 * pending rows legitimately produce warnings of their own. An unscoped
 * "no warnings were logged" assertion is therefore a lie about this suite -
 * caught by exactly that assertion failing here.
 */
function warningsFor(logger: { lines: Line[] }, kind: string): Line[] {
  return logger.lines.filter((l) =>
    l.level === 'warn'
    && Array.isArray(l.ctx?.['persistingKinds'])
    && (l.ctx['persistingKinds'] as string[]).includes(kind));
}

describe('what counts as claimable', () => {
  ptest('a FUTURE-scheduled pending task is not overdue', async (db, kind) => {
    // Both real kinds are deliberately future-scheduled: safety-check at
    // +2 minutes, expiry at +2 hours. Neither is a stall.
    await seed(db, kind, { runAt: '+2 minutes' });
    await seed(db, kind, { runAt: '+2 hours' });

    const result = await probeFor(db, recordingLogger()).scan(drained);
    assert.equal(mine(result, kind), undefined, 'scheduled work is not late work');
  });

  ptest('a due pending task is reported, with its age measured', async (db, kind) => {
    await seed(db, kind, { runAt: '-90 seconds' });

    const logger = recordingLogger();
    const result = await probeFor(db, logger).scan(drained);

    const k = mine(result, kind);
    assert.equal(k?.dueCount, 1);
    assert.equal(k?.reclaimableCount, 0);
    assert.ok(k!.oldestDueMs >= 89_000 && k!.oldestDueMs <= 95_000,
      `age should be ~90s, got ${k!.oldestDueMs}`);
    assert.ok(k?.headTaskId, 'the row claim_tasks must take next is named');
  });

  ptest('claimed, done, abandoned and cancelled are never counted as pending', async (db, kind) => {
    // A live lease: legitimately in flight, not claimable.
    await seed(db, kind, { state: 'claimed', claimedUntil: '+60 seconds' });
    await seed(db, kind, { state: 'done', completedAt: 'now' });
    await seed(db, kind, { state: 'abandoned', completedAt: 'now' });
    await seed(db, kind, { state: 'cancelled', completedAt: 'now' });

    const result = await probeFor(db, recordingLogger()).scan(drained);
    const k = mine(result, kind);
    assert.equal(k?.dueCount ?? 0, 0, 'none of these four are pending work');
    assert.equal(k?.reclaimableCount ?? 0, 0, 'and none has an expired lease');
  });

  ptest('a claimed row with an EXPIRED lease is a separate, named class', async (db, kind) => {
    // The second silent stall: a worker died mid-dispatch. The row is
    // claimable again, but the 0010 sweep only runs inside a claim - so with
    // no worker it is never reclaimed and never abandoned either.
    await seed(db, kind, { state: 'claimed', claimedUntil: '-10 seconds', attempts: 1 });

    const result = await probeFor(db, recordingLogger()).scan(drained);
    const k = mine(result, kind);
    assert.equal(k?.dueCount, 0, 'it is not pending, and must not be reported as pending');
    assert.equal(k?.reclaimableCount, 1);
    assert.equal(k?.headTaskId, null, 'there is no pending head to track');
  });

  ptest('a retry is distinguished from a first attempt', async (db, kind) => {
    await seed(db, kind, { attempts: 0 });
    await seed(db, kind, { attempts: 3 });

    const result = await probeFor(db, recordingLogger()).scan(drained);
    const k = mine(result, kind);
    assert.equal(k?.dueCount, 2);
    assert.equal(k?.retrying, 1, 'run_at on a retry is a backoff time, not the original intent');
  });

  ptest('the probe agrees with claim_tasks about what is claimable', async (db, kind) => {
    // The property that matters most. If these drift, the probe reports work
    // the claimer would not take, or misses work it would.
    await seed(db, kind, { runAt: '-30 seconds' });                                  // due
    await seed(db, kind, { runAt: '+1 hour' });                                       // not yet
    await seed(db, kind, { state: 'claimed', claimedUntil: '+60 seconds' });          // in flight
    await seed(db, kind, { state: 'claimed', claimedUntil: '-5 seconds', attempts: 1 }); // reclaimable

    const result = await probeFor(db, recordingLogger()).scan(drained);
    const k = mine(result, kind);
    const probeSaysClaimable = (k?.dueCount ?? 0) + (k?.reclaimableCount ?? 0);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM task_queue t
        WHERE t.kind = $1 AND t.run_at <= now()
          AND (t.state = 'pending'
               OR (t.state = 'claimed' AND t.claimed_until < now()))`, [kind]);
    assert.equal(probeSaysClaimable, rows[0]!.n);
    assert.equal(probeSaysClaimable, 2);
  });
});

describe('it changes nothing', () => {
  ptest('every mutable column is identical after repeated scans', async (db, kind) => {
    const id = await seed(db, kind, { attempts: 2 });
    const snapshot = async () => (await db.query(
      `SELECT task_key, kind, payload, run_at, state, claimed_by, claimed_until,
              attempts, max_attempts, last_error, created_at, completed_at
         FROM task_queue WHERE id = $1`, [id])).rows[0];

    const before = await snapshot();
    const probe = probeFor(db, recordingLogger());
    await probe.scan(drained);
    await probe.scan(drained);
    await probe.scan(saturated);
    const after = await snapshot();

    assert.deepEqual(after, before, 'a diagnostic must not touch what it diagnoses');
  });

  ptest('it does not requeue, abandon or reclaim anything', async (db, kind) => {
    const due = await seed(db, kind, { runAt: '-1 hour' });
    const expired = await seed(db, kind, {
      state: 'claimed', claimedUntil: '-1 hour', attempts: 5,
    });

    await probeFor(db, recordingLogger()).scan(drained);

    const { rows } = await db.query<{ id: string; state: string; attempts: number }>(
      `SELECT id::text, state, attempts FROM task_queue WHERE id = ANY($1) ORDER BY id`,
      [[due, expired]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(due)?.state, 'pending', 'still pending — reporting is not claiming');
    assert.equal(byId.get(due)?.attempts, 0, 'and attempts were not touched');
    assert.equal(byId.get(expired)?.state, 'claimed',
      'an exhausted expired lease is NOT abandoned by the probe — only claim_tasks does that');
  });

  ptest('it writes no ledger row — abandoned-task monitoring is untouched', async (db, kind) => {
    const abandoned = await seed(db, kind, { state: 'abandoned', completedAt: 'now' });
    await seed(db, kind, { runAt: '-30 seconds' });

    await probeFor(db, recordingLogger()).scan(drained);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM task_alert_log WHERE task_id = $1`, [abandoned]);
    assert.equal(rows[0]!.n, 0, 'the probe must not announce or record anything');
  });

  ptest('abandoned-task monitoring still behaves identically alongside it', async (db, kind) => {
    const abandoned = await seed(db, kind, { state: 'abandoned', completedAt: 'now' });
    await db.query(
      `UPDATE task_queue SET last_error = 'task route returned 500', attempts = 5
        WHERE id = $1`, [abandoned]);
    await seed(db, kind, { runAt: '-30 seconds' });

    const logger = recordingLogger();
    // Both diagnostics, in the order the loop runs them.
    await new AbandonedTaskMonitor(db, logger, { batchSize: 500 }).scan();
    await probeFor(db, logger).scan(drained);

    const announced = logger.lines.find((l) =>
      l.msg.startsWith('ABANDONED safety-critical') && l.ctx?.['taskId'] === abandoned);
    assert.ok(announced, 'the abandonment is still announced, exactly as before');
    assert.equal(announced.ctx?.['errorClass'], 'route_rejected');
    const ledger = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM task_alert_log WHERE task_id = $1`, [abandoned]);
    assert.equal(ledger.rows[0]!.n, 1, 'one ledger row, from the monitor and not the probe');
  });
});

describe('observation, not a clock', () => {
  ptest('a head that stands still is warned about on the second scan', async (db, kind) => {
    await seed(db, kind, { runAt: '-45 seconds' });

    const logger = recordingLogger();
    const probe = probeFor(db, logger);

    const first = await probe.scan(drained);
    assert.equal(first.persisting.includes(kind), false, 'one sighting confirms nothing');

    const second = await probe.scan(drained);
    assert.equal(second.persisting.includes(kind), true);
    const warn = warningsFor(logger, kind);
    assert.equal(warn.length, 1);
    assert.match(warn[0]!.msg, /NOT DRAINING .* spare capacity/);
  });

  ptest('a head that is actually claimed between scans is not warned about', async (db, kind) => {
    const first = await seed(db, kind, { runAt: '-45 seconds' });
    const logger = recordingLogger();
    const probe = probeFor(db, logger);
    await probe.scan(drained);

    // The worker does its job: that row is claimed, and a newer one is next.
    await db.query(
      `UPDATE task_queue SET state='claimed', claimed_by='opp-w',
              claimed_until = now() + interval '60 seconds', attempts = 1
        WHERE id = $1`, [first]);
    await seed(db, kind, { runAt: '-5 seconds' });

    const second = await probe.scan(drained);
    assert.equal(second.persisting.includes(kind), false, 'the queue is draining');
    assert.deepEqual(warningsFor(logger, kind), [],
      'a draining kind must never be warned about');
  });
});

describe('failure and redaction', () => {
  ptest('a dead database makes the probe loud, not fatal', async (db) => {
    const doomed = createPool(loadDbConfig(), { max: 1 });
    await doomed.query('SELECT 1');
    await closePool(doomed);

    const logger = recordingLogger();
    const probe = new OverduePendingProbe(doomed, logger);
    const result = await probe.scan(drained);

    assert.equal(result.failed, true);
    assert.equal(probe.stats.consecutiveFailures, 1);
    assert.ok(logger.lines.some((l) =>
      l.level === 'error' && l.msg.startsWith('overdue-pending probe FAILED')));
    // The live database is unaffected.
    const ok = await probeFor(db, recordingLogger()).scan(drained);
    assert.equal(ok.failed, false);
  });

  ptest('no diagnostic line carries anything from the payload', async (db, kind) => {
    await seed(db, kind, { runAt: '-30 seconds' });
    const logger = recordingLogger();
    const probe = probeFor(db, logger);
    await probe.scan(drained);
    await probe.scan(drained);   // includes the warn path

    const dump = JSON.stringify(logger.lines);
    for (const forbidden of [
      'alertId', 'al-', '251911223344', '8.9956', '38.7897', 'Milo',
      'evidence.m4a', 'payload', 'audioUrl', 'keyword',
    ]) {
      assert.ok(!dump.includes(forbidden), `a diagnostic line leaked ${forbidden}`);
    }
    assert.ok(logger.lines.length >= 2);
  });
});
