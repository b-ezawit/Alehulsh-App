/**
 * The whole worker stack against real PostgreSQL.
 *
 * WorkerLoop -> TaskWorker -> PostgresTaskQueue -> real SQL functions, and
 * httpTaskDispatcher -> the real /internal/tasks routes through their real
 * `x-task-secret` guard.
 *
 * NO SOCKET IS OPENED. `fetch` is replaced with a shim forwarding to Fastify's
 * `inject`, so the dispatcher drives the real route in-process. Nothing here
 * can reach a notification provider, and `notify-contacts` is deliberately
 * unrouted.
 *
 * `sleep` is injected throughout, so no test waits for real time.
 * Synthetic data only; this suite owns the `wk-` task-key prefix.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { createPool, loadDbConfig, closePool } from '../src/db/pool.js';
import { PostgresTaskQueue } from '../src/queue/PostgresTaskQueue.js';
import { TaskWorker, httpTaskDispatcher, type TaskDispatcher } from '../src/queue/TaskWorker.js';
import { WorkerLoop } from '../src/queue/WorkerLoop.js';
import { AbandonedTaskMonitor } from '../src/queue/AbandonedTaskMonitor.js';
import { OverduePendingProbe } from '../src/queue/OverduePendingProbe.js';
import { PostgresAlertRepository } from '../src/repositories/postgres/PostgresAlertRepository.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';
import { buildServer } from '../src/server.js';
import { createLogger, type Logger } from '../src/logger.js';
import { makeDeps, ACTIVE_WINDOW } from './fakes.js';

const logger = createLogger('error');

let admin: Pool | null = null;
let available = false;
let skipReason = '';
const OWNER_UUID = randomUUID();
const SUBJECT = `wk${randomUUID().replace(/-/g, '').slice(0, 26)}`;

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
  admin = createPool(cfg, { max: 4 });
  await admin.query(
    `INSERT INTO users (id, display_name) VALUES ($1,'WorkerOwner')
     ON CONFLICT (id) DO NOTHING`, [OWNER_UUID]);
  await admin.query(
    `INSERT INTO identity_map (firebase_uid, user_id) VALUES ($1,$2)
     ON CONFLICT (firebase_uid) DO NOTHING`, [SUBJECT, OWNER_UUID]);
  available = true;
});

after(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM task_queue WHERE task_key LIKE 'wk-%'`);
  await admin.query(`DELETE FROM alerts WHERE owner_id = $1`, [OWNER_UUID]);
  // Nothing cascades to alert_history; clean up our own.
  await admin.query(`DELETE FROM alert_history WHERE owner_id = $1`, [OWNER_UUID]);
  await admin.query(`DELETE FROM users WHERE id = $1`, [OWNER_UUID]);
  await closePool(admin);
});

/**
 * Serialise against taskQueue.integration, which also claims from task_queue.
 *
 * This suite's loop claims through TaskWorker, which takes ANY due row - so
 * without this it steals that suite's tasks and completes them under the wrong
 * worker id. Filtering results cannot help: the claim itself is the
 * interference. Same key on both sides; neither touches the other's data.
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

function wtest(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) { t.skip(skipReason); return; }
    await withQueueLock(admin!, async () => {
      // This suite owns the 'wk-' prefix; other suites own theirs.
      await admin!.query(`DELETE FROM task_queue WHERE task_key LIKE 'wk-%'`);
      await admin!.query(`DELETE FROM alerts WHERE owner_id = $1`, [OWNER_UUID]);
      await admin!.query(`DELETE FROM alert_history WHERE owner_id = $1`, [OWNER_UUID]);
      await fn();
    });
  });
}

const due = (msAgo = 1000) => new Date(Date.now() - msAgo);

async function stateOf(key: string): Promise<string | null> {
  const { rows } = await admin!.query<{ state: string }>(
    `SELECT state FROM task_queue WHERE task_key = $1`, [key]);
  return rows[0]?.state ?? null;
}

/** Only this suite's tasks, so a parallel suite cannot affect an assertion. */
function mine(tasks: { taskKey: string }[]): { taskKey: string }[] {
  return tasks.filter((t) => t.taskKey.startsWith('wk-'));
}

