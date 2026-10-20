/**
 * Which queue production gets, and what happens when it cannot have one.
 *
 * The failure this guards against is not a crash. It is a process that starts
 * happily, accepts an SOS, reports success, and holds the safety check in a
 * Map that never fires. Nobody sees an error; the alert simply never
 * escalates. So "production refuses to start" is the feature.
 *
 * No database is touched: a Pool object is never connected, only passed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildTaskQueue, isDurable } from '../src/queue/buildTaskQueue.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';
import { PostgresTaskQueue } from '../src/queue/PostgresTaskQueue.js';

/** Never connected. Selection must not require a live database. */
const fakePool = {} as Pool;

describe('production selection', () => {
  test('production with a pool gets the durable queue', () => {
    const q = buildTaskQueue('production', { pool: fakePool });
    assert.ok(q instanceof PostgresTaskQueue);
    assert.equal(isDurable(q), true);
  });

  test('production WITHOUT a pool refuses to start', () => {
    assert.throws(() => buildTaskQueue('production'), /No durable TaskQueue/);
    assert.throws(() => buildTaskQueue('production', {}), /No durable TaskQueue/);
    assert.throws(() => buildTaskQueue('production', { pool: undefined }), /No durable TaskQueue/);
  });

  test('the refusal says what to set, not just that something is wrong', () => {
    // An operator reading this at 3am needs the variable names.
    const err = (() => { try { buildTaskQueue('production'); return null; } catch (e) { return e as Error; } })();
    assert.ok(err);
    for (const name of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
      assert.match(err.message, new RegExp(name), `should name ${name}`);
    }
    assert.match(err.message, /never fires scheduled tasks|silently never run/,
      'and should say why falling back is not an option');
  });

  test('the refusal carries no credential value', () => {
    const err = (() => { try { buildTaskQueue('production'); return null; } catch (e) { return e as Error; } })();
    // It names the variables; it must not contain anything that looks like a
    // value for one.
    assert.ok(!/=\S/.test(err!.message), 'no NAME=value pair may appear');
  });
});

describe('production can never silently fall back to memory', () => {
  test('no argument shape yields an in-memory queue in production', () => {
    // Exhaustive over the shapes a caller could plausibly pass.
    const shapes: { pool?: Pool | undefined }[] = [
      {}, { pool: undefined },
    ];
    for (const shape of shapes) {
      assert.throws(() => buildTaskQueue('production', shape),
        `production must refuse for ${JSON.stringify(shape)}`);
    }
    // And when it does return, it is never the Map.
    const ok = buildTaskQueue('production', { pool: fakePool });
    assert.ok(!(ok instanceof InMemoryTaskQueue));
  });

  test('a falsy-but-present pool is treated as absent, not accepted', () => {
    // Guards the `!pool` check against a future `pool: null` caller.
    assert.throws(
      () => buildTaskQueue('production', { pool: null as unknown as Pool }),
      /No durable TaskQueue/);
  });
});

describe('development', () => {
  test('development without a pool gets the in-memory queue', () => {
    const q = buildTaskQueue('development');
    assert.ok(q instanceof InMemoryTaskQueue);
    assert.equal(isDurable(q), false, 'so the caller can warn accurately');
  });

  test('development WITH a pool gets the durable queue', () => {
    // Testing against a Map proves nothing about the queue that will run.
    const q = buildTaskQueue('development', { pool: fakePool });
    assert.ok(q instanceof PostgresTaskQueue);
    assert.equal(isDurable(q), true);
  });
});

describe('the interface is unchanged', () => {
  test('both implementations satisfy TaskQueue', () => {
    for (const q of [
      buildTaskQueue('development'),
      buildTaskQueue('production', { pool: fakePool }),
    ]) {
      assert.equal(typeof q.schedule, 'function');
      assert.equal(typeof q.cancel, 'function');
    }
  });

  test('isDurable answers honestly for the in-memory queue', () => {
    assert.equal(isDurable(new InMemoryTaskQueue()), false);
  });
});
