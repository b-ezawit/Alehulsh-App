import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hashEmail } from '../src/crypto/identifier.js';
import { Pool } from 'pg';
import { requireRestrictedRuntimeLogin } from '../src/db/runtimeLogin.js';
import { createPool, loadDbConfig, isLoopbackHost, createApiDatabase, withApiTransaction } from '../src/db/pool.js';
import { SupabaseSessionBridge, readSessionPolicy } from '../src/auth/SupabaseSessionBridge.js';
import { createWorkersApp } from '../src/workers/app.js';
import { makeDeps, PEPPER } from './fakes.js';
let pool: Pool | undefined, runtimePool: Pool | undefined;
const runtimeRole = 'bridge_runtime_' + randomUUID().replaceAll('-', '');
const subjects: string[] = [];
const policy = { maxAgeSeconds: 0, inactivitySeconds: 0 };
before(async () => {
  if (process.env['ALEHULSH_LOCAL_DB_TESTS'] !== '1') return; const config = loadDbConfig(); if (!isLoopbackHost(config.host)) throw Error('synthetic loopback fixture only'); pool = createPool(config); await pool.query('SELECT 1');
  await pool.query(`CREATE ROLE ${runtimeRole} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD 'synthetic_bridge_runtime_only'`);
  await pool.query(`GRANT alehulsh_api TO ${runtimeRole}`);
  runtimePool = new Pool({ ...config, user: runtimeRole, password: 'synthetic_bridge_runtime_only', ssl: false, max: 2 });
});
after(async () => { if (!pool) return; await pool.query("DELETE FROM users WHERE id IN (SELECT user_id FROM identity_map WHERE firebase_uid LIKE 'supabase:%' AND substring(firebase_uid from 10)=ANY($1))", [subjects]); await pool.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [subjects]); await runtimePool?.end(); await pool.query(`DROP ROLE IF EXISTS ${runtimeRole}`); await pool.end(); });
async function fixture() { const uid = randomUUID(), sessionId = randomUUID(); subjects.push(uid); await pool!.query('INSERT INTO auth.users(id,email,email_confirmed_at,phone,phone_confirmed_at)VALUES($1,$2,now(),$3,now())', [uid, `synthetic-${uid}@test.invalid`, '+251911234567']); await pool!.query('INSERT INTO auth.sessions(id,user_id)VALUES($1,$2)', [sessionId, uid]); return { uid, sessionId }; }
const bridge = () => new SupabaseSessionBridge(createApiDatabase(pool!), policy);
function local(name: string, fn: () => Promise<void>) { test(name, async t => { if (!pool) { t.skip('explicit isolated local database required'); return; } await fn(); }); }
local('provider Auth RLS and isolated reader column grants are exercised', async () => {
  const tables = await pool!.query("SELECT c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth' AND c.relname IN ('users','sessions')");
  assert.equal(tables.rowCount, 2); assert.ok(tables.rows.every(row => row.rls === true));
  const { rows: [role] } = await pool!.query("SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='alehulsh_auth_reader'");
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcanlogin: false });
  const { rows: [grants] } = await pool!.query("SELECT has_column_privilege('alehulsh_auth_reader','auth.users','encrypted_password','SELECT') AS password_read,has_column_privilege('alehulsh_auth_reader','auth.users','email','SELECT') AS email_read");
  assert.deepEqual(grants, { password_read: false, email_read: true });
  const actor = await fixture(); assert.ok(await bridge().inspect(actor));
});
local('live session inspection binds subject/session exactly and does not provision implicitly', async () => {
  const actor = await fixture(), identity = await bridge().inspect(actor); assert.equal(identity?.applicationSubject, null); assert.equal(identity?.verifiedPhone, '+251911234567');
  assert.equal(await bridge().inspect({ ...actor, sessionId: randomUUID() }), null); assert.equal(await bridge().inspect({ ...actor, uid: randomUUID() }), null);
  const rows = await pool!.query('SELECT count(*)::int AS n FROM supabase_accounts WHERE auth_subject=$1', [actor.uid]); assert.equal(rows.rows[0].n, 0);
});
local('deleted, banned, anonymous, expired and revoked sessions cannot authenticate', async () => {
  for (const update of ["banned_until=now()+interval '1 hour'", "deleted_at=now()", 'is_anonymous=true']) {
    const actor = await fixture(); await pool!.query(`UPDATE auth.users SET ${update} WHERE id=$1`, [actor.uid]); assert.equal(await bridge().inspect(actor), null);
  }
  const expired = await fixture(); await pool!.query("UPDATE auth.sessions SET not_after=now()-interval '1 second' WHERE id=$1", [expired.sessionId]); assert.equal(await bridge().inspect(expired), null);
  const revoked = await fixture(); await pool!.query('DELETE FROM auth.sessions WHERE id=$1', [revoked.sessionId]); assert.equal(await bridge().inspect(revoked), null);
});
local('timebox and inactivity policies are explicit and enforced before background cleanup', async () => {
  const actor = await fixture(); await pool!.query("UPDATE auth.sessions SET created_at=now()-interval '2 hours',refreshed_at=(now() AT TIME ZONE 'UTC')-interval '1 hour' WHERE id=$1", [actor.sessionId]);
  assert.equal(await new SupabaseSessionBridge(createApiDatabase(pool!), { maxAgeSeconds: 3600, inactivitySeconds: 0 }).inspect(actor), null);
  assert.equal(await new SupabaseSessionBridge(createApiDatabase(pool!), { maxAgeSeconds: 0, inactivitySeconds: 60 }).inspect(actor), null);
  assert.ok(await bridge().inspect(actor));
});
local('API logout revokes only the authenticated provider session and denies its still-valid JWT immediately', async () => {
  const actor=await fixture(), other=await fixture();
  const app=createWorkersApp({tokenVerifier:()=>({verify:async()=>actor}),
    withAuthDatabase:async(_env,run)=>run(createApiDatabase(runtimePool!))});
  const env={SUPABASE_SESSION_MAX_AGE_SECONDS:'0',SUPABASE_SESSION_INACTIVITY_SECONDS:'0'};
  const send=(path:string,body?:unknown)=>app.request(path,{method:body===undefined?'GET':'POST',
    headers:{authorization:'Bearer synthetic-valid-token','content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)})},env);
  assert.equal((await send('/v1/me/logout',{sessionId:other.sessionId})).status,400);
  assert.equal((await send('/v1/me/logout',{})).status,204);
  assert.equal(await bridge().inspect(actor),null);
  assert.ok(await bridge().inspect(other));
  assert.equal((await send('/v1/me/account')).status,401);
  assert.equal((await pool!.query('SELECT id FROM auth.sessions WHERE id=$1',[actor.sessionId])).rowCount,1);
  await assert.rejects(createApiDatabase(runtimePool!).query('SELECT * FROM public.revoked_supabase_sessions'),
    (e:unknown)=>(e as {code?:string}).code==='42501');
});
local('provider confirmation fields are authoritative; missing confirmation grants no identifier ownership', async () => {
  const actor = await fixture(); await pool!.query('UPDATE auth.users SET phone_confirmed_at=NULL,email_confirmed_at=NULL WHERE id=$1', [actor.uid]);
  const identity = await bridge().inspect(actor); assert.equal(identity?.verifiedPhone, null); assert.equal(identity?.verifiedEmail, null);
});
local('verified provider identifiers synchronize with stale-proof fencing and lose eligibility after confirmation is removed',async()=>{
  const actor=await fixture(), service=new SupabaseSessionBridge(createApiDatabase(runtimePool!),policy);
  await service.provision(actor,{name:'Synthetic',homeAddress:'',keywordHash:'synthetic-hash'});
  const identity=(await service.inspect(actor))!;
  await service.synchronizeIdentifiers(actor,identity,PEPPER);
  const read=async()=> (await pool!.query('SELECT phone_hash,email_hash,phone_verified_at,email_verified_at FROM users WHERE id=(SELECT user_id FROM supabase_accounts WHERE auth_subject=$1)',[actor.uid])).rows[0];
  const stored=await read();assert.ok(stored.phone_verified_at);assert.ok(stored.email_verified_at);
  assert.equal(stored.email_hash,hashEmail(identity.verifiedEmail!,PEPPER));
  await pool!.query('UPDATE auth.users SET phone_confirmed_at=NULL,email_confirmed_at=NULL WHERE id=$1',[actor.uid]);
  await assert.rejects(service.synchronizeIdentifiers(actor,identity,PEPPER),(e:unknown)=>(e as {code?:string}).code==='40001');
  await service.synchronizeIdentifiers(actor,(await service.inspect(actor))!,PEPPER);
  assert.deepEqual(await read(),{phone_hash:null,email_hash:null,phone_verified_at:null,email_verified_at:null});
});
local('concurrent explicit provisioning is atomic, idempotent and preserves the first keyword', async () => {
  const actor = await fixture(), profile = { name: 'Synthetic', homeAddress: '', keywordHash: 'synthetic-first-hash' };
  const results = await Promise.all(Array.from({ length: 8 }, () => bridge().provision(actor, profile))); assert.equal(new Set(results).size, 1);
  await bridge().provision(actor, { ...profile, keywordHash: 'must-not-replace' });
  const row = await pool!.query('SELECT u.keyword_hash FROM users u JOIN supabase_accounts a ON a.user_id=u.id WHERE a.auth_subject=$1', [actor.uid]); assert.equal(row.rowCount, 1); assert.equal(row.rows[0].keyword_hash, profile.keywordHash);
  assert.equal((await bridge().inspect(actor))?.applicationSubject, `supabase:${actor.uid}`);
});
local('provisioning rollback cannot leave a user or identity binding behind', async () => {
  const actor = await fixture(); await assert.rejects(withApiTransaction(pool!, null, async tx => { await new SupabaseSessionBridge(tx, policy).provision(actor, { name: 'Synthetic', homeAddress: '', keywordHash: 'synthetic' }); throw Error('synthetic abort'); }), /synthetic abort/);
  assert.equal((await bridge().inspect(actor))?.applicationSubject, null);
  const row = await pool!.query('SELECT count(*)::int AS n FROM identity_map WHERE firebase_uid=$1', [`supabase:${actor.uid}`]); assert.equal(row.rows[0].n, 0);
});
local('a matching legacy email never links or overwrites the legacy account', async () => {
  const actor = await fixture(), legacy = randomUUID(), legacySubject = `legacy-${randomUUID()}`;
  try {
    await pool!.query("INSERT INTO users(id,display_name,keyword_hash,email_hash,email_verified_at)VALUES($1,'Existing','legacy-hash',$2,now())", [legacy, hashEmail(`synthetic-${actor.uid}@test.invalid`, PEPPER)]); await pool!.query('INSERT INTO identity_map(firebase_uid,user_id)VALUES($1,$2)', [legacySubject, legacy]);
    const canonical = await bridge().provision(actor, { name: 'New', homeAddress: '', keywordHash: 'new-hash' }); assert.notEqual(canonical, legacySubject);
    const old = await pool!.query('SELECT keyword_hash FROM users WHERE id=$1', [legacy]); assert.equal(old.rows[0].keyword_hash, 'legacy-hash');
  } finally { await pool!.query('DELETE FROM users WHERE id=$1', [legacy]); }
});
local('restricted API role cannot read raw Auth records or write identity bindings', async () => {
  const actor = await fixture(), db = createApiDatabase(runtimePool!);
  await requireRestrictedRuntimeLogin(db);
  await assert.rejects(requireRestrictedRuntimeLogin(createApiDatabase(pool!)), /restricted runtime/);
  for (const sql of ['SELECT email FROM auth.users', 'SELECT id FROM auth.sessions', 'SELECT * FROM supabase_accounts', 'SET ROLE alehulsh_auth_reader']) await assert.rejects(db.query(sql), (error: unknown) => (error as { code?: string; }).code === '42501');
  assert.ok(await bridge().inspect(actor));
});
local('Workers use the real session bridge; unprovisioned SOS and revoked sessions cannot reach repositories', async () => {
  const actor = await fixture(), deps = makeDeps(); let repositoryCalls = 0;
  const app = createWorkersApp({
    tokenVerifier: () => ({ verify: async () => actor }), withAuthDatabase: async (_env, run) => run(createApiDatabase(pool!)),
    withRepositories: async (_env, _subject, run) => { repositoryCalls++; return run({ alerts: deps.alerts, inbox: deps.inbox, writes: deps }); }
  });
  const env = { KEYWORD_PEPPER: PEPPER, SUPABASE_SESSION_MAX_AGE_SECONDS: '0', SUPABASE_SESSION_INACTIVITY_SECONDS: '0' };
  const send = (path: string, body?: unknown) => app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer signed-fixture', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  assert.deepEqual(await (await send('/v1/me/account')).json(), { provisioned: false });
  assert.equal((await send('/v1/alerts', { requestId: 'must-not-provision' })).status, 403); assert.equal(repositoryCalls, 0);
  assert.equal((await send('/v1/me/account', { name: 'Synthetic', keyword: 'tangerine' })).status, 201);
  assert.deepEqual(await (await send('/v1/me/account')).json(), { provisioned: true });
  await pool!.query('DELETE FROM auth.sessions WHERE id=$1', [actor.sessionId]);
  assert.equal((await send('/v1/me/inbox')).status, 401); assert.equal(repositoryCalls, 0);
});
test('missing session policy never guesses timeouts', () => {
  assert.throws(() => readSessionPolicy({}), /SUPABASE_SESSION_MAX_AGE_SECONDS/);
  assert.throws(() => readSessionPolicy({ SUPABASE_SESSION_MAX_AGE_SECONDS: '0', SUPABASE_SESSION_INACTIVITY_SECONDS: '-1' }));
  assert.deepEqual(readSessionPolicy({ SUPABASE_SESSION_MAX_AGE_SECONDS: '0', SUPABASE_SESSION_INACTIVITY_SECONDS: '0' }), policy);
});