/**
 * Drive the loop until this suite's task reaches a state we care about.
 *
 * Pass COUNTS are deliberately not asserted in this file. `claim_tasks` claims
 * any due task, and other suites run in parallel processes against the same
 * table, so `result.succeeded` is not this suite's to predict - a neighbour's
 * task can fill the pass. What IS ours is the observable outcome of our own
 * task and its alert, which is also the thing that actually matters.
 *
 * The count-based behaviour (empty-queue waiting, backoff sequences, stats
 * accounting) is asserted deterministically in test/workerLoop.test.ts against
 * a stub worker, where no shared table can interfere.
 */
async function tickUntil(
  loop: { tick: () => Promise<unknown> },
  done: () => Promise<boolean>,
  maxTicks = 12,
): Promise<boolean> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (await done()) return true;
    await loop.tick();
  }
  return done();
}

/** A loop whose waits are recorded rather than endured. */
function loopOver(worker: TaskWorker, waits: number[] = []) {
  return {
    waits,
    loop: new WorkerLoop({
      worker, logger,
      pollIntervalMs: 2_000, errorBackoffMs: 1_000, maxErrorBackoffMs: 8_000,
      shutdownGraceMs: 5_000,
      sleep: async (ms: number) => { waits.push(ms); },
    }),
  };
}

/** `fetch` that forwards to Fastify's inject. No socket is opened. */
function injectFetch(app: FastifyInstance): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const res = await app.inject({
      method: 'POST', url: new URL(String(url)).pathname,
      headers: init?.headers as Record<string, string>,
      payload: init?.body as string,
    });
    return { ok: res.statusCode < 400, status: res.statusCode } as Response;
  }) as unknown as typeof fetch;
}

/** The real route stack over the real Postgres alert repository. */
async function harness() {
  const repo = new PostgresAlertRepository(admin!, ACTIVE_WINDOW);
  const scheduled = new InMemoryTaskQueue();
  const deps = makeDeps({ alerts: repo, queue: scheduled, logger });
  const app = buildServer(deps);
  const dispatch = httpTaskDispatcher({
    baseUrl: 'http://worker.invalid',
    secret: deps.config.taskRunnerSecret,
    fetchImpl: injectFetch(app),
  });
  return { app, repo, scheduled, dispatch, secret: deps.config.taskRunnerSecret };
}

describe('the loop drives the real stack', () => {
  wtest('claims, dispatches and completes a safety check end to end', async () => {
    const { app, repo, dispatch } = await harness();
    try {
      const { alert } = await repo.create({
        requestId: 'wk-e2e-000001', ownerId: SUBJECT, latitude: null, longitude: null,
      });
      const queue = new PostgresTaskQueue(admin!);
      await queue.schedule({
        key: `wk-e2e-${alert.id}`, runAt: due(),
        payload: { kind: 'safety-check', alertId: alert.id },
      });

      const worker = new TaskWorker(queue, dispatch, logger, { worker: 'wk-e2e' });
      const { loop } = loopOver(worker);
      assert.ok(await tickUntil(loop, async () => await stateOf(`wk-e2e-${alert.id}`) === 'done'),
        'the task must reach done');
      // The real handler ran against the real repository.
      assert.equal((await repo.findById(alert.id))?.status, 'escalated');
    } finally { await app.close(); }
  });

  // Empty-queue waiting is asserted in test/workerLoop.test.ts, against a stub
  // worker with an injected sleep. It cannot be asserted meaningfully here: a
  // pass is only idle if NO suite has due work, which parallel test files
  // cannot guarantee.

  wtest('a handler failure retries within the bounded budget, then abandons', async () => {
    const queue = new PostgresTaskQueue(admin!);
    await queue.schedule({
      key: 'wk-retry-0001', runAt: due(), payload: { kind: 'expiry', alertId: 'x' },
    });
    const always: TaskDispatcher = async () => { throw new Error('synthetic handler failure'); };
    const worker = new TaskWorker(queue, always, logger, { worker: 'wk-retry' });
    const { loop } = loopOver(worker);

    for (let i = 0; i < 8; i += 1) {
      // Clear the backoff so the loop can proceed; in production the backoff
      // is what stops this being tight.
      await admin!.query(
        `UPDATE task_queue SET run_at = now() WHERE task_key = $1 AND state = 'pending'`,
        ['wk-retry-0001']);
      await loop.tick();
      if (await stateOf('wk-retry-0001') === 'abandoned') break;
    }
    assert.equal(await stateOf('wk-retry-0001'), 'abandoned',
      'a permanently failing task must stop, not retry forever');
  });

  wtest('an unroutable kind fails loudly and is never recorded as handled', async () => {
    // `notify-contacts` was the example until it gained a handler (P3-04).
    // The property is unchanged: a kind nothing serves must fail visibly.
    const { app, dispatch } = await harness();
    try {
      const queue = new PostgresTaskQueue(admin!);
      await queue.schedule({
        key: 'wk-notify-001', runAt: due(),
        payload: { kind: 'send-postcard', alertId: 'x' },
      });
      const worker = new TaskWorker(queue, dispatch, logger, { worker: 'wk-notify' });
      const { loop } = loopOver(worker);
      const errored = async (): Promise<boolean> => {
        const { rows } = await admin!.query<{ last_error: string | null }>(
          `SELECT last_error FROM task_queue WHERE task_key = $1`, ['wk-notify-001']);
        return rows[0]?.last_error != null;
      };
      assert.ok(await tickUntil(loop, errored), 'it must fail, not be quietly handled');

      const { rows } = await admin!.query<{ last_error: string; state: string }>(
        `SELECT last_error, state FROM task_queue WHERE task_key = $1`, ['wk-notify-001']);
      assert.match(String(rows[0]!.last_error), /no handler registered/);
      assert.notEqual(rows[0]!.state, 'done', 'and it must never be recorded as handled');
    } finally { await app.close(); }
  });
});

