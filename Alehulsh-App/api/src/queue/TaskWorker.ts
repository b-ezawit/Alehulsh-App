/**
 * Runs due tasks.  (M-07)
 *
 * Storage is PostgresTaskQueue; this is execution, and the two are separate
 * because the existing design already separated them. `requireTaskRunner`
 * (src/auth/taskAuth.ts) authenticates a task runner against the
 * /internal/tasks routes and says so explicitly: "the same check works when
 * the queue becomes a Postgres worker at C-04 (M-07)". So this worker claims
 * from the database and dispatches to those routes rather than re-implementing
 * the handlers - which already re-read the alert, skip terminal ones, and are
 * documented idempotent for at-least-once delivery.
 *
 * DELIVERY IS AT-LEAST-ONCE. A worker that dispatches successfully and then
 * dies before completing the row will run that task again after the lease
 * expires. Nothing here claims otherwise, and nothing should: the handlers are
 * idempotent precisely because this is unavoidable.
 *
 * NO TRANSACTION IS HELD DURING DISPATCH. Claim, dispatch, and complete are
 * three separate statements. Holding a transaction open across a network call
 * would pin a connection for the length of the slowest external service.
 */
import type { Logger } from '../logger.js';
import type { ClaimedTask, PostgresTaskQueue } from './PostgresTaskQueue.js';

/**
 * Executes one task. Throwing means failure, and the task is retried with
 * backoff until max_attempts.
 *
 * Injected so tests drive real queue mechanics with a fake executor and make
 * no network call - and so this worker cannot accidentally become the thing
 * that sends a real notification.
 */
export type TaskDispatcher = (task: ClaimedTask) => Promise<void>;

export interface TaskWorkerOptions {
  /** Identifies this worker in the lease. Distinct per process. */
  worker: string;
  /** Tasks per claim. Bounded so one worker cannot starve the others. */
  batchSize?: number;
  /** Lease length. MUST exceed the slowest dispatch. */
  leaseMs?: number;
  /** Tasks dispatched at once. Bounded so a batch cannot fan out unboundedly. */
  concurrency?: number;
}

export interface RunResult {
  claimed: number;
  succeeded: number;
  failed: number;
  /** Dispatched, but the row was no longer ours to complete. */
  lost: number;
}

const DEFAULTS = { batchSize: 10, leaseMs: 60_000, concurrency: 4 };

export class TaskWorker {
  private readonly opts: Required<TaskWorkerOptions>;
  private stopping = false;
  /** Resolves when the current pass has finished. */
  private inFlight: Promise<unknown> | null = null;

  constructor(
    private readonly queue: PostgresTaskQueue,
    private readonly dispatch: TaskDispatcher,
    private readonly logger: Logger,
    options: TaskWorkerOptions,
  ) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /**
   * One pass: claim a batch, run it, record every outcome.
   *
   * Never throws for a task's sake - one failing task must not abandon the
   * rest of the batch. A failure to reach the database at all DOES throw, so a
   * broken queue is loud rather than an endless run of empty passes.
   */
  async runOnce(): Promise<RunResult> {
    if (this.stopping) return { claimed: 0, succeeded: 0, failed: 0, lost: 0 };

    const tasks = await this.queue.claim(
      this.opts.worker, this.opts.batchSize, this.opts.leaseMs,
    );
    if (tasks.length === 0) return { claimed: 0, succeeded: 0, failed: 0, lost: 0 };

    const result: RunResult = { claimed: tasks.length, succeeded: 0, failed: 0, lost: 0 };

    // Bounded concurrency: a fixed number of lanes pulling from one list,
    // rather than Promise.all over the whole batch.
    const pending = [...tasks];
    const lanes = Array.from(
      { length: Math.min(this.opts.concurrency, pending.length) },
      async () => {
        for (;;) {
          const task = pending.shift();
          if (!task) return;
          const outcome = await this.runTask(task);
          result[outcome] += 1;
        }
      },
    );

    // One lane can fail recording its outcome while another is still sending
    // or completing work. Settle every lane before rejecting the pass, so a
    // scheduled hosting handler (or shutdown) cannot end their execution early.
    const settled = Promise.allSettled(lanes);
    this.inFlight = settled;
    try {
      const outcomes = await settled;
      const failure = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } finally {
      this.inFlight = null;
    }
    return result;
  }

