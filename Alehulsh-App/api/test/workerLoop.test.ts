/**
 * The polling loop: when it waits, how it survives a broken queue, and how it
 * stops.
 *
 * Deterministic by construction. `sleep` is injected and records what it was
 * asked to wait rather than waiting, so nothing here depends on real time
 * passing - no sleeps, no timing assumptions, and therefore no race for a
 * flake to hide in. The TaskWorker is a stub so a pass can be made to behave
 * exactly as a case needs.
 *
 * No database, no network, no notification: there is nothing here that could
 * reach outside the process.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerLoop } from '../src/queue/WorkerLoop.js';
import type { RunResult, TaskWorker } from '../src/queue/TaskWorker.js';
import type { Logger } from '../src/logger.js';
import type { AbandonedTaskMonitor } from '../src/queue/AbandonedTaskMonitor.js';
import type { ClaimContext, OverduePendingProbe } from '../src/queue/OverduePendingProbe.js';

/** Captures what was logged, so sensitive-data assertions can inspect it. */
function recordingLogger(): Logger & { lines: { level: string; msg: string; ctx: unknown }[] } {
  const lines: { level: string; msg: string; ctx: unknown }[] = [];
  const at = (level: string) => (msg: string, ctx?: unknown) => { lines.push({ level, msg, ctx }); };
  return {
    lines,
    debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'),
  } as Logger & { lines: { level: string; msg: string; ctx: unknown }[] };
}

const empty: RunResult = { claimed: 0, succeeded: 0, failed: 0, lost: 0 };
const busy = (over: Partial<RunResult> = {}): RunResult =>
  ({ claimed: 1, succeeded: 1, failed: 0, lost: 0, ...over });

/**
 * A TaskWorker stand-in. `passes` is a script: each entry is either a result
 * to return or an error to throw.
 */
