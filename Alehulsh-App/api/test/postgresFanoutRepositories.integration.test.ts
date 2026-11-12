/**
 * PostgresUserRepository and PostgresInboxRepository against real PostgreSQL.
 * (M-05)
 *
 * These two complete the fan-out slice on PostgreSQL: an alert is already on
 * Postgres (PostgresAlertRepository), contacts are resolved through the user
 * repository, and the projection lands in the inbox the API serves. What is
 * exercised here is identity translation, recipient isolation and the identity
 * ambiguity refusal - not query syntax.
 *
 * Synthetic data only. Every fixture is namespaced per run.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, loadDbConfig, closePool, type Queryable } from '../src/db/pool.js';
import { PostgresUserRepository } from '../src/repositories/postgres/PostgresUserRepository.js';
import { PostgresInboxRepository } from '../src/repositories/postgres/PostgresInboxRepository.js';
import { PostgresContactRepository } from '../src/repositories/postgres/PostgresContactRepository.js';
import { hashPhone } from '../src/crypto/identifier.js';
import { ContactMatcher } from '../src/services/ContactMatcher.js';
import { IdentityNotMappedError, type AlertProjection } from '../src/repositories/types.js';

let admin: Pool | null = null;
let restricted: Pool | null = null;
let users: PostgresUserRepository;
let inbox: PostgresInboxRepository;
let contacts: PostgresContactRepository;
const PEPPER = 'pepper-for-tests-only';
let available = false;
let skipReason = '';

/** External subjects: Firebase-uid shaped, NOT uuids. That is the point. */
const OWNER = `fo${randomUUID().replace(/-/g, '').slice(0, 26)}`;
const CONTACT = `fc${randomUUID().replace(/-/g, '').slice(0, 26)}`;
const STRANGER = `fs${randomUUID().replace(/-/g, '').slice(0, 26)}`;
const UNMAPPED = `fu${randomUUID().replace(/-/g, '').slice(0, 26)}`;

const OWNER_ID = randomUUID();
const CONTACT_ID = randomUUID();
const STRANGER_ID = randomUUID();
let ALERT_ID = '';

