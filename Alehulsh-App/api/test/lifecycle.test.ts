/**
 * Shutdown ordering and failure tolerance (sprint 3, P5).
 *
 * No real signals and no real process.exit: the sequence is exported so it can
 * be driven directly, and `exit` is injected.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shutdown, registerShutdownHandlers } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger('error');

function fakeApp(behaviour: { fail?: boolean; delayMs?: number } = {}) {
  const calls: string[] = [];
  return {
    calls,
    app: {
      close: async () => {
        calls.push('close');
        if (behaviour.delayMs) await new Promise((r) => setTimeout(r, behaviour.delayMs));
        if (behaviour.fail) throw new Error('drain failed');
      },
    },
  };
}

describe('shutdown ordering', () => {
  test('the server drains BEFORE the pools close', async () => {
    const order: string[] = [];
    await shutdown({
      app: { close: async () => { order.push('drain'); } },
      logger,
      teardowns: [
        async () => { order.push('pool-a'); },
        async () => { order.push('pool-b'); },
      ],
    });
    // Reversed, every in-flight request would lose its connection
    // mid-statement.
    assert.deepEqual(order, ['drain', 'pool-a', 'pool-b']);
  });

  test('teardowns run in the order given', async () => {
    const order: number[] = [];
    await shutdown({
      app: { close: async () => {} },
      logger,
      teardowns: [1, 2, 3].map((n) => async () => { order.push(n); }),
    });
    assert.deepEqual(order, [1, 2, 3]);
  });
});

describe('failure tolerance', () => {
  test('a failed drain does not prevent the pools closing', async () => {
    const closed: string[] = [];
    const { app } = fakeApp({ fail: true });
    await shutdown({
      app, logger,
      teardowns: [async () => { closed.push('pool'); }],
    });
    assert.deepEqual(closed, ['pool'],
      'the connections must be released even when the drain went wrong');
  });

  test('one failing teardown does not stop the others', async () => {
    const closed: string[] = [];
    await shutdown({
      app: { close: async () => {} },
      logger,
      teardowns: [
        async () => { closed.push('a'); },
        async () => { throw new Error('this one is broken'); },
        async () => { closed.push('c'); },
      ],
    });
    assert.deepEqual(closed, ['a', 'c']);
  });

  test('shutdown never throws, whatever fails', async () => {
    await assert.doesNotReject(() => shutdown({
      app: { close: async () => { throw new Error('x'); } },
      logger,
      teardowns: [async () => { throw new Error('y'); }],
    }));
  });
});

describe('the timeout is a bound, not a suggestion', () => {
  test('a stuck drain does not hang the process forever', async () => {
    const started = Date.now();
    await shutdown({
      app: { close: () => new Promise<void>(() => { /* never resolves */ }) },
      logger,
      timeoutMs: 150,
    });
    const elapsed = Date.now() - started;
    // The orchestrator SIGKILLs eventually anyway; returning lets us exit
    // deliberately instead of being killed mid-teardown.
    assert.ok(elapsed < 2000, `returned in ${elapsed}ms rather than hanging`);
  });

  test('a fast shutdown does not wait for the timeout', async () => {
    const started = Date.now();
    await shutdown({
      app: { close: async () => {} }, logger, teardowns: [], timeoutMs: 5000,
    });
    assert.ok(Date.now() - started < 1000, 'it returns as soon as the work is done');
  });
});

describe('signal handling', () => {
  test('a signal runs the sequence once and exits zero', async () => {
    const codes: number[] = [];
    let drained = 0;
    const detach = registerShutdownHandlers({
      app: { close: async () => { drained += 1; } },
      logger,
      exit: (code) => { codes.push(code); },
    });
    try {
      process.emit('SIGTERM');
      // Let the async sequence settle.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(drained, 1);
      assert.deepEqual(codes, [0]);
    } finally {
      detach();
    }
  });

  test('a second signal exits immediately instead of waiting', async () => {
    const codes: number[] = [];
    const detach = registerShutdownHandlers({
      app: { close: () => new Promise<void>(() => {}) },   // never finishes
      logger,
      timeoutMs: 10_000,
      exit: (code) => { codes.push(code); },
    });
    try {
      process.emit('SIGTERM');
      process.emit('SIGTERM');
      await new Promise((r) => setTimeout(r, 50));
      // Someone pressing Ctrl-C twice means "stop now"; waiting out ten
      // seconds at that point only looks like a hang.
      assert.deepEqual(codes, [1]);
    } finally {
      detach();
    }
  });

  test('detaching leaves no listener behind', () => {
    const before = process.listenerCount('SIGTERM');
    const detach = registerShutdownHandlers({
      app: { close: async () => {} }, logger, exit: () => {},
    });
    assert.equal(process.listenerCount('SIGTERM'), before + 1);
    detach();
    assert.equal(process.listenerCount('SIGTERM'), before,
      'a long-lived process must not accumulate handlers');
  });
});
