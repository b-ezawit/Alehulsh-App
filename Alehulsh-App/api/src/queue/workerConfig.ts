/**
 * Configuration for the task worker process.  (M-07)
 *
 * Separate from `loadConfig()` deliberately. The API's config requires
 * FIREBASE_PROJECT_ID, STORAGE_BUCKET and KEYWORD_PEPPER; the worker needs
 * none of them. Reusing it would mean the worker refuses to start for reasons
 * that have nothing to do with its job - and the thing it does is run the
 * safety check, so "failed to start" has a cost.
 *
 * Follows the existing conventions: `required` for anything that must be set,
 * a positive-number check for durations, and NO default connection string
 * anywhere (src/db/pool.ts).
 *
 * NO SECRET VALUE LIVES HERE. TASK_RUNNER_SECRET and the dispatch base URL are
 * read from the environment and never written to source, logs or fixtures.
 */
import { loadDbConfig, type DbConfig } from '../db/pool.js';

export interface WorkerConfig {
  env: 'development' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  db: DbConfig;
  /** Identifies this process in the lease. */
  workerId: string;
  /** Where the /internal/tasks routes live. */
  dispatchBaseUrl: string;
  /** Authenticates the worker to those routes. */
  taskRunnerSecret: string;

  /** Wait between polls when the queue was empty. */
  pollIntervalMs: number;
  /** First wait after a queue failure; doubles up to the cap. */
  errorBackoffMs: number;
  maxErrorBackoffMs: number;
  /** How long a claim is held. MUST exceed dispatchTimeoutMs. */
  leaseMs: number;
  /** Per-dispatch HTTP timeout. */
  dispatchTimeoutMs: number;
  /** Tasks per claim. */
  batchSize: number;
  /** Tasks dispatched at once. */
  concurrency: number;
  /** How long shutdown waits for in-flight work. */
  shutdownGraceMs: number;

  /** Minimum gap between abandoned-task scans.  (P2-17) */
  monitorIntervalMs: number;
  /** Tasks announced per scan. More than this waits for the next scan. */
  monitorBatchSize: number;
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function positive(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number of ms`);
  }
  return n;
}

function positiveInt(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

/**
 * Read and VALIDATE the worker's configuration.
 *
 * Throws on anything missing or incoherent, so the process dies at startup
 * rather than running in a state that quietly loses work. A worker that starts
 * with a lease shorter than its dispatch timeout does not look broken - it
 * just runs every slow task twice.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const level = env['LOG_LEVEL'] ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(level)) {
    throw new Error(`LOG_LEVEL must be debug|info|warn|error, got: ${level}`);
  }
  const mode = env['NODE_ENV'] === 'production' ? 'production' : 'development';
  if (mode === 'production' && level === 'debug') {
    // Debug logging in production is how sensitive values escape.
    throw new Error('LOG_LEVEL=debug is not permitted when NODE_ENV=production');
  }

  // Fails closed with no default connection string: an unconfigured worker
  // cannot silently reach a hosted database.
  const db = loadDbConfig(env);

  const leaseMs = positive('TASK_LEASE_MS', 60_000, env);
  const dispatchTimeoutMs = positive('TASK_DISPATCH_TIMEOUT_MS', 10_000, env);

  // The invariant that matters most, and the one nothing else would catch: a
  // lease shorter than the dispatch timeout means a slow task is reclaimed
  // while it is still running, and executed twice for no reason.
  if (leaseMs <= dispatchTimeoutMs) {
    throw new Error(
      `TASK_LEASE_MS (${leaseMs}) must exceed TASK_DISPATCH_TIMEOUT_MS ` +
      `(${dispatchTimeoutMs}), or a slow task is reclaimed while still in flight`,
    );
  }

  const errorBackoffMs = positive('TASK_ERROR_BACKOFF_MS', 1_000, env);
  const maxErrorBackoffMs = positive('TASK_MAX_ERROR_BACKOFF_MS', 30_000, env);
  if (maxErrorBackoffMs < errorBackoffMs) {
    throw new Error(
      `TASK_MAX_ERROR_BACKOFF_MS (${maxErrorBackoffMs}) must be at least ` +
      `TASK_ERROR_BACKOFF_MS (${errorBackoffMs})`,
    );
  }

  return {
    env: mode,
    logLevel: level as WorkerConfig['logLevel'],
    db,
    // Distinct per process. The hostname/pid default is good enough to tell
    // two workers apart in a lease, and carries nothing sensitive.
    workerId: env['TASK_WORKER_ID']?.trim() || `worker-${process.pid}`,
    dispatchBaseUrl: required('TASK_DISPATCH_BASE_URL', env),
    taskRunnerSecret: required('TASK_RUNNER_SECRET', env),
    pollIntervalMs: positive('TASK_POLL_INTERVAL_MS', 2_000, env),
    errorBackoffMs,
    maxErrorBackoffMs,
    leaseMs,
    dispatchTimeoutMs,
    batchSize: positiveInt('TASK_BATCH_SIZE', 10, env),
    concurrency: positiveInt('TASK_CONCURRENCY', 4, env),
    shutdownGraceMs: positive('TASK_SHUTDOWN_GRACE_MS', 15_000, env),

    // P2-17. Deliberately NO off switch: a safety platform should not ship an
    // environment variable that silently disables the only thing watching for
    // dropped safety work. The interval can be lengthened, not removed.
    monitorIntervalMs: positive('TASK_MONITOR_INTERVAL_MS', 60_000, env),
    monitorBatchSize: positiveInt('TASK_MONITOR_BATCH_SIZE', 100, env),
  };
}
