/**
 * The polling loop around TaskWorker.  (M-07)
 *
 * TaskWorker.runOnce() does one pass: claim, dispatch, record. This drives it
 * continuously and owns exactly three concerns it cannot:
 *
 *   when to poll again, how to survive a queue that is unreachable, and when
 *   to stop.
 *
 * Deliberately NOT a second queue abstraction: it adds no retry logic, never
 * completes a task itself, and holds no state about individual tasks. Retries,
 * leases and the stale-worker guard all stay in the database functions and
 * TaskWorker, where they are already tested.
 *
 * No process concerns here either - no signals, no exit codes, no timers
 * beyond an injectable sleep. That lives in src/worker.ts, so this is
 * deterministically testable without waiting for real time to pass.
 */
import type { Logger } from '../logger.js';
import type { AbandonedTaskMonitor } from './AbandonedTaskMonitor.js';
import type { OverduePendingProbe } from './OverduePendingProbe.js';
import type { RunResult, TaskWorker } from './TaskWorker.js';

export interface WorkerLoopOptions {
  worker: TaskWorker;
  logger: Logger;
  /** Wait after a pass that claimed nothing. */
  pollIntervalMs: number;
  /** First wait after a queue failure. Doubles, capped. */
  errorBackoffMs: number;
  maxErrorBackoffMs: number;
  /** How long stop() waits for the pass in flight. */
  shutdownGraceMs: number;
  /**
   * Watches for abandoned tasks.  (P2-17)
   *
   * Carried here rather than given its own loop because it needs exactly what
   * this loop already owns - a cadence and a process - and a second loop would
   * duplicate both. It is NOT part of a pass: it never claims, completes or
   * cancels anything, its failures do not touch `consecutiveErrors` or the
   * poll backoff, and it cannot be the reason a safety check does not run.
   */
  monitor?: AbandonedTaskMonitor | null;
  /**
   * Watches for claimable work that is NOT BEING CLAIMED.  (P2-17b)
   *
   * Read-only, and on the same gate as the monitor above - both are the
   * periodic diagnostic step, and a second interval knob would be two numbers
   * to keep in step for no benefit. Error-isolated separately, so one
   * diagnostic failing does not hide the other.
   */
  backlogProbe?: OverduePendingProbe | null;
  /** Minimum gap between monitor and probe scans. Independent of the poll interval. */
  monitorIntervalMs?: number;
  /** Injected so tests need not wait for real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so the monitor's gate is deterministic in tests. */
  now?: () => number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

export interface LoopStats {
  passes: number;
  claimed: number;
  succeeded: number;
  failed: number;
  lost: number;
  /** Consecutive queue failures. Reset by any successful pass. */
  consecutiveErrors: number;
}

export class WorkerLoop {
  private readonly opts: Required<WorkerLoopOptions>;
  private running = false;
  private stopping = false;
  /** The loop's own promise, awaited by stop(). */
  private loop: Promise<void> | null = null;
  private backoffMs: number;

  readonly stats: LoopStats = {
    passes: 0, claimed: 0, succeeded: 0, failed: 0, lost: 0, consecutiveErrors: 0,
  };

  /**
   * NEGATIVE_INFINITY, so the FIRST tick scans.
   *
   * That is the restart-recovery property: a worker coming up must report
   * tasks that were abandoned while nothing was running, not only ones it
   * witnesses itself.
   */
  private lastMonitorAt = Number.NEGATIVE_INFINITY;

  constructor(options: WorkerLoopOptions) {
    this.opts = {
      sleep: realSleep,
      now: () => Date.now(),
      monitor: null,
      backlogProbe: null,
      monitorIntervalMs: 60_000,
      ...options,
    };
    this.backoffMs = this.opts.errorBackoffMs;
  }

  /**
   * Begin polling. Returns immediately; the loop runs in the background.
   *
   * Calling it twice is a no-op rather than a second loop. Two loops on one
   * TaskWorker would claim under the same worker identity, so each could
   * complete work the other was running - the stale-worker guard is keyed on
   * the worker id and cannot tell them apart.
   */
  start(): void {
    if (this.running) {
      this.opts.logger.warn('worker loop already running; ignoring start');
      return;
    }
    if (this.stopping) {
      this.opts.logger.warn('worker loop is stopping; not restarting');
      return;
    }
    this.running = true;
    this.loop = this.run().finally(() => { this.running = false; });
  }