function stubWorker(passes: (RunResult | Error)[]) {
  let i = 0;
  const calls: number[] = [];
  let stopped = false;
  const worker = {
    async runOnce(): Promise<RunResult> {
      calls.push(i);
      const next = passes[Math.min(i, passes.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      return next ?? empty;
    },
    async stop(): Promise<void> { stopped = true; },
    get isStopping(): boolean { return stopped; },
    // The loop reads this to tell a stall from a backlog.
    get batchSize(): number { return 10; },
  };
  return {
    worker: worker as unknown as TaskWorker,
    get callCount(): number { return calls.length; },
    get stopped(): boolean { return stopped; },
  };
}

/**
 * An AbandonedTaskMonitor stand-in.  (P2-17)
 *
 * `scan()` is documented never to throw, so the default stub does not. The
 * `throws` option exists to prove the loop survives a monitor that breaks that
 * contract.
 */
function stubMonitor(options: { throws?: boolean } = {}) {
  let scans = 0;
  return {
    get scans(): number { return scans; },
    monitor: {
      async scan(): Promise<unknown> {
        scans += 1;
        if (options.throws) throw new Error('monitor exploded');
        return null;
      },
    } as unknown as AbandonedTaskMonitor,
  };
}

/** An OverduePendingProbe stand-in that records the claim context it was given. */
function stubProbe(options: { throws?: boolean } = {}) {
  const contexts: ClaimContext[] = [];
  return {
    get contexts(): ClaimContext[] { return contexts; },
    probe: {
      async scan(context: ClaimContext): Promise<unknown> {
        contexts.push(context);
        if (options.throws) throw new Error('probe exploded');
        return null;
      },
    } as unknown as OverduePendingProbe,
  };
}

/** A loop with a recording sleep, so waits are observable not endured. */
function makeLoop(passes: (RunResult | Error)[], over: Partial<{
  pollIntervalMs: number; errorBackoffMs: number; maxErrorBackoffMs: number;
  shutdownGraceMs: number; monitor: AbandonedTaskMonitor; monitorIntervalMs: number;
  backlogProbe: OverduePendingProbe; now: () => number;
}> = {}) {
  const stub = stubWorker(passes);
  const logger = recordingLogger();
  const waits: number[] = [];
  const loop = new WorkerLoop({
    worker: stub.worker,
    logger,
    pollIntervalMs: over.pollIntervalMs ?? 2_000,
    errorBackoffMs: over.errorBackoffMs ?? 1_000,
    maxErrorBackoffMs: over.maxErrorBackoffMs ?? 8_000,
    shutdownGraceMs: over.shutdownGraceMs ?? 5_000,
    sleep: async (ms: number) => { waits.push(ms); },
    ...(over.monitor ? { monitor: over.monitor } : {}),
    ...(over.backlogProbe ? { backlogProbe: over.backlogProbe } : {}),
    ...(over.monitorIntervalMs === undefined ? {} : { monitorIntervalMs: over.monitorIntervalMs }),
    ...(over.now ? { now: over.now } : {}),
  });
  return { loop, stub, logger, waits };
}

describe('an empty queue waits instead of spinning', () => {
  test('a pass that claimed nothing sleeps for the poll interval', async () => {
    const { loop, waits } = makeLoop([empty], { pollIntervalMs: 2_500 });
    await loop.tick();
    assert.deepEqual(waits, [2_500]);
  });

  test('a pass that claimed work does NOT wait', async () => {
    // Waiting with due work outstanding would add latency to an emergency for
    // no reason: a full batch means there may be more.
    const { loop, waits } = makeLoop([busy()]);
    await loop.tick();
    assert.deepEqual(waits, [], 'no wait after productive work');
  });

  test('ten idle passes sleep ten times — the loop cannot spin', async () => {
    const { loop, waits } = makeLoop([empty]);
    for (let i = 0; i < 10; i += 1) await loop.tick();
    assert.equal(waits.length, 10);
    assert.ok(waits.every((w) => w === 2_000));
  });
});

describe('a broken queue backs off and keeps going', () => {
  test('a failing pass does not throw out of the loop', async () => {
    // A database blip must not take down the process that runs safety checks.
    const { loop } = makeLoop([new Error('connection refused')]);
    await assert.doesNotReject(() => loop.tick());
  });

  test('the backoff doubles and is capped', async () => {
    const boom = new Error('connection refused');
    const { loop, waits } = makeLoop(
      [boom, boom, boom, boom, boom, boom],
      { errorBackoffMs: 1_000, maxErrorBackoffMs: 8_000 });
    for (let i = 0; i < 6; i += 1) await loop.tick();
    assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 8_000, 8_000],
      'doubling, then held at the cap');
  });

  test('every failure is logged, not just the first', async () => {
    // An operator needs to see it continuing to fail, not one line and silence.
    const boom = new Error('connection refused');
    const { loop, logger } = makeLoop([boom, boom, boom]);
    for (let i = 0; i < 3; i += 1) await loop.tick();
    const errors = logger.lines.filter((l) => l.level === 'error');
    assert.equal(errors.length, 3);
    assert.equal((errors[2]!.ctx as { consecutiveErrors: number }).consecutiveErrors, 3);
  });

  test('a successful pass resets the backoff', async () => {
    const boom = new Error('down');
    const { loop, waits } = makeLoop([boom, boom, empty, boom],
      { errorBackoffMs: 1_000, maxErrorBackoffMs: 8_000 });
    await loop.tick();           // 1000
    await loop.tick();           // 2000
    await loop.tick();           // success -> poll interval
    await loop.tick();           // back to 1000, not 4000
    assert.deepEqual(waits, [1_000, 2_000, 2_000, 1_000]);
  });

  test('task failures are NOT queue failures', async () => {
    // A task failing is the queue working. Only an unreachable queue backs off.
    const { loop, waits, logger } = makeLoop([busy({ succeeded: 0, failed: 3, claimed: 3 })]);
    await loop.tick();
    assert.deepEqual(waits, [], 'a productive pass does not wait');
    assert.equal(loop.stats.consecutiveErrors, 0);
    assert.equal(logger.lines.filter((l) => l.level === 'error').length, 0);
  });
});

