import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Pool, QueryResultRow } from 'pg';
import {
  createApiDatabase, createPool, databaseTls, withApiTransaction, withTransaction, type Queryable,
} from '../src/db/pool.js';

const internalId = '00112233-4455-6677-8899-aabbccddeeff';

function fakePool(options: { unmapped?: boolean; bypass?: boolean; rollbackFails?: boolean; failOn?: 'BEGIN' | 'COMMIT' } = {}) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const releases: unknown[] = [];
  const boundaryError = new Error('synthetic transaction boundary failed');
  const client = {
    async query(sql: string, params: unknown[] = []) {
      statements.push({ sql, params });
      if (sql === options.failOn) throw boundaryError;
      if (sql === 'ROLLBACK' && options.rollbackFails) throw new Error('rollback failed');
      let rows: QueryResultRow[] = [];
      if (sql.includes('FROM pg_roles')) rows = [{ rolname: 'alehulsh_api', rolsuper: false, rolbypassrls: options.bypass ?? false }];
      if (sql.includes('resolve_identity')) rows = [{ user_id: options.unmapped ? null : internalId }];
      return { rows };
    },
    release(destroy?: boolean) { releases.push(destroy); },
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements, releases, boundaryError };
}

describe('application database identity boundary', () => {
  test('downgrades and resolves the verified subject before any application query', async () => {
    const f = fakePool();
    await withApiTransaction(f.pool, 'verified-external-subject', (tx) => tx.query('SELECT application_data'));
    assert.equal(f.statements[0]?.sql, 'BEGIN');
    assert.equal(f.statements[1]?.sql, 'SET LOCAL ROLE alehulsh_api');
    const identity = f.statements.findIndex((q) => q.sql.includes('resolve_identity'));
    const claim = f.statements.findIndex((q) => q.params[0] === internalId);
    const body = f.statements.findIndex((q) => q.sql === 'SELECT application_data');
    assert.ok(identity < claim && claim < body);
    assert.deepEqual(f.statements[claim]?.params, [internalId, JSON.stringify({ sub: internalId })]);
    assert.equal(f.statements.at(-1)?.sql, 'COMMIT');
  });

  test('system operations explicitly clear both identity claim formats', async () => {
    const f = fakePool();
    await createApiDatabase(f.pool).query('SELECT system_work');
    assert.ok(f.statements.some((q) => q.sql.includes("set_config('request.jwt.claim.sub', '', true)")
      && q.sql.includes("set_config('request.jwt.claims', '{}', true)")));
    assert.equal(f.statements.some((q) => q.sql.includes('resolve_identity')), false);
  });

  test('unknown subjects fail closed without invoking the body', async () => {
    const f = fakePool({ unmapped: true });
    let called = false;
    await assert.rejects(() => withApiTransaction(f.pool, 'unknown', async () => { called = true; }), /identity not mapped/);
    assert.equal(called, false);
    assert.equal(f.statements.at(-1)?.sql, 'ROLLBACK');
  });

  test('an unsafe role fails closed before invoking the body', async () => {
    const f = fakePool({ bypass: true });
    let called = false;
    await assert.rejects(() => withApiTransaction(f.pool, null, async () => { called = true; }), /without superuser or BYPASSRLS/);
    assert.equal(called, false);
  });

  test('rebound application work shares the restricted transaction', async () => {
    const f = fakePool();
    await createApiDatabase(f.pool, 'owner').transaction(async (tx) => {
      await tx.query('SELECT a');
      await tx.query('SELECT b');
    });
    assert.equal(f.statements.filter((q) => q.sql === 'BEGIN').length, 1);
    assert.equal(f.statements.filter((q) => q.sql === 'COMMIT').length, 1);
  });

  test('rollback failure discards the connection exactly once and keeps the original error', async () => {
    const f = fakePool({ rollbackFails: true });
    const original = new Error('original');
    await assert.rejects(() => withTransaction(f.pool, async () => { throw original; }), (err) => err === original);
    assert.deepEqual(f.releases, [true]);
  });

  test('BEGIN failure discards the connection exactly once without calling application work', async () => {
    const f = fakePool({ failOn: 'BEGIN' });
    let called = false;
    await assert.rejects(() => withTransaction(f.pool, async () => { called = true; }), (err) => err === f.boundaryError);
    assert.equal(called, false);
    assert.deepEqual(f.releases, [true]);
  });

  test('COMMIT failure discards the connection, invalidates the handle and preserves the original error', async () => {
    const f = fakePool({ failOn: 'COMMIT' });
    let escaped: Queryable | undefined;
    await assert.rejects(() => withApiTransaction(f.pool, 'owner', async (tx) => {
      escaped = tx;
      await tx.query('SELECT application_work');
    }), (err) => err === f.boundaryError);
    assert.deepEqual(f.releases, [true]);
    await assert.rejects(() => escaped!.query('SELECT cannot_reuse_transaction'), /transaction has ended/);
  });
});

describe('database TLS', () => {
  test('remote databases verify certificates by default', () => {
    assert.deepEqual(databaseTls({ host: 'db.example.invalid' }), { rejectUnauthorized: true });
    assert.deepEqual(databaseTls({ host: 'db.example.invalid', sslCa: 'synthetic-ca' }), { rejectUnauthorized: true, ca: 'synthetic-ca' });
  });
  test('plaintext is limited to explicit loopback development', () => {
    assert.equal(databaseTls({ host: '127.0.0.1' }), false);
    assert.equal(databaseTls({ host: 'localhost' }), false);
  });
  test('remote callers cannot bypass verification through pool options', () => {
    const cfg = { host: 'db.example.invalid', port: 5432, database: 'test', user: 'test', password: 'synthetic' };
    assert.throws(() => createPool(cfg, { ssl: false }), /cannot be disabled/);
    assert.throws(() => createPool(cfg, { ssl: { rejectUnauthorized: false } }), /cannot be disabled/);
  });
});

test('migration dry-run is an offline inventory requiring no credentials or confirmation', () => {
  const script = fileURLToPath(new URL('../../db/apply-remote.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--dry-run'], {
    env: { PATH: process.env['PATH'] ?? '', PGHOST: 'must-not-connect.invalid', PGPORT: '1' },
    encoding: 'utf8', timeout: 3000,
  });
  assert.equal(result.error, undefined, 'the offline process must actually start');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /offline migration inventory/);
  assert.match(result.stdout, /0001_init.sql/);
  assert.doesNotMatch(result.stdout, /connected:|applying /);
});
