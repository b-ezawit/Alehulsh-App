import { requireRestrictedRuntimeLogin } from '../src/db/runtimeLogin.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createApiDatabase, createPool, isLoopbackHost, loadDbConfig, withApiTransaction,
} from '../src/db/pool.js';

let pool: Pool | undefined;
const alice = randomUUID(), bob = randomUUID();
const aliceSubject = `identity-alice-${randomUUID()}`, bobSubject = `identity-bob-${randomUUID()}`;
const aliceAlert = randomUUID(), bobAlert = randomUUID();
const aliceEvidence = randomUUID(), bobEvidence = randomUUID();
let enabled = false;

before(async () => {
  // This suite never silently falls back to a hosted DB, even if PG* happens
  // to be set. Enable only for an explicit synthetic loopback environment.
  if (process.env['ALEHULSH_LOCAL_DB_TESTS'] !== '1') return;
  const cfg = loadDbConfig();
  if (!isLoopbackHost(cfg.host)) throw new Error('identity integration tests require loopback PostgreSQL');
  pool = createPool(cfg, { max: 1 });
  await pool.query(`INSERT INTO users (id, display_name) VALUES ($1,'Alice'),($2,'Bob')`, [alice, bob]);
  await pool.query(`INSERT INTO identity_map (firebase_uid,user_id) VALUES ($1,$2),($3,$4)`, [aliceSubject, alice, bobSubject, bob]);
  await pool.query(`INSERT INTO alerts (id,owner_id,request_id,expires_at)
    VALUES ($1,$2,$3,now()+interval '2 hours'),($4,$5,$6,now()+interval '2 hours')`,
  [aliceAlert, alice, randomUUID(), bobAlert, bob, randomUUID()]);
  await pool.query(`INSERT INTO evidence (id,alert_id,owner_id,r2_key,content_type)
    VALUES ($1,$2,$3,$4,'audio/aac'),($5,$6,$7,$8,'audio/aac')`,
  [aliceEvidence, aliceAlert, alice, `identity/${aliceEvidence}`, bobEvidence, bobAlert, bob, `identity/${bobEvidence}`]);
  enabled = true;
});

after(async () => {
  if (!pool) return;
  try {
    await pool.query('DELETE FROM evidence WHERE owner_id = ANY($1::uuid[])', [[alice, bob]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[alice, bob]]);
  } finally { await pool.end(); }
});

function localTest(name: string, fn: () => Promise<void>) {
  test(name, async (t) => {
    if (!enabled) { t.skip('explicit synthetic local DB not enabled'); return; }
    await fn();
  });
}

localTest('the application runs as a restricted role and maps external subjects to internal UUIDs', async () => {
  await withApiTransaction(pool!, aliceSubject, async (tx) => {
    const { rows } = await tx.query<{ role: string; uid: string }>('SELECT current_user AS role, auth.uid()::text AS uid');
    assert.deepEqual(rows[0], { role: 'alehulsh_api', uid: alice });
  });
});

localTest('Alice can read her evidence but cannot read Bob even by exact object ID', async () => {
  const db = createApiDatabase(pool!, aliceSubject);
  const own = await db.query('SELECT id FROM evidence WHERE id = $1', [aliceEvidence]);
  const other = await db.query('SELECT id FROM evidence WHERE id = $1', [bobEvidence]);
  assert.equal(own.rows.length, 1);
  assert.equal(other.rows.length, 0);
});

localTest('Alice cannot update Bob evidence or attach her evidence to Bob alert', async () => {
  const db = createApiDatabase(pool!, aliceSubject);
  const other = await db.query('UPDATE evidence SET content_type = $2 WHERE id = $1', [bobEvidence, 'audio/ogg']);
  assert.equal(other.rowCount, 0);
  await assert.rejects(() => db.query('UPDATE evidence SET alert_id = $2 WHERE id = $1', [aliceEvidence, bobAlert]),
    (err: unknown) => ['42501', '23514'].includes((err as { code: string }).code));
  const retained = await db.query('SELECT alert_id FROM evidence WHERE id=$1', [aliceEvidence]);
  assert.equal(retained.rows.length, 1);
  assert.equal(retained.rows[0]!.alert_id, aliceAlert);
});

localTest('Alice cannot insert evidence owned by Bob or bind her own evidence to Bob alert', async () => {
  const db = createApiDatabase(pool!, aliceSubject);
  for (const [ownerId, alertId] of [[bob, bobAlert], [alice, bobAlert]]) {
    await assert.rejects(() => db.query(`INSERT INTO evidence (alert_id,owner_id,r2_key,content_type)
      VALUES ($1,$2,$3,'audio/aac')`, [alertId, ownerId, `identity/${randomUUID()}`]),
    (err: unknown) => (err as { code?: string }).code === '42501');
  }
});

localTest('owner identity does not leak to Bob or system work through the same pooled connection', async () => {
  const aliceRows = await createApiDatabase(pool!, aliceSubject).query<{ id: string }>('SELECT id::text FROM evidence');
  const bobRows = await createApiDatabase(pool!, bobSubject).query<{ id: string }>('SELECT id::text FROM evidence');
  const systemRows = await createApiDatabase(pool!).query('SELECT id FROM evidence');
  assert.deepEqual(aliceRows.rows.map((r) => r.id), [aliceEvidence]);
  assert.deepEqual(bobRows.rows.map((r) => r.id), [bobEvidence]);
  assert.equal(systemRows.rows.length, 0);
  const raw = await pool!.query<{ uid: string | null; role: string }>('SELECT auth.uid()::text AS uid, current_user AS role');
  assert.equal(raw.rows[0]?.uid, null);
  assert.notEqual(raw.rows[0]?.role, 'alehulsh_api');
});

localTest('failed work rolls back local claims and unknown subjects cannot access the body', async () => {
  await assert.rejects(() => withApiTransaction(pool!, aliceSubject, async () => { throw new Error('synthetic failure'); }));
  let called = false;
  await assert.rejects(() => withApiTransaction(pool!, `unknown-${randomUUID()}`, async () => { called = true; }), /identity not mapped/);
  assert.equal(called, false);
  const { rows } = await createApiDatabase(pool!).query<{ uid: string | null }>('SELECT auth.uid()::text AS uid');
  assert.equal(rows[0]?.uid, null);
});

localTest('runtime rejects a privileged session and a dedicated login cannot escape API grants with RESET ROLE', async () => {
  await assert.rejects(requireRestrictedRuntimeLogin(pool!), /restricted runtime/);
  const login=`test_runtime_${randomUUID().replaceAll('-','')}`;
  const config=loadDbConfig();
  await pool!.query(`CREATE ROLE ${login} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await pool!.query(`GRANT alehulsh_api TO ${login}`);
  const runtime=createPool({...config,user:login,password:'synthetic-local-only'},{max:1});
  try {
    await requireRestrictedRuntimeLogin(runtime);
    await withApiTransaction(runtime,aliceSubject,async tx=>{
      assert.equal((await tx.query('SELECT id FROM evidence WHERE id=$1',[aliceEvidence])).rowCount,1);
      await tx.query('RESET ROLE');
      await assert.rejects(tx.query('SELECT keyword_hash FROM users'),{code:'42501'});
      // The transaction is intentionally aborted by the denied SQL.
    }).catch(error=>{ if(error.code!=='25P02') throw error; });
  } finally { await runtime.end(); await pool!.query(`DROP ROLE ${login}`); }
});
