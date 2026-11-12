import type { Queryable } from '../db/pool.js';
import type { Logger } from '../logger.js';
import { PostgresTaskQueue } from './PostgresTaskQueue.js';
import { TaskWorker, type RunResult, type TaskDispatcher } from './TaskWorker.js';

export interface TaskBatchOptions {
  /** Unique for this invocation, so a stale invocation cannot complete another's lease. */
  worker: string;
  batchSize?: number;
  concurrency?: number;
  leaseMs?: number;
  /** The injected dispatcher must enforce this timeout, e.g. httpTaskDispatcher. */
  dispatchTimeoutMs: number;
}

const MAX_BATCH_SIZE = 100;

/**
 * One bounded pass for a scheduled/event handler. This reuses the PostgreSQL
 * queue and its existing lease/retry authority; it starts no polling loop and
 * does not keep a transaction open during dispatch.
 *
 * The caller supplies a timeout-enforcing dispatcher and a Queryable with
 * bounded connection/query timeouts. This bounds the AMOUNT of work claimed,
 * not arbitrary code inside an injected dispatcher or driver. Await the pass
 * from the hosting handler so the runtime does not discard in-flight work.
 */
export async function runTaskBatch(
  db: Queryable,
  dispatch: TaskDispatcher,
  logger: Logger,
  options: TaskBatchOptions,
): Promise<RunResult> {
  const batchSize = options.batchSize ?? 10;
  const concurrency = options.concurrency ?? Math.min(4, batchSize);
  const leaseMs = options.leaseMs ?? 60_000;
  const timeout = options.dispatchTimeoutMs;
  if (!options.worker.trim()) throw new Error('task batch requires a non-empty worker identity');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`task batch size must be an integer from 1 to ${MAX_BATCH_SIZE}`);
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > batchSize) {
    throw new Error('task batch concurrency must be an integer from 1 to batch size');
  }
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error('task dispatch timeout must be a positive safe integer');
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000) {
    throw new Error('task lease must be a safe integer of at least one second');
  }
  // PostgresTaskQueue rounds to seconds. Include queued lanes in the budget:
  // the final task's lease started when the whole batch was claimed, not when
  // that task finally entered its dispatch lane.
  const actualLeaseMs = Math.round(leaseMs / 1000) * 1000;
  const dispatchBudgetMs = Math.ceil(batchSize / concurrency) * timeout;
  if (!Number.isSafeInteger(actualLeaseMs) || !Number.isSafeInteger(dispatchBudgetMs)
    || actualLeaseMs <= dispatchBudgetMs) {
    throw new Error('task lease must exceed the entire batch dispatch budget');
  }
  return new TaskWorker(new PostgresTaskQueue(db), dispatch, logger, {
    worker: options.worker.trim(), batchSize, concurrency, leaseMs,
  }).runOnce();
}
