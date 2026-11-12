import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, loadDbConfig, createApiDatabase, isLoopbackHost } from '../src/db/pool.js';
import { PostgresClientPolicyRepository } from '../src/repositories/postgres/PostgresClientPolicyRepository.js';
import { PostgresVersionTelemetryRepository } from '../src/repositories/postgres/PostgresVersionTelemetryRepository.js';

let pool: Pool | undefined;
const alice = randomUUID(), bob = randomUUID();
const subject = `metadata-${alice}`, other = `metadata-${bob}`;
before(async () => {
  if (process.env['ALEHULSH_LOCAL_DB_TESTS'] !== '1') return;
  const cfg = loadDbConfig();
  if (!isLoopbackHost(cfg.host)) throw new Error('metadata tests require an isolated loopback database');
  pool = createPool(cfg);
  await pool.query('INSERT INTO users(id) VALUES($1),($2)', [alice, bob]);
  await pool.query('INSERT INTO identity_map(firebase_uid,user_id) VALUES($1,$2),($3,$4)',
    [subject, alice, other, bob]);
});
after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[alice, bob]]);
  await pool.end();
});

test('policy outages cannot lock people out; API cannot publish an upgrade floor', async t => {
  if (!pool) { t.skip('isolated local database not enabled'); return; }
  const db = createApiDatabase(pool, subject);
  assert.deepEqual(await new PostgresClientPolicyRepository(db).get(), {
    android: { minVersion: null, latestVersion: null }, ios: { minVersion: null, latestVersion: null },
  });
  await assert.rejects(db.query("INSERT INTO client_policy(platform,min_version) VALUES('android','99.0.0')"));
  const unavailable = { query: async () => { throw new Error('offline'); } } as unknown as typeof db;
  assert.equal((await new PostgresClientPolicyRepository(unavailable).get()).android.minVersion, null);
});

test('telemetry keeps latest observation, ignores delayed replay and enforces owner writes', async t => {
  if (!pool) { t.skip('isolated local database not enabled'); return; }
  const db = createApiDatabase(pool, subject);
  const repo = new PostgresVersionTelemetryRepository(db);
  await repo.record(subject, 'android', '1.2.0', new Date('2026-10-24T10:00:00Z'));
  await repo.record(subject, 'android', '1.1.0', new Date('2026-10-24T09:00:00Z'));
  const counts = await repo.distribution();
  assert.equal(counts['1.2.0'], 1);
  assert.equal(counts['1.1.0'], undefined);
  await assert.rejects(repo.record(other, 'android', '9.0.0', new Date()));
  await assert.rejects(repo.record('unmapped-subject', 'android', '1.0.0', new Date()));
  const aliceRows = await db.query('SELECT user_id::text FROM client_versions');
  assert.deepEqual(aliceRows.rows, [{ user_id: alice }]);
  assert.equal(await new PostgresVersionTelemetryRepository(createApiDatabase(pool, other)).deleteForUid(subject), 0);
  assert.equal(await repo.deleteForUid(subject), 1);
});