describe('overlapping loops are prevented', () => {
  test('a second start() is ignored', async () => {
    // Two loops on one TaskWorker would claim under the same worker identity,
    // so each could complete work the other was running - the stale-worker
    // guard is keyed on the worker id and cannot tell them apart.
    const { loop, logger } = makeLoop([empty]);
    loop.start();
    loop.start();
    loop.start();
    const warned = logger.lines.filter((l) => l.msg.includes('already running'));
    assert.equal(warned.length, 2, 'the two extra starts were refused');
    await loop.stop();
  });

  test('start() after stop() does not resurrect the loop', async () => {
    const { loop, logger } = makeLoop([empty]);
    loop.start();
    await loop.stop();
    loop.start();
    assert.ok(logger.lines.some((l) => l.msg.includes('not restarting')));
    assert.equal(loop.isRunning, false);
  });

  test('tick() does nothing once stopping', async () => {
    const { loop, stub } = makeLoop([empty]);
    await loop.stop();
    assert.equal(await loop.tick(), null);
    assert.equal(stub.callCount, 0, 'no pass is started after stop');
  });
});

describe('graceful shutdown', () => {
  test('stopping while idle stops the worker and the loop', async () => {
    const { loop, stub } = makeLoop([empty]);
    loop.start();
    await loop.stop();
    assert.equal(stub.stopped, true, 'the TaskWorker was told to stop');
    assert.equal(loop.isStopping, true);
    assert.equal(loop.isRunning, false);
  });

  test('stopping while a pass is in flight waits for it', async () => {
    // Deterministic: the pass is released by resolving a promise, not by time.
    let release!: () => void;
    const inFlight = new Promise<void>((r) => { release = r; });
    let finished = false;

    const logger = recordingLogger();
    const worker = {
      async runOnce(): Promise<RunResult> {
        await inFlight;
        finished = true;
        return busy();
      },
      async stop(): Promise<void> {},
      get isStopping(): boolean { return false; },
    } as unknown as TaskWorker;

    const loop = new WorkerLoop({
      worker, logger,
      pollIntervalMs: 1, errorBackoffMs: 1, maxErrorBackoffMs: 1,
      shutdownGraceMs: 5_000,
      sleep: async () => {},
    });

    const pass = loop.tick();
    const stopping = loop.stop();
    assert.equal(finished, false, 'still in flight');
    release();
    await pass;
    await stopping;
    assert.equal(finished, true, 'in-flight work was allowed to finish');
  });

  test('stop() never marks unfinished work complete', async () => {
    // The loop records nothing about individual tasks; TaskWorker does, and
    // only after its dispatch returns. So an abandoned pass cannot report
    // unfinished work as succeeded.
    const { loop, stub } = makeLoop([busy()]);
    await loop.stop();
    assert.deepEqual(
      { succeeded: loop.stats.succeeded, failed: loop.stats.failed, lost: loop.stats.lost },
      { succeeded: 0, failed: 0, lost: 0 });
    assert.equal(stub.callCount, 0);
  });

  test('a second stop() is a no-op', async () => {
    const { loop } = makeLoop([empty]);
    loop.start();
    await loop.stop();
    await assert.doesNotReject(() => loop.stop());
  });

  test('a loop that will not finish is abandoned, loudly, within the grace', async () => {
    // Bounded on purpose: at most one lease interval of delay, versus a
    // shutdown that never completes and gets SIGKILLed mid-write.
    const logger = recordingLogger();
    const worker = {
      // Never resolves.
      runOnce: () => new Promise<RunResult>(() => {}),
      async stop(): Promise<void> {},
      get isStopping(): boolean { return false; },
    } as unknown as TaskWorker;

    const loop = new WorkerLoop({
      worker, logger,
      pollIntervalMs: 1, errorBackoffMs: 1, maxErrorBackoffMs: 1,
      shutdownGraceMs: 30,
      sleep: async () => {},
    });
    loop.start();
    await loop.stop();

    assert.ok(
      logger.lines.some((l) => l.level === 'error' && l.msg.includes('grace period')),
      'the operator must be told the loop was abandoned');
    const ctx = logger.lines.find((l) => l.msg.includes('grace period'))?.ctx as
      { detail: string } | undefined;
    assert.match(String(ctx?.detail), /leases will expire/,
      'and told what happens to the work');
  });
});