function reachable(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

before(async () => {
  let cfg;
  try { cfg = loadDbConfig(); } catch {
    skipReason = 'PG* environment not configured (fail-closed, not assumed)';
    return;
  }
  if (!(await reachable(cfg.host, cfg.port))) {
    skipReason = 'no PostgreSQL reachable on the configured host:port';
    return;
  }
  admin = createPool(cfg, { max: 4 });
  // The role the API actually runs as, so grants and RLS are live controls.
  restricted = createPool(cfg, { max: 2, options: '-c role=alehulsh_api' });

  await admin.query(
    `INSERT INTO users (id, display_name) VALUES ($1,'Owner'),($2,'Contact'),($3,'Stranger')
     ON CONFLICT (id) DO NOTHING`,
    [OWNER_ID, CONTACT_ID, STRANGER_ID],
  );
  await admin.query(
    `INSERT INTO identity_map (firebase_uid, user_id) VALUES ($1,$2),($3,$4),($5,$6)
     ON CONFLICT (firebase_uid) DO NOTHING`,
    [OWNER, OWNER_ID, CONTACT, CONTACT_ID, STRANGER, STRANGER_ID],
  );
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO alerts (owner_id, request_id, expires_at, location, location_quality, location_age_ms)
     VALUES ($1, $2, now() + interval '2 hours',
             ST_SetSRID(ST_MakePoint(38.7897, 8.9956),4326)::geography, 'live', 30000)
     RETURNING id`,
    [OWNER_ID, `fanout-${randomUUID()}`],
  );
  ALERT_ID = String(rows[0]!.id);

  users = new PostgresUserRepository(admin);
  inbox = new PostgresInboxRepository(admin);
  contacts = new PostgresContactRepository(admin, PEPPER);
  available = true;
});

after(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM alert_history WHERE owner_id = ANY($1::uuid[])`,
    [[OWNER_ID, CONTACT_ID, STRANGER_ID]]);
  await admin.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`,
    [[OWNER_ID, CONTACT_ID, STRANGER_ID]]);
  if (restricted) await closePool(restricted);
  await closePool(admin);
});

function ptest(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) { t.skip(skipReason); return; }
    await fn();
  });
}

function projection(over: Partial<AlertProjection> = {}): AlertProjection {
  return {
    alertId: ALERT_ID,
    displayName: 'Hana',
    fuzzedLat: 8.9956,
    fuzzedLng: 38.7897,
    fuzzedPrecision: 'exact',
    isUrgent: false,
    status: 'active',
    createdAt: new Date('2026-10-21T09:00:00.000Z'),
    hasVoiceNote: false,
    reportedDelayMs: null,
    audience: 'contact',
    ...over,
  };
}

describe('PostgresUserRepository — identity never leaks outwards', () => {
  ptest('findByUid takes and returns the EXTERNAL subject', async () => {
    const rec = await users.findByUid(OWNER);
    assert.ok(rec);
    assert.equal(rec.uid, OWNER, 'the internal uuid must never cross the boundary');
    assert.notEqual(rec.uid, OWNER_ID);
    assert.equal(rec.mustSetKeyword, true, 'schema default');
    assert.equal(rec.safetyKeywordHash, null);
  });

  ptest('an unmapped or malformed subject is null, not an error', async () => {
    for (const subject of [UNMAPPED, '', 'with\u0000nul', OWNER_ID]) {
      assert.equal(
        await users.findByUid(subject), null,
        `${JSON.stringify(subject)} must not resolve`,
      );
    }
    // The internal uuid is explicitly NOT a valid subject — passing one in
    // must not work, or the two namespaces have been conflated.
    assert.equal(await users.findByUid(OWNER_ID), null);
  });

  ptest('setSafetyKeywordHash stores the hash and clears mustSetKeyword', async () => {
    const hash = 'scrypt$65536$8$1$c2FsdA$aGFzaA';
    await users.setSafetyKeywordHash(OWNER, hash);

    const rec = await users.findByUid(OWNER);
    assert.equal(rec?.safetyKeywordHash, hash);
    assert.equal(rec?.mustSetKeyword, false);
  });

  ptest('an unmapped subject RAISES rather than silently writing nothing', async () => {
    // A keyword she believes she set but which was never stored means she
    // cannot cancel her own alert.
    await assert.rejects(
      () => users.setSafetyKeywordHash(UNMAPPED, 'scrypt$65536$8$1$a$b'),
      IdentityNotMappedError,
    );
    await assert.rejects(
      () => users.setSafetyKeywordHash(OWNER, ''), /empty keyword hash/,
    );
  });
});

describe('identifier resolution — the displacement attack', () => {
  ptest('a verified phone hash resolves to its owner', async () => {
    const hash = `phonehash-${randomUUID()}`;
    await admin!.query(
      `UPDATE users SET phone_hash = $2, phone_verified_at = now() WHERE id = $1`,
      [CONTACT_ID, hash],
    );
    assert.equal(await users.findUidByIdentifierHash(hash), CONTACT);
  });

  ptest('the SCHEMA makes an unverified phone hash impossible', async () => {
    // 0001: CHECK (phone_hash IS NULL OR phone_verified_at IS NOT NULL).
    // This is the structural half of the fix — stronger than a predicate,
    // because no code path can write the bad state at all.
    await assert.rejects(
      () => admin!.query(
        `UPDATE users SET phone_hash = $2, phone_verified_at = NULL WHERE id = $1`,
        [STRANGER_ID, `unverified-${randomUUID()}`],
      ),
      /phone_hash_requires_verification|violates check constraint/,
    );
  });

  ptest('the SCHEMA makes a COLLIDING hash impossible — the displacement attack', async () => {
    // The attack this closes: get a woman's emergency contact's hash into your
    // own profile and you might be resolved as that contact — the tier that
    // receives EXACT coordinates — while she is never notified at all.
    //
    // In PostgreSQL it cannot even be set up. `users_phone_hash_uq` and
    // `users_email_hash_uq` are partial UNIQUE indexes, so two rows cannot
    // carry the same identifier hash. That is strictly stronger than refusing
    // to resolve an ambiguity, because the bad state never exists.
    const shared = `collide-${randomUUID()}`;
    await admin!.query(
      `UPDATE users SET phone_hash = $2, phone_verified_at = now() WHERE id = $1`,
      [CONTACT_ID, shared],
    );
    await assert.rejects(
      () => admin!.query(
        `UPDATE users SET phone_hash = $2, phone_verified_at = now() WHERE id = $1`,
        [STRANGER_ID, shared],
      ),
      /users_phone_hash_uq|duplicate key/,
      'a second row must not be able to claim the same identifier',
    );
    // The legitimate holder still resolves, unaffected.
    assert.equal(await users.findUidByIdentifierHash(shared), CONTACT);
  });

  ptest('and the ambiguity refusal still covers any path that got past it', async () => {
    // Defence in depth. The UNIQUE indexes mean this branch cannot fire today,
    // so it is driven with a stub: if a future migration dropped an index, or
    // another backend lacks one, resolving to an arbitrary winner must not
    // silently return.
    const twoRows: Queryable = {
      query: async () => ({
        rows: [{ firebase_uid: CONTACT }, { firebase_uid: STRANGER }],
        rowCount: 2, command: 'SELECT', oid: 0, fields: [],
      }) as never,
    };

    const ambiguous = new PostgresUserRepository(twoRows);
    assert.equal(
      await ambiguous.findUidByIdentifierHash('whatever'), null,
      'two candidates must resolve to nobody, never to the first row',
    );
  });

  ptest('an unverified email hash cannot resolve, while verified ownership can',async()=>{
    const emailHash=`emailhash-${randomUUID()}`;
    await assert.rejects(admin!.query('UPDATE users SET email_hash=$2 WHERE id=$1',[STRANGER_ID,emailHash]),
      (error:unknown)=>(error as {code?:string}).code==='23514');
    await admin!.query('UPDATE users SET email_hash=$2,email_verified_at=now() WHERE id=$1',[STRANGER_ID,emailHash]);
    try{assert.equal(await users.findUidByIdentifierHash(emailHash),STRANGER);}
    finally{await admin!.query('UPDATE users SET email_hash=NULL,email_verified_at=NULL WHERE id=$1',[STRANGER_ID]);}
  });

  ptest('an unknown or empty hash is null', async () => {
    assert.equal(await users.findUidByIdentifierHash(`nobody-${randomUUID()}`), null);
    assert.equal(await users.findUidByIdentifierHash(''), null);
  });

  ptest('a user with no identity mapping cannot be resolved by hash', async () => {
    // A row can exist in `users` without an identity_map entry — provisioning
    // is a separate step. Resolving one would return an internal uuid as if it
    // were a subject.
    const orphan = randomUUID();
    const hash = `orphan-${randomUUID()}`;
    await admin!.query(
      `INSERT INTO users (id, display_name, phone_hash, phone_verified_at)
       VALUES ($1,'Orphan',$2, now())`, [orphan, hash]);
    try {
      assert.equal(await users.findUidByIdentifierHash(hash), null);
    } finally {
      await admin!.query(`DELETE FROM users WHERE id = $1`, [orphan]);
    }
  });
});

describe('PostgresInboxRepository — the fan-out read side', () => {
  ptest('put then get round-trips the projection', async () => {
    await inbox.put(CONTACT, projection());
    const got = await inbox.get(CONTACT, ALERT_ID);

    assert.ok(got);
    assert.equal(got.alertId, ALERT_ID);
    assert.equal(got.audience, 'contact');
    assert.equal(got.fuzzedPrecision, 'exact');
    assert.equal(got.fuzzedLat, 8.9956);
    assert.equal(got.displayName, 'Hana');
    assert.equal(got.status, 'active');
    assert.ok(got.createdAt instanceof Date);
    assert.equal(got.createdAt.toISOString(), '2026-10-21T09:00:00.000Z');
  });

  ptest('put is idempotent and REFRESHES without duplicating', async () => {
    await inbox.put(CONTACT, projection({ status: 'active' }));
    const firstCreated = await createdAtOf(CONTACT_ID);

    await inbox.put(CONTACT, projection({ status: 'escalated' }));

    const { rows } = await admin!.query<{ n: string }>(
      `SELECT count(*) AS n FROM inbox WHERE recipient_id = $1 AND alert_id = $2`,
      [CONTACT_ID, ALERT_ID]);
    assert.equal(rows[0]!.n, '1', 'a refresh must not create a second row');

    const got = await inbox.get(CONTACT, ALERT_ID);
    assert.equal(got?.status, 'escalated', 'and it must reflect the newer state');
    assert.equal(
      (await createdAtOf(CONTACT_ID))?.getTime(), firstCreated?.getTime(),
      'created_at must not move, or the inbox ordering jumps on a refresh',
    );
  });

  ptest('the audience COLUMN wins over the stored blob', async () => {
    // A blob that disagreed with the column must not be able to upgrade a
    // responder to the exact-coordinate contact tier.
    await inbox.put(STRANGER, projection({ audience: 'responder' }));
    await admin!.query(
      `UPDATE inbox SET projection = jsonb_set(projection, '{audience}', '"contact"')
        WHERE recipient_id = $1 AND alert_id = $2`,
      [STRANGER_ID, ALERT_ID]);

    const got = await inbox.get(STRANGER, ALERT_ID);
    assert.equal(got?.audience, 'responder', 'the enum column is authoritative');
  });

  ptest('one recipient cannot read another’s projection', async () => {
    await inbox.put(CONTACT, projection());
    assert.notEqual(await inbox.get(CONTACT, ALERT_ID), null);
    assert.equal(await inbox.get(UNMAPPED, ALERT_ID), null);

    const mine = await inbox.listForRecipient(CONTACT, 25);
    const theirs = await inbox.listForRecipient(UNMAPPED, 25);
    assert.ok(mine.length >= 1);
    assert.deepEqual(theirs, []);
  });

  ptest('listForRecipient is bounded and newest-first', async () => {
    // A second alert, so ordering is observable.
    const { rows } = await admin!.query<{ id: string }>(
      `INSERT INTO alerts (owner_id, request_id, expires_at)
       VALUES ($1,$2, now() + interval '2 hours') RETURNING id`,
      [STRANGER_ID, `fanout2-${randomUUID()}`]);
    const second = String(rows[0]!.id);
    try {
      await inbox.put(CONTACT, projection());
      await inbox.put(CONTACT, projection({ alertId: second }));

      const all = await inbox.listForRecipient(CONTACT, 25);
      assert.ok(all.length >= 2);
      assert.equal(all[0]!.alertId, second, 'the newer row first');

      assert.equal((await inbox.listForRecipient(CONTACT, 1)).length, 1, 'bounded');
    } finally {
      await admin!.query(`DELETE FROM alerts WHERE id = $1`, [second]);
    }
  });

  ptest('listRecipients returns EXTERNAL subjects, for retraction', async () => {
    await inbox.put(CONTACT, projection());
    const recipients = await inbox.listRecipients(ALERT_ID);
    assert.ok(recipients.includes(CONTACT));
    assert.ok(!recipients.includes(CONTACT_ID), 'never the internal uuid');
  });

  ptest('remove deletes only that recipient’s row', async () => {
    await inbox.put(CONTACT, projection());
    await inbox.put(STRANGER, projection({ audience: 'responder' }));

    await inbox.remove(CONTACT, ALERT_ID);

    assert.equal(await inbox.get(CONTACT, ALERT_ID), null);
    assert.notEqual(await inbox.get(STRANGER, ALERT_ID), null,
      'retracting from one inbox must not empty another');
  });

  ptest('malformed ids and unmapped subjects never throw', async () => {
    // The same contract the alert repository holds: a bad id is "no such row",
    // not a 500 that a task runner retries until the work is abandoned.
    for (const bad of ['', 'not-a-uuid', 'with\u0000nul', '{}', 'x'.repeat(100)]) {
      assert.equal(await inbox.get(CONTACT, bad), null);
      assert.deepEqual(await inbox.listRecipients(bad), []);
      await inbox.remove(CONTACT, bad);
      await inbox.put(CONTACT, projection({ alertId: bad }));
    }
    // An unmapped recipient is a no-op write, matching the fan-out's contract
    // that a contact without an account is not an error.
    await inbox.put(UNMAPPED, projection());
    assert.equal(await inbox.get(UNMAPPED, ALERT_ID), null);
  });

  ptest('every terminal transition atomically retracts projections and refuses late fan-out', async () => {
    const owner = randomUUID();
    await admin!.query(`INSERT INTO users (id, display_name) VALUES ($1, 'Privacy fixture')`, [owner]);
    try {
      for (const status of ['resolved', 'cancelled', 'expired']) {
        const { rows } = await admin!.query<{ id: string }>(
          `INSERT INTO alerts (owner_id, request_id, expires_at)
           VALUES ($1, $2, now() + interval '1 hour') RETURNING id`,
          [owner, `privacy-${randomUUID()}`]);
        const id = rows[0]!.id;
        await inbox.put(CONTACT, projection({ alertId: id, alertKey: id }));
        assert.ok(await inbox.get(CONTACT, id));
        await admin!.query(
          `UPDATE alerts SET status = $2::alert_status, end_reason = $2::alert_status, ended_at = now()
            WHERE id = $1`, [id, status]);
        assert.equal(await inbox.get(CONTACT, id), null);
        await inbox.put(CONTACT, projection({ alertId: id, alertKey: id }));
        const { rows: copies } = await admin!.query(`SELECT 1 FROM inbox WHERE alert_id = $1`, [id]);
        assert.equal(copies.length, 0, 'neither the old copy nor a late copy may retain exact coordinates');
      }
    } finally {
      await admin!.query(`DELETE FROM users WHERE id = $1`, [owner]);
    }
  });

  ptest('elapsed live rows and mismatched incident keys fail closed', async () => {
    const owner = randomUUID();
    await admin!.query(`INSERT INTO users (id, display_name) VALUES ($1, 'Expiry fixture')`, [owner]);
    try {
      const { rows } = await admin!.query<{ id: string }>(
        `INSERT INTO alerts (owner_id, request_id, created_at, expires_at)
         VALUES ($1, $2, now() - interval '2 hours', now() - interval '1 hour') RETURNING id`,
        [owner, `elapsed-${randomUUID()}`]);
      const id = rows[0]!.id;
      await inbox.put(CONTACT, projection({ alertId: id }));
      assert.equal(await inbox.get(CONTACT, id), null);
      assert.ok(!(await inbox.listForRecipient(CONTACT, 100)).some((p) => p.alertId === id));
      await inbox.remove(CONTACT, ALERT_ID);
      await inbox.put(CONTACT, projection({ alertKey: randomUUID() }));
      assert.equal(await inbox.get(CONTACT, ALERT_ID), null);
    } finally {
      await admin!.query(`DELETE FROM users WHERE id = $1`, [owner]);
    }
  });

  ptest('fan-out holding an alert lock cannot recreate an inbox after concurrent closure', async () => {
    const owner = randomUUID();
    await admin!.query(`INSERT INTO users (id, display_name) VALUES ($1, 'Race fixture')`, [owner]);
    const writer = await admin!.connect();
    const closer = await admin!.connect();
    try {
      const { rows } = await admin!.query<{ id: string }>(
        `INSERT INTO alerts (owner_id, request_id, expires_at)
         VALUES ($1, $2, now() + interval '1 hour') RETURNING id`,
        [owner, `race-${randomUUID()}`]);
      const id = rows[0]!.id;
      await writer.query('BEGIN');
      await new PostgresInboxRepository(writer).put(CONTACT, projection({ alertId: id }));
      // The UPDATE must wait for the writer's alert lock. The writer commits
      // first; closure then removes its exact-coordinate row in its own commit.
      const close = closer.query(
        `UPDATE alerts SET status = 'resolved', end_reason = 'resolved', ended_at = now()
          WHERE id = $1`, [id]);
      await writer.query('COMMIT');
      await close;
      assert.equal(await inbox.get(CONTACT, id), null);
      assert.equal((await admin!.query(`SELECT 1 FROM inbox WHERE alert_id = $1`, [id])).rows.length, 0);
    } finally {
      await writer.query('ROLLBACK');
      writer.release(); closer.release();
      await admin!.query(`DELETE FROM users WHERE id = $1`, [owner]);
    }
  });

  ptest('deleting the user cascades her inbox away', async () => {
    const tmpId = randomUUID();
    const tmpSubject = `ft${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await admin!.query(`INSERT INTO users (id, display_name) VALUES ($1,'Temp')`, [tmpId]);
    await admin!.query(
      `INSERT INTO identity_map (firebase_uid, user_id) VALUES ($1,$2)`, [tmpSubject, tmpId]);
    await inbox.put(tmpSubject, projection({ audience: 'responder' }));
    assert.notEqual(await inbox.get(tmpSubject, ALERT_ID), null);

    assert.equal(await users.deleteByUid(tmpSubject), 1);

    const { rows } = await admin!.query<{ n: string }>(
      `SELECT count(*) AS n FROM inbox WHERE recipient_id = $1`, [tmpId]);
    assert.equal(rows[0]!.n, '0', 'C-16: her projections go with her account');
    assert.equal(await users.deleteByUid(tmpSubject), 0, 'erasing twice is success');
  });
});

