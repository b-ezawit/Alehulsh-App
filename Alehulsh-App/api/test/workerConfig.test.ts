/**
 * Worker configuration: what must be set, and what must be coherent.
 *
 * A worker that starts misconfigured does not look broken. It claims work and
 * loses it, or runs every slow task twice. So the validation is the feature,
 * and these tests are about the refusals.
 *
 * No database and no network: only an env object is passed in.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkerConfig } from '../src/queue/workerConfig.js';

/** The minimum that must be present for anything to load. */
const BASE: NodeJS.ProcessEnv = {
  PGHOST: '127.0.0.1', PGPORT: '55432', PGDATABASE: 'synthetic',
  PGUSER: 'synthetic', PGPASSWORD: 'synthetic-not-a-real-secret',
  TASK_DISPATCH_BASE_URL: 'http://127.0.0.1:8080',
  TASK_RUNNER_SECRET: 'synthetic-not-a-real-secret',
};

const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...BASE, ...over });

describe('what must be configured', () => {
  test('a complete environment loads, with documented defaults', () => {
    const c = loadWorkerConfig(env());
    assert.equal(c.env, 'development');
    assert.equal(c.pollIntervalMs, 2_000);
    assert.equal(c.leaseMs, 60_000);
    assert.equal(c.dispatchTimeoutMs, 10_000);
    assert.equal(c.batchSize, 10);
    assert.equal(c.concurrency, 4);
    assert.equal(c.shutdownGraceMs, 15_000);
    assert.match(c.workerId, /^worker-\d+$/, 'a default identity, distinct per process');
  });

  test('the database connection is required, with no default', () => {
    // Fail-closed: an unconfigured worker must not be able to reach anything.
    for (const missing of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
      const e = env();
      delete e[missing];
      assert.throws(() => loadWorkerConfig(e), new RegExp(missing),
        `${missing} must be required`);
    }
  });

  test('the dispatch target and its secret are required', () => {
    for (const missing of ['TASK_DISPATCH_BASE_URL', 'TASK_RUNNER_SECRET']) {
      const e = env();
      delete e[missing];
      assert.throws(() => loadWorkerConfig(e), new RegExp(missing));
    }
    // Present but blank is the same as absent.
    assert.throws(() => loadWorkerConfig(env({ TASK_RUNNER_SECRET: '   ' })),
      /TASK_RUNNER_SECRET/);
  });
});

describe('durations and counts must be coherent', () => {
  test('the lease MUST exceed the dispatch timeout', () => {
    // The invariant nothing else would catch: a shorter lease means a slow
    // task is reclaimed while still running, and executed twice.
    assert.throws(
      () => loadWorkerConfig(env({ TASK_LEASE_MS: '5000', TASK_DISPATCH_TIMEOUT_MS: '10000' })),
      /must exceed/);
    assert.throws(
      () => loadWorkerConfig(env({ TASK_LEASE_MS: '10000', TASK_DISPATCH_TIMEOUT_MS: '10000' })),
      /must exceed/, 'equal is not enough — dispatch may take the full timeout');
    assert.doesNotThrow(
      () => loadWorkerConfig(env({ TASK_LEASE_MS: '10001', TASK_DISPATCH_TIMEOUT_MS: '10000' })));
  });

  test('the backoff cap must not be below the first backoff', () => {
    assert.throws(
      () => loadWorkerConfig(env({
        TASK_ERROR_BACKOFF_MS: '5000', TASK_MAX_ERROR_BACKOFF_MS: '1000',
      })), /must be at least/);
  });

  test('non-positive or nonsense durations are refused', () => {
    for (const name of [
      'TASK_POLL_INTERVAL_MS', 'TASK_LEASE_MS', 'TASK_DISPATCH_TIMEOUT_MS',
      'TASK_ERROR_BACKOFF_MS', 'TASK_MAX_ERROR_BACKOFF_MS', 'TASK_SHUTDOWN_GRACE_MS',
    ]) {
      for (const bad of ['0', '-1', 'soon', '', 'NaN']) {
        assert.throws(() => loadWorkerConfig(env({ [name]: bad })),
          `${name}=${JSON.stringify(bad)} must be refused`);
      }
    }
  });

  test('batch size and concurrency must be positive integers', () => {
    for (const name of ['TASK_BATCH_SIZE', 'TASK_CONCURRENCY']) {
      for (const bad of ['0', '-1', '2.5', 'many', '']) {
        assert.throws(() => loadWorkerConfig(env({ [name]: bad })),
          `${name}=${JSON.stringify(bad)} must be refused`);
      }
      assert.doesNotThrow(() => loadWorkerConfig(env({ [name]: '3' })));
    }
  });
});