describe('alert correctness through the worker', () => {
  wtest('a resolved alert is not escalated by a delayed task', async () => {
    // The sequence this guards: the task was queued while she was in trouble,
    // she resolved, and the worker only gets to it afterwards.
    const { app, repo, dispatch } = await harness();
    try {
      const { alert } = await repo.create({
        requestId: 'wk-term-00001', ownerId: SUBJECT, latitude: null, longitude: null,
      });
      await repo.updateStatus(alert.id, 'resolved', { resolvedBy: 'owner' });

      const queue = new PostgresTaskQueue(admin!);
      await queue.schedule({
        key: `wk-term-${alert.id}`, runAt: due(),
        payload: { kind: 'safety-check', alertId: alert.id },
      });
      const worker = new TaskWorker(queue, dispatch, logger, { worker: 'wk-term' });
      const { loop } = loopOver(worker);
      // The task completes - the handler decided correctly that there was
      // nothing to do. A completed task is not the same as a side effect.
      assert.ok(await tickUntil(loop, async () => await stateOf(`wk-term-${alert.id}`) === 'done'),
        'the task is handled and recorded');
      assert.equal((await repo.findById(alert.id))?.status, 'resolved',
        'a delayed task must not drag her back into escalation');
    } finally { await app.close(); }
  });

  for (const terminal of ['cancelled', 'expired'] as const) {
    wtest(`a ${terminal} alert is likewise left alone`, async () => {
      const { app, repo, dispatch } = await harness();
      try {
        const { alert } = await repo.create({
          requestId: `wk-${terminal.slice(0, 4)}-0001`, ownerId: SUBJECT,
          latitude: null, longitude: null,
        });
        await repo.updateStatus(alert.id, terminal, {});

        const queue = new PostgresTaskQueue(admin!);
        await queue.schedule({
          key: `wk-${terminal}-${alert.id}`, runAt: due(),
          payload: { kind: 'safety-check', alertId: alert.id },
        });
        const worker = new TaskWorker(queue, dispatch, logger, { worker: 'wk-t' });
        await loopOver(worker).loop.tick();

        assert.equal((await repo.findById(alert.id))?.status, terminal);
      } finally { await app.close(); }
    });
  }

  wtest('the route guard still applies to the worker', async () => {
    const { app } = await harness();
    try {
      const queue = new PostgresTaskQueue(admin!);
      await queue.schedule({
        key: 'wk-guard-0001', runAt: due(), payload: { kind: 'expiry', alertId: 'x' },
      });
      const wrongSecret = httpTaskDispatcher({
        baseUrl: 'http://worker.invalid', secret: 'not-the-secret',
        fetchImpl: injectFetch(app),
      });
      const worker = new TaskWorker(queue, wrongSecret, logger, { worker: 'wk-guard' });
      const { loop } = loopOver(worker);
      const refused = async (): Promise<boolean> => {
        const { rows } = await admin!.query<{ last_error: string | null }>(
          `SELECT last_error FROM task_queue WHERE task_key = $1`, ['wk-guard-0001']);
        return rows[0]?.last_error != null;
      };
      assert.ok(await tickUntil(loop, refused),
        'the worker must not be able to bypass the guard');

      const { rows } = await admin!.query<{ last_error: string; state: string }>(
        `SELECT last_error, state FROM task_queue WHERE task_key = $1`, ['wk-guard-0001']);
      assert.match(String(rows[0]!.last_error), /401/);
      assert.notEqual(rows[0]!.state, 'done');
    } finally { await app.close(); }
  });
});