describe('under the role the API actually runs as', () => {
  ptest('both repositories work as alehulsh_api', async () => {
    // Every other suite connects as the owning superuser, which bypasses
    // GRANTs and is exempt from RLS — so a green run there proves nothing
    // about the deployed role. This is the check that caught a missing DELETE
    // on alerts in an earlier sprint.
    const { rows } = await restricted!.query<{ current_user: string; is_super: boolean }>(
      `SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS is_super`);
    assert.equal(rows[0]!.current_user, 'alehulsh_api');
    assert.equal(rows[0]!.is_super, false, 'the suite must not pass as a superuser');

    const ru = new PostgresUserRepository(restricted!);
    const ri = new PostgresInboxRepository(restricted!);

    assert.equal((await ru.findByUid(OWNER))?.uid, OWNER);
    await ri.put(CONTACT, projection());
    assert.notEqual(await ri.get(CONTACT, ALERT_ID), null);
    assert.ok((await ri.listForRecipient(CONTACT, 10)).length >= 1);
    await ri.remove(CONTACT, ALERT_ID);
  });
});

async function createdAtOf(recipientId: string): Promise<Date | null> {
  const { rows } = await admin!.query<{ created_at: Date }>(
    `SELECT created_at FROM inbox WHERE recipient_id = $1 AND alert_id = $2`,
    [recipientId, ALERT_ID]);
  return rows[0]?.created_at ?? null;
}