describe('production', () => {
  test('debug logging is refused in production', () => {
    // Debug logging in production is how sensitive values escape.
    assert.throws(
      () => loadWorkerConfig(env({ NODE_ENV: 'production', LOG_LEVEL: 'debug' })),
      /not permitted/);
  });

  test('an unknown log level is refused', () => {
    assert.throws(() => loadWorkerConfig(env({ LOG_LEVEL: 'verbose' })), /LOG_LEVEL/);
  });

  test('production still requires the database, with no fallback', () => {
    const e = env({ NODE_ENV: 'production' });
    delete e['PGHOST'];
    assert.throws(() => loadWorkerConfig(e), /PGHOST/);
  });
});

describe('the config carries no secret into anything observable', () => {
  test('an error message never contains a credential value', () => {
    // Errors reach logs and process output. They may name a variable; they
    // must not carry its value.
    const sentinel = 'sentinel-credential-value';
    const e = env({ TASK_RUNNER_SECRET: sentinel, TASK_LEASE_MS: '1' });
    const err = (() => { try { loadWorkerConfig(e); return null; } catch (x) { return x as Error; } })();
    assert.ok(err);
    assert.ok(!err.message.includes(sentinel));
    assert.ok(!err.message.includes('synthetic-not-a-real-secret'));
  });
});

describe('abandoned-task monitoring is configured, and cannot be switched off (P2-17)', () => {
  test('sensible defaults, so an unconfigured worker still monitors', () => {
    const c = loadWorkerConfig(env());
    assert.equal(c.monitorIntervalMs, 60_000);
    assert.equal(c.monitorBatchSize, 100);
  });

  test('both are read from the environment', () => {
    const c = loadWorkerConfig(env({
      TASK_MONITOR_INTERVAL_MS: '15000', TASK_MONITOR_BATCH_SIZE: '25',
    }));
    assert.equal(c.monitorIntervalMs, 15_000);
    assert.equal(c.monitorBatchSize, 25);
  });

  test('nonsense is refused at startup rather than silently defaulted', () => {
    for (const bad of ['0', '-1', 'soon', '']) {
      assert.throws(() => loadWorkerConfig(env({ TASK_MONITOR_INTERVAL_MS: bad })),
        /TASK_MONITOR_INTERVAL_MS/);
    }
    for (const bad of ['0', '-5', '1.5', 'lots', '']) {
      assert.throws(() => loadWorkerConfig(env({ TASK_MONITOR_BATCH_SIZE: bad })),
        /TASK_MONITOR_BATCH_SIZE/);
    }
  });

  test('there is NO off switch', () => {
    // A safety platform should not ship an environment variable that silently
    // disables the only thing watching for dropped safety work. Anything that
    // looks like one must not be honoured.
    const c = loadWorkerConfig(env({
      TASK_MONITOR_ENABLED: 'false', TASK_MONITOR: 'off', TASK_MONITOR_DISABLED: '1',
    }));
    assert.equal(c.monitorIntervalMs, 60_000, 'monitoring stays configured');
    assert.ok(!Object.keys(c).some((k) => /enabled|disabled/i.test(k)));
  });
});
