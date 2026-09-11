import { InMemoryTaskQueue, type TaskQueue } from './TaskQueue.js';

/**
 * The one dependency with no production implementation yet.
 *
 * InMemoryTaskQueue is a Map. It has no timer and no runner: scheduling a task
 * on it stores the task and nothing ever fires. In this system that is not a
 * degraded queue, it is a silent safety failure — the two-minute safety check
 * would never run, a coerced user's alert would never escalate, and her
 * contacts would never be told. Nobody would see an error, because from the
 * request's point of view the schedule succeeded.
 *
 * So it is allowed in development and refused in production. M-07 replaces it
 * with a durable queue; until then, deploying is meant to be impossible.
 */
export function buildTaskQueue(env: 'development' | 'production'): TaskQueue {
  if (env === 'production') {
    throw new Error(
      'No durable TaskQueue is implemented. InMemoryTaskQueue never fires scheduled ' +
      'tasks, so safety checks and escalation would silently never run. ' +
      'Implement the durable queue (M-07) before deploying to production.',
    );
  }
  return new InMemoryTaskQueue();
}