describe('PostgresContactRepository — the people the fan-out reaches', () => {
  async function addContact(
    ownerId: string, phone: string, label: string, primary = false,
  ): Promise<void> {
    await admin!.query(
      `INSERT INTO emergency_contacts (owner_id, label, phone_e164, is_primary)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (owner_id, phone_e164) DO UPDATE
          SET label = EXCLUDED.label, is_primary = EXCLUDED.is_primary`,
      [ownerId, label, phone, primary],
    );
  }

  ptest('lists her contacts with hashes derived using the pepper', async () => {
    await addContact(OWNER_ID, '+251911111111', 'Sister', true);

    const list = await contacts.listByOwner(OWNER);
    const sister = list.find((c) => c.name === 'Sister');
    assert.ok(sister, 'her contact must be listed');
    assert.equal(sister.ownerUid, OWNER, 'external subject, never the uuid');
    assert.equal(sister.isPrimary, true);
    // The hash is DERIVED here, not stored — the pepper never enters the table.
    assert.equal(sister.phoneHash, hashPhone('+251911111111', PEPPER));
    assert.equal(sister.emailHash, null, 'contact email is not an ownership proof');
  });

  ptest('the raw number is not what the hash is computed from — it is normalised', async () => {
    // The four shapes an Ethiopian number arrives in must hash identically, or
    // matching silently fails and her contact is never told.
    await addContact(OWNER_ID, '+251922222222', 'Neighbour');
    const list = await contacts.listByOwner(OWNER);
    const n = list.find((c) => c.name === 'Neighbour');

    for (const shape of ['0922222222', '251922222222', '922222222', '+251 92 222 2222']) {
      assert.equal(
        n?.phoneHash, hashPhone(shape, PEPPER),
        `${shape} must hash to the same value`,
      );
    }
  });

  ptest('a different pepper produces a different hash', async () => {
    // What makes a stolen database insufficient on its own.
    await addContact(OWNER_ID, '+251933333333', 'Aunt');
    const same = await new PostgresContactRepository(admin!, PEPPER).listByOwner(OWNER);
    const other = await new PostgresContactRepository(admin!, 'different-pepper')
      .listByOwner(OWNER);

    const a = same.find((c) => c.name === 'Aunt')?.phoneHash;
    const b = other.find((c) => c.name === 'Aunt')?.phoneHash;
    assert.ok(a && b);
    assert.notEqual(a, b);
  });

  ptest('an empty pepper is refused at construction', async () => {
    assert.throws(() => new PostgresContactRepository(admin!, ''), /requires a pepper/);
  });

  ptest('primary first, then stable', async () => {
    await addContact(OWNER_ID, '+251944444444', 'Second');
    await admin!.query('UPDATE emergency_contacts SET is_primary=false WHERE owner_id=$1', [OWNER_ID]);
    await addContact(OWNER_ID, '+251955555555', 'Primary', true);

    const list = await contacts.listByOwner(OWNER);
    assert.equal(list[0]?.isPrimary, true, 'the contact she marked primary leads');
    // Repeating the read must not reshuffle it.
    assert.deepEqual(
      (await contacts.listByOwner(OWNER)).map((c) => c.id),
      list.map((c) => c.id),
    );
  });

  ptest('she sees only her own contacts', async () => {
    await addContact(OWNER_ID, '+251966666666', 'Hers');
    await addContact(STRANGER_ID, '+251977777777', 'Theirs');

    const hers = await contacts.listByOwner(OWNER);
    assert.ok(hers.some((c) => c.name === 'Hers'));
    assert.equal(hers.some((c) => c.name === 'Theirs'), false);
    assert.deepEqual(await contacts.listByOwner(UNMAPPED), []);
  });

  ptest('deleteAllForOwner reports the real count and touches nobody else', async () => {
    await addContact(STRANGER_ID, '+251988888888', 'Survivor');
    const mine = (await contacts.listByOwner(OWNER)).length;
    assert.ok(mine > 0);

    assert.equal(await contacts.deleteAllForOwner(OWNER), mine);
    assert.deepEqual(await contacts.listByOwner(OWNER), []);
    assert.ok(
      (await contacts.listByOwner(STRANGER)).some((c) => c.name === 'Survivor'),
      'erasure must be scoped to one owner',
    );

    // Erasing again is success, not an error.
    assert.equal(await contacts.deleteAllForOwner(OWNER), 0);
    assert.equal(await contacts.deleteAllForOwner(UNMAPPED), 0);
  });

  ptest('ContactMatcher resolves a contact to her account through this repository', async () => {
    // The actual fan-out question: does a woman's emergency contact, who has
    // the app, resolve to an account — using only hashes, never a raw number?
    const phone = '+251912345678';
    await addContact(OWNER_ID, phone, 'Has The App', true);
    await admin!.query(
      `UPDATE users SET phone_hash = $2, phone_verified_at = now() WHERE id = $1`,
      [CONTACT_ID, hashPhone(phone, PEPPER)],
    );
    try {
      const matcher = new ContactMatcher(contacts, users);
      const resolved = await matcher.resolveForOwner(OWNER);
      const hit = resolved.find((r) => r.uid === CONTACT);

      assert.ok(hit, 'her contact with an account must resolve to that account');
      assert.equal(hit.uid, CONTACT, 'and to the EXTERNAL subject');
    } finally {
      await admin!.query(
        `UPDATE users SET phone_hash = NULL, phone_verified_at = NULL WHERE id = $1`,
        [CONTACT_ID]);
      await contacts.deleteAllForOwner(OWNER);
    }
  });

  ptest('a contact without an account is returned as unreachable, not dropped', async () => {
    // P3-01 s6: she is entitled to see which contacts we cannot reach.
    await addContact(OWNER_ID, '+251919999999', 'No App');
    try {
      const resolved = await new ContactMatcher(contacts, users).resolveForOwner(OWNER);
      const hit = resolved.find((r) => r.name === 'No App');
      assert.ok(hit, 'the contact must still be returned');
      assert.equal(hit.uid, null, 'with no account resolved');
    } finally {
      await contacts.deleteAllForOwner(OWNER);
    }
  });

  ptest('works under alehulsh_api, the role the API runs as', async () => {
    await addContact(OWNER_ID, '+251910000001', 'RoleTest');
    try {
      const rc = new PostgresContactRepository(restricted!, PEPPER);
      const list = await rc.listByOwner(OWNER);
      assert.ok(list.some((c) => c.name === 'RoleTest'));
    } finally {
      await contacts.deleteAllForOwner(OWNER);
    }
  });
});
