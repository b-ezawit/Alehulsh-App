import { PostgresAlertRepository } from '../src/repositories/postgres/PostgresAlertRepository.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createApiDatabase, createPool, isLoopbackHost, loadDbConfig, withApiTransaction } from '../src/db/pool.js';
import { PostgresEvidenceRepository, type EvidenceIntegrityVerifier } from '../src/repositories/postgres/PostgresEvidenceRepository.js';
import { storagePathFor } from '../src/evidence/EvidenceStore.js';
import type { EvidenceRecord } from '../src/repositories/types.js';

let pool: Pool | undefined;
let ready = false;
const alice = randomUUID(), bob = randomUUID(), responder = randomUUID();
const aliceSubject = `evidence-alice-${randomUUID()}`;
const bobSubject = `evidence-bob-${randomUUID()}`;
const responderSubject = `evidence-responder-${randomUUID()}`;
const aliceAlert = randomUUID(), bobAlert = randomUUID();
const deliberateId = randomUUID(), automaticId = randomUUID();
const objects = new Map<string, Uint8Array>();
let inspections = 0;
const integrity: EvidenceIntegrityVerifier = {
  async publish(path,contentType) {
    const measured=await this.inspect(path); const destination=`${path}/published/${randomUUID()}`;
    objects.set(destination,objects.get(path)!.slice());return{...measured,storagePath:destination};
  },
  async inspect(path) {
    inspections++;
    const bytes = objects.get(path);
    if (!bytes) throw new Error('synthetic object missing');
    return { sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  },
};
let owner: PostgresEvidenceRepository;
let other: PostgresEvidenceRepository;
let helper: PostgresEvidenceRepository;

before(async () => {
  if (process.env['ALEHULSH_LOCAL_DB_TESTS'] !== '1') return;
  const config = loadDbConfig();
  if (!isLoopbackHost(config.host)) throw new Error('evidence tests require loopback PostgreSQL');
  pool = createPool(config, { max: 4 });
  await pool.query(`INSERT INTO users (id,display_name) VALUES ($1,'Alice'),($2,'Bob'),($3,'Responder')`,
    [alice, bob, responder]);
  await pool.query(`INSERT INTO identity_map (firebase_uid,user_id) VALUES ($1,$2),($3,$4),($5,$6)`,
    [aliceSubject, alice, bobSubject, bob, responderSubject, responder]);
  await pool.query(`INSERT INTO alerts (id,owner_id,request_id,expires_at)
    VALUES ($1,$2,$3,now()+interval '1 hour'),($4,$5,$6,now()+interval '1 hour')`,
    [aliceAlert, alice, randomUUID(), bobAlert, bob, randomUUID()]);
  await pool.query(`INSERT INTO inbox (recipient_id,alert_id,audience,projection)
    VALUES ($1,$2,'responder',$3::jsonb)`, [responder, aliceAlert, JSON.stringify({ alertId: aliceAlert })]);
  await pool.query(`INSERT INTO acceptances (alert_id,responder_id,audience)
    VALUES ($1,$2,'responder')`, [aliceAlert, responder]);
  owner = new PostgresEvidenceRepository(createApiDatabase(pool, aliceSubject), integrity);
  other = new PostgresEvidenceRepository(createApiDatabase(pool, bobSubject), integrity);
  helper = new PostgresEvidenceRepository(createApiDatabase(pool, responderSubject), integrity);
  ready = true;
});

after(async () => {
  if (!pool) return;
  try {
    await pool.query(`DELETE FROM evidence WHERE owner_id = ANY($1::uuid[])`, [[alice, bob, responder]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[alice, bob, responder]]);
  } finally { await pool.end(); }
});

function record(id: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id, alertId: aliceAlert, alertKey: aliceAlert, ownerUid: aliceSubject,
    storagePath: storagePathFor(aliceSubject, aliceAlert, id), contentType: 'audio/aac',
    sizeBytes: null, durationMs: 1200, createdAt: new Date(), uploaded: false,
    kind: 'deliberate', ...overrides,
  };
}
function localTest(name: string, body: () => Promise<void>) {
  test(name, async (t) => {
    if (!ready) { t.skip('explicit synthetic loopback DB not enabled'); return; }
    await body();
  });
}

