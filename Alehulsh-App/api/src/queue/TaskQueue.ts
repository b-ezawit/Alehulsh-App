/**
 * Swap point #3 of 3. See docs/api-layer.md.
 *
 * Cloud Tasks now; a Postgres-backed queue after C-04 (M-07).
 *
 * Scheduled delivery is the point: the safety check fires two minutes after an
 * alert and must be *cancellable* when she resolves. A cron sweeping a table
 * cannot express that cleanly. See coercion-and-escalation.md §3.
 */
export interface ScheduledTask {
  /** Caller-supplied so it can be cancelled without bookkeeping. */
  key: string;
  runAt: Date;
  payload: Record<string, unknown>;
}

export interface TaskQueue {
  schedule(task: ScheduledTask): Promise<void>;
  cancel(key: string): Promise<void>;
}

/** For tests and local runs. Never used in a deployed environment. */
export class InMemoryTaskQueue implements TaskQueue {
  readonly scheduled = new Map<string, ScheduledTask>();
  async schedule(task: ScheduledTask): Promise<void> {
    this.scheduled.set(task.key, task);
  }
  async cancel(key: string): Promise<void> {
    this.scheduled.delete(key);
  }
}