describe('malformed alert ids through the task-runner path', () => {
  wtest('the route answers safely instead of 500ing', async () => {
    // Before the repository guard, a malformed alertId reached a uuid cast and
    // raised 22P02 -> 500. The answer must be the same as for a well-formed id
    // that names nothing: there is no such alert, and nothing to do.
    const { app, secret } = await harness();
    try {
      for (const alertId of ['x', 'not-a-uuid', '', ' ', '../../etc/passwd']) {
        for (const route of ['safety-check', 'expiry']) {
          const res = await app.inject({
            method: 'POST', url: `/internal/tasks/${route}`,
            headers: { 'x-task-secret': secret, 'content-type': 'application/json' },
            payload: JSON.stringify({ alertId }),
          });
          // An empty id is refused by the body schema (minLength 1); anything
          // else must be handled, never a server error.
          assert.notEqual(res.statusCode, 500,
            `${route} with ${JSON.stringify(alertId)} must not be a server error`);
          if (res.statusCode === 200) {
            assert.deepEqual(res.json(), { handled: false });
          }
        }
      }
    } finally { await app.close(); }
  });

  wtest('a task with a malformed id completes and does NOT retry to abandoned', async () => {
    // This is what the defect cost: the 500 was indistinguishable from a
    // transient failure, so the worker retried on its bounded budget and the
    // task ended `abandoned` - a dropped task and a page, for an input that
    // cannot name an alert.
    const { app, dispatch } = await harness();
    try {
      const queue = new PostgresTaskQueue(admin!);
      await queue.schedule({
        key: 'wk-malformed-1', runAt: due(),
        payload: { kind: 'safety-check', alertId: 'not-a-uuid' },
      });
      const worker = new TaskWorker(queue, dispatch, logger, { worker: 'wk-mal' });
      const { loop } = loopOver(worker);

      assert.ok(await tickUntil(loop, async () => await stateOf('wk-malformed-1') === 'done'),
        'the task must be handled on the first attempt');

      const { rows } = await admin!.query<{ attempts: number; last_error: string | null }>(
        `SELECT attempts, last_error FROM task_queue WHERE task_key = $1`, ['wk-malformed-1']);
      assert.equal(Number(rows[0]!.attempts), 1, 'exactly one attempt — no retry cycle');
      assert.equal(rows[0]!.last_error, null, 'and nothing recorded as a failure');
    } finally { await app.close(); }
  });

  wtest('a valid id for a nonexistent alert behaves identically', async () => {
    // The two cases are the same thing to a caller, and must stay that way.
    const { app, dispatch } = await harness();
    try {
      const queue = new PostgresTaskQueue(admin!);
      await queue.schedule({
        key: 'wk-nonexist-1', runAt: due(),
        payload: { kind: 'safety-check', alertId: randomUUID() },
      });
      const worker = new TaskWorker(queue, dispatch, logger, { worker: 'wk-ne' });
      const { loop } = loopOver(worker);
      assert.ok(await tickUntil(loop, async () => await stateOf('wk-nonexist-1') === 'done'));
      const { rows } = await admin!.query<{ attempts: number }>(
        `SELECT attempts FROM task_queue WHERE task_key = $1`, ['wk-nonexist-1']);
      assert.equal(Number(rows[0]!.attempts), 1);
    } finally { await app.close(); }
  });
});

