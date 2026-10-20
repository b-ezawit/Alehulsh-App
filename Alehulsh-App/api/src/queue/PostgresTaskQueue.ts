/**
 * TaskQueue backed by PostgreSQL.  (M-07)
 *
 * Implements the SAME interface as InMemoryTaskQueue, so nothing above it
 * changes: routes keep calling `schedule` and `cancel`.
 *
 * Storage only. It does not run anything - see TaskWorker. That separation is
 * the existing design's, not a new one: `requireTaskRunner`
 * (src/auth/taskAuth.ts) was written with the note that "the same check works
 * when the queue becomes a Postgres worker at C-04 (M-07)", so execution was
 * always meant to stay behind the authenticated /internal/tasks routes.
 *
 * Every invariant lives in a database function (enqueue_task, cancel_task), so
 * a future caller cannot bypass them. All SQL is parameterised.
 */
import type { Queryable } from '../db/pool.js';
import type { ScheduledTask, TaskQueue } from './TaskQueue.js';

/** The queue row as claim_tasks returns it. */
export interface ClaimedTask {
  id: string;
  taskKey: string;
  kind: string;
  payload: Record<string, unknown>;
  runAt: Date;
  /** Includes this claim, so a first attempt reports 1. */
  attempts: number;
  maxAttempts: number;
}

interface TaskRow {
  id: string;
  task_key: string;
  kind: string;
  payload: Record<string, unknown>;
  run_at: Date;
  attempts: number;
  max_attempts: number;
}

function mapTask(row: TaskRow): ClaimedTask {
  return {
    id: String(row.id),
    taskKey: row.task_key,
    kind: row.kind,
    payload: row.payload,
    runAt: row.run_at,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
  };
}

/**
 * Read the task kind out of an opaque payload.
 *
 * `ScheduledTask.payload` is a `Record<string, unknown>` by contract, so the
 * kind is not guaranteed. It is stored for logging and metrics ONLY - the
 * handler reads the payload itself - so an absent kind is recorded as
 * 'unknown' rather than refused. Losing a safety check to a metadata field
 * would be the wrong trade.
 */
function kindOf(payload: Record<string, unknown>): string {
  const kind = payload['kind'];
  return typeof kind === 'string' && kind.length > 0 ? kind : 'unknown';
}

export class PostgresTaskQueue implements TaskQueue {
  /**
   * @param db a Pool for ordinary calls, or one transaction's client when the
   *   caller owns a transaction. Taking a Queryable is what lets an alert and
   *   its scheduled work commit together: a queue bound to its own pool
   *   connection would commit independently, leaving a scheduled safety check
   *   for an alert that was rolled back. Never issues BEGIN/COMMIT/ROLLBACK.
   */
  constructor(private readonly db: Queryable) {}

  /** The same queue bound to one transaction. */
  withQueryable(db: Queryable): PostgresTaskQueue {
    return new PostgresTaskQueue(db);
  }

  /**
   * Durable, and idempotent on `key`.
   *
   * A repeated schedule of the same key is a no-op - it does NOT move `runAt`
   * later. That is deliberate and safety-relevant: if re-triggering an SOS
   * pushed the safety check back, someone under coercion could be kept from
   * escalating indefinitely by tapping the button again.
   */
  async schedule(task: ScheduledTask): Promise<void> {
    await this.db.query(
      `SELECT enqueue_task($1::text, $2::text, $3::jsonb, $4::timestamptz)`,
      [task.key, kindOf(task.payload), JSON.stringify(task.payload), task.runAt],
    );
  }

  /**
   * Cancels pending and claimed work alike.
   *
   * Silent when there is nothing to cancel: a resolve arriving after the check
   * already ran is normal, not an error.
   */
  async cancel(key: string): Promise<void> {
    await this.db.query(`SELECT cancel_task($1::text)`, [key]);
  }

  /**
   * Claim up to `limit` due tasks for `worker`, for the length of `leaseMs`.
   *
   * The lease must outlast the slowest dispatch, or a slow task is reclaimed
   * while still running and executed twice for no reason.
   */
  async claim(worker: string, limit = 10, leaseMs = 60_000): Promise<ClaimedTask[]> {
    const lease = `${Math.max(1, Math.round(leaseMs / 1000))} seconds`;
    const { rows } = await this.db.query<TaskRow>(
      `SELECT id, task_key, kind, payload, run_at, attempts, max_attempts
         FROM claim_tasks($1::text, $2::int, $3::interval)`,
      [worker, limit, lease],
    );
    return rows.map(mapTask);
  }

  /**
   * Report the outcome. Returns false when this worker no longer owns the task
   * - its lease expired and someone else took it, or it was cancelled.
   *
   * On failure the task returns to pending with exponential backoff until
   * `max_attempts`, then becomes `abandoned`. Bounded, so a permanently
   * failing task cannot spin.
   */
  async complete(
    taskId: string, worker: string, ok: boolean, error?: string,
  ): Promise<boolean> {
    const { rows } = await this.db.query<{ complete_task: boolean }>(
      `SELECT complete_task($1::bigint, $2::text, $3::boolean, $4::text)`,
      [taskId, worker, ok, error ?? null],
    );
    return rows[0]?.complete_task === true;
  }
}
