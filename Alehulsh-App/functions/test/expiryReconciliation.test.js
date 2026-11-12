const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileExpiredAlerts } = require('../expiryReconciliation');

const NOW = new Date('2026-10-24T12:00:00Z');
const expiry = new Date(NOW.getTime() - 1000);
const incident = (id, over = {}) => ({
  alertKey: `key-${id}`, status: 'active', expiresAtTimestamp: expiry,
  createdAt: new Date(NOW.getTime() - 60_000), ...over,
});

// A transaction test double which snapshots query results, re-reads documents
// independently, and stages writes until commit. The race hooks change source
// state AFTER query selection and BEFORE the transaction read.
class Database {
  constructor() { this.rows = new Map(); this.beforeTransaction = null; this.failCreate = false; }
  source(id, data) { this.rows.set(`active_alerts/${id}`, data); }
  snapshot(path) {
    const data = this.rows.get(path);
    return { id: path.split('/').pop(), ref: { path }, exists: !!data,
      data: () => data ? { ...data } : undefined, get: (key) => data?.[key] };
  }
  collection(name) {
    const db = this;
    const query = {
      filters: [], count: 200, cursor: null,
      doc(id) { return { path: `${name}/${id}` }; },
      where(field, op, value) { this.filters.push([field, op, value]); return this; },
      orderBy() { return this; },
      limit(n) { this.count = n; return this; },
      startAfter(cursor) { this.cursor = cursor; return this; },
      async get() {
        let docs = [...db.rows.keys()].filter((p) => p.startsWith(`${name}/`))
          .map((p) => db.snapshot(p)).filter((s) => this.filters.every(([key, op, value]) => {
            const actual = s.get(key);
            return op === 'in' ? value.includes(actual) : actual <= value;
          }));
        docs.sort(compare);
        if (this.cursor) docs = docs.filter((s) => compare(s, this.cursor) > 0);
        docs = docs.slice(0, this.count);
        return { docs, empty: docs.length === 0 };
      },
    };
    return query;
  }
  async runTransaction(fn) {
    if (this.beforeTransaction) { const hook = this.beforeTransaction; this.beforeTransaction = null; hook(); }
    const writes = [];
    const result = await fn({
      get: async (ref) => this.snapshot(ref.path),
      update: (ref, patch) => writes.push([ref.path, { ...this.rows.get(ref.path), ...patch }]),
      create: (ref, value) => {
        if (this.failCreate) throw new Error('simulated intent persistence failure');
        assert.equal(this.rows.has(ref.path), false);
        writes.push([ref.path, value]);
      },
    });
    for (const [path, value] of writes) this.rows.set(path, value);
    return result;
  }
  work() { return [...this.rows].filter(([path]) => path.startsWith('alert_task_outbox/')); }
}

function compare(a, b) {
  return a.get('expiresAtTimestamp') - b.get('expiresAtTimestamp') || a.id.localeCompare(b.id);
}
function run(db, options = {}) {
  return reconcileExpiredAlerts({ db, now: NOW, pageSize: 2,
    timestampFromDate: (date) => date, serverTimestamp: () => NOW,
    logger: { error() {} }, ...options });
}

test('a backlog of terminal documents cannot starve a later open alert', async () => {
  const db = new Database();
  for (let i = 0; i < 205; i++) db.source(`closed-${i}`, incident(i, { status: 'resolved' }));
  db.source('later-live', incident('later-live'));
  assert.equal(await run(db), 1);
  assert.equal(db.rows.get('active_alerts/later-live').status, 'expired');
  assert.equal(db.work().length, 1);
});

test('pagination reaches every due live incident beyond the first page', async () => {
  const db = new Database();
  for (let i = 0; i < 7; i++) db.source(`open-${i}`, incident(i));
  assert.equal(await run(db), 7);
  assert.equal(db.work().length, 7);
});

for (const status of ['resolved', 'cancelled', 'expired']) {
  test(`a concurrent ${status} transition is not overwritten by expiry`, async () => {
    const db = new Database();
    db.source('owner', incident('owner'));
    db.beforeTransaction = () => db.source('owner', incident('owner', { status }));
    assert.equal(await run(db), 0);
    assert.equal(db.rows.get('active_alerts/owner').status, status);
    assert.equal(db.work().length, 0);
  });
}

test('replacement of an owner slot cannot expire the replacement incident', async () => {
  const db = new Database();
  db.source('owner', incident('owner'));
  db.beforeTransaction = () => db.source('owner', incident('new-incident'));
  assert.equal(await run(db), 0);
  assert.equal(db.rows.get('active_alerts/owner').status, 'active');
});

test('an expiry extended after candidate selection is rechecked', async () => {
  const db = new Database();
  db.source('owner', incident('owner'));
  db.beforeTransaction = () => db.source('owner', incident('owner', {
    expiresAtTimestamp: new Date(NOW.getTime() + 60_000),
  }));
  assert.equal(await run(db), 0);
  assert.equal(db.work().length, 0);
});

test('cleanup intent failure rolls back closure; retry commits both', async () => {
  const db = new Database();
  db.source('owner', incident('owner'));
  db.failCreate = true;
  await assert.rejects(run(db), /intent persistence failure/);
  assert.equal(db.rows.get('active_alerts/owner').status, 'active');
  assert.equal(db.work().length, 0);
  db.failCreate = false;
  assert.equal(await run(db), 1);
  assert.equal(db.rows.get('active_alerts/owner').status, 'expired');
  assert.equal(db.work()[0][1].payload.alertKey, 'key-owner');
});

test('replays preserve completed cleanup intents rather than resetting delivery', async () => {
  const db = new Database();
  db.source('owner', incident('owner'));
  assert.equal(await run(db), 1);
  const [path, task] = db.work()[0];
  db.rows.set(path, { ...task, state: 'delivered' });
  assert.equal(await run(db), 0);
  assert.equal(db.work()[0][1].state, 'delivered');
});

test('legacy closure adopts an immutable key for conditional cleanup', async () => {
  const db = new Database();
  const { alertKey, ...legacy } = incident('owner');
  db.source('owner', legacy);
  assert.equal(await run(db), 1);
  const current = db.rows.get('active_alerts/owner');
  assert.ok(current.alertKey);
  assert.equal(db.work()[0][1].payload.alertKey, current.alertKey);
});
