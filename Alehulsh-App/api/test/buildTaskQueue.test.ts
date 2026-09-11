import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskQueue } from '../src/queue/buildTaskQueue.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';

describe('buildTaskQueue — the production guard', () => {
  test('refuses to start in production', () => {
    // There is no durable queue yet. Starting anyway would accept SOS traffic
    // and silently never fire a safety check, which is worse than not running.
    assert.throws(() => buildTaskQueue('production'), /durable TaskQueue/);
  });

  test('the refusal names the task that fixes it', () => {
    assert.throws(() => buildTaskQueue('production'), /M-07/);
  });

  test('development gets the in-memory queue', () => {
    assert.ok(buildTaskQueue('development') instanceof InMemoryTaskQueue);
  });
});
