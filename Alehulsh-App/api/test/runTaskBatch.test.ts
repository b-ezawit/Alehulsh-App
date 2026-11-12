import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Queryable } from '../src/db/pool.js';
import type { Logger } from '../src/logger.js';
import { runTaskBatch, type TaskBatchOptions } from '../src/queue/runTaskBatch.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const OPTIONS: TaskBatchOptions = {
  worker: 'scheduled-invocation-one', batchSize: 4, concurrency: 2,
  leaseMs: 10_000, dispatchTimeoutMs: 1000,
};
function row(id: string) {
  return {
    id, task_key: `safety-check:${id}`, kind: 'safety-check',
    payload: { kind: 'safety-check', alertId: `alert-${id}` }, run_at: new Date(),
    attempts: 1, max_attempts: 5,
  };
}

class ScriptedDb implements Queryable {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  completeOwned = true;
  claimError: Error | undefined;
  completeError: Error | undefined;
  constructor(readonly rows = [row('1')]) {}
  async query<R extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    this.calls.push({ sql, params });
    let rows: unknown[];
    if (sql.includes('claim_tasks(')) {
      if (this.claimError) throw this.claimError;
      rows = this.rows.slice(0, Number(params[1]));
    } else if (sql.includes('complete_task(')) {
      if (this.completeError) throw this.completeError;
      rows = [{ complete_task: this.completeOwned }];
    } else {
      throw new Error('the pass must use only the existing claim/complete functions');
    }
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult<R>;
  }
}

describe('scheduled task batches reuse durable queue authority', () => {
  test('one pass claims a bounded batch with the configured lease and completes each task', async () => {
    const db = new ScriptedDb([row('1'), row('2')]);
    const dispatched: string[] = [];
    const result = await runTaskBatch(db, async (task) => { dispatched.push(task.id); }, logger, OPTIONS);
    assert.deepEqual(result, { claimed: 2, succeeded: 2, failed: 0, lost: 0 });
    assert.deepEqual(dispatched.sort(), ['1', '2']);
    assert.deepEqual(db.calls[0]!.params, [OPTIONS.worker, 4, '10 seconds']);
    assert.equal(db.calls.filter((c) => c.sql.includes('claim_tasks(')).length, 1);
    const completions = db.calls.filter((c) => c.sql.includes('complete_task('));
    assert.equal(completions.length, 2);
    assert.ok(completions.every((c) => c.params[1] === OPTIONS.worker && c.params[2] === true));
  });

  test('empty passes return immediately without dispatch or another claim', async () => {
    const db = new ScriptedDb([]);
    const result = await runTaskBatch(db, async () => { assert.fail('no tasks were claimed'); }, logger, OPTIONS);
    assert.deepEqual(result, { claimed: 0, succeeded: 0, failed: 0, lost: 0 });
    assert.equal(db.calls.length, 1);
  });

  test('failure is recorded for database retry and a later invocation uses the next attempt', async () => {
    const db = new ScriptedDb();
    const failed = await runTaskBatch(db, async () => { throw new Error('synthetic dispatch failure'); }, logger, OPTIONS);
    assert.equal(failed.failed, 1);
    assert.deepEqual(db.calls[1]!.params, ['1', OPTIONS.worker, false, 'synthetic dispatch failure']);
    // Backoff and retry eligibility are database responsibilities. This fake
    // only scripts the next claim; database integration tests prove timing.
    db.rows[0]!.attempts = 2;
    const next = await runTaskBatch(db, async (task) => { assert.equal(task.attempts, 2); }, logger,
      { ...OPTIONS, worker: 'scheduled-invocation-two' });
    assert.equal(next.succeeded, 1);
    assert.equal(db.calls.filter((c) => c.sql.includes('claim_tasks(')).length, 2);
    assert.deepEqual(db.calls[3]!.params, ['1', 'scheduled-invocation-two', true, null]);
  });

  test('a stale lease completion is reported lost, not successful', async () => {
    const db = new ScriptedDb();
    db.completeOwned = false;
    assert.deepEqual(await runTaskBatch(db, async () => {}, logger, OPTIONS), {
      claimed: 1, succeeded: 0, failed: 0, lost: 1,
    });
    assert.equal(db.calls.length, 2);
  });

  test('claim and outcome-recording outages propagate without spinning', async () => {
    const brokenClaim = new ScriptedDb();
    brokenClaim.claimError = new Error('synthetic claim outage');
    await assert.rejects(runTaskBatch(brokenClaim, async () => {}, logger, OPTIONS), /claim outage/);
    assert.equal(brokenClaim.calls.length, 1);
    const brokenComplete = new ScriptedDb();
    brokenComplete.completeError = new Error('synthetic completion outage');
    await assert.rejects(runTaskBatch(brokenComplete, async () => {}, logger, OPTIONS), /completion outage/);
    assert.equal(brokenComplete.calls.length, 2);
  });

  test('concurrency bounds dispatch across the entire claimed batch', async () => {
    const db = new ScriptedDb([row('1'), row('2'), row('3'), row('4')]);
    let active = 0;
    let peak = 0;
    await runTaskBatch(db, async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
    }, logger, OPTIONS);
    assert.equal(peak, 2);
    assert.equal(active, 0);
  });
});

describe('bounds are checked before any task can be claimed', () => {
  test('invalid work identities, sizes, timeouts and leases make no database call', async () => {
    const variants: Array<Partial<TaskBatchOptions>> = [
      { worker: '' }, { worker: '  ' }, { batchSize: 0 }, { batchSize: -1 },
      { batchSize: 101 }, { batchSize: 1.5 }, { batchSize: NaN },
      { concurrency: 0 }, { concurrency: 5 }, { concurrency: 1.5 },
      { leaseMs: 0 }, { leaseMs: 999 }, { leaseMs: Infinity }, { leaseMs: Number.MAX_SAFE_INTEGER },
      { dispatchTimeoutMs: 0 }, { dispatchTimeoutMs: NaN }, { dispatchTimeoutMs: 1.5 },
    ];
    for (const variant of variants) {
      const db = new ScriptedDb();
      await assert.rejects(runTaskBatch(db, async () => {}, logger, { ...OPTIONS, ...variant }));
      assert.equal(db.calls.length, 0, 'invalid options must not acquire task leases');
    }
  });

  test('the lease covers waiting dispatch lanes, not only a single task timeout', async () => {
    const db = new ScriptedDb();
    await assert.rejects(runTaskBatch(db, async () => {}, logger, {
      ...OPTIONS, batchSize: 10, concurrency: 1, leaseMs: 5000, dispatchTimeoutMs: 1000,
    }), /entire batch dispatch budget/);
    assert.equal(db.calls.length, 0);
  });

  test('lease rounding cannot produce a lease equal to the dispatch budget', async () => {
    const db = new ScriptedDb();
    await assert.rejects(runTaskBatch(db, async () => {}, logger, {
      ...OPTIONS, batchSize: 1, concurrency: 1, leaseMs: 10_499, dispatchTimeoutMs: 10_000,
    }), /entire batch dispatch budget/);
    assert.equal(db.calls.length, 0);
  });
});
