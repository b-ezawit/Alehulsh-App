/**
 * Connection lifecycle: transactions, release, shutdown, and what happens
 * when PostgreSQL is not there.  (sprint 3, P5)
 *
 * A leaked client is worse than a failed request. The pool has a fixed size,
 * so one leak per failure means the pool drains and every later SOS waits on a
 * connection that is never coming back - a failure mode that gets worse under
 * exactly the load that matters.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import type { Pool } from 'pg';
import {
  createPool, loadDbConfig, withTransaction, closePool, type Queryable,
} from '../src/db/pool.js';

let cfg: ReturnType<typeof loadDbConfig> | null = null;
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
  try { cfg = loadDbConfig(); } catch {
    skipReason = 'PG* environment not configured (fail-closed, not assumed)';
    return;
  }
  if (!(await reachable(cfg.host, cfg.port))) {
    skipReason = 'no PostgreSQL reachable on the configured host:port';
    return;
  }
  available = true;
});

function ptest(name: string, fn: (pool: Pool) => Promise<void>): void {
  test(name, async (t) => {
    if (!available) { t.skip(skipReason); return; }
    // A small pool on purpose: a leak shows up as exhaustion within the test
    // rather than as a slow drain nobody notices.
    const pool = createPool(cfg!, { max: 2, connectionTimeoutMillis: 2000 });
    try {
      await fn(pool);
    } finally {
      await closePool(pool);
    }
  });
}

describe('withTransaction', () => {
  ptest('commits when the body returns', async (pool) => {
    const value = await withTransaction(pool, async (tx) => {
      await tx.query(`CREATE TEMP TABLE pg_tx_commit (v int)`);
      await tx.query(`INSERT INTO pg_tx_commit VALUES (1)`);
      const { rows } = await tx.query<{ v: number }>(`SELECT v FROM pg_tx_commit`);
      return rows[0]!.v;
    });
    assert.equal(value, 1);
  });

  ptest('rolls back when the body throws, and reports the ORIGINAL error', async (pool) => {
    const original = new Error('the actual reason');
    await assert.rejects(
      () => withTransaction(pool, async (tx) => {
        await tx.query(`SELECT 1`);
        throw original;
      }),
      (e: unknown) => e === original,
      'a failure during cleanup must not replace why the work was abandoned');
  });

  ptest('releases the connection on success, so the pool does not drain', async (pool) => {
    // More iterations than the pool has connections: if any were kept, this
    // would block until the connection timeout and fail.
    for (let i = 0; i < 6; i += 1) {
      await withTransaction(pool, async (tx) => { await tx.query(`SELECT $1::int`, [i]); });
    }
    assert.equal(pool.idleCount > 0, true, 'connections came back to the pool');
    assert.equal(pool.waitingCount, 0, 'and nothing is queued behind a leak');
  });

  ptest('releases the connection on failure too', async (pool) => {
    for (let i = 0; i < 6; i += 1) {
      await assert.rejects(() => withTransaction(pool, async (tx) => {
        await tx.query(`SELECT $1::int`, [i]);
        throw new Error('fail');
      }));
    }
    // The real assertion: the pool is still usable at all.
    const { rows } = await withTransaction(pool, async (tx) =>
      tx.query<{ ok: number }>(`SELECT 1 AS ok`));
    assert.equal(rows[0]!.ok, 1, 'the pool survived six failed transactions');
  });

  ptest('releases the connection when the SQL itself fails', async (pool) => {
    for (let i = 0; i < 6; i += 1) {
      await assert.rejects(() => withTransaction(pool, async (tx) => {
        await tx.query(`SELECT * FROM a_table_that_does_not_exist`);
      }));
    }
    const { rows } = await withTransaction(pool, async (tx) =>
      tx.query<{ ok: number }>(`SELECT 1 AS ok`));
    assert.equal(rows[0]!.ok, 1);
  });

  ptest('a handle kept past the end of its transaction is refused', async (pool) => {
    // pg does NOT invalidate a released client: without the TransactionScope
    // guard, this handle kept issuing statements on the same backend
    // connection the pool had already handed to the next caller - verified by
    // pg_backend_pid - and could run BEGIN and COMMIT on it. A stray COMMIT
    // from code holding an old handle would commit someone else's
    // half-finished unit of work.
    let escaped: Queryable | null = null;
    await withTransaction(pool, async (tx) => { escaped = tx; });

    await assert.rejects(() => escaped!.query(`SELECT 1`), /transaction has ended/);
    await assert.rejects(() => escaped!.query(`COMMIT`), /transaction has ended/,
      'especially transaction control');

    const { rows } = await withTransaction(pool, async (tx) =>
      tx.query<{ ok: number }>(`SELECT 1 AS ok`));
    assert.equal(rows[0]!.ok, 1, 'and the pool is still healthy afterwards');
  });

  ptest('a handle is refused after a FAILED transaction too', async (pool) => {
    let escaped: Queryable | null = null;
    await assert.rejects(() => withTransaction(pool, async (tx) => {
      escaped = tx;
      throw new Error('fail');
    }));
    await assert.rejects(() => escaped!.query(`SELECT 1`), /transaction has ended/);
  });

  ptest('deferred COMMIT failure discards the backend and cannot leak local identity to its replacement', async (pool) => {
    let previousPid = 0;
    let escaped: Queryable | undefined;
    await assert.rejects(() => withTransaction(pool, async (tx) => {
      escaped = tx;
      const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      previousPid = rows[0]!.pid;
      await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, ['synthetic-private-subject']);
      await tx.query('CREATE TEMP TABLE pg_deferred_commit_failure (v int UNIQUE DEFERRABLE INITIALLY DEFERRED)');
      // INSERT succeeds; the unique violation is raised only by COMMIT.
      await tx.query('INSERT INTO pg_deferred_commit_failure VALUES (1),(1)');
    }), (err: unknown) => (err as { code?: string }).code === '23505');
    assert.equal(pool.totalCount, 0, 'the uncertain connection was discarded');
    await assert.rejects(() => escaped!.query('SELECT 1'), /transaction has ended/);
    const { rows } = await pool.query<{ pid: number; subject: string | null }>(
      `SELECT pg_backend_pid() AS pid, current_setting('request.jwt.claim.sub', true) AS subject`);
    assert.notEqual(rows[0]!.pid, previousPid, 'subsequent work runs on a new backend');
    assert.equal(rows[0]!.subject, null, 'the prior transaction identity cannot survive');
  });

  ptest('concurrent transactions do not see each other', async (pool) => {
    const [a, b] = await Promise.all([
      withTransaction(pool, async (tx) => {
        await tx.query(`CREATE TEMP TABLE pg_iso_a (v int)`);
        await tx.query(`INSERT INTO pg_iso_a VALUES (1)`);
        const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_iso_a`);
        return rows[0]!.n;
      }),
      withTransaction(pool, async (tx) => {
        await tx.query(`CREATE TEMP TABLE pg_iso_b (v int)`);
        const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_iso_b`);
        return rows[0]!.n;
      }),
    ]);
    assert.equal(a, 1);
    assert.equal(b, 0, 'a temp table in one transaction is invisible to the other');
  });
});

describe('shutdown', () => {
  ptest('closePool is idempotent', async (pool) => {
    await closePool(pool);
    await closePool(pool);   // must not throw
    await closePool(pool);
  });

  ptest('closePool does not throw when the pool is already broken', async (pool) => {
    await pool.end();
    await assert.doesNotReject(() => closePool(pool));
  });

  ptest('a closed pool refuses work rather than hanging', async (pool) => {
    await closePool(pool);
    await assert.rejects(() => pool.query(`SELECT 1`));
  });
});

describe('when PostgreSQL is unavailable', () => {
  test('a connection failure surfaces, and no client is leaked', async (t) => {
    // Port 1: nothing listens, and connecting is refused immediately rather
    // than timing out, so this is fast and deterministic.
    const dead = createPool(
      { host: '127.0.0.1', port: 1, database: 'x', user: 'x', password: 'x' },
      { max: 2, connectionTimeoutMillis: 500 });
    try {
      for (let i = 0; i < 4; i += 1) {
        await assert.rejects(() => withTransaction(dead, async (tx) => tx.query(`SELECT 1`)));
      }
      // If withTransaction had kept a client on the connect failure, the pool
      // would be exhausted and this would report queued callers.
      assert.equal(dead.waitingCount, 0, 'nothing is queued behind a leaked client');
      assert.equal(dead.totalCount, 0, 'and no connection is held open');
    } finally {
      await closePool(dead);
    }
  });

  test('the error does not carry the password', async (t) => {
    const dead = createPool(
      { host: '127.0.0.1', port: 1, database: 'synthetic', user: 'synthetic', password: 'sentinel-not-a-real-secret' },
      { connectionTimeoutMillis: 500 });
    try {
      const err = await dead.query(`SELECT 1`).then(() => null, (e: unknown) => e);
      const text = `${String(err)}${JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}))}`;
      assert.ok(!text.includes('sentinel-not-a-real-secret'),
        'a connection error must not serialise the credential');
    } finally {
      await closePool(dead);
    }
  });
});