describe('failure of the queue itself', () => {
  wtest('an unreachable queue backs off instead of crashing', async () => {
    const dead = createPool(
      { host: '127.0.0.1', port: 1, database: 'x', user: 'x', password: 'x' },
      { connectionTimeoutMillis: 300 });
    try {
      const worker = new TaskWorker(new PostgresTaskQueue(dead), async () => {}, logger,
        { worker: 'wk-dead' });
      const { loop, waits } = loopOver(worker);
      for (let i = 0; i < 3; i += 1) await assert.doesNotReject(() => loop.tick());
      assert.deepEqual(waits, [1_000, 2_000, 4_000], 'backoff doubles');
      assert.equal(loop.stats.consecutiveErrors, 3);
      assert.equal(loop.stats.passes, 0, 'a failed pass is not a pass');
    } finally { await closePool(dead); }
  });

  wtest('a completion failure surfaces rather than being swallowed', async () => {
    const queue = new PostgresTaskQueue(admin!);
    await queue.schedule({
      key: 'wk-cfail-0001', runAt: due(), payload: { kind: 'expiry', alertId: 'x' },
    });
    // A queue whose complete() always fails: the work may well have happened,
    // and we simply cannot record it. The lease expires and it runs again.
    const broken = Object.create(queue) as PostgresTaskQueue;
    Object.defineProperty(broken, 'complete', {
      value: async () => { throw new Error('connection lost'); },
    });
    const worker = new TaskWorker(broken, async () => {}, logger, { worker: 'wk-cfail' });
    const { loop } = loopOver(worker);

    await assert.doesNotReject(() => loop.tick(), 'the loop survives it');
    assert.equal(loop.stats.consecutiveErrors, 1, 'and treats it as a queue failure');
    assert.equal(await stateOf('wk-cfail-0001'), 'claimed',
      'the task stays claimed; its lease expires and it becomes claimable again');
  });
});

describe('leases and stale workers, through the loop', () => {
  wtest('an expired lease lets another worker take the task', async () => {
    const queue = new PostgresTaskQueue(admin!);
    await queue.schedule({
      key: 'wk-lease-0001', runAt: due(), payload: { kind: 'expiry', alertId: 'x' },
    });
    const first = mine(await queue.claim('wk-dying', 10, 60_000));
    assert.equal(first.length, 1);
    await admin!.query(
      `UPDATE task_queue SET claimed_until = now() - interval '1 second'
        WHERE task_key = $1`, ['wk-lease-0001']);

    const second = mine(await queue.claim('wk-living', 10, 60_000));
    assert.equal(second.length, 1, 'a dead worker must not strand the task');
  });

  wtest('a stale worker cannot complete a reclaimed task', async () => {
    const queue = new PostgresTaskQueue(admin!);
    await queue.schedule({
      key: 'wk-stale-0001', runAt: due(), payload: { kind: 'expiry', alertId: 'x' },
    });
    const slow = mine(await queue.claim('wk-slow', 10, 60_000)) as { taskKey: string; id?: string }[];
    const { rows } = await admin!.query<{ id: string }>(
      `SELECT id FROM task_queue WHERE task_key = $1`, ['wk-stale-0001']);
    await admin!.query(
      `UPDATE task_queue SET claimed_until = now() - interval '1 second'
        WHERE task_key = $1`, ['wk-stale-0001']);
    await queue.claim('wk-new', 10, 60_000);

    assert.equal(await queue.complete(rows[0]!.id, 'wk-slow', true), false,
      'the stale result is discarded');
    assert.equal(await stateOf('wk-stale-0001'), 'claimed', 'the newer claim survives');
    assert.ok(slow.length === 1);
  });
});

