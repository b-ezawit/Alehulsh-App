import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from '../src/logger.js';
import type { ClaimedTask, PostgresTaskQueue } from '../src/queue/PostgresTaskQueue.js';
import { TaskWorker } from '../src/queue/TaskWorker.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function task(id: string): ClaimedTask {
  return { id, taskKey: `test:${id}`, kind: 'safety-check', payload: {},
    runAt: new Date(), attempts: 1, maxAttempts: 5 };
}
const eventLoopTurn = () => new Promise<void>((resolve) => { setImmediate(resolve); });

test('a completion failure waits for other dispatch lanes before rejecting or stopping', async () => {
  const firstFailed = deferred();
  const secondStarted = deferred();
  const releaseSecond = deferred();
  const failure = new Error('synthetic outcome recording failure');
  const completed: string[] = [];
  const queue = {
    claim: async () => [task('one'), task('two')],
    complete: async (id: string) => {
      if (id === 'one') {
        firstFailed.resolve();
        throw failure;
      }
      completed.push(id);
      return true;
    },
  } as unknown as PostgresTaskQueue;
  const worker = new TaskWorker(queue, async (claimed) => {
    if (claimed.id === 'two') {
      secondStarted.resolve();
      await releaseSecond.promise;
    }
  }, logger, { worker: 'settlement-test', concurrency: 2 });
  let passSettled = false;
  const pass = worker.runOnce().then(
    () => { passSettled = true; assert.fail('outcome recording failure must propagate'); },
    (error: unknown) => { passSettled = true; return error; },
  );
  await Promise.all([firstFailed.promise, secondStarted.promise]);
  try {
    // Advance the event loop, without waiting for a real-time deadline, so
    // first-lane rejection has had every opportunity to reject the outer pass.
    await eventLoopTurn();
    assert.equal(passSettled, false, 'the pass ended while another dispatch was blocked');
    let stopSettled = false;
    const stop = worker.stop().then(() => { stopSettled = true; });
    await eventLoopTurn();
    assert.equal(stopSettled, false, 'shutdown failed to wait for the remaining lane');
    releaseSecond.resolve();
    assert.equal(await pass, failure);
    await stop;
    assert.deepEqual(completed, ['two']);
    assert.equal(stopSettled, true);
  } finally {
    releaseSecond.resolve();
    await pass;
  }
});
