/**
 * Real PostgreSQL regression tests for migration 0014. Synthetic local data
 * only: this suite refuses non-loopback PGHOST and never loads .dev.vars.
 * A transaction-local fault injects a failing task insert after state changes.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, loadDbConfig, withTransaction, type Queryable } from '../src/db/pool.js';

const OWNER = randomUUID();
const SUBJECT = `atomic-${randomUUID()}`;
const SUFFIX = randomUUID().replace(/-/g, '');
const FAIL_FUNCTION = `test_atomic_work_fail_${SUFFIX}`;
const FAIL_TRIGGER = `test_atomic_work_trigger_${SUFFIX}`;
const DELAY = 47_000;
let pool: Pool | undefined;
let available = false;
let skipReason = 'local PG* environment not configured';

before(async () => {
  let config;
  try { config = loadDbConfig(); } catch { return; }
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    skipReason = 'this destructive fault-injection suite requires loopback PGHOST';
    return;
  }
  pool = createPool(config, { max: 2 });
  // Configured local failures are test failures, not silent skips.
  await pool.query('SELECT 1');
  await pool.query(`INSERT INTO users(id, display_name) VALUES ($1, 'AtomicWorkFixture')`, [OWNER]);
  await pool.query(`INSERT INTO identity_map(firebase_uid, user_id) VALUES ($1, $2)`, [SUBJECT, OWNER]);
  await pool.query(`CREATE FUNCTION public.${FAIL_FUNCTION}() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('alehulsh.test_fail_task_kind', true) = NEW.kind
        AND (NEW.kind <> 'notify-contacts' OR NEW.task_key LIKE '%:escalation')
        AND EXISTS (SELECT 1 FROM public.alerts a
          WHERE a.id::text = NEW.payload->>'alertId' AND a.owner_id = '${OWNER}'::uuid)
      THEN RAISE EXCEPTION 'synthetic required-task insertion failure'
        USING DETAIL = NEW.payload->>'alertId'; END IF;
      RETURN NEW;
    END $$`);
  await pool.query(`CREATE TRIGGER ${FAIL_TRIGGER} BEFORE INSERT ON public.task_queue
    FOR EACH ROW EXECUTE FUNCTION public.${FAIL_FUNCTION}()`);
  available = true;
});

after(async () => {
  if (!pool) return;
  try {
    await pool.query(`DROP TRIGGER IF EXISTS ${FAIL_TRIGGER} ON public.task_queue`);
    await pool.query(`DROP FUNCTION IF EXISTS public.${FAIL_FUNCTION}()`);
    await clearRows();
    await pool.query('DELETE FROM users WHERE id = $1', [OWNER]);
  } finally { await pool.end(); }
});

async function clearRows() {
  await pool!.query(`DELETE FROM task_queue t WHERE t.payload->>'alertId' IN
    (SELECT a.id::text FROM alerts a WHERE a.owner_id = $1)`, [OWNER]);
  await pool!.query('DELETE FROM alerts WHERE owner_id = $1', [OWNER]);
  await pool!.query('DELETE FROM alert_history WHERE owner_id = $1', [OWNER]);
}

function dbtest(name: string, fn: () => Promise<void>) {
  test(name, async (t) => {
    if (!available) { t.skip(skipReason); return; }
    await clearRows();
    await fn();
  });
}

async function create(request: string, db: Queryable = pool!) {
  const { rows } = await db.query<{ alert_id: string; created: boolean }>(
    `SELECT * FROM create_alert_with_tasks($1,$2,NULL,NULL,NULL,NULL,
      interval '2 hours',NULL,120000,$3)`, [SUBJECT, request, DELAY]);
  assert.ok(rows[0]?.alert_id);
  return rows[0]!;
}

async function tasks(id: string) {
  const { rows } = await pool!.query<{
    task_key: string; kind: string; run_at: Date; state: string;
    completed_at: Date | null; claimed_by: string | null; claimed_until: Date | null;
  }>(`SELECT task_key, kind, run_at, state, completed_at, claimed_by, claimed_until
      FROM task_queue WHERE payload->>'alertId' = $1 ORDER BY task_key`, [id]);
  return rows;
}

describe('required alert work commits with PostgreSQL emergency state', () => {
  dbtest('a required task insertion failure rolls back new alert and audit history', async () => {
    let failedAlertId = '';
    await assert.rejects(withTransaction(pool!, async (tx) => {
      await tx.query(`SELECT set_config('alehulsh.test_fail_task_kind','expiry',true)`);
      await create('atomic-create-fail', tx);
    }), (error: unknown) => {
      assert.match((error as Error).message, /synthetic required-task insertion failure/);
      failedAlertId = (error as { detail: string }).detail;
      assert.match(failedAlertId, /^[0-9a-f-]{36}$/);
      return true;
    });
    const alerts = await pool!.query('SELECT id FROM alerts WHERE owner_id = $1', [OWNER]);
    const history = await pool!.query('SELECT id FROM alert_history WHERE owner_id = $1', [OWNER]);
    assert.equal(alerts.rowCount, 0);
    assert.equal(history.rowCount, 0);
    // The first enqueue succeeded before the injected second-insert failure;
    // rollback must remove that task too, not merely the alert.
    const queued = await pool!.query(`SELECT id FROM task_queue WHERE payload->>'alertId' = $1`, [failedAlertId]);
    assert.equal(queued.rowCount, 0);
    assert.equal((await create('atomic-create-fail')).created, true, 'the failed request can be retried');
  });

  dbtest('failure enqueueing escalation notification rolls back escalation and its audit entry', async () => {
    const { alert_id } = await create('atomic-escalate-fail');
    const before = await tasks(alert_id);
    const historyBefore = await pool!.query('SELECT id FROM alert_history WHERE alert_id = $1', [alert_id]);
    await assert.rejects(withTransaction(pool!, async (tx) => {
      await tx.query(`SELECT set_config('alehulsh.test_fail_task_kind','notify-contacts',true)`);
      await tx.query(`SELECT transition_alert_with_tasks($1,'escalated','api','no_answer',NULL)`, [alert_id]);
    }), /synthetic required-task insertion failure/);
    const { rows } = await pool!.query('SELECT status, escalated_at FROM alerts WHERE id = $1', [alert_id]);
    assert.equal(rows[0]!.status, 'active');
    assert.equal(rows[0]!.escalated_at, null);
    assert.deepEqual(await tasks(alert_id), before);
    const historyAfter = await pool!.query('SELECT id FROM alert_history WHERE alert_id = $1', [alert_id]);
    assert.equal(historyAfter.rowCount, historyBefore.rowCount);
    await pool!.query(`SELECT transition_alert_with_tasks($1,'escalated','api','no_answer',NULL)`, [alert_id]);
    const repaired = await tasks(alert_id);
    assert.equal(repaired.filter((r) => r.kind === 'notify-contacts').length, 2);
  });

  dbtest('failed-keyword task failure rolls back attempt count, escalation, and audit entry together', async () => {
    const { alert_id } = await create('atomic-keyword-rollback');
    const before = await tasks(alert_id);
    const historyBefore = await pool!.query('SELECT id FROM alert_history WHERE alert_id=$1', [alert_id]);
    await assert.rejects(withTransaction(pool!, async (tx) => {
      await tx.query(`SELECT set_config('alehulsh.test_fail_task_kind','notify-contacts',true)`);
      await tx.query('SELECT fail_keyword_attempt_with_tasks($1,$2)', [alert_id, new Date()]);
    }), /synthetic required-task insertion failure/);
    const { rows } = await pool!.query(`SELECT status,attempt_count,last_attempt_at,escalated_at
      FROM alerts WHERE id=$1`, [alert_id]);
    assert.deepEqual(rows[0], { status: 'active', attempt_count: 0, last_attempt_at: null, escalated_at: null });
    assert.deepEqual(await tasks(alert_id), before);
    assert.equal((await pool!.query('SELECT id FROM alert_history WHERE alert_id=$1', [alert_id])).rowCount,
      historyBefore.rowCount);
  });

  dbtest('failed keyword increments once and commits escalation with its notification', async () => {
    const { alert_id } = await create('atomic-keyword-success');
    const at = new Date();
    await pool!.query('SELECT fail_keyword_attempt_with_tasks($1,$2)', [alert_id, at]);
    const { rows } = await pool!.query(`SELECT status,attempt_count,last_attempt_at,escalation_reason
      FROM alerts WHERE id=$1`, [alert_id]);
    assert.equal(rows[0]!.status, 'escalated');
    assert.equal(rows[0]!.attempt_count, 1);
    assert.equal((rows[0]!.last_attempt_at as Date).getTime(), at.getTime());
    assert.equal(rows[0]!.escalation_reason, 'wrong_keyword');
    assert.equal((await tasks(alert_id)).filter((task) => task.task_key.endsWith(':escalation')).length, 1);
  });

  dbtest('failed keyword after escalation preserves original reason and repairs its missing work', async () => {
    const { alert_id } = await create('atomic-keyword-repair');
    await pool!.query(`SELECT transition_alert_with_tasks($1,'escalated','api','no_answer',NULL)`, [alert_id]);
    const { rows: prior } = await pool!.query('SELECT escalated_at FROM alerts WHERE id=$1', [alert_id]);
    const notification = (await tasks(alert_id)).find((task) => task.task_key.endsWith(':escalation'))!;
    await pool!.query('DELETE FROM task_queue WHERE task_key=$1', [notification.task_key]);
    await pool!.query('SELECT fail_keyword_attempt_with_tasks($1,$2)', [alert_id, new Date()]);
    const { rows } = await pool!.query('SELECT attempt_count,escalation_reason,escalated_at FROM alerts WHERE id=$1', [alert_id]);
    assert.equal(rows[0]!.attempt_count, 1);
    assert.equal(rows[0]!.escalation_reason, 'no_answer');
    assert.equal((rows[0]!.escalated_at as Date).getTime(), (prior[0]!.escalated_at as Date).getTime());
    assert.deepEqual((await tasks(alert_id)).find((task) => task.task_key.endsWith(':escalation')), notification);
  });

  dbtest('failed keyword cannot increment or enqueue after any terminal state', async () => {
    for (const status of ['resolved', 'cancelled', 'expired']) {
      await clearRows();
      const { alert_id } = await create(`atomic-keyword-terminal-${status}`);
      await pool!.query(`SELECT transition_alert_with_tasks($1,$2::alert_status,'api',NULL,'owner')`, [alert_id, status]);
      const before = await tasks(alert_id);
      await pool!.query('SELECT fail_keyword_attempt_with_tasks($1,$2)', [alert_id, new Date()]);
      const { rows } = await pool!.query('SELECT status,attempt_count,last_attempt_at FROM alerts WHERE id=$1', [alert_id]);
      assert.deepEqual(rows[0], { status, attempt_count: 0, last_attempt_at: null });
      assert.deepEqual(await tasks(alert_id), before);
    }
  });

  dbtest('retry repairs missing initialization using the original safety deadline', async () => {
    const { alert_id } = await create('atomic-repair-deadline');
    const original = await tasks(alert_id);
    assert.equal(original.length, 3);
    const safety = original.find((t) => t.kind === 'safety-check')!;
    await pool!.query(`DELETE FROM task_queue WHERE payload->>'alertId' = $1 AND kind = 'safety-check'`, [alert_id]);
    const retry = await create('atomic-repair-deadline');
    assert.equal(retry.alert_id, alert_id);
    assert.equal(retry.created, false);
    const repaired = await tasks(alert_id);
    assert.deepEqual(repaired, original);
    const { rows } = await pool!.query<{ created_at: Date }>('SELECT created_at FROM alerts WHERE id = $1', [alert_id]);
    assert.equal(safety.run_at.getTime(), rows[0]!.created_at.getTime() + DELAY);
  });

  dbtest('a repeated escalation repairs a missing contact task without advancing its deadline', async () => {
    const { alert_id } = await create('atomic-repair-escalation');
    await pool!.query(`SELECT transition_alert_with_tasks($1,'escalated','api','wrong_keyword',NULL)`, [alert_id]);
    const original = (await tasks(alert_id)).find((t) => t.task_key.endsWith(':escalation'))!;
    assert.ok(original);
    await pool!.query('DELETE FROM task_queue WHERE task_key = $1', [original.task_key]);
    await pool!.query(`SELECT transition_alert_with_tasks($1,'escalated','api','no_answer',NULL)`, [alert_id]);
    const repaired = (await tasks(alert_id)).find((t) => t.task_key.endsWith(':escalation'))!;
    assert.deepEqual(repaired, original);
    const { rows } = await pool!.query('SELECT escalation_reason FROM alerts WHERE id = $1', [alert_id]);
    assert.equal(rows[0]!.escalation_reason, 'wrong_keyword');
  });

  dbtest('terminal retries preserve pending retraction and cancel other work with valid terminal metadata', async () => {
    const { alert_id } = await create('atomic-terminal-retry');
    await pool!.query(`UPDATE task_queue SET state='claimed', claimed_by='synthetic-worker',
      claimed_until=now()+interval '1 minute' WHERE payload->>'alertId'=$1 AND kind='safety-check'`, [alert_id]);
    await pool!.query(`SELECT transition_alert_with_tasks($1,'resolved','api',NULL,'owner')`, [alert_id]);
    const before = await tasks(alert_id);
    const cleanup = before.find((t) => t.kind === 'retract-inbox')!;
    assert.equal(cleanup.state, 'pending');
    for (const row of before.filter((t) => t.kind !== 'retract-inbox')) {
      assert.equal(row.state, 'cancelled');
      assert.ok(row.completed_at);
      assert.equal(row.claimed_by, null);
      assert.equal(row.claimed_until, null);
    }
    await pool!.query(`SELECT transition_alert_with_tasks($1,'resolved','api',NULL,'owner')`, [alert_id]);
    const after = await tasks(alert_id);
    assert.equal(after.filter((t) => t.kind === 'retract-inbox').length, 1);
    assert.deepEqual(after.find((t) => t.kind === 'retract-inbox'), cleanup);
  });
});