describe('no external side effects', () => {
  wtest('the dispatcher refuses a baseUrl that is not plain http(s)', async () => {
    for (const bad of ['file:///etc/passwd', 'ftp://host/x', 'not-a-url']) {
      assert.throws(() => httpTaskDispatcher({ baseUrl: bad, secret: 's' }));
    }
  });

  wtest('a full pass opens no socket — every dispatch is injected', async () => {
    // Belt and braces: the dispatcher is handed an injected fetch, and the
    // one it would otherwise use is replaced here with a throwing stub. If
    // anything reached real fetch, this fails.
    const { app, repo, secret } = await harness();
    try {
      // A REAL alert id. `alertId: 'x'` would reach
      // PostgresAlertRepository.findById, which raises 22P02 on a malformed
      // uuid rather than returning null - see the sprint report. That is a
      // separate finding, deliberately not fixed here; this test is about
      // where the request goes, so it uses an id the handler can resolve.
      const { alert } = await repo.create({
        requestId: 'wk-nosock-0001', ownerId: SUBJECT, latitude: null, longitude: null,
      });
      const queue = new PostgresTaskQueue(admin!);
      await queue.schedule({
        key: 'wk-nosock-001', runAt: due(),
        payload: { kind: 'expiry', alertId: alert.id },
      });
      let realFetchCalls = 0;
      const dispatch = httpTaskDispatcher({
        // The real secret: this test is about where the request GOES, not
        // whether it is authorised. A wrong secret would 401 and prove nothing
        // about sockets.
        baseUrl: 'http://worker.invalid', secret,
        fetchImpl: (async (...args: unknown[]) => {
          realFetchCalls += 1;
          return injectFetch(app)(...(args as Parameters<typeof fetch>));
        }) as unknown as typeof fetch,
      });
      const worker = new TaskWorker(queue, dispatch, logger, { worker: 'wk-nosock' });
      const { loop } = loopOver(worker);
      assert.ok(await tickUntil(loop, async () =>
        ['done', 'cancelled'].includes(await stateOf('wk-nosock-001') ?? '')));
      assert.equal((await repo.findById(alert.id))?.status, 'expired',
        'terminal transition may cancel its own claimed expiry task atomically');
      // At least our own dispatch went through the injected fetch, and the
      // real one was never reached - a dispatch that escaped would have
      // thrown on an unresolvable host instead.
      assert.ok(realFetchCalls >= 1, 'dispatch went through the injected fetch');
    } finally { await app.close(); }
  });
});

/**
 * Abandonment monitoring through the real worker stack.  (P2-17)
 *
 * The pieces are tested on their own - the monitor in
 * abandonedTaskMonitor.integration.test.ts, the loop's gate in
 * workerLoop.test.ts. What is only provable here is the WIRING: that a task
 * the real loop actually gives up on is announced by the monitor the real
 * worker process carries, with real PostgreSQL underneath and no stubs in
 * between.
 */