describe('statistics and logging', () => {
  test('a pass is accounted for exactly once', async () => {
    const { loop } = makeLoop([busy({ claimed: 5, succeeded: 3, failed: 1, lost: 1 })]);
    await loop.tick();
    assert.deepEqual(loop.stats, {
      passes: 1, claimed: 5, succeeded: 3, failed: 1, lost: 1, consecutiveErrors: 0,
    });
  });

  test('a failed pass is not counted as a pass', async () => {
    const { loop } = makeLoop([new Error('down')]);
    await loop.tick();
    assert.equal(loop.stats.passes, 0);
    assert.equal(loop.stats.consecutiveErrors, 1);
  });

  test('NOTHING sensitive reaches a log line', async () => {
    // The loop logs counts, intervals and error messages. It is handed no
    // task payload at all - TaskWorker keeps that - so there is nothing for it
    // to leak. This asserts that stays true.
    const boom = new Error('connection to 10.1.2.3 refused');
    const { loop, logger } = makeLoop([boom, empty, busy()]);
    for (let i = 0; i < 3; i += 1) await loop.tick();
    loop.start();
    await loop.stop();

    const serialised = JSON.stringify(logger.lines);
    for (const forbidden of [
      'alertId', 'payload', 'latitude', 'longitude', 'secret', 'token',
      'x-task-secret', 'phone', 'contact', 'audio', 'PGPASSWORD',
    ]) {
      assert.ok(!serialised.includes(forbidden),
        `a log line must not mention ${forbidden}`);
    }
  });
});

describe('the abandoned-task monitor rides on this loop (P2-17)', () => {
  test('no monitor configured is simply no monitoring — the loop is unchanged', async () => {
    const { loop, waits } = makeLoop([empty]);
    await loop.tick();
    assert.deepEqual(waits, [2_000]);
  });

  test('the FIRST tick scans, so a restart reports what it never witnessed', async () => {
    // The whole point: tasks abandoned while nothing was running must be
    // reported by the process that comes up, not only ones it sees happen.
    const m = stubMonitor();
    const { loop } = makeLoop([empty], {
      monitor: m.monitor, monitorIntervalMs: 60_000, now: () => 1_000,
    });
    await loop.tick();
    assert.equal(m.scans, 1);
  });

  test('scans are time-gated, so a busy loop does not scan every pass', async () => {
    const m = stubMonitor();
    let clock = 0;
    const { loop } = makeLoop([busy()], {
      monitor: m.monitor, monitorIntervalMs: 1_000, now: () => clock,
    });

    await loop.tick();                     // t=0, first scan
    clock = 400; await loop.tick();        // too soon
    clock = 999; await loop.tick();        // still too soon
    assert.equal(m.scans, 1);

    clock = 1_000; await loop.tick();      // the interval has elapsed
    assert.equal(m.scans, 2);
  });

  test('an idle loop still monitors on schedule', async () => {
    const m = stubMonitor();
    let clock = 0;
    const { loop } = makeLoop([empty], {
      monitor: m.monitor, monitorIntervalMs: 500, now: () => clock,
    });
    for (let i = 0; i < 4; i += 1) { await loop.tick(); clock += 500; }
    assert.equal(m.scans, 4, 'monitoring must not depend on there being work');
  });

  test('a monitor that throws cannot stop the loop that runs safety checks', async () => {
    const m = stubMonitor({ throws: true });
    const { loop, logger, stub } = makeLoop([busy(), busy()], {
      monitor: m.monitor, monitorIntervalMs: 0,
    });

    await assert.doesNotReject(() => loop.tick());
    await loop.tick();
    assert.equal(stub.callCount, 2, 'passes keep happening');
    assert.ok(logger.lines.some((l) =>
      l.level === 'error' && l.msg.includes('monitor threw')));
  });

  test('a monitor failure does not become a queue failure', async () => {
    // Nothing about monitoring may feed the poll backoff: an unobserved
    // abandonment is bad, but it is not the queue being broken.
    const m = stubMonitor({ throws: true });
    const { loop, waits } = makeLoop([busy()], {
      monitor: m.monitor, monitorIntervalMs: 0,
    });
    await loop.tick();

    assert.equal(loop.stats.consecutiveErrors, 0);
    assert.equal(loop.stats.passes, 1);
    assert.deepEqual(waits, [], 'no backoff was triggered by the monitor');
  });

  test('an unreachable queue does not scan — the monitor needs the same database', async () => {
    const m = stubMonitor();
    const { loop } = makeLoop([new Error('connection refused')], {
      monitor: m.monitor, monitorIntervalMs: 0,
    });
    await loop.tick();
    assert.equal(m.scans, 0);
  });

  test('a stopping loop does not scan', async () => {
    const m = stubMonitor();
    const { loop } = makeLoop([empty], { monitor: m.monitor, monitorIntervalMs: 0 });
    await loop.stop();
    await loop.tick();
    assert.equal(m.scans, 0);
  });
});

