/**
 * Transaction-local identity context against the REAL Supabase project.
 * (migration plan 0.3, and the precondition for Hyperdrive)
 *
 * This is the assumption the whole API-on-Workers plan rests on. Hyperdrive
 * pools in TRANSACTION mode and resets the connection after each transaction,
 * so a session-level `SET` does not survive - but `SET LOCAL` inside an
 * explicit BEGIN/COMMIT does. Every RLS policy written for this system reads
 * `auth.uid()`, which reads `request.jwt.claim.sub`, so if that cannot be set
 * per transaction then RLS cannot be used from a Worker at all.
 *
 * Measured here against Supabase's own transaction pooler rather than
 * reasoned about.
 *
 * SKIPS unless ALEHULSH_SUPABASE_INTEGRATION=1 and SUPABASE_* are in the environment, so the suite stays green for
 * anyone without credentials. Synthetic rows only, cleaned up after.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const HOST = process.env['SUPABASE_POOLER_HOST'] ?? '';
const USER = process.env['SUPABASE_POOLER_USER'] ?? '';
const PASSWORD = process.env['SUPABASE_DB_PASSWORD'] ?? '';
/** 6543 is the TRANSACTION pooler - the mode Hyperdrive uses. */
const TXN_PORT = Number(process.env['SUPABASE_POOLER_TXN_PORT'] ?? 6543);

let pool: pg.Pool | null = null;
let available = false;
let skipReason = '';

const ALICE = randomUUID();
const BOB = randomUUID();
let ALERT_ID = '';

function makePool(port: number): pg.Pool {
  return new pg.Pool({
    host: HOST, port, user: USER, database: 'postgres', password: PASSWORD,
    ssl: {
      rejectUnauthorized: true,
      ...(process.env['PGSSL_CA_PEM'] ? { ca: process.env['PGSSL_CA_PEM'] } : {}),
    },
    connectionTimeoutMillis: 30_000,
    // More than one connection, so "does a claim leak to the next caller?" is
    // a question this pool can actually answer.
    max: 3,
  });
}

before(async () => {
  if (process.env['ALEHULSH_SUPABASE_INTEGRATION'] !== '1') {
    skipReason = 'hosted Supabase checks require explicit ALEHULSH_SUPABASE_INTEGRATION=1';
    return;
  }
  if (!HOST || !USER || !PASSWORD) {
    skipReason = 'SUPABASE_* not in the environment (load api/.dev.vars to run)';
    return;
  }
  try {
    pool = makePool(TXN_PORT);
    await pool.query('SELECT 1');
  } catch (err) {
    skipReason = `Supabase transaction pooler unreachable: ${(err as Error).message}`;
    if (pool) await pool.end().catch(() => {});
    pool = null;
    return;
  }
  await pool.query(
    `INSERT INTO users (id, display_name) VALUES ($1,'Alice'),($2,'Bob')
     ON CONFLICT (id) DO NOTHING`, [ALICE, BOB]);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO alerts (owner_id, request_id, expires_at)
     VALUES ($1, $2, now() + interval '2 hours') RETURNING id`,
    [ALICE, `sb-${randomUUID()}`]);
  ALERT_ID = String(rows[0]!.id);
  available = true;
});

after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM alert_history WHERE owner_id = ANY($1::uuid[])`, [[ALICE, BOB]])
    .catch(() => {});
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ALICE, BOB]]).catch(() => {});
  await pool.end();
});

function stest(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) { t.skip(skipReason); return; }
    await fn();
  });
}

