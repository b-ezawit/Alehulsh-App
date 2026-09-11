import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AccountDeleter } from '../src/services/AccountDeleter.js';
import { createLogger } from '../src/logger.js';
import type { DeletableStore } from '../src/repositories/types.js';
import { OWNER } from './fakes.js';

const logger = createLogger('error');

const store = (name: string, count: number): DeletableStore => ({
  name, purge: async () => count,
});
const failing = (name: string, msg: string): DeletableStore => ({
  name, purge: async () => { throw new Error(msg); },
});

describe('AccountDeleter', () => {
  test('purges every registered store and reports counts', async () => {
    const d = new AccountDeleter([store('alerts', 2), store('contacts', 3), store('user', 1)], logger);
    const r = await d.deleteAccount(OWNER);
    assert.equal(r.complete, true);
    assert.deepEqual(r.purged, { alerts: 2, contacts: 3, user: 1 });
    assert.deepEqual(r.failed, {});
  });

  test('reports incomplete rather than success when a store fails', async () => {
    // The failure that matters: she is told her data is gone and it is not.
    const d = new AccountDeleter([store('alerts', 2), failing('evidence', 'bucket unreachable')], logger);
    const r = await d.deleteAccount(OWNER);
    assert.equal(r.complete, false);
    assert.equal(r.failed['evidence'], 'bucket unreachable');
  });

  test('one failing store does not stop the others', async () => {
    // Less of her data left behind is strictly better than none deleted.
    const d = new AccountDeleter([failing('alerts', 'nope'), store('contacts', 3), store('user', 1)], logger);
    const r = await d.deleteAccount(OWNER);
    assert.equal(r.purged['contacts'], 3);
    assert.equal(r.purged['user'], 1);
    assert.equal(r.complete, false);
  });

  test('deletes in registration order, so the account record goes last', async () => {
    // A failure part-way must never orphan data belonging to a user who no
    // longer exists and can no longer be found.
    const order: string[] = [];
    const tracked = (name: string): DeletableStore => ({
      name, purge: async () => { order.push(name); return 0; },
    });
    const d = new AccountDeleter([tracked('evidence'), tracked('alerts'), tracked('user')], logger);
    await d.deleteAccount(OWNER);
    assert.deepEqual(order, ['evidence', 'alerts', 'user']);
  });

  test('refuses to be constructed with no stores', () => {
    // Otherwise it would "succeed" at deleting nothing.
    assert.throws(() => new AccountDeleter([], logger), /at least one store/);
  });

  test('a store finding nothing is still a success', async () => {
    const d = new AccountDeleter([store('alerts', 0)], logger);
    const r = await d.deleteAccount(OWNER);
    assert.equal(r.complete, true);
    assert.equal(r.purged['alerts'], 0);
  });

  test('the receipt records when it happened', async () => {
    const d = new AccountDeleter([store('user', 1)], logger);
    const r = await d.deleteAccount(OWNER);
    assert.ok(r.completedAt instanceof Date);
    assert.equal(r.uid, OWNER);
  });
});
