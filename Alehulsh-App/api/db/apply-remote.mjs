#!/usr/bin/env node
/**
 * Apply migrations to a REMOTE PostgreSQL (Supabase).  (M-05)
 *
 * Deliberately separate from run.sh, which takes no connection string at all
 * so it cannot be pointed at a hosted database by accident. That property is
 * worth keeping, so this is the only path to a remote one and it is loud:
 *
 *   - every detail comes from the environment, never from a file in the repo;
 *   - it REFUSES without ALEHULSH_REMOTE_CONFIRM=yes;
 *   - it refuses outright if the target looks like production;
 *   - it prints the target before doing anything, and NEVER the password;
 *   - which files have been applied is recorded IN the database, so a re-run
 *     resumes rather than replaying non-idempotent DDL (CREATE TYPE has no
 *     IF NOT EXISTS);
 *   - there is no reset, no DROP, and no destructive path at all.
 *
 * Uses `pg` - the same driver the API uses - rather than a psql binary. That
 * is not a convenience: it means this script exercises the exact client path
 * the application will use against Supabase, including TLS.
 *
 * Apply requires PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD, explicit
 * ALEHULSH_REMOTE_ENVIRONMENT=development and ALEHULSH_REMOTE_EXPECTED_HOST.
 * Dry-run needs none of these and never connects.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrationInventory, verifyMigrationLedger } from './migrationIntegrity.mjs';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const inventory = migrationInventory(migrationsDir);
const files = inventory.map(item => item.name);

// Offline planning only: do not construct a client, require credentials,
// connect, or create the ledger. This intentionally cannot know which files
// are already applied. Even a read-only remote check would contact a host.
if (process.argv.includes('--dry-run')) {
  console.log('DRY RUN: offline migration inventory; applied state is unknown.');
  for (const name of files) console.log(`-- migration ${name}`);
} else {

const required = ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD'];
for (const v of required) {
  if (!process.env[v]) {
    console.error(`FATAL: ${v} is not set`);
    process.exit(2);
  }
}

const target = `${process.env.PGUSER}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`;

if (process.env.ALEHULSH_REMOTE_CONFIRM !== 'yes') {
  console.error('FATAL: refusing to touch a remote database without ALEHULSH_REMOTE_CONFIRM=yes');
  console.error(`       target would be: ${target}`);
  process.exit(2);
}

// Managed production hosts often have opaque project IDs, so a word match
// cannot establish that a target is development. Require an explicit target
// pin as well as the human confirmation. This remains an operator assertion,
// not a proof of the remote project's purpose.
if (process.env.ALEHULSH_REMOTE_ENVIRONMENT !== 'development'
    || process.env.ALEHULSH_REMOTE_EXPECTED_HOST !== process.env.PGHOST) {
  console.error('FATAL: apply requires ALEHULSH_REMOTE_ENVIRONMENT=development and an exact ALEHULSH_REMOTE_EXPECTED_HOST match');
  process.exit(2);
}

if (/prod|production|live/i.test(`${process.env.PGHOST}${process.env.PGDATABASE}`)) {
  console.error(`FATAL: target looks like production (${target}). Refusing.`);
  process.exit(2);
}

console.log(`target : ${target}`);
console.log('mode   : APPLY\n');

const client = new pg.Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  // Authenticate the server in every environment. Supply the PEM CA through
  // secret/config management when the host's chain is not publicly trusted.
  ssl: {
    rejectUnauthorized: true,
    ...(process.env.PGSSL_CA_PEM ? { ca: process.env.PGSSL_CA_PEM } : {}),
  },
  connectionTimeoutMillis: 30_000,
  // A migration can legitimately take a while; nothing here should be killed
  // half-applied by a short default.
  statement_timeout: 120_000,
});

try {
  await client.connect();
  const { rows: [who] } = await client.query(
    `select current_user as who,
            (select rolsuper from pg_roles where rolname = current_user) as super,
            version() as version`,
  );
  console.log(`connected: ${who.who} (superuser=${who.super}) on ${who.version.split(' ').slice(0, 2).join(' ')}\n`);

  // Session lock covers ledger creation and the complete ordered run, so two
  // operators cannot race the same unapplied file. Released by client.end().
  await client.query("SELECT pg_advisory_lock(hashtextextended('alehulsh:migrations:v1',0))");
  await client.query(`
    CREATE TABLE IF NOT EXISTS alehulsh_migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const { rows: done } = await client.query('SELECT filename,checksum FROM alehulsh_migrations');
  verifyMigrationLedger(inventory, done);
  const applied = new Set(done.map((r) => r.filename));

  let failed = false;

  for (const name of files) {
    if (applied.has(name)) {
      console.log(`-- ${name.padEnd(40)} already applied, skipped`);
      continue;
    }
    process.stdout.write(`-- applying ${name.padEnd(36)} `);
    try {
      await client.query('BEGIN');
      await client.query(inventory.find(item => item.name === name).sql);
      // Recorded only after it succeeded, so a failure leaves the file pending
      // rather than silently skipped next time.
      await client.query(
        `INSERT INTO alehulsh_migrations (filename,checksum) VALUES ($1,$2)`,
        [name, inventory.find(item => item.name === name).checksum],
      );
      await client.query('COMMIT');
      console.log('ok');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.log('FAILED');
      // SQL errors can contain sensitive row values. Report only SQLSTATE.
      console.error(`     migration failed (SQLSTATE ${err.code ?? 'unavailable'})`);
      failed = true;
      break;
    }
  }
  process.exitCode = failed ? 1 : 0;
} catch (err) {
  // Never echo the connection object; it holds the password.
  console.error(`FATAL: database operation failed (SQLSTATE ${err.code ?? 'unavailable'})`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
}
