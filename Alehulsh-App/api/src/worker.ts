import { requireRestrictedRuntimeLogin } from './db/runtimeLogin.js';
/**
 * The task worker process.  (M-07)
 *
 * Claims due tasks from PostgreSQL and dispatches them to the authenticated
 * /internal/tasks routes. A separate process from the API deliberately: it
 * scales on queue depth rather than request volume, and a worker wedged on a
 * slow dispatch must not consume the API's connections.
 *
 * NO NOTIFICATION IS SENT. The dispatcher routes `safety-check` and `expiry`
 * only; `notify-contacts` has no handler and is deliberately unrouted, so an
 * unroutable kind fails loudly and ends `abandoned` rather than being quietly
 * handled. Contact fan-out is not part of this.
 *
 * WHAT THIS FILE OWNS, and nothing else: configuration, signals, exit codes.
 * The loop is WorkerLoop; one pass is TaskWorker; retries, leases and the
 * stale-worker guard are database functions. Nothing is duplicated here.
 *
 * DEPLOYMENT-TIME CONFIGURATION, all unset in this repository:
 *
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD   the queue (fail-closed)
 *   TASK_DISPATCH_BASE_URL                           where the API is
 *   TASK_RUNNER_SECRET                               authenticates to it
 *
 * Optional, with defaults: TASK_WORKER_ID, TASK_POLL_INTERVAL_MS,
 * TASK_LEASE_MS, TASK_DISPATCH_TIMEOUT_MS, TASK_BATCH_SIZE, TASK_CONCURRENCY,
 * TASK_ERROR_BACKOFF_MS, TASK_MAX_ERROR_BACKOFF_MS, TASK_SHUTDOWN_GRACE_MS,
 * TASK_MONITOR_INTERVAL_MS, TASK_MONITOR_BATCH_SIZE.
 *
 * No secret value and no production URL appears in this repository, and this
 * process reads them only from the environment. Where they come from at
 * deployment is an open decision, still unmade. Note also that `alehulsh_api`
 * is NOLOGIN today, so this process cannot connect in production at all until
 * that credential decision lands.
 */
import { createLogger } from './logger.js';
import { closePool, createPool, createApiDatabase } from './db/pool.js';
import { AbandonedTaskMonitor } from './queue/AbandonedTaskMonitor.js';
import { OverduePendingProbe } from './queue/OverduePendingProbe.js';
import { buildTaskQueue, isDurable } from './queue/buildTaskQueue.js';
import { PostgresTaskQueue } from './queue/PostgresTaskQueue.js';
import { TaskWorker, httpTaskDispatcher } from './queue/TaskWorker.js';
import { WorkerLoop } from './queue/WorkerLoop.js';
import { loadWorkerConfig } from './queue/workerConfig.js';

/** Exit codes, so an orchestrator can tell these apart. */
export const EXIT_CONFIG = 2;
export const EXIT_FATAL = 1;

export async function main(): Promise<void> {
  // Configuration first, and nothing else before it. An unrecoverable config
  // error must kill the process at startup rather than after it has claimed
  // work it cannot dispatch.
  const config = loadWorkerConfig();
  const logger = createLogger(config.logLevel);

  const pool = createPool(config.db);
  try { await requireRestrictedRuntimeLogin(pool); }
  catch (error) { await closePool(pool); throw error; }
  const database = createApiDatabase(pool);
  const queue = buildTaskQueue(config.env, { pool: database });

  if (!isDurable(queue)) {
    // Unreachable in production - buildTaskQueue throws there - but a worker
    // polling a Map would claim nothing forever while looking healthy, which
    // is the one failure mode worse than not starting.
    throw new Error(
      'the task worker requires the durable queue; an in-memory queue has nothing to claim',
    );
  }

  const dispatcher = httpTaskDispatcher({
    baseUrl: config.dispatchBaseUrl,
    secret: config.taskRunnerSecret,
    timeoutMs: config.dispatchTimeoutMs,
  });

  const taskWorker = new TaskWorker(queue as PostgresTaskQueue, dispatcher, logger, {
    worker: config.workerId,
    batchSize: config.batchSize,
    leaseMs: config.leaseMs,
    concurrency: config.concurrency,
  });

  // P2-17. Observability for work the queue gave up on. Reads task_queue and
  // appends to task_alert_log; it cannot claim, complete or cancel anything,
  // and it sends nothing anywhere - stdout and a database row are all there
  // is. Nothing collects stdout, so that is a durable RECORD, not an alert:
  // no destination, no on-call, and no guarantee a human ever sees it.
  //
  // It lives in this process because the worker is where the queue is already
  // being polled. If no worker is deployed nothing monitors, which is the same
  // precondition the queue itself has.
  const monitor = new AbandonedTaskMonitor(database, logger, {
    batchSize: config.monitorBatchSize,
  });

  // P2-17b. The other half of the picture: work the queue has NOT given up on
  // and is also not claiming. Read-only - one SELECT, no state touched, and
  // no threshold, because none has been approved. It reports the measurement a
  // threshold would have to be chosen from.
  //
  // It cannot detect the worst case, no worker running at all: nothing scans
  // when nothing runs. That needs a check OUTSIDE this process - the claim
  // predicate run from elsewhere, or an alarm on the absence of the periodic
  // scan lines these two emit.
  const backlogProbe = new OverduePendingProbe(database, logger);

  const loop = new WorkerLoop({
    worker: taskWorker,
    logger,
    pollIntervalMs: config.pollIntervalMs,
    errorBackoffMs: config.errorBackoffMs,
    maxErrorBackoffMs: config.maxErrorBackoffMs,
    shutdownGraceMs: config.shutdownGraceMs,
    monitor,
    backlogProbe,
    monitorIntervalMs: config.monitorIntervalMs,
  });

  // Not registerShutdownHandlers: that drains an HTTP server then closes
  // teardowns, and this process has no server. The ordering here is the same
  // idea though - stop claiming, let the pass finish, THEN release the pool,
  // because the pass needs its connections to record outcomes.
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      logger.warn('second signal received; exiting immediately', { signal });
      process.exit(EXIT_FATAL);
      return;
    }
    shuttingDown = true;
    logger.info('worker shutting down', { signal, workerId: config.workerId });
    void (async () => {
      await loop.stop();
      await closePool(pool);
      logger.info('worker stopped cleanly', { passes: loop.stats.passes });
      process.exit(0);
    })();
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as NodeJS.Signals[]) {
    process.on(signal, onSignal);
  }

  logger.info('task worker starting', {
    workerId: config.workerId,
    env: config.env,
    // Timing only. The base URL is omitted: it is not secret, but it is of no
    // use in a log line and keeping config values out of logs by default is
    // the habit that stops the secret ones leaking.
    pollIntervalMs: config.pollIntervalMs,
    leaseMs: config.leaseMs,
    batchSize: config.batchSize,
    concurrency: config.concurrency,
    monitorIntervalMs: config.monitorIntervalMs,
  });

  loop.start();
}

/**
 * Only runs when this file is the entry point, so importing it in a test does
 * not start a loop.
 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // stderr, not the logger: the logger may be what failed to build. A
    // config error is distinguished by its exit code so an orchestrator does
    // not restart-loop on something restarting cannot fix.
    process.stderr.write(`fatal: ${message}\n`);
    process.exit(/Missing required|must be|must exceed|not permitted/.test(message)
      ? EXIT_CONFIG : EXIT_FATAL);
  });
}
