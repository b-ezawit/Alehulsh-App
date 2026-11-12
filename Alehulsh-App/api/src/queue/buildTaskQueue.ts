import type { Queryable } from '../db/pool.js';
import { PostgresTaskQueue } from './PostgresTaskQueue.js';
import { InMemoryTaskQueue, type TaskQueue } from './TaskQueue.js';

/**
 * Chooses the queue implementation.  (M-07)
 *
 * InMemoryTaskQueue is a Map. It has no timer and no runner: scheduling a task
 * on it stores the task and nothing ever fires. In this system that is not a
 * degraded queue, it is a silent safety failure - the two-minute safety check
 * would never run, a coerced user's alert would never escalate, and her
 * contacts would never be told. Nobody would see an error, because from the
 * request's point of view the schedule succeeded.
 *
 * So production REQUIRES the durable implementation and refuses to start
 * without it. The refusal moved rather than disappeared: it used to mean "M-07
 * is unimplemented", and now means "M-07 is implemented but not configured".
 * The one thing that must never happen - production silently holding tasks in
 * a Map - is still impossible.
 */
export function buildTaskQueue(
  env: 'development' | 'production',
  options: { pool?: Queryable | undefined } = {},
): TaskQueue {
  const { pool } = options;

  if (env === 'production') {
    if (!pool) {
      // Fail closed, and say what to do about it.
      throw new Error(
        'No durable TaskQueue: production requires a PostgreSQL connection. ' +
        'Set PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD (see src/db/pool.ts). ' +
        'Refusing to start rather than fall back to the in-memory queue, which ' +
        'never fires scheduled tasks — safety checks and escalation would ' +
        'silently never run.',
      );
    }
    return new PostgresTaskQueue(pool);
  }

  // Development may use the durable queue too, and should when a database is
  // available: testing against a Map proves nothing about the queue that will
  // actually run.
  return pool ? new PostgresTaskQueue(pool) : new InMemoryTaskQueue();
}

/**
 * Whether this queue can actually fire anything.
 *
 * Exists so a caller can warn accurately instead of assuming. The old code
 * warned whenever `env !== 'production'`, which would now be wrong: a
 * development run with a database gets the real queue.
 */
export function isDurable(queue: TaskQueue): boolean {
  return queue instanceof PostgresTaskQueue;
}
