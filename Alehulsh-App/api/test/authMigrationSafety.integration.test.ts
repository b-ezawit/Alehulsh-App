import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool, loadDbConfig, isLoopbackHost } from '../src/db/pool.js';

test('Auth bridge migration refuses an operator without provider policy ownership before changing the schema', async t => {
  if (process.env['ALEHULSH_LOCAL_DB_TESTS'] !== '1') { t.skip('isolated local database required'); return; }
  const config = loadDbConfig(); if (!isLoopbackHost(config.host)) throw Error('local fixture only');
  const pool = createPool(config), role = `auth_operator_${randomUUID().replaceAll('-', '')}`;
  const client = await pool.connect(); let created = false;
  try {
    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE`); created = true;
    const before = (await client.query('SELECT count(*)::int AS n FROM supabase_accounts')).rows[0].n;
    await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${role}`);
    const migration = await readFile('db/migrations/0022_supabase_identity_bridge.sql', 'utf8');
    await assert.rejects(client.query(migration), (error: unknown) => {
      const e = error as { code?: string; message?: string };
      return e.code === '42501' && e.message === 'approved Auth policy owner authority required';
    });
    await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM supabase_accounts')).rows[0].n, before);
  } finally {
    await client.query('ROLLBACK');
    if (created) await client.query(`DROP ROLE ${role}`);
    client.release(); await pool.end();
  }
});