  /** One pass plus its wait. Exposed so tests can step the loop. */
  async tick(): Promise<RunResult | null> {
    if (this.stopping) return null;

    let result: RunResult;
    try {
      result = await this.opts.worker.runOnce();
    } catch (err: unknown) {
      // The queue itself is unreachable - not one task failing, which
      // runOnce() handles internally and never throws for.
      //
      // The worker does NOT exit. A database blip must not take down the
      // process that runs safety checks, because nothing would restart it
      // except an orchestrator that cannot tell this apart from a crash loop.
      // It backs off instead, and says so every time: an operator watching
      // this needs to see it continuing to fail, not one line and silence.
      this.stats.consecutiveErrors += 1;
      this.opts.logger.error('worker pass failed; backing off', {
        consecutiveErrors: this.stats.consecutiveErrors,
        backoffMs: this.backoffMs,
        detail: err instanceof Error ? err.message : String(err),
      });
      await this.opts.sleep(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxErrorBackoffMs);
      return null;
    }

    // A pass that reached the database resets the backoff, whatever the tasks
    // in it did. Task failures are the queue working, not the queue being
    // broken.
    this.stats.consecutiveErrors = 0;
    this.backoffMs = this.opts.errorBackoffMs;

    this.stats.passes += 1;
    this.stats.claimed += result.claimed;
    this.stats.succeeded += result.succeeded;
    this.stats.failed += result.failed;
    this.stats.lost += result.lost;

    // After the pass and BEFORE the idle wait, so an idle loop still monitors
    // on schedule. Gated by time, so a busy loop polling flat out does not
    // scan on every pass.
    //
    // `result` is handed to the diagnostics because what this pass managed to
    // claim is evidence: a pass with spare capacity that nonetheless left work
    // claimable is a different problem from one that filled its batch.
    await this.maybeMonitor(result);

    if (result.claimed === 0) {
      // An empty queue must not become a spin. Anything above zero means
      // there may be more due work, so the next pass goes straight away -
      // waiting with a full batch outstanding would add latency to an
      // emergency for no reason.
      await this.opts.sleep(this.opts.pollIntervalMs);
    }
    return result;
  }

  /**
   * Scan for abandoned tasks, at most once per `monitorIntervalMs`.
   *
   * `scan()` is documented never to throw and swallows its own failures
   * loudly; the catch here is insurance, so that a BUG in monitoring can
   * still never stop the loop that runs safety checks. Nothing about a
   * monitor failure feeds the poll backoff or the pass counters - an
   * unobserved abandonment is bad, but it is not the queue failing.
   */
  private async maybeMonitor(result: RunResult): Promise<void> {
    const monitor = this.opts.monitor;
    const probe = this.opts.backlogProbe;
    if (!monitor && !probe) return;

    const now = this.opts.now();
    if (now - this.lastMonitorAt < this.opts.monitorIntervalMs) return;
    // Stamped BEFORE the awaits, so a slow scan cannot be started twice.
    this.lastMonitorAt = now;

    if (monitor) {
      try {
        await monitor.scan();
      } catch (err: unknown) {
        this.opts.logger.error('abandoned-task monitor threw; task processing continues', {
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Separately isolated: one diagnostic breaking must not take the other
    // down with it, or a bug in the newer one would silently disable
    // abandonment reporting.
    if (probe) {
      try {
        await probe.scan({
          claimed: result.claimed,
          capacity: this.opts.worker.batchSize,
        });
      } catch (err: unknown) {
        this.opts.logger.error('overdue-pending probe threw; task processing continues', {
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async run(): Promise<void> {
    this.opts.logger.info('worker loop started', {
      pollIntervalMs: this.opts.pollIntervalMs,
    });
    while (!this.stopping) {
      await this.tick();
    }
    this.opts.logger.info('worker loop finished', {
      passes: this.stats.passes,
      claimed: this.stats.claimed,
      succeeded: this.stats.succeeded,
      failed: this.stats.failed,
      lost: this.stats.lost,
    });
  }

  /**
   * Stop claiming and let the pass in flight finish, within the grace period.
   *
   * Bounded on purpose. If the grace expires the loop is abandoned rather than
   * waited on: the tasks it was running keep their leases, which expire and
   * make the work claimable again. That is the correct trade - at most one
   * lease interval of delay, versus a shutdown that never completes and gets
   * SIGKILLed mid-write.
   *
   * Nothing is marked complete here. TaskWorker records an outcome only after
   * its dispatch returns, so abandoning a pass can never report unfinished
   * work as succeeded.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    await this.opts.worker.stop();

    if (!this.loop) return;
    let timer: NodeJS.Timeout | undefined;
    const bounded = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.opts.shutdownGraceMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([this.loop.then(() => 'drained' as const), bounded]);
      if (outcome === 'timeout') {
        this.opts.logger.error('worker loop did not finish within the grace period', {
          shutdownGraceMs: this.opts.shutdownGraceMs,
          detail: 'in-flight leases will expire and the work becomes claimable again',
        });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  get isRunning(): boolean { return this.running; }
  get isStopping(): boolean { return this.stopping; }
}