describe('the overdue-pending probe rides the same gate (P2-17b)', () => {
  test('no probe configured leaves the loop exactly as it was', async () => {
    const { loop, waits } = makeLoop([empty]);
    await loop.tick();
    assert.deepEqual(waits, [2_000]);
  });

  test('the probe runs, and runs on the FIRST tick', async () => {
    const p = stubProbe();
    const { loop } = makeLoop([empty], {
      backlogProbe: p.probe, monitorIntervalMs: 60_000, now: () => 5_000,
    });
    await loop.tick();
    assert.equal(p.contexts.length, 1);
  });

  test('it is handed what the pass actually claimed, so it can tell a stall from a backlog', async () => {
    const p = stubProbe();
    const { loop } = makeLoop([busy({ claimed: 3 })], {
      backlogProbe: p.probe, monitorIntervalMs: 0,
    });
    await loop.tick();
    assert.deepEqual(p.contexts[0], { claimed: 3, capacity: 10 });

    const full = stubProbe();
    const saturated = makeLoop([busy({ claimed: 10 })], {
      backlogProbe: full.probe, monitorIntervalMs: 0,
    });
    await saturated.loop.tick();
    assert.deepEqual(full.contexts[0], { claimed: 10, capacity: 10 });
  });

  test('probe and monitor share one gate — not two intervals to keep in step', async () => {
    const m = stubMonitor();
    const p = stubProbe();
    let clock = 0;
    const { loop } = makeLoop([empty], {
      monitor: m.monitor, backlogProbe: p.probe,
      monitorIntervalMs: 1_000, now: () => clock,
    });

    await loop.tick();                  // both
    clock = 500; await loop.tick();     // neither
    assert.equal(m.scans, 1);
    assert.equal(p.contexts.length, 1);

    clock = 1_000; await loop.tick();   // both again
    assert.equal(m.scans, 2);
    assert.equal(p.contexts.length, 2);
  });

  test('a probe that throws cannot stop the loop, and is not a queue failure', async () => {
    const p = stubProbe({ throws: true });
    const { loop, logger, stub, waits } = makeLoop([busy(), busy()], {
      backlogProbe: p.probe, monitorIntervalMs: 0,
    });

    await assert.doesNotReject(() => loop.tick());
    await loop.tick();

    assert.equal(stub.callCount, 2, 'passes keep happening');
    assert.equal(loop.stats.consecutiveErrors, 0);
    assert.deepEqual(waits, [], 'no backoff was triggered by a diagnostic');
    assert.ok(logger.lines.some((l) =>
      l.level === 'error' && l.msg.includes('overdue-pending probe threw')));
  });

  test('the two diagnostics are isolated from each other', async () => {
    // A bug in the newer one must not silently disable abandonment reporting.
    const m = stubMonitor();
    const p = stubProbe({ throws: true });
    const { loop, logger } = makeLoop([empty], {
      monitor: m.monitor, backlogProbe: p.probe, monitorIntervalMs: 0,
    });
    await loop.tick();

    assert.equal(m.scans, 1, 'the monitor still ran');
    assert.ok(logger.lines.some((l) => l.msg.includes('overdue-pending probe threw')));
  });

  test('a monitor that throws does not stop the probe either', async () => {
    const m = stubMonitor({ throws: true });
    const p = stubProbe();
    const { loop } = makeLoop([empty], {
      monitor: m.monitor, backlogProbe: p.probe, monitorIntervalMs: 0,
    });
    await loop.tick();
    assert.equal(p.contexts.length, 1);
  });

  test('an unreachable queue does not probe — it needs the same database', async () => {
    const p = stubProbe();
    const { loop } = makeLoop([new Error('connection refused')], {
      backlogProbe: p.probe, monitorIntervalMs: 0,
    });
    await loop.tick();
    assert.equal(p.contexts.length, 0);
  });
});
