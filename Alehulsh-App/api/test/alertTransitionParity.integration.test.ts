/**
 * Every AlertRepository must agree about when an alert may change state.
 *
 * Two backends that disagree about whether a resolved alert can escalate is
 * worse than either rule alone: the behaviour then depends on which backend
 * happens to be wired in, and the migration silently changes what the safety
 * check does. So the same transition table runs against all three
 * implementations and they must produce identical results.
 *
 * REAL here: FirestoreAlertRepository against the Firestore emulator, and
 * PostgresAlertRepository against local PostgreSQL+PostGIS. The fake is
 * included because handler tests run on it, and a fake that permits what the
 * real backends refuse lets a test pass on behaviour that cannot happen.
 *
 * Each backend skips independently when its dependency is absent, and says so.
 * Synthetic data only; no notification is sent and no provider exists to call.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { Pool } from 'pg';
import { createPool, loadDbConfig, closePool } from '../src/db/pool.js';
import { FirestoreAlertRepository } from '../src/repositories/firestore/FirestoreAlertRepository.js';
import { PostgresAlertRepository } from '../src/repositories/postgres/PostgresAlertRepository.js';
import type { AlertRepository, AlertStatus } from '../src/repositories/types.js';
import { FakeAlertRepository, ACTIVE_WINDOW } from './fakes.js';

const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080';

let fbApp: App | null = null;
let fsDb: Firestore | null = null;
let pool: Pool | null = null;
let fsReason = '';
let pgReason = '';

/** Own namespace, so this suite cannot disturb composition.integration. */
const FS_OWNER = `parity_fs_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const PG_UUID = randomUUID();
const PG_SUBJECT = `parityPg${randomUUID().replace(/-/g, '').slice(0, 20)}`;

function reachable(hostPort: string, timeoutMs = 1500): Promise<boolean> {
  const [host, port] = hostPort.split(':');
  return new Promise((resolve) => {
    const sock = connect({ host: host ?? '127.0.0.1', port: Number(port ?? 8080) });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

before(async () => {
  // Firestore
  if (await reachable(EMULATOR)) {
    process.env['FIRESTORE_EMULATOR_HOST'] = EMULATOR;
    fbApp = initializeApp({ projectId: 'alehulsh-itest' }, `parity-${Date.now()}`);
    fsDb = getFirestore(fbApp);
  } else {
    fsReason = `Firestore emulator unavailable at ${EMULATOR}`;
  }

  // PostgreSQL
  let cfg;
  try { cfg = loadDbConfig(); } catch {
    pgReason = 'PG* environment not configured (fail-closed, not assumed)';
  }
  if (cfg && await reachable(`${cfg.host}:${cfg.port}`)) {
    pool = createPool(cfg, { max: 3 });
    await pool.query(
      `INSERT INTO users (id, display_name) VALUES ($1,'Parity') ON CONFLICT (id) DO NOTHING`,
      [PG_UUID]);
    await pool.query(
      `INSERT INTO identity_map (firebase_uid, user_id) VALUES ($1,$2)
       ON CONFLICT (firebase_uid) DO NOTHING`, [PG_SUBJECT, PG_UUID]);
  } else if (cfg) {
    pgReason = 'no PostgreSQL reachable on the configured host:port';
  }
});

after(async () => {
  if (fsDb) {
    await fsDb.collection('active_alerts').doc(FS_OWNER).delete().catch(() => {});
    const archived = await fsDb.collection('alert_history')
      .where('userId', '==', FS_OWNER).get().catch(() => null);
    for (const d of archived?.docs ?? []) await d.ref.delete().catch(() => {});
  }
  if (fbApp) await deleteApp(fbApp).catch(() => {});
  if (pool) {
    await pool.query(`DELETE FROM alerts WHERE owner_id = $1`, [PG_UUID]);
    // Nothing cascades to alert_history (0008/§5); clean up our own.
    await pool.query(`DELETE FROM alert_history WHERE owner_id = $1`, [PG_UUID]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [PG_UUID]);
    await closePool(pool);
  }
});

/** A fresh active alert on each backend, with the backend's own owner id. */
async function freshFirestore(seq: string) {
  await fsDb!.collection('active_alerts').doc(FS_OWNER).delete().catch(() => {});
  const repo = new FirestoreAlertRepository(fsDb!, ACTIVE_WINDOW);
  const { alert } = await repo.create({
    requestId: `parity-fs-${seq}`, ownerId: FS_OWNER, latitude: null, longitude: null,
  });
  return { repo: repo as AlertRepository, alert };
}

async function freshPostgres(seq: string) {
  await pool!.query(`DELETE FROM alerts WHERE owner_id = $1`, [PG_UUID]);
  const repo = new PostgresAlertRepository(pool!, ACTIVE_WINDOW);
  const { alert } = await repo.create({
    requestId: `parity-pg-${seq}`, ownerId: PG_SUBJECT, latitude: null, longitude: null,
  });
  return { repo: repo as AlertRepository, alert };
}

async function freshFake(seq: string) {
  const repo = new FakeAlertRepository();
  const { alert } = await repo.create({
    requestId: `parity-fk-${seq}`, ownerId: `fake_owner_${seq}`,
    latitude: null, longitude: null,
  });
  return { repo: repo as AlertRepository, alert };
}

/**
 * The table every backend must satisfy.
 *
 * `from` is reached first, then `to` is attempted; `expect` is the status the
 * alert must hold afterwards. Mirrors transition_alert (0004).
 */
const CASES: { label: string; from: AlertStatus[]; to: AlertStatus; expect: AlertStatus }[] = [
  // Terminal states are final — the defect this suite exists for.
  { label: 'resolved cannot escalate',  from: ['resolved'],  to: 'escalated', expect: 'resolved' },
  { label: 'cancelled cannot escalate', from: ['cancelled'], to: 'escalated', expect: 'cancelled' },
  { label: 'expired cannot escalate',   from: ['expired'],   to: 'escalated', expect: 'expired' },
  { label: 'resolved cannot expire',    from: ['resolved'],  to: 'expired',   expect: 'resolved' },
  { label: 'cancelled cannot resolve',  from: ['cancelled'], to: 'resolved',  expect: 'cancelled' },
  { label: 'expired cannot cancel',     from: ['expired'],   to: 'cancelled', expect: 'expired' },
  // A terminal state reached THROUGH escalation is still terminal.
  { label: 'escalated->resolved is final',
    from: ['escalated', 'resolved'], to: 'escalated', expect: 'resolved' },
  // Valid transitions must keep working.
  { label: 'active -> escalated', from: [],            to: 'escalated', expect: 'escalated' },
  { label: 'active -> resolved',  from: [],            to: 'resolved',  expect: 'resolved' },
  { label: 'active -> cancelled', from: [],            to: 'cancelled', expect: 'cancelled' },
  { label: 'active -> expired',   from: [],            to: 'expired',   expect: 'expired' },
  { label: 'escalated -> resolved (owner_late)',
    from: ['escalated'], to: 'resolved',  expect: 'resolved' },
  { label: 'escalated -> expired', from: ['escalated'], to: 'expired',   expect: 'expired' },
  // No double escalation: the second attempt must not overwrite the first.
  { label: 'escalated -> escalated is refused',
    from: ['escalated'], to: 'escalated', expect: 'escalated' },
];

/** Fields a transition needs so the row satisfies its own constraints. */
function fieldsFor(to: AlertStatus): Parameters<AlertRepository['updateStatus']>[2] {
  const now = new Date();
  if (to === 'resolved') return { resolvedAt: now, resolvedBy: 'owner' };
  if (to === 'escalated') return { escalatedAt: now, escalationReason: 'no_answer' };
  return {};
}

const BACKENDS: {
  name: string;
  skip: () => string;
  fresh: (seq: string) => Promise<{ repo: AlertRepository; alert: { id: string } }>;
}[] = [
  { name: 'Firestore (emulator)', skip: () => fsReason, fresh: freshFirestore },
  { name: 'PostgreSQL',           skip: () => pgReason, fresh: freshPostgres },
  { name: 'Fake (in-memory)',     skip: () => '',       fresh: freshFake },
];

for (const backend of BACKENDS) {
  describe(`transition rules — ${backend.name}`, () => {
    CASES.forEach((c, i) => {
      test(c.label, async (t) => {
        const why = backend.skip();
        if (why) { t.skip(why); return; }

        const { repo, alert } = await backend.fresh(`${i}`.padStart(3, '0'));
        for (const step of c.from) {
          await repo.updateStatus(alert.id, step, fieldsFor(step));
        }
        const result = await repo.updateStatus(alert.id, c.to, fieldsFor(c.to));

        assert.equal(result.status, c.expect,
          `${backend.name}: expected ${c.expect} after attempting ${c.to}`);
        // And the stored row agrees with what was returned.
        const reread = await repo.findById(alert.id);
        assert.equal(reread?.status, c.expect, `${backend.name}: stored status must match`);
      });
    });

    test('an unsupported target is refused, not silently applied', async (t) => {
      const why = backend.skip();
      if (why) { t.skip(why); return; }
      const { repo, alert } = await backend.fresh('900');
      // 'active' is not a transition target: an alert is born active and
      // never returns. transition_alert raises; the others must too.
      await assert.rejects(() => repo.updateStatus(alert.id, 'active', {}),
        `${backend.name}: target 'active' must be refused`);
      assert.equal((await repo.findById(alert.id))?.status, 'active',
        'and nothing changed');
    });

    test('a refused transition writes no fields', async (t) => {
      const why = backend.skip();
      if (why) { t.skip(why); return; }
      const { repo, alert } = await backend.fresh('901');
      await repo.updateStatus(alert.id, 'resolved', fieldsFor('resolved'));
      await repo.updateStatus(alert.id, 'escalated', fieldsFor('escalated'));

      const after = await repo.findById(alert.id);
      assert.equal(after?.status, 'resolved');
      assert.equal(after?.escalatedAt, undefined,
        'escalatedAt must not be written by a refused escalation');
      assert.equal(after?.escalationReason, undefined,
        'nor the reason — a resolved alert carrying an escalation reason is a lie');
    });
  });
}

describe('concurrency — the guard cannot be bypassed by racing', () => {
  for (const backend of BACKENDS) {
    test(`${backend.name}: concurrent resolve and escalate yield one consistent state`, async (t) => {
      const why = backend.skip();
      if (why) { t.skip(why); return; }

      const { repo, alert } = await backend.fresh('950');
      const [a, b] = await Promise.all([
        repo.updateStatus(alert.id, 'resolved', fieldsFor('resolved')),
        repo.updateStatus(alert.id, 'escalated', fieldsFor('escalated')),
      ]);

      const stored = await repo.findById(alert.id);

      // BOTH interleavings are legitimate, and the test must not depend on
      // which one happened:
      //
      //   resolve first  -> resolved, no escalatedAt (the escalation was
      //                     refused, which is the guard working)
      //   escalate first -> resolved WITH escalatedAt, because
      //                     escalated -> resolved is the valid `owner_late`
      //                     path and the alert keeps its escalation history
      //
      // An earlier version asserted a resolved alert never carries
      // escalatedAt. That was simply wrong, and it passed only because
      // PostgreSQL happened to interleave one way - exactly the kind of
      // order-dependent assertion that hides a race rather than finding one.
      //
      // The invariant that actually matters: a resolve is never undone.
      assert.ok(['resolved', 'escalated'].includes(stored!.status));
      const anyoneSawResolved = [a, b].some((r) => r.status === 'resolved');
      if (anyoneSawResolved) {
        assert.equal(stored!.status, 'resolved',
          'once a caller has been told the alert is resolved, it must stay resolved');
      }
      if (stored!.status === 'resolved') {
        assert.notEqual(stored!.resolvedAt, undefined,
          'a resolved alert records when it ended');
      }
      for (const [who, seen] of [['first', a], ['second', b]] as const) {
        assert.ok(['resolved', 'escalated'].includes(seen.status),
          `${who} caller saw an impossible status: ${seen.status}`);
      }
    });

    test(`${backend.name}: a resolve racing a safety check cannot re-open the alert`, async (t) => {
      const why = backend.skip();
      if (why) { t.skip(why); return; }

      // The real sequence: she resolves while a queued safety check is in
      // flight. Whatever the interleaving, the alert must not be escalated
      // afterwards if the resolve landed first.
      const { repo, alert } = await backend.fresh('951');
      await repo.updateStatus(alert.id, 'resolved', fieldsFor('resolved'));

      const attempts = await Promise.all(
        [0, 1, 2, 3].map(() => repo.updateStatus(alert.id, 'escalated', fieldsFor('escalated'))),
      );
      for (const r of attempts) assert.equal(r.status, 'resolved');
      assert.equal((await repo.findById(alert.id))?.status, 'resolved',
        'four concurrent escalation attempts must not move a resolved alert');
    });
  }
});

/**
 * Malformed ids, across all three implementations.
 *
 * The id has DIFFERENT semantics per backend, which is the whole reason this
 * needed two guards rather than one:
 *
 *   PostgreSQL - `alerts.id` is a uuid, distinct from the owner. A non-uuid
 *                raises 22P02 at the cast.
 *   Firestore  - the document id IS the owner's uid, which is what makes
 *                "one active alert per user" a schema property. A uuid
 *                predicate would reject every real id in that collection.
 *
 * So the predicates differ by necessity. What must NOT differ is the CONTRACT:
 * a malformed id is never an uncaught exception, `findById` reports null, and a
 * method that returns an Alert reports a clean not-found.
 */
const MALFORMED: { label: string; id: string }[] = [
  { label: 'empty', id: '' },
  { label: 'single dot', id: '.' },
  { label: 'double dot', id: '..' },
  { label: 'interior slash', id: 'a/b' },
  { label: 'double leading slash', id: '//x' },
  { label: 'leading slash', id: '/victim' },
  { label: 'trailing slash', id: 'victim/' },
  { label: 'reserved pattern', id: '__proto__' },
  { label: 'reserved-ish', id: '__id1__' },
  { label: 'over 1500 bytes', id: 'a'.repeat(1501) },
  { label: 'NUL byte', id: 'a\u0000b' },
  { label: 'path traversal', id: '../../etc/passwd' },
  { label: 'sql-ish', id: "'; DROP TABLE alerts; --" },
  { label: 'not a uuid', id: 'not-a-uuid' },
];

for (const backend of BACKENDS) {
  describe(`malformed ids — ${backend.name}`, () => {
    test('findById returns null and never throws', async (t) => {
      const why = backend.skip();
      if (why) { t.skip(why); return; }
      const { repo } = await backend.fresh('800');
      for (const { label, id } of MALFORMED) {
        const out = await repo.findById(id).then((r) => r, (e: unknown) => e as Error);
        assert.equal(out, null, `${backend.name}: findById(${label}) must be null, got ${
          out instanceof Error ? `${out.constructor.name}: ${out.message}` : 'an alert'}`);
      }
    });

    test('a method returning an Alert reports a clean not-found, never a crash', async (t) => {
      const why = backend.skip();
      if (why) { t.skip(why); return; }
      const { repo } = await backend.fresh('801');
      for (const { label, id } of MALFORMED) {
        for (const [name, call] of [
          ['updateStatus', () => repo.updateStatus(id, 'resolved', { resolvedAt: new Date() })],
          ['recordFailedAttempt', () => repo.recordFailedAttempt(id, new Date())],
        ] as [string, () => Promise<unknown>][]) {
          const err = await call().then(() => null, (e: unknown) => e as Error);
          assert.ok(err, `${backend.name}: ${name}(${label}) must reject`);
          // A raw TypeError or a driver error is a crash, not a contract.
          assert.ok(!(err instanceof TypeError),
            `${backend.name}: ${name}(${label}) threw a raw TypeError`);
          assert.ok(!/invalid input syntax|INVALID_ARGUMENT|resource path/i.test(err.message),
            `${backend.name}: ${name}(${label}) leaked a driver error: ${err.message}`);
        }
      }
    });

    test('a valid id still resolves, and a valid-but-absent one is null', async (t) => {
      const why = backend.skip();
      if (why) { t.skip(why); return; }
      const { repo, alert } = await backend.fresh('802');
      assert.equal((await repo.findById(alert.id))?.id, alert.id, 'the real alert still resolves');
      // A well-formed id for this backend that names nothing.
      const absent = backend.name.startsWith('PostgreSQL') ? randomUUID() : 'parity_absent_uid';
      assert.equal(await repo.findById(absent), null);
    });

    test('a list-returning method is empty, not an exception', async (t) => {
      const why = backend.skip();
      if (why) { t.skip(why); return; }
      const { repo } = await backend.fresh('803');
      for (const { label, id } of MALFORMED) {
        const out = await repo.listHistoryForOwner(id).then((r) => r, (e: unknown) => e as Error);
        assert.ok(Array.isArray(out), `${backend.name}: listHistoryForOwner(${label}) must be an array`);
        assert.equal((out as unknown[]).length, 0);
      }
    });
  });
}

describe('each backend accepts ITS OWN valid id shape', () => {
  test('PostgreSQL accepts non-canonical uuid forms the column accepts', async (t) => {
    if (pgReason) { t.skip(pgReason); return; }
    const { repo, alert } = await freshPostgres('810');
    for (const form of [alert.id, alert.id.toUpperCase(), alert.id.replace(/-/g, ''), `{${alert.id}}`]) {
      assert.equal((await repo.findById(form))?.id, alert.id,
        `the uuid column accepts ${form}, so the guard must too`);
    }
  });

  test('Firestore accepts a plain uid, which is NOT uuid-shaped', async (t) => {
    if (fsReason) { t.skip(fsReason); return; }
    // The point of two guards: this id would fail the PostgreSQL predicate.
    const { repo, alert } = await freshFirestore('811');
    assert.ok(!/^[0-9a-f]{8}-/i.test(alert.id), 'the Firestore id is a uid, not a uuid');
    assert.equal((await repo.findById(alert.id))?.id, alert.id);
  });
});