localTest('pending metadata round-trips under owner RLS and preserves deliberate/automatic intent', async () => {
  const note = await owner.create(record(deliberateId));
  await owner.create(record(automaticId, { kind: 'automatic' }));
  assert.equal(note.ownerUid, aliceSubject);
  assert.equal(note.alertKey, aliceAlert);
  assert.equal(note.durationMs, 1200);
  assert.equal(note.uploaded, false);
  assert.equal((await owner.findById(automaticId))?.kind, 'automatic');
  assert.equal((await owner.listForAlert(aliceAlert)).length, 2);
  assert.equal((await owner.listForOwner(aliceSubject)).length, 2);
});

localTest('another owner and system identity cannot read or enumerate protected evidence', async () => {
  assert.equal(await other.findById(deliberateId), null);
  assert.deepEqual(await other.listForAlert(aliceAlert), []);
  assert.deepEqual(await other.listForOwner(aliceSubject), []);
  const system = new PostgresEvidenceRepository(createApiDatabase(pool!));
  assert.equal(await system.findById(deliberateId), null);
});

localTest('foreign owner/incident binding cannot create a recording', async () => {
  await assert.rejects(() => other.create(record(randomUUID())));
  const id = randomUUID();
  await assert.rejects(() => owner.create(record(id, {
    alertId: bobAlert, alertKey: bobAlert,
    storagePath: storagePathFor(aliceSubject, bobAlert, id),
  })));
});

localTest('finalization without a trusted checksum verifier fails closed', async () => {
  const unsafe = new PostgresEvidenceRepository(createApiDatabase(pool!, aliceSubject));
  await assert.rejects(() => unsafe.markUploaded(deliberateId, 5), /publisher/);
  const { rows } = await pool!.query(`SELECT state,actual_sha256,completed_at FROM evidence WHERE id=$1`, [deliberateId]);
  assert.deepEqual(rows[0], { state: 'pending_upload', actual_sha256: null, completed_at: null });
});

localTest('trusted byte inspection finalizes a checksum and rejects a mismatched HEAD size', async () => {
  const path = storagePathFor(aliceSubject, aliceAlert, deliberateId);
  objects.set(path, new TextEncoder().encode('synthetic deliberate audio'));
  await assert.rejects(() => owner.markUploaded(deliberateId, 1));
  assert.equal((await owner.findById(deliberateId))?.uploaded, false);
  const completed = await owner.markUploaded(deliberateId, null);
  assert.equal(completed.uploaded, true);
  assert.equal(completed.sizeBytes, objects.get(path)!.length);
  const { rows } = await pool!.query(`SELECT actual_sha256,completed_at FROM evidence WHERE id=$1`, [deliberateId]);
  assert.match(rows[0].actual_sha256, /^[0-9a-f]{64}$/);
  assert.ok(rows[0].completed_at instanceof Date);
  assert.equal((await owner.markUploaded(deliberateId, null)).uploaded, true, 'same bytes are idempotent');
  assert.equal((await owner.create(record(deliberateId))).storagePath,completed.storagePath,'metadata creation retry preserves published evidence');
});

localTest('an accepted responder reads only stored deliberate notes and cannot finalize/delete them', async () => {
  const path = storagePathFor(aliceSubject, aliceAlert, automaticId);
  objects.set(path, new TextEncoder().encode('synthetic automatic audio'));
  await owner.markUploaded(automaticId, null);
  assert.ok(await helper.findById(deliberateId));
  assert.equal(await helper.findById(automaticId), null);
  assert.deepEqual((await helper.listForAlert(aliceAlert)).map((r) => r.id), [deliberateId]);
  const before = inspections;
  await assert.rejects(() => helper.markUploaded(deliberateId, null));
  assert.equal(inspections, before, 'unauthorized finalization must not inspect the object');
  assert.equal(await helper.deleteAllForOwner(aliceSubject), 0);
  assert.ok(await owner.findById(deliberateId));
});