  /** @returns which counter to increment. */
  private async runTask(task: ClaimedTask): Promise<'succeeded' | 'failed' | 'lost'> {
    // Structured and deliberately thin: ids, kind, attempt. The PAYLOAD IS
    // NEVER LOGGED - it carries an alert id, and for a future notification
    // task would carry more.
    const ctx = {
      taskId: task.id, kind: task.kind,
      attempt: task.attempts, maxAttempts: task.maxAttempts,
    };

    let ok = false;
    let failure: string | undefined;
    try {
      await this.dispatch(task);
      ok = true;
    } catch (err: unknown) {
      // Recorded, never swallowed: a swallowed error would be reported as
      // success and the task would never retry.
      failure = err instanceof Error ? err.message : String(err);
    }

    let owned: boolean;
    try {
      owned = await this.queue.complete(task.id, this.opts.worker, ok, failure);
    } catch (err: unknown) {
      // The work may well have happened; we simply cannot record it. Loud,
      // because the lease will expire and the task will run again.
      this.logger.error('task outcome could not be recorded', {
        ...ctx, ok, detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (!owned) {
      // Lease expired and someone else took it, or it was cancelled. Either
      // way this worker's result is discarded - which is why handlers must be
      // idempotent.
      this.logger.warn('task completed by a worker that no longer owned it', { ...ctx, ok });
      return 'lost';
    }

    if (ok) {
      this.logger.info('task done', ctx);
      return 'succeeded';
    }

    const exhausted = task.attempts >= task.maxAttempts;
    // error, not warn, when exhausted: an abandoned task means something that
    // should have happened did not. For a safety check that is a woman whose
    // alert never escalated.
    this.logger[exhausted ? 'error' : 'warn'](
      exhausted ? 'task ABANDONED after final attempt' : 'task failed, will retry',
      { ...ctx, detail: failure },
    );
    return 'failed';
  }

  /**
   * Stop claiming and let the current pass finish.
   *
   * Leases are NOT force-released: a lease released early could be claimed by
   * another worker while this one is still mid-dispatch. Letting them expire
   * costs at most one lease interval of delay and cannot double-run anything
   * that is still running.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.inFlight) {
      await this.inFlight.catch(() => { /* already logged per task */ });
    }
    this.logger.info('task worker stopped', { worker: this.opts.worker });
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /**
   * The most this worker will claim in one pass.
   *
   * Exposed so a diagnostic can tell a STALL from a BACKLOG: a pass that
   * claimed fewer than this had spare capacity, so anything still claimable
   * was not taken for some other reason. Read-only; nothing can change it.
   */
  get batchSize(): number {
    return this.opts.batchSize;
  }
}

/**
 * Dispatches a task to the authenticated /internal/tasks route for its kind.
 *
 * The route guard is unchanged: the same `x-task-secret` the existing handlers
 * already require. This deliberately does not reach into the handlers, so
 * their authorization stays in exactly one place.
 *
 * `notify-contacts` IS NOW ROUTED (P3-04). Its handler writes a durable
 * projection into each contact's inbox and calls no external service. An
 * unroutable kind still fails, retries within its bounded budget and ends
 * `abandoned` - loudly, which remains the correct outcome for work nobody can
 * perform.
 */
export function httpTaskDispatcher(options: {
  /** MUST come from trusted configuration. See the validation below. */
  baseUrl: string;
  secret: string;
  /** Must be shorter than the worker's lease. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): TaskDispatcher {
  const routes: Record<string, string> = {
    'safety-check': '/internal/tasks/safety-check',
    expiry: '/internal/tasks/expiry',
    'retract-inbox': '/internal/tasks/retract-inbox',
    // P3-04. Now routed: it writes durable inbox rows for her contacts and
    // sends nothing externally. Before this it had no route, so every
    // escalation produced a task that retried to exhaustion and abandoned.
    'notify-contacts': '/internal/tasks/notify-contacts',
  };
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  /**
   * Validated once, at construction, so a bad value fails at startup rather
   * than on the first alert.
   *
   * Every request carries `x-task-secret`, which authenticates the endpoint
   * that escalates alerts. So where that header is sent matters as much as
   * what it protects: a mistyped base URL does not merely break the worker, it
   * hands the secret to whoever is on the other end.
   */
  let origin: URL;
  try {
    origin = new URL(options.baseUrl);
  } catch {
    throw new Error('task dispatcher baseUrl is not a URL');
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new Error(`task dispatcher baseUrl must be http(s), got ${origin.protocol}`);
  }
  if (origin.username !== '' || origin.password !== '') {
    // Credentials in a URL end up in logs and process listings.
    throw new Error('task dispatcher baseUrl must not embed credentials');
  }

  return async (task: ClaimedTask): Promise<void> => {
    const path = routes[task.kind];
    if (!path) {
      throw new Error(`no handler registered for task kind '${task.kind}'`);
    }
    const alertId = task.payload['alertId'];
    if (typeof alertId !== 'string' || alertId.length === 0) {
      throw new Error(`task ${task.kind} carries no alertId`);
    }

    // Resolved against the validated origin, and pinned to it. `path` comes
    // from the fixed table above, so this cannot currently escape - the check
    // is here so it still cannot if that table ever takes a dynamic value.
    const url = new URL(path, origin);
    if (url.origin !== origin.origin) {
      throw new Error('task route resolved outside the configured origin');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-task-secret': options.secret },
        body: JSON.stringify({ alertId, ...(typeof task.payload['alertKey'] === 'string'
          ? { alertKey: task.payload['alertKey'] } : {}) }),
        signal: controller.signal,
        // VERIFIED LEAK, now closed: fetch follows redirects by default and
        // forwards custom headers across origins. A redirect from the task
        // route - through misconfiguration or a compromised hop - sent
        // `x-task-secret` to the redirect target. Measured against two local
        // servers: the secret arrived at both.
        //
        // An internal task route has no legitimate reason to redirect, so a
        // redirect is an error rather than something to follow.
        redirect: 'error',
      });
      if (!res.ok) {
        // Status only. A body could echo request content back into the log.
        throw new Error(`task route returned ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
