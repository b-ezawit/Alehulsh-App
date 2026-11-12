import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, createApiDatabase, loadDbConfig, isLoopbackHost } from '../src/db/pool.js';
import { PostgresProfileRepository } from '../src/repositories/postgres/PostgresProfileRepository.js';
import { PostgresContactManagementRepository } from '../src/repositories/postgres/PostgresContactManagementRepository.js';
import { PostgresAlertRepository } from '../src/repositories/postgres/PostgresAlertRepository.js';
import { PostgresInboxRepository } from '../src/repositories/postgres/PostgresInboxRepository.js';
import { createWorkersApp } from '../src/workers/app.js';

let pool: Pool | undefined;
const owner = randomUUID(), stranger = randomUUID();
const uid = `owned-${randomUUID()}`, other = `owned-${randomUUID()}`;
const first = randomUUID(), second = randomUUID();
const contact = (phone = '+251911234567', isPrimary = true) => ({ name: 'Synthetic contact', phone, email: '', relationship: '', isPrimary });
const profiles = (actor = uid) => new PostgresProfileRepository(createApiDatabase(pool!, actor));
const contacts = (actor = uid) => new PostgresContactManagementRepository(createApiDatabase(pool!, actor));
before(async () => {
  if (process.env['ALEHULSH_LOCAL_DB_TESTS'] !== '1') return;
  const config = loadDbConfig(); if (!isLoopbackHost(config.host)) throw Error('isolated local fixture only');
  pool = createPool(config);
  await pool.query("INSERT INTO users(id,display_name,keyword_hash)VALUES($1,'Owner','synthetic-keyword'),($2,'Stranger','other-keyword')", [owner, stranger]);
  await pool.query('INSERT INTO identity_map(firebase_uid,user_id)VALUES($1,$2),($3,$4)', [uid, owner, other, stranger]);
});
after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM alert_history WHERE owner_id=ANY($1::uuid[])', [[owner, stranger]]);
  await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner, stranger]]);
  await pool.end();
});
function local(name: string, run: () => Promise<void>) {
  test(name, async t => { if (!pool) { t.skip('explicit isolated database required'); return; } await run(); });
}
function app(actor = uid) {
  return createWorkersApp({
    sessionIsActive: async () => true, tokenVerifier: () => ({ verify: async () => ({ uid: actor, sessionId: randomUUID() }) }),
    withRepositories: async (_env, identity, run) => {
      const db = createApiDatabase(pool!, identity.uid);
      return run({
        profiles: new PostgresProfileRepository(db), contactManagement: new PostgresContactManagementRepository(db),
        alerts: new PostgresAlertRepository(db, 7200000), inbox: new PostgresInboxRepository(db)
      });
    }
  });
}
const send = (path: string, method = 'GET', body?: unknown, actor = uid) => app(actor).request(path, {
  method, headers: { authorization: 'Bearer synthetic-local', 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

local('profile reads and writes require the transaction owner and never return keyword hashes', async () => {
  assert.equal(await profiles().get(other), null);
  await assert.rejects(profiles().update(other, { fullName: 'Attack' }));
  const result = await profiles().update(uid, { fullName: 'Updated' });
  assert.equal(result.fullName, 'Updated'); assert.equal(result.safetyKeywordSet, true);
  assert.equal(JSON.stringify(result).includes('synthetic-keyword'), false);
  assert.equal((await profiles(other).get(other))?.fullName, 'Stranger');
});
local('editing a verified phone revokes its ownership proof; retaining it preserves proof', async () => {
  await pool!.query("UPDATE users SET phone_e164='+251911234567',phone_hash='synthetic-phone-hash',phone_verified_at=now() WHERE id=$1", [owner]);
  assert.equal((await profiles().update(uid, { phoneNumber: '+251911234567' })).phoneVerified, true);
  assert.equal((await profiles().update(uid, { phoneNumber: '+251922234567' })).phoneVerified, false);
  const row = await pool!.query('SELECT phone_hash FROM users WHERE id=$1', [owner]); assert.equal(row.rows[0].phone_hash, null);
});
local('profile route rejects keyword, identity and verification spoofing', async () => {
  for (const field of ['bloodType', 'medicalNotes', 'keywordHash', 'safetyKeyword', 'phoneVerified', 'emailVerified', 'ownerId', '__proto__']) {
    const body = JSON.parse(`{"${field}":"spoof"}`);
    assert.equal((await send('/v1/me/profile', 'PATCH', body)).status, 400);
    await assert.rejects(profiles().update(uid, body));
  }
});
local('contact retry is idempotent and a foreign contact id cannot be read, replaced or deleted', async () => {
  assert.equal(await contacts().put(uid, first, contact()), true);
  assert.equal(await contacts().put(uid, first, contact()), false);
  assert.deepEqual(await contacts(other).list(uid), []);
  await assert.rejects(contacts(other).put(other, first, contact('+251933234567')));
  await contacts(other).remove(other, first);
  assert.equal((await contacts().list(uid)).length, 1);
});
local('concurrent primary changes serialize and keep exactly one primary', async () => {
  await Promise.all([contacts().put(uid, first, contact()), contacts().put(uid, second, contact('+251944234567'))]);
  const rows = await contacts().list(uid); assert.equal(rows.length, 2); assert.equal(rows.filter(c => c.isPrimary).length, 1);
});
local('a duplicate phone rolls back the primary change rather than clearing the previous primary', async () => {
  const before = (await contacts().list(uid)).find(c => c.isPrimary)!;
  await assert.rejects(contacts().put(uid, randomUUID(), contact(before.phone)));
  assert.equal((await contacts().list(uid)).find(c => c.isPrimary)?.id, before.id);
});
local('changing contact identifiers clears a previously trusted link', async () => {
  await pool!.query('UPDATE emergency_contacts SET contact_user_id=$2,linked_at=now() WHERE id=$1', [first, stranger]);
  await contacts().put(uid, first, contact('+251955234567', false));
  const row = await pool!.query('SELECT contact_user_id,linked_at FROM emergency_contacts WHERE id=$1', [first]);
  assert.equal(row.rows[0].contact_user_id, null); assert.equal(row.rows[0].linked_at, null);
});
local('contact routes reject ownership and consent claims and do not expose another owner contacts', async () => {
  for (const extra of [{ ownerId: stranger }, { contactUserId: stranger }, { consent: true }])
    assert.equal((await send(`/v1/me/contacts/${randomUUID()}`, 'PUT', { ...contact(), ...extra })).status, 400);
  assert.deepEqual(await (await send('/v1/me/contacts', 'GET', undefined, other)).json(), { contacts: [] });
  assert.equal((await send('/v1/me/contacts/not-a-uuid', 'DELETE')).status, 400);
});
local('location opt-out strips coordinates from new alerts and history never returns precise coordinates', async () => {
  await profiles().update(uid, { locationSharingEnabled: false });
  const id = randomUUID();
  await pool!.query(`INSERT INTO alerts(id,owner_id,request_id,expires_at,location,location_quality,location_age_ms,accuracy_m)
    VALUES($1,$2,$3,now()+interval '1 hour',ST_SetSRID(ST_MakePoint(38.7,9.0),4326)::geography,'live',100,12)`, [id, owner, randomUUID()]);
  const row = await pool!.query('SELECT location,location_quality,location_age_ms,accuracy_m FROM alerts WHERE id=$1', [id]);
  assert.deepEqual(row.rows[0], { location: null, location_quality: 'unavailable', location_age_ms: null, accuracy_m: null });
  const history = await (await send('/v1/me/alerts')).json() as { alerts: Record<string, unknown>[]; };
  assert.equal(history.alerts.length, 1); assert.equal(history.alerts[0]!.hasLocation, false);
  for (const key of ['latitude', 'longitude', 'location', 'attemptCount']) assert.equal(key in history.alerts[0]!, false);
  assert.deepEqual((await (await send('/v1/me/alerts', 'GET', undefined, other)).json() as { alerts: unknown[]; }).alerts, []);
  assert.equal((await send('/v1/me/alerts?limit=101')).status, 400);
});
local('a later preference change does not cancel or modify an existing incident', async () => {
  const before = await pool!.query('SELECT id,status,location FROM alerts WHERE owner_id=$1', [owner]);
  await profiles().update(uid, { locationSharingEnabled: true });
  assert.deepEqual((await pool!.query('SELECT id,status,location FROM alerts WHERE owner_id=$1', [owner])).rows, before.rows);
});

local('retired medical fields remain stored pending policy but are absent from profile responses', async () => {
  await pool!.query("UPDATE users SET blood_type='A+',medical_notes='synthetic-retired-history' WHERE id=$1",[owner]);
  const data=await profiles().get(uid);
  assert.equal(JSON.stringify(data).includes('synthetic-retired-history'),false);
  assert.equal(Object.hasOwn(data!,'bloodType'),false);
  const stored=await pool!.query('SELECT medical_notes FROM users WHERE id=$1',[owner]);
  assert.equal(stored.rows[0].medical_notes,'synthetic-retired-history');
});