localTest('changed object bytes cannot replace a stored checksum on finalize replay', async () => {
  const path = storagePathFor(aliceSubject, aliceAlert, deliberateId);
  objects.set(path, new TextEncoder().encode('different synthetic bytes'));
  const before = await pool!.query(`SELECT actual_sha256 FROM evidence WHERE id=$1`, [deliberateId]);
  const replay=await owner.markUploaded(deliberateId, null);
  assert.ok(replay.storagePath.includes('/published/'));
  assert.notDeepEqual(objects.get(replay.storagePath),objects.get(path));
  const after = await pool!.query(`SELECT actual_sha256 FROM evidence WHERE id=$1`, [deliberateId]);
  assert.equal(after.rows[0].actual_sha256, before.rows[0].actual_sha256);
});

localTest('invalid metadata cannot introduce path substitution, premature upload or bad durations', async () => {
  for (const patch of [
    { storagePath: 'evidence/someone-else/recording' }, { uploaded: true },
    { durationMs: -1 }, { contentType: 'application/octet-stream' }, { alertKey: randomUUID() },
  ]) await assert.rejects(() => owner.create(record(randomUUID(), patch)));
  assert.equal(await owner.findById('not-a-uuid'), null);
  assert.deepEqual(await owner.listForAlert('not-a-uuid'), []);
});

localTest('a delayed expiry worker cannot extend responder audio access beyond the deadline', async () => {
  assert.ok(await helper.findById(deliberateId));
  await pool!.query(`UPDATE alerts SET created_at=now()-interval '2 hours',
    expires_at=now()-interval '1 hour' WHERE id=$1`, [aliceAlert]);
  try {
    assert.equal(await helper.findById(deliberateId), null);
    assert.deepEqual(await helper.listForAlert(aliceAlert), []);
    // Prove the control is in RLS itself, rather than just this adapter's SQL.
    const raw = await createApiDatabase(pool!, responderSubject).query(
      `SELECT r2_key FROM evidence WHERE id=$1`, [deliberateId]);
    assert.equal(raw.rows.length, 0);
    assert.ok(await owner.findById(deliberateId), 'owner history remains accessible');
  } finally {
    await pool!.query(`UPDATE alerts SET expires_at=now()+interval '1 hour' WHERE id=$1`, [aliceAlert]);
  }
});

