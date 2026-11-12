/** Real PostgreSQL; application calls use the restricted transaction wrapper. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, loadDbConfig, isLoopbackHost, createApiDatabase } from '../src/db/pool.js';
import { PostgresAcceptanceRepository } from '../src/repositories/postgres/PostgresAcceptanceRepository.js';
import { AppError } from '../src/errors.js';
import { IdentityNotMappedError } from '../src/repositories/types.js';

const owner = randomUUID(), bob = randomUUID(), carol = randomUUID(), otherOwner = randomUUID();
const bobSubject = `accept-bob-${randomUUID()}`, carolSubject = `accept-carol-${randomUUID()}`;
const ownAlert = randomUUID(), otherAlert = randomUUID();
const acceptedAt = new Date('2026-10-24T09:00:00Z');
const applicationName = `acceptance-test-${randomUUID()}`;
let pool: Pool | undefined;
let available = false;
let repo: PostgresAcceptanceRepository;

before(async () => {
  if (process.env['ALEHULSH_LOCAL_DB_TESTS'] !== '1') return;
  const cfg = loadDbConfig();
  if (!isLoopbackHost(cfg.host)) throw new Error('acceptance tests require explicit loopback PostgreSQL');
  pool = createPool(cfg, { max: 8, application_name: applicationName });
  await pool.query(`INSERT INTO users(id,display_name) VALUES
    ($1,'Owner'),($2,'Bob'),($3,'Carol'),($4,'OtherOwner')`, [owner, bob, carol, otherOwner]);
  await pool.query(`INSERT INTO identity_map(firebase_uid,user_id) VALUES ($1,$2),($3,$4)`,
    [bobSubject, bob, carolSubject, carol]);
  repo = new PostgresAcceptanceRepository(createApiDatabase(pool, bobSubject));
  available = true;
});

after(async () => {
  if (!pool) return;
  try {
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner, bob, carol, otherOwner]]);
  } finally { await pool.end(); }
});

async function reset() {
  await pool!.query('DELETE FROM alerts WHERE id=ANY($1::uuid[])', [[ownAlert, otherAlert]]);
  await pool!.query(`INSERT INTO alerts(id,owner_id,request_id,expires_at)
    VALUES ($1,$2,$3,now()+interval '2 hours'),($4,$5,$6,now()+interval '2 hours')`,
    [ownAlert, owner, randomUUID(), otherAlert, otherOwner, randomUUID()]);
}
function dbtest(name: string, fn: () => Promise<void>) {
  test(name, async (t) => {
    if (!available) { t.skip('explicit synthetic loopback database not enabled'); return; }
    await reset();
    await fn();
  });
}
function acceptance(alertId: string = ownAlert, responderUid: string = bobSubject) {
  return { alertId, responderUid, acceptedAt, audience: 'contact' as const };
}

describe('PostgreSQL acceptance persistence', () => {
  dbtest('withdrawal retains original acknowledgment, forbids other identities and cannot affect a different incident',async()=>{
    await repo.record(acceptance());
    await new PostgresAcceptanceRepository(createApiDatabase(pool!,carolSubject)).withdraw(ownAlert,bobSubject,ownAlert);
    assert.ok(await repo.findFor(ownAlert,bobSubject));
    await repo.withdraw(ownAlert,bobSubject,'different-incident');assert.ok(await repo.findFor(ownAlert,bobSubject));
    await repo.withdraw(ownAlert,bobSubject,ownAlert);await repo.withdraw(ownAlert,bobSubject,ownAlert);
    assert.equal(await repo.findFor(ownAlert,bobSubject),null);assert.equal((await repo.listForAlert(ownAlert)).length,0);
    const row=(await pool!.query('SELECT accepted_at,withdrawn_at FROM acceptances WHERE alert_id=$1',[ownAlert])).rows[0];
    assert.equal(row.accepted_at.getTime(),acceptedAt.getTime());assert.ok(row.withdrawn_at);
    const reactivated=await repo.record(acceptance());assert.equal(reactivated.created,true);assert.deepEqual(reactivated.acceptance,acceptance());
  });
  dbtest('writes as restricted role and exposes external subjects rather than internal UUIDs', async () => {
    const identity = await createApiDatabase(pool!, bobSubject).query<{ role: string }>('SELECT current_user AS role');
    assert.equal(identity.rows[0]!.role, 'alehulsh_api');
    const created = await repo.record(acceptance());
    assert.equal(created.created, true);
    assert.deepEqual(created.acceptance, acceptance());
    assert.deepEqual(await repo.findFor(ownAlert, bobSubject), acceptance());
    assert.equal(await repo.findFor(ownAlert, bob), null, 'internal UUID is not an external subject');
  });

  dbtest('replays preserve the first timestamp and audience', async () => {
    await repo.record(acceptance());
    const replay = await repo.record({ ...acceptance(), acceptedAt: new Date(acceptedAt.getTime() + 60_000), audience: 'responder' });
    assert.equal(replay.created, false);
    assert.deepEqual(replay.acceptance, acceptance());
    assert.equal((await repo.listForAlert(ownAlert)).length, 1);
  });

  dbtest('concurrent acceptances produce one first writer and one durable row', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.record(acceptance())));
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.ok(results.every((result) => result.acceptance.responderUid === bobSubject));
    assert.equal((await repo.listForAlert(ownAlert)).length, 1);
  });

  dbtest('list and lookup stay within the requested alert and responder', async () => {
    await repo.record(acceptance());
    const carolRepo = new PostgresAcceptanceRepository(createApiDatabase(pool!, carolSubject));
    await carolRepo.record(acceptance(otherAlert, carolSubject));
    assert.deepEqual(await repo.listForAlert(ownAlert), [acceptance()]);
    assert.equal(await repo.findFor(ownAlert, carolSubject), null);
    assert.equal(await repo.findFor(otherAlert, bobSubject), null);
    assert.deepEqual(await carolRepo.listForAlert(otherAlert), [acceptance(otherAlert, carolSubject)]);
  });

  dbtest('unmapped identity is refused without creating an acceptance', async () => {
    await assert.rejects(repo.record(acceptance(ownAlert, `unmapped-${randomUUID()}`)), IdentityNotMappedError);
    assert.deepEqual(await repo.listForAlert(ownAlert), []);
  });

  dbtest('resolved, cancelled, expired, and overdue alerts cannot gain a new acceptance', async () => {
    for (const status of ['resolved', 'cancelled', 'expired'] as const) {
      await pool!.query(`UPDATE alerts SET status=$2::alert_status, ended_at=now(), end_reason=$2::alert_status
        WHERE id=$1`, [ownAlert, status]);
      await assert.rejects(repo.record(acceptance()), (error: unknown) => error instanceof AppError && error.code === 'alert_closed');
    }
    await pool!.query(`UPDATE alerts SET status='active', ended_at=NULL, end_reason=NULL,
      created_at=now()-interval '2 hours', expires_at=now()-interval '1 minute' WHERE id=$1`, [ownAlert]);
    await assert.rejects(repo.record(acceptance()), (error: unknown) => error instanceof AppError && error.code === 'alert_closed');
    assert.deepEqual(await repo.listForAlert(ownAlert), []);
  });

  dbtest('stored acceptance stays idempotent after closure and does not reopen the alert', async () => {
    await repo.record(acceptance());
    await pool!.query(`UPDATE alerts SET status='resolved',ended_at=now(),end_reason='resolved' WHERE id=$1`, [ownAlert]);
    const replay = await repo.record({ ...acceptance(), acceptedAt: new Date() });
    assert.equal(replay.created, false);
    assert.deepEqual(replay.acceptance, acceptance());
    const { rows } = await pool!.query('SELECT status FROM alerts WHERE id=$1', [ownAlert]);
    assert.equal(rows[0]!.status, 'resolved');
  });

  dbtest('an acceptance waiting behind a terminal transition cannot insert after it commits', async () => {
    const terminal = await pool!.connect();
    let accepting: Promise<unknown> | undefined;
    let open = false;
    try {
      await terminal.query('BEGIN');
      open = true;
      await terminal.query('SELECT id FROM alerts WHERE id=$1 FOR UPDATE', [ownAlert]);
      accepting = repo.record(acceptance()).then((result) => result, (error: unknown) => error);
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const observed = await pool!.query(`SELECT 1 FROM pg_stat_activity
          WHERE application_name=$1 AND wait_event_type='Lock'
            AND query LIKE '%INSERT INTO acceptances%'`, [applicationName]);
        if (observed.rowCount) { blocked = true; break; }
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
      assert.equal(blocked, true, 'the acceptance must actually contend for the alert lock');
      await terminal.query(`UPDATE alerts SET status='resolved',ended_at=now(),end_reason='resolved' WHERE id=$1`, [ownAlert]);
      await terminal.query('COMMIT');
      open = false;
      const outcome = await accepting;
      assert.ok(outcome instanceof AppError && outcome.code === 'alert_closed');
      assert.deepEqual(await repo.listForAlert(ownAlert), []);
    } finally {
      if (open) await terminal.query('ROLLBACK');
      terminal.release();
      if (accepting) await accepting;
    }
  });

  dbtest('erasure reaches every acceptance for one responder and preserves other responders', async () => {
    await repo.record(acceptance());
    await repo.record(acceptance(otherAlert));
    const carolRepo = new PostgresAcceptanceRepository(createApiDatabase(pool!, carolSubject));
    await carolRepo.record(acceptance(ownAlert, carolSubject));
    assert.equal(await repo.deleteAllForResponder(bobSubject), 2);
    assert.equal(await repo.deleteAllForResponder(bobSubject), 0);
    assert.deepEqual(await repo.listForAlert(ownAlert), [acceptance(ownAlert, carolSubject)]);
  });

  dbtest('malformed resource identifiers read as absent and cannot create rows', async () => {
    for (const id of ['', 'not-a-uuid', 'x'.repeat(65)]) {
      assert.equal(await repo.findFor(id, bobSubject), null);
      assert.deepEqual(await repo.listForAlert(id), []);
      await assert.rejects(repo.record(acceptance(id)), (error: unknown) => error instanceof AppError && error.code === 'not_found');
    }
    assert.equal(await repo.findFor(ownAlert, ''), null);
    await assert.rejects(repo.record({ ...acceptance(), acceptedAt: new Date(NaN) }),
      (error: unknown) => error instanceof AppError && error.code === 'invalid_request');
  });
});