describe('the project is really ours, and migrated', () => {
  stest('every migration in the repository is recorded as applied', async () => {
    // Derived from the directory rather than a hardcoded count, so adding a
    // migration cannot leave this test quietly asserting the old number.
    const { readdirSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const expected = readdirSync(
      join(dirname(new URL(import.meta.url).pathname), '..', '..', 'db', 'migrations'),
    ).filter((f) => f.endsWith('.sql')).sort();

    const { rows } = await pool!.query<{ filename: string }>(
      'SELECT filename FROM alehulsh_migrations ORDER BY filename');

    assert.deepEqual(rows.map((r) => r.filename), expected,
      'the Supabase project must have exactly the repository\u2019s migrations');
    assert.ok(expected.length >= 12, `expected at least 12, found ${expected.length}`);
  });

  stest('PostGIS is installed and usable, not merely available', async () => {
    const { rows } = await pool!.query<{ d: number }>(
      `SELECT ST_Distance(
                ST_SetSRID(ST_MakePoint(38.7897, 8.9956),4326)::geography,
                ST_SetSRID(ST_MakePoint(38.7900, 8.9960),4326)::geography) AS d`);
    assert.ok(rows[0]!.d > 0 && rows[0]!.d < 200, `expected a small distance, got ${rows[0]!.d}`);
  });

  stest('our roles exist alongside Supabase’s own', async () => {
    const { rows } = await pool!.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles
        WHERE rolname IN ('anon','authenticated','service_role','alehulsh_api')
        ORDER BY rolname`);
    assert.deepEqual(rows.map((r) => r.rolname),
      ['alehulsh_api', 'anon', 'authenticated', 'service_role']);
  });

  stest('Supabase’s auth.uid() is what our policies will call', async () => {
    // We deliberately did NOT overwrite it: theirs is a superset of ours and
    // the schema is not writable by this role anyway.
    const { rows } = await pool!.query<{ def: string }>(
      `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='auth' AND p.proname='uid'`);
    assert.ok(rows[0]);
    assert.match(rows[0].def, /request\.jwt\.claim\.sub/);
    assert.match(rows[0].def, /RETURNS uuid/);
  });
});

describe('transaction-local identity under the TRANSACTION pooler', () => {
  stest('SET LOCAL inside a transaction sets auth.uid()', async () => {
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      // set_config(..., true) is SET LOCAL: scoped to this transaction.
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ALICE]);
      const { rows } = await client.query<{ uid: string | null }>('SELECT auth.uid() AS uid');
      assert.equal(rows[0]!.uid, ALICE, 'the claim must reach auth.uid()');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  stest('it does NOT survive the transaction — no leak to the next caller', async () => {
    // The reason this matters: with a pooled connection, a claim that
    // outlived its transaction would be read by whoever got the connection
    // next, and RLS would hand them another woman's rows.
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ALICE]);
      await client.query('COMMIT');

      const { rows } = await client.query<{ uid: string | null }>('SELECT auth.uid() AS uid');
      assert.equal(rows[0]!.uid, null, 'the claim must not persist past COMMIT');
    } finally {
      client.release();
    }
  });

  stest('a rollback also clears it', async () => {
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [BOB]);
      await client.query('ROLLBACK');
      const { rows } = await client.query<{ uid: string | null }>('SELECT auth.uid() AS uid');
      assert.equal(rows[0]!.uid, null);
    } finally {
      client.release();
    }
  });

  stest('two transactions on the same connection cannot see each other’s claim', async () => {
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ALICE]);
      const first = await client.query<{ uid: string | null }>('SELECT auth.uid() AS uid');
      await client.query('COMMIT');

      await client.query('BEGIN');
      const second = await client.query<{ uid: string | null }>('SELECT auth.uid() AS uid');
      await client.query('COMMIT');

      assert.equal(first.rows[0]!.uid, ALICE);
      assert.equal(second.rows[0]!.uid, null,
        'a later transaction must start with no identity at all');
    } finally {
      client.release();
    }
  });

  stest('without a claim, auth.uid() is null rather than an error', async () => {
    // Fail-closed: a handler that forgot to set the claim must read as
    // "nobody", not blow up and not fall through to someone.
    const { rows } = await pool!.query<{ uid: string | null }>('SELECT auth.uid() AS uid');
    assert.equal(rows[0]!.uid, null);
  });
});

describe('RLS actually filters by the transaction-local claim', () => {
  /**
   * The policies that use auth.uid() are on `evidence`, and they are scoped to
   * **alehulsh_api** - not `authenticated`, which has no grant on the table at
   * all, because a client never reads evidence metadata directly.
   *
   * So the shape under test is the one the deployed API will use: connect as
   * the project's `postgres`, then DOWNGRADE to alehulsh_api for the duration
   * of the transaction and set the claim. Inside that transaction the role is
   * not a superuser and does not have BYPASSRLS, so RLS is a live control
   * rather than a decoration.
   *
   * This is also how the API can run as alehulsh_api at all while that role is
   * NOLOGIN: it never logs in as it, it becomes it per transaction. The
   * prerequisite is one grant - `alehulsh_api TO postgres WITH SET TRUE` -
   * applied by migration 0012.
   */
  async function evidenceVisibleAs(subject: string | null): Promise<number> {
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE alehulsh_api`);
      if (subject !== null) {
        await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [subject]);
      }
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM evidence WHERE alert_id = $1::uuid`, [ALERT_ID]);
      await client.query('COMMIT');
      return Number(rows[0]!.n);
    } finally {
      client.release();
    }
  }

  stest('the downgrade really drops privilege, and reverts', async () => {
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE alehulsh_api');
      const inside = await client.query<{ cu: string; su: boolean; brls: boolean }>(
        `SELECT current_user AS cu,
                (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
                (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS brls`);
      await client.query('COMMIT');
      const after = await client.query<{ cu: string }>('SELECT current_user AS cu');

      assert.equal(inside.rows[0]!.cu, 'alehulsh_api');
      assert.equal(inside.rows[0]!.su, false, 'must not be a superuser inside the transaction');
      assert.equal(inside.rows[0]!.brls, false, 'and must not bypass RLS');
      assert.equal(after.rows[0]!.cu, 'postgres', 'the downgrade must not outlive the transaction');
    } finally {
      client.release();
    }
  });

  stest('the owner sees her own evidence; a stranger sees none', async () => {
    await pool!.query(
      `INSERT INTO evidence (id, alert_id, owner_id, r2_key, state, content_type,
                             actual_sha256, completed_at, deliberate)
       VALUES ($1,$2,$3,$4,'stored','audio/m4a','deadbeef', now(), true)
       ON CONFLICT (id) DO NOTHING`,
      [randomUUID(), ALERT_ID, ALICE, `evidence/${ALICE}/${ALERT_ID}/e1`]);

    assert.equal(await evidenceVisibleAs(ALICE), 1, 'the owner must see her recording');
    assert.equal(await evidenceVisibleAs(BOB), 0, 'a stranger must see nothing');
    assert.equal(await evidenceVisibleAs(null), 0, 'and no claim means nothing');
  });
});