localTest('a transaction started before expiry cannot extend responder access past wall-clock expiry', async () => {
  try {
    await withApiTransaction(pool!, responderSubject, async (tx) => {
      assert.equal((await tx.query(`SELECT id FROM evidence WHERE id=$1`, [deliberateId])).rows.length, 1);
      await pool!.query(`UPDATE alerts SET expires_at=clock_timestamp()+interval '100 milliseconds'
        WHERE id=$1`, [aliceAlert]);
      await tx.query('SELECT pg_sleep(0.2)');
      assert.equal((await tx.query(`SELECT r2_key FROM evidence WHERE id=$1`, [deliberateId])).rows.length, 0);
    });
    assert.ok(await owner.findById(deliberateId));
  } finally {
    await pool!.query(`UPDATE alerts SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [aliceAlert]);
  }
});

localTest('terminal closure revokes responder playback while preserving owner evidence', async () => {
  await pool!.query(`UPDATE alerts SET status='resolved',end_reason='resolved',ended_at=now() WHERE id=$1`, [aliceAlert]);
  assert.equal(await helper.findById(deliberateId), null);
  assert.ok(await owner.findById(deliberateId));
});

localTest('database trigger refuses published-byte mutation and upload-state reset',async()=>{
 const scoped=createApiDatabase(pool!,aliceSubject),before=await owner.findById(deliberateId);
 assert.ok(before,'published fixture must exist');
 for(const [column,value] of [['r2_key',storagePathFor(aliceSubject,aliceAlert,deliberateId)],['actual_sha256','b'.repeat(64)],
   ['size_bytes',999],['deliberate',false],['content_type','audio/mpeg'],['state','pending_upload']] as const){
   await assert.rejects(scoped.query(`UPDATE evidence SET ${column}=$2 WHERE id=$1`,[deliberateId,value]),
    (error:unknown)=>(error as {code?:string}).code==='23514');
 }
 const after=await owner.findById(deliberateId);assert.deepEqual(after,before);
 await scoped.query('UPDATE evidence SET r2_key=r2_key,state=state WHERE id=$1',[deliberateId]);
});

localTest('owner erasure is scoped and idempotent under restricted RLS', async () => {
  assert.equal(await other.deleteAllForOwner(aliceSubject), 0);
  assert.equal(await owner.deleteAllForOwner(aliceSubject), 2);
  assert.equal(await owner.deleteAllForOwner(aliceSubject), 0);
});

localTest('pending evidence consent metadata cannot be rewritten before upload',async()=>{
 const id=randomUUID();
 // A fixture is inserted directly because the earlier tests intentionally
 // expire the alert. The update still executes under the real owner role.
 await pool!.query(`INSERT INTO evidence(id,alert_id,owner_id,r2_key,content_type,deliberate)
  VALUES($1,$2,$3,$4,'audio/aac',false)`,[id,aliceAlert,alice,storagePathFor(aliceSubject,aliceAlert,id)]);
 await assert.rejects(createApiDatabase(pool!,aliceSubject).query('UPDATE evidence SET deliberate=true WHERE id=$1',[id]),
  (error:unknown)=>(error as {code?:string}).code==='23514');
});
localTest('legacy checksummed staging metadata can be published once without changing byte identity',async()=>{
 const id=randomUUID(),path=storagePathFor(aliceSubject,aliceAlert,id),sha='a'.repeat(64),destination=`${path}/published/${randomUUID()}`;
 await pool!.query(`INSERT INTO evidence(id,alert_id,owner_id,r2_key,content_type,state,actual_sha256,size_bytes,completed_at)
  VALUES($1,$2,$3,$4,'audio/aac','stored',$5,7,now())`,[id,aliceAlert,alice,path,sha]);
 const result=await owner.markPublished(id,path,{storagePath:destination,sha256:sha,sizeBytes:7});
 assert.equal(result.storagePath,destination);
 await assert.rejects(createApiDatabase(pool!,aliceSubject).query('UPDATE evidence SET r2_key=$2 WHERE id=$1',[id,`${path}/published/${randomUUID()}`]),
  (error:unknown)=>(error as {code?:string}).code==='23514');
});

localTest('concurrent PostgreSQL evidence admission has exactly one winner for the last slot', async () => {
  const alertId = randomUUID();
  await pool!.query(`INSERT INTO alerts(id,owner_id,request_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`, [alertId,alice,randomUUID()]);
  const item = () => { const id = randomUUID(); return record(id, { alertId, alertKey: alertId, storagePath: storagePathFor(aliceSubject,alertId,id) }); };
  for(let i=0;i<19;i++) await owner.create(item());
  const attempts=Array.from({length:8},item);
  const outcomes=await Promise.allSettled(attempts.map(r=>owner.create(r)));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await owner.listForAlert(alertId)).length,20);
  const winner=attempts[outcomes.findIndex(r=>r.status==='fulfilled')]!;
  assert.equal((await owner.create(winner)).id,winner.id);
  for(const result of outcomes) if(result.status==='rejected') assert.equal(result.reason.code,'rate_limited');
  await new PostgresAlertRepository(createApiDatabase(pool!,aliceSubject),3600000).updateStatus(alertId,'resolved',{resolvedBy:'owner'});
});

localTest('parallel PostgreSQL keyword admission is bounded, recoverable, and incident scoped', async () => {
  const alertId=randomUUID();
  await pool!.query(`INSERT INTO alerts(id,owner_id,request_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`,[alertId,alice,randomUUID()]);
  const repo=new PostgresAlertRepository(createApiDatabase(pool!,aliceSubject),3600000);
  const results=await Promise.all(Array.from({length:12},()=>repo.admitKeywordVerification(alertId,alertId,3,30000)));
  assert.equal(results.filter(Boolean).length,3);
  await pool!.query("UPDATE alerts SET keyword_admission_at=now()-interval '31 seconds' WHERE id=$1",[alertId]);
  assert.equal(await repo.admitKeywordVerification(alertId,alertId,3,30000),true);
  assert.equal(await repo.admitKeywordVerification(alertId,'stale-key',3,30000),false);
  await repo.updateStatus(alertId,'resolved',{resolvedBy:'owner'});
  assert.equal(await repo.admitKeywordVerification(alertId,alertId,3,30000),false);
});