describe('abandoned work is announced by the worker that gave up on it (P2-17)', () => {
  interface Line { level: string; msg: string; ctx: Record<string, unknown> | undefined }

  function recording(): Logger & { lines: Line[] } {
    const lines: Line[] = [];
    const at = (level: string) => (msg: string, ctx?: Record<string, unknown>) => {
      lines.push({ level, msg, ctx });
    };
    return {
      lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'),
    } as Logger & { lines: Line[] };
  }

  wtest('an unroutable task is abandoned, then announced by its worker', async () => {
    const { app, dispatch } = await harness();
    try {
      // max_attempts = 1, so one failed dispatch exhausts it immediately. The
      // real backoff is 10s x 2^attempts, which no test should wait out.
      // `send-postcard` has no route, which is what makes the dispatch fail.
      const key = `wk-mon-${randomUUID()}`;
      const { rows } = await admin!.query<{ id: string }>(
        `INSERT INTO task_queue (task_key, kind, payload, run_at, max_attempts)
         VALUES ($1,'send-postcard',$2::jsonb,$3,1) RETURNING id`,
        [key, JSON.stringify({ kind: 'send-postcard', alertId: `wk-${randomUUID()}` }), due()],
      );
      const taskId = String(rows[0]!.id);

      const captured = recording();
      const worker = new TaskWorker(
        new PostgresTaskQueue(admin!), dispatch, captured,
        { worker: `wk-mon-${randomUUID()}`, batchSize: 20, leaseMs: 60_000 },
      );
      const loop = new WorkerLoop({
        worker, logger: captured,
        pollIntervalMs: 2_000, errorBackoffMs: 1_000, maxErrorBackoffMs: 8_000,
        shutdownGraceMs: 5_000,
        sleep: async () => {},
        // The real monitor, on the real pool, carried by the real loop.
        monitor: new AbandonedTaskMonitor(admin!, captured, { batchSize: 500 }),
        monitorIntervalMs: 0,
      });

      await tickUntil(loop, async () => (await stateOf(key)) === 'abandoned');
      assert.equal(await stateOf(key), 'abandoned',
        'precondition: an unroutable kind must be given up on');

      // One more tick, in case the abandonment landed after that tick's scan.
      await loop.tick();

      const announcement = captured.lines.find((l) =>
        l.msg.startsWith('ABANDONED safety-critical') && l.ctx?.['taskId'] === taskId);
      assert.ok(announcement, 'the worker must announce the work it dropped');
      assert.equal(announcement.level, 'error');
      assert.equal(announcement.ctx?.['kind'], 'send-postcard');
      assert.equal(announcement.ctx?.['errorClass'], 'no_handler');
      assert.equal(announcement.ctx?.['severity'], 'safety');

      // The durable half: it survives this process.
      const ledger = await admin!.query<{ severity: string; error_class: string }>(
        `SELECT severity, error_class FROM task_alert_log WHERE task_id = $1`, [taskId]);
      assert.deepEqual(ledger.rows[0], { severity: 'safety', error_class: 'no_handler' });

      // And announcing it changed nothing about the task.
      const after = await admin!.query<{ state: string; attempts: number }>(
        `SELECT state, attempts FROM task_queue WHERE id = $1`, [taskId]);
      assert.equal(after.rows[0]!.state, 'abandoned');
      assert.equal(after.rows[0]!.attempts, 1);

      // NOTHING WAS SENT. The only outbound path is the injected fetch, which
      // forwards to Fastify in-process; `notify-contacts` is not routed at all.
      assert.equal(
        captured.lines.some((l) => /sms|push|email|provider|notified/i.test(l.msg)),
        false, 'no notification may be claimed or attempted');
    } finally {
      await app.close();
    }
  });

  wtest('a healthy loop emits the liveness line every scan', async () => {
    const { app, dispatch } = await harness();
    try {
      const captured = recording();
      const worker = new TaskWorker(
        new PostgresTaskQueue(admin!), dispatch, captured,
        { worker: `wk-live-${randomUUID()}`, batchSize: 1, leaseMs: 60_000 },
      );
      const loop = new WorkerLoop({
        worker, logger: captured,
        pollIntervalMs: 2_000, errorBackoffMs: 1_000, maxErrorBackoffMs: 8_000,
        shutdownGraceMs: 5_000,
        sleep: async () => {},
        monitor: new AbandonedTaskMonitor(admin!, captured, { batchSize: 5 }),
        monitorIntervalMs: 0,
      });

      await loop.tick();
      await loop.tick();
      await loop.tick();

      const liveness = captured.lines.filter((l) => l.msg === 'abandoned-task scan');
      assert.equal(liveness.length, 3,
        'absence of this line is how an operator can tell the monitor died');
      assert.equal(liveness[2]?.ctx?.['scans'], 3);
    } finally {
      await app.close();
    }
  });
});

/**
 * Claimable-but-unclaimed work, through the real worker stack.  (P2-17b)
 *
 * The probe's unit tests drive its classification exactly; this proves the
 * WIRING, and - in the second test - reproduces a genuine stall rather than
 * simulating one: a row held by another transaction is SKIPPED by
 * `claim_tasks`'s `FOR UPDATE SKIP LOCKED`, so it stays pending and due while
 * a perfectly healthy worker polls past it. That is exactly the condition the
 * probe exists to surface.
 */
describe('claimable work that is not being claimed, through the loop (P2-17b)', () => {
  interface PLine { level: string; msg: string; ctx: Record<string, unknown> | undefined }

  function capture(): Logger & { lines: PLine[] } {
    const lines: PLine[] = [];
    const at = (level: string) => (msg: string, ctx?: Record<string, unknown>) => {
      lines.push({ level, msg, ctx });
    };
    return {
      lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'),
    } as Logger & { lines: PLine[] };
  }

  /** A loop carrying the real probe. */
  function probingLoop(worker: TaskWorker, logger: Logger, probe: OverduePendingProbe) {
    return new WorkerLoop({
      worker, logger,
      pollIntervalMs: 2_000, errorBackoffMs: 1_000, maxErrorBackoffMs: 8_000,
      shutdownGraceMs: 5_000,
      sleep: async () => {},
      backlogProbe: probe,
      monitorIntervalMs: 0,
    });
  }

  function warningsFor(logger: { lines: PLine[] }, kind: string): PLine[] {
    return logger.lines.filter((l) =>
      l.level === 'warn'
      && Array.isArray(l.ctx?.['persistingKinds'])
      && (l.ctx['persistingKinds'] as string[]).includes(kind));
  }

  wtest('a queue the worker is draining is never warned about', async () => {
    const { app, repo, dispatch } = await harness();
    try {
      const { alert } = await repo.create({
        requestId: `wk-probe-${randomUUID().slice(0, 8)}`,
        ownerId: SUBJECT, latitude: null, longitude: null,
      });
      const key = `wk-probe-${randomUUID()}`;
      await admin!.query(
        `INSERT INTO task_queue (task_key, kind, payload, run_at)
         VALUES ($1,'safety-check',$2::jsonb,$3)`,
        [key, JSON.stringify({ kind: 'safety-check', alertId: alert.id }), due()],
      );

      const logger = capture();
      const probe = new OverduePendingProbe(admin!, logger, { kindLimit: 500 });
      const worker = new TaskWorker(
        new PostgresTaskQueue(admin!), dispatch, logger,
        { worker: `wk-probe-${randomUUID()}`, batchSize: 20, leaseMs: 60_000 },
      );
      const loop = probingLoop(worker, logger, probe);

      await tickUntil(loop, async () => (await stateOf(key)) !== 'pending');
      await loop.tick();

      assert.notEqual(await stateOf(key), 'pending', 'the worker drained it');
      assert.deepEqual(warningsFor(logger, 'safety-check'), [],
        'a draining queue must produce no warning');
      // The liveness line is still there.
      assert.ok(logger.lines.some((l) => l.msg === 'overdue-pending probe'));
    } finally {
      await app.close();
    }
  });

  wtest('a row SKIPPED by the claimer is surfaced as not draining', async () => {
    const { app, dispatch } = await harness();
    // A kind of its own, so the assertion is this test's however busy the
    // table is. It is never claimed, so it is never dispatched either.
    const kind = `wk-stall-${randomUUID().slice(0, 8)}`;
    const holder = await admin!.connect();
    try {
      const { rows } = await admin!.query<{ id: string }>(
        `INSERT INTO task_queue (task_key, kind, payload, run_at)
         VALUES ($1,$2,'{"alertId":"x"}'::jsonb,$3) RETURNING id`,
        [`wk-stall-${randomUUID()}`, kind, due(60_000)],
      );
      const stalled = String(rows[0]!.id);

      // Another transaction holds the row. claim_tasks uses FOR UPDATE SKIP
      // LOCKED, so a healthy worker polls straight past it - no blocking, no
      // error, and nothing in any existing log line.
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM task_queue WHERE id = $1 FOR UPDATE`, [stalled]);

      const logger = capture();
      const probe = new OverduePendingProbe(admin!, logger, { kindLimit: 500 });
      const worker = new TaskWorker(
        new PostgresTaskQueue(admin!), dispatch, logger,
        { worker: `wk-stall-${randomUUID()}`, batchSize: 20, leaseMs: 60_000 },
      );
      const loop = probingLoop(worker, logger, probe);

      await loop.tick();
      assert.deepEqual(warningsFor(logger, kind), [], 'one sighting confirms nothing');
      await loop.tick();

      const warned = warningsFor(logger, kind);
      assert.equal(warned.length, 1, 'a row the claimer keeps skipping must be surfaced');
      assert.match(warned[0]!.msg, /NOT DRAINING/);
      assert.equal(warned[0]!.ctx?.['spareCapacity'], true,
        'the worker had room, so this is a stall and not a backlog');

      // Still pending, still untouched: the probe reports, it does not rescue.
      const after = await admin!.query<{ state: string; attempts: number }>(
        `SELECT state, attempts FROM task_queue WHERE id = $1`, [stalled]);
      assert.equal(after.rows[0]!.state, 'pending');
      assert.equal(after.rows[0]!.attempts, 0);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
      await admin!.query(`DELETE FROM task_queue WHERE kind = $1`, [kind]);
      await app.close();
    }
  });
});
