/**
 * Integration test over the REAL composition, not the fakes.  (P1-28)
 *
 * The unit suite builds every service by hand, so it passes whether or not
 * anything in src/index.ts actually wires those services together. That gap hid
 * three defects at once: the process could not start, the fan-out had no
 * caller, and no user document carried the identifier hash the fan-out needs.
 *
 * REAL here:   Firestore (emulator), Firestore*Repository, ContactMatcher,
 *              AlertFanout, buildServer and every route.
 * SUBSTITUTED: tokenVerifier (token verification is auth.test.ts's job) and the
 *              task queue. Both are named below so no reader mistakes this for
 *              an end-to-end test of the deployed system.
 *
 * Requires the Firestore emulator. Skipped, loudly, when it is not running, so
 * `npm test` stays usable offline without silently proving nothing.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';
import { FirestoreAlertRepository } from '../src/repositories/firestore/FirestoreAlertRepository.js';
import { FirestoreUserRepository } from '../src/repositories/firestore/FirestoreUserRepository.js';
import { FirestoreContactRepository } from '../src/repositories/firestore/FirestoreContactRepository.js';
import { FirestoreInboxRepository } from '../src/repositories/firestore/FirestoreInboxRepository.js';
import { FirestoreAcceptanceRepository } from '../src/repositories/firestore/FirestoreAcceptanceRepository.js';
import { ContactMatcher } from '../src/services/ContactMatcher.js';
import { AlertFanout } from '../src/services/AlertFanout.js';
import { ResponderRegistry } from '../src/services/ResponderRegistry.js';
import { hashPhone } from '../src/crypto/identifier.js';
import { createLogger } from '../src/logger.js';
import {
  makeDeps, authAs, PEPPER, ACTIVE_WINDOW,
  FakeResponderLocationRepository, FakeResponderRepository,
} from './fakes.js';

const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080';
const VICTIM = 'itest_victim';
const CONTACT = 'itest_contact';
const STRANGER = 'itest_stranger';
const CONTACT_PHONE = '0911234567';

let app: FastifyInstance;
let db: Firestore;
let fbApp: ReturnType<typeof initializeApp> | null = null;
let inbox: FirestoreInboxRepository;
let contactsRepo: FirestoreContactRepository;
let users: FirestoreUserRepository;
let logger: ReturnType<typeof createLogger>;
/** The fake deps' task-runner secret, so the internal routes can be driven. */
let TASK_SECRET: string;
let available = false;

/**
 * Is anything listening? A plain TCP connect, deliberately not a Firestore
 * call: the Firestore client retries an unreachable host for long enough to
 * time the whole runner out, and the open channel then keeps the process alive
 * past its own teardown. This leaves nothing behind either way.
 */
function emulatorReachable(hostPort: string, timeoutMs = 1000): Promise<boolean> {
  const [host, port] = hostPort.split(':');
  return new Promise((resolve) => {
    const sock = connect({ host: host ?? '127.0.0.1', port: Number(port ?? 8080) });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

before(async () => {
  process.env['FIRESTORE_EMULATOR_HOST'] = EMULATOR;
  logger = createLogger('error');

  available = await emulatorReachable(EMULATOR);
  if (!available) {
    // eslint-disable-next-line no-console
    console.error(
      `\n  SKIPPED: Firestore emulator not reachable at ${EMULATOR}.` +
      `\n  Start it with: firebase emulators:start --only firestore\n`,
    );
    return;
  }

  fbApp = initializeApp({ projectId: 'alehulsh-itest' }, `itest-${Date.now()}`);
  db = getFirestore(fbApp);

  // Start from a known state for THIS suite's fixtures.
  //
  // Several assertions here depend on it: `POST /v1/alerts writes a real alert
  // document` expects 201, and a leftover live alert makes create fold and
  // return 200 instead. The emulator keeps data for as long as it runs, so
  // without this the suite passes on the first run and fails on the second -
  // measured, before this was added: 15 pass / 0 fail clean, 12 pass / 3 fail
  // on a repeat.
  //
  // Scoped to this suite's own uids rather than clearing the emulator, so it
  // cannot disturb another suite running in a parallel process.
  await clearFixtures();

  users = new FirestoreUserRepository(db);
  contactsRepo = new FirestoreContactRepository(db, PEPPER);
  inbox = new FirestoreInboxRepository(db);

  const compositionDeps = makeDeps({
    alerts: new FirestoreAlertRepository(db, ACTIVE_WINDOW),
    users,
    contacts: contactsRepo,
    inbox,
    acceptances: new FirestoreAcceptanceRepository(db),
    queue: new InMemoryTaskQueue(),
  });
  TASK_SECRET = compositionDeps.config.taskRunnerSecret;
  app = buildServer(compositionDeps);

  // Her profile, shaped exactly as the app writes it: contacts as an array of
  // cleartext fields with a locally generated id.
  await db.collection('users').doc(VICTIM).set({
    fullName: 'Victim', email: 'victim@test.invalid', phoneNumber: '0922000000',
    emergencyContacts: [{
      id: 'contact_1735000000000_0', name: 'Sister',
      phone: CONTACT_PHONE, email: 'sister@test.invalid', isPrimary: true,
    }],
  });
  // The contact has an account but carries NO identifier hash, which is the
  // state every real account is in today.
  await db.collection('users').doc(CONTACT).set({
    fullName: 'Sister', email: 'sister@test.invalid', phoneNumber: CONTACT_PHONE,
  });
});

/**
 * Remove only what this suite creates, children before parents.
 *
 * Note the SUBCOLLECTIONS. `inbox/{uid}/alerts/*` and
 * `alert_acceptances/{alertId}/responders/*` hold the documents that make
 * these assertions state-dependent, and a parent document does not exist for
 * a subcollection-only path - so sweeping the top-level collection finds
 * nothing and leaves them in place. A leftover acceptance is what turned
 * `the notified contact can acknowledge` from 201 into an idempotent 200.
 *
 * Alert ids are owner uids in the Firestore layout, so the suite's uids are
 * also the alert ids to clean under.
 */
async function clearFixtures(): Promise<void> {
  const uids = [VICTIM, CONTACT, STRANGER];
  for (const uid of uids) {
    await db.collection('active_alerts').doc(uid).delete().catch(() => {});

    const inbox = await db.collection('inbox').doc(uid).collection('alerts')
      .get().catch(() => null);
    for (const d of inbox?.docs ?? []) await d.ref.delete().catch(() => {});

    const responders = await db.collection('alert_acceptances').doc(uid)
      .collection('responders').get().catch(() => null);
    for (const d of responders?.docs ?? []) await d.ref.delete().catch(() => {});
  }

  // Archived alerts are keyed by an opaque alertKey, so they are matched on
  // their owner field rather than by id.
  const archived = await db.collection('alert_history').get().catch(() => null);
  for (const d of archived?.docs ?? []) {
    const data = d.data() as { userId?: string };
    if (uids.includes(data.userId ?? '')) await d.ref.delete().catch(() => {});
  }
}

after(async () => {
  // Nothing was opened when the emulator was absent, so there is nothing to
  // close - and attempting it would itself hang.
  if (!fbApp) return;
  // Leave the emulator as this suite found it, so a repeat run starts clean
  // even if `before`'s sweep is ever removed.
  try { await clearFixtures(); } catch { /* best effort */ }
  try { await db.terminate(); } catch { /* already closed */ }
  try { await deleteApp(fbApp); } catch { /* already closed */ }
});

/**
 * A test that needs the emulator.
 *
 * The skip is decided inside the test body, not in its options: describe()
 * callbacks run during collection, before before() has executed, so an option
 * computed there would read `available` while it is still false and skip
 * everything even when the emulator is up.
 */
function itest(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) {
      t.skip(`Firestore emulator unavailable at ${EMULATOR}`);
      return;
    }
    await fn();
  });
}

/**
 * A test for behaviour the system is SUPPOSED to have and does not yet.
 *
 * Marked todo, so it runs and reports as an outstanding target rather than
 * failing the suite. Confirming that a defect is still present is not the same
 * as confirming the feature works: these are the assertions that must go green
 * before the feature can be called done. Drop the `todo` wrapper - do not
 * rewrite the assertion - when the corresponding fix lands.
 */
function ptest(name: string, fn: () => Promise<void>): void {
  test(name, { todo: 'not implemented yet - see docs/ and the task sheet' }, async (t) => {
    if (!available) {
      t.skip(`Firestore emulator unavailable at ${EMULATOR}`);
      return;
    }
    await fn();
  });
}

describe('alert creation through the real composition', () => {
  itest('POST /v1/alerts writes a real alert document', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(VICTIM),
      payload: { requestId: 'itest-req-0001', latitude: 9.0125, longitude: 38.7636 },
    });
    assert.equal(res.statusCode, 201);
    // The document id is the owner's uid: one live alert per person, which is
    // also what makes a retry idempotent.
    assert.equal(res.json().alert.id, VICTIM);
    assert.equal((await db.collection('active_alerts').doc(VICTIM).get()).exists, true);
  });

  itest('creating an alert fans out to NOBODY', async () => {
    // Regression guard for the defect, not an endorsement of it: AlertFanout is
    // never constructed in src/index.ts and dispatch() has no caller, so no
    // recipient learns of an alert. Flip these two assertions when the fan-out
    // is wired into the create path.
    assert.equal(await inbox.get(CONTACT, VICTIM), null);
    assert.deepEqual(await inbox.listRecipients(VICTIM), []);
  });
});

describe('contact resolution against real Firestore', () => {
  itest('a contact with no identifier hash is unreachable', async () => {
    const resolved = await new ContactMatcher(contactsRepo, users).resolveForOwner(VICTIM);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]!.uid, null);
  });

  itest('the same contact resolves once a phoneHash exists', async () => {
    // Isolates the defect: the lookup is correct, nothing populates the field.
    await db.collection('users').doc(CONTACT)
      .set({ phoneHash: hashPhone(CONTACT_PHONE, PEPPER) }, { merge: true });
    const resolved = await new ContactMatcher(contactsRepo, users).resolveForOwner(VICTIM);
    assert.equal(resolved[0]!.uid, CONTACT);
  });
});

describe('fan-out, when something calls it', () => {
  itest('dispatch() writes a real projection', async () => {
    const fanout = new AlertFanout(
      inbox,
      new FakeResponderLocationRepository(),
      new ResponderRegistry(new FakeResponderRepository(), 3, logger),
      new ContactMatcher(contactsRepo, users),
      logger,
    );
    const stored = (await db.collection('active_alerts').doc(VICTIM).get()).data()!;
    const result = await fanout.dispatch({
      id: VICTIM, ownerId: VICTIM, requestId: 'itest-req-0001',
      latitude: 9.0125, longitude: 38.7636,
      geohash: (stored['geohash'] as string | undefined) ?? null,
      status: 'active', createdAt: new Date(),
      expiresAt: new Date(Date.now() + ACTIVE_WINDOW), reportedDelayMs: null,
    } as never);

    assert.deepEqual(result.contacts, [CONTACT]);
    assert.notEqual(await inbox.get(CONTACT, VICTIM), null);
  });

  itest('the projection carries no phone, email or other contact', async () => {
    const raw = JSON.stringify(await inbox.get(CONTACT, VICTIM));
    for (const secret of [
      'victim@test.invalid', 'sister@test.invalid', CONTACT_PHONE, '0922000000', 'Sister',
    ]) {
      assert.ok(!raw.includes(secret), `projection must not contain ${secret}`);
    }
  });
});

describe('acknowledgement authorization', () => {
  itest('the notified contact can acknowledge', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/alerts/${VICTIM}/accept`,
      headers: authAs(CONTACT), payload: {},
    });
    assert.equal(res.statusCode, 201, res.body);
  });

  itest('a replay is idempotent, not a second acceptance', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/alerts/${VICTIM}/accept`,
      headers: authAs(CONTACT), payload: {},
    });
    assert.equal(res.statusCode, 200);
  });

  itest('someone who holds no projection gets not_found, not forbidden', async () => {
      // Authorization is checked before existence, so an alert you were not
      // sent is indistinguishable from one that does not exist. Without this
      // the endpoint enumerates live emergencies.
      const res = await app.inject({
        method: 'POST', url: `/v1/alerts/${VICTIM}/accept`,
        headers: authAs(STRANGER), payload: {},
      });
      assert.equal(res.statusCode, 404);
    });

  itest('an unauthenticated acknowledgement is rejected', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/alerts/${VICTIM}/accept`, payload: {},
    });
    assert.equal(res.statusCode, 401);
  });
});

describe('the notification pipeline', () => {
  itest('notify-contacts is scheduled but has NO handler', async () => {
    // Regression guard: escalation and a wrong-keyword resolve both schedule
    // this task, and nothing serves it, so contacts are never told. Flip this
    // to 200 when the handler lands.
    const res = await app.inject({
      method: 'POST', url: '/internal/tasks/notify-contacts',
      headers: { 'x-task-secret': 'task-secret-for-tests' },
      payload: { alertId: VICTIM },
    });
    assert.equal(res.statusCode, 404);
  });
});

// ---------------------------------------------------------------------------
// TARGETS. The positive counterparts of the three regression guards above.
// Each asserts the feature working, not the defect persisting.
// ---------------------------------------------------------------------------

describe('TARGET 1 - alert creation triggers the fan-out', () => {
  ptest('a new alert reaches the intended recipient inbox without manual dispatch',
    async () => {
      // Needs: AlertFanout constructed in src/index.ts, added to Deps, and
      // called from the create path in routes/alerts.ts.
      await db.collection('users').doc(CONTACT)
        .set({ phoneHash: hashPhone(CONTACT_PHONE, PEPPER) }, { merge: true });
      await db.collection('active_alerts').doc(VICTIM).delete();
      await inbox.remove(CONTACT, VICTIM);

      const res = await app.inject({
        method: 'POST', url: '/v1/alerts', headers: authAs(VICTIM),
        payload: { requestId: 'target-req-0001', latitude: 9.0125, longitude: 38.7636 },
      });
      assert.equal(res.statusCode, 201);

      assert.notEqual(await inbox.get(CONTACT, VICTIM), null,
        'creating an alert must notify her contacts');
      assert.deepEqual(await inbox.listRecipients(VICTIM), [CONTACT]);
    });

  ptest('an alert with no location still reaches contacts, and no stranger',
    async () => {
      // A missing fix must not cost her the contact path: contacts are matched
      // by explicit link, not by distance. Responders get nothing, because we
      // cannot claim she is near anyone.
      await db.collection('active_alerts').doc(VICTIM).delete();
      await inbox.remove(CONTACT, VICTIM);

      const res = await app.inject({
        method: 'POST', url: '/v1/alerts', headers: authAs(VICTIM),
        payload: { requestId: 'target-req-0002', latitude: null, longitude: null },
      });
      assert.equal(res.statusCode, 201);
      assert.notEqual(await inbox.get(CONTACT, VICTIM), null);
    });
});

describe('TARGET 2 - a VERIFIED contact resolves to the right account', () => {
  ptest('resolution requires a verified identifier, not a self-asserted one',
    async () => {
      // Needs: identifier ownership verification (phone OTP), hashes written
      // ONLY from verified identifiers, and a rules restriction stopping a
      // client writing phoneHash/emailHash to its own user document.
      //
      // Today an attacker writes his victim's sister's number into his own
      // profile and the server hashes it for him, which resolves him into the
      // contact audience - the tier that receives EXACT coordinates.
      const ATTACKER = 'itest_attacker';
      try {
        await db.collection('users').doc(ATTACKER).set({
          fullName: 'Not The Sister',
          phoneNumber: CONTACT_PHONE,          // claimed, never proven
          phoneHash: hashPhone(CONTACT_PHONE, PEPPER),
          phoneVerified: false,
        });

        const resolved = await new ContactMatcher(contactsRepo, users).resolveForOwner(VICTIM);
        assert.equal(resolved[0]!.uid, CONTACT,
          'an unverified claimant must never win the contact slot');
        assert.notEqual(resolved[0]!.uid, ATTACKER);
      } finally {
        // Must run even though the assertion above currently fails, or the
        // planted collision leaks into every later test in this file.
        await db.collection('users').doc(ATTACKER).delete();
      }
    });

  ptest('a colliding hash must not DISPLACE the real contact', async () => {
    // Discovered by this suite rather than by reading: findUidByIdentifierHash
    // queries `where(phoneHash == h).limit(1)`, and nothing constrains that
    // field to be unique across users. With two documents carrying the same
    // hash the winner is arbitrary.
    //
    // The consequence is worse than an extra recipient. When the attacker wins
    // he becomes the ONLY resolved contact, so the projection is written to his
    // inbox and the woman's real emergency contact is never told at all - a
    // silent denial of her alert, achieved by writing one field to his own
    // profile.
    const ATTACKER = 'itest_collider';
    try {
      await db.collection('users').doc(CONTACT)
        .set({ phoneHash: hashPhone(CONTACT_PHONE, PEPPER) }, { merge: true });
      await db.collection('users').doc(ATTACKER).set({
        fullName: 'Collider',
        phoneHash: hashPhone(CONTACT_PHONE, PEPPER),
      });

      const resolved = await new ContactMatcher(contactsRepo, users).resolveForOwner(VICTIM);
      assert.equal(resolved[0]!.uid, CONTACT,
        'the real contact must still resolve despite a colliding hash');
    } finally {
      await db.collection('users').doc(ATTACKER).delete();
    }
  });
});

describe('TARGET 3 - the notification task executes', () => {
  ptest('notify-contacts has a handler and reports what it did', async () => {
    // Needs: a registered /internal/tasks/notify-contacts handler. Escalation
    // and a wrong-keyword resolve both schedule this task today and nothing
    // serves it, so no contact is ever told.
    const res = await app.inject({
      method: 'POST', url: '/internal/tasks/notify-contacts',
      headers: { 'x-task-secret': 'task-secret-for-tests' },
      payload: { alertId: VICTIM },
    });
    assert.equal(res.statusCode, 200, 'the task must be served, not 404');
  });

  ptest('a redelivered notify-contacts does not notify twice', async () => {
    // Any queue redelivers. The handler must be idempotent per (alert,
    // recipient) - and note the two schedulers currently build DIFFERENT task
    // keys for one alert, so de-duplication cannot rely on the key alone.
    const send = () => app.inject({
      method: 'POST', url: '/internal/tasks/notify-contacts',
      headers: { 'x-task-secret': 'task-secret-for-tests' },
      payload: { alertId: VICTIM },
    });
    assert.equal((await send()).statusCode, 200);
    const second = await send();
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().notified, 0, 'a replay must notify nobody again');
  });
});

describe('TARGET 4 - the recipient sees only what her audience permits', () => {
  // These two CAN pass now: the tiering is implemented. They are here because
  // the suite asserted only that the projection leaked no PII, never that the
  // two audiences actually differ.
  itest('a contact she chose receives the true position', async () => {
    // Self-sufficient on purpose: the todo tests above mutate the alert and
    // inbox, and a test that silently depends on their leftovers is a test
    // that will lie once they start passing.
    await db.collection('users').doc(CONTACT)
      .set({ phoneHash: hashPhone(CONTACT_PHONE, PEPPER) }, { merge: true });
    await inbox.remove(CONTACT, VICTIM);

    const fanout = new AlertFanout(
      inbox,
      new FakeResponderLocationRepository(),
      new ResponderRegistry(new FakeResponderRepository(), 3, logger),
      new ContactMatcher(contactsRepo, users),
      logger,
    );
    await fanout.dispatch({
      id: VICTIM, ownerId: VICTIM, requestId: 'tier-0001',
      latitude: 9.0125, longitude: 38.7636, geohash: null,
      status: 'active', createdAt: new Date(),
      expiresAt: new Date(Date.now() + ACTIVE_WINDOW), reportedDelayMs: null,
    } as never);

    const proj = await inbox.get(CONTACT, VICTIM);
    assert.notEqual(proj, null, 'the contact must have received a projection');
    assert.equal(proj!.audience, 'contact');
    assert.equal(proj!.fuzzedPrecision, 'exact');
    assert.equal(proj!.fuzzedLat, 9.0125);
    assert.equal(proj!.fuzzedLng, 38.7636);
  });

  itest('the projection never carries the evidence itself, only that it exists',
    async () => {
      const proj = await inbox.get(CONTACT, VICTIM);
      assert.equal(typeof proj!.hasVoiceNote, 'boolean');
      assert.ok(!('voiceNotes' in (proj as object)));
      assert.ok(!('responders' in (proj as object)));
    });
});

describe('TARGET 5 - an unauthorized recipient is shut out', () => {
  // Also already true, and worth keeping adjacent to the targets it belongs
  // with rather than buried in the acknowledgement group.
  itest('a stranger can neither read nor acknowledge the alert', async () => {
    assert.equal(await inbox.get(STRANGER, VICTIM), null,
      'no projection means nothing to read');

    const res = await app.inject({
      method: 'POST', url: `/v1/alerts/${VICTIM}/accept`,
      headers: authAs(STRANGER), payload: {},
    });
    assert.equal(res.statusCode, 404);
  });

  itest('the refusal is byte-identical to a nonexistent alert', async () => {
    // Otherwise the endpoint is an oracle for "is there a live emergency
    // belonging to this uid".
    const unsent = await app.inject({
      method: 'POST', url: `/v1/alerts/${VICTIM}/accept`,
      headers: authAs(STRANGER), payload: {},
    });
    const absent = await app.inject({
      method: 'POST', url: '/v1/alerts/itest_no_such_alert/accept',
      headers: authAs(STRANGER), payload: {},
    });
    assert.equal(unsent.statusCode, absent.statusCode);
    assert.deepEqual(unsent.json(), absent.json());
  });
});

describe('malformed alert ids through the real routes (Firestore)', () => {
  /**
   * Every malformed id a route can actually receive, including the
   * URL-encoded slash - `%2F` decodes to '/' before the handler sees it, so
   * the repository is what has to cope.
   */
  const MALFORMED_PATH_IDS = [
    ['encoded slash', '%2Fvictim'],
    ['encoded slash both ends', '%2Fvictim%2F'],
    ['encoded double slash', '%2F%2Fvictim'],
    ['encoded interior slash', 'a%2Fb'],
    ['single dot', '.'],
    ['double dot', '..'],
    ['encoded traversal', '..%2F..%2Fetc%2Fpasswd'],
    ['reserved pattern', '__proto__'],
    ['very long', 'a'.repeat(400)],
  ] as const;

  itest('a path-parameter alert id never produces a 500', async () => {
    // Before the guard, '/victim' reached doc() and threw, and '.' reached
    // .get() and threw INVALID_ARGUMENT - both surfacing as 500s.
    for (const [label, encoded] of MALFORMED_PATH_IDS) {
      for (const route of ['resolve', 'reveal']) {
        const res = await app.inject({
          method: 'POST', url: `/v1/alerts/${encoded}/${route}`,
          headers: authAs(STRANGER),
          payload: route === 'resolve' ? { keyword: 'anything' } : {},
        });
        assert.notEqual(res.statusCode, 500,
          `${route} with ${label} must not be a server error (got ${res.statusCode})`);
      }
    }
  });

  itest('an encoded slash cannot reach another account\'s alert', async () => {
    // '/victim' normalises to the document `victim` in Firestore, so the
    // alias could have fetched her alert. Authorisation is on the document's
    // userId field, never on the id it was fetched by - and the guard now
    // rejects the alias outright. Both have to hold.
    await app.inject({
      method: 'POST', url: '/v1/alerts', headers: authAs(VICTIM),
      payload: { requestId: 'itest-alias-001', latitude: 9.0125, longitude: 38.7636 },
    });
    for (const encoded of ['%2F' + VICTIM, VICTIM + '%2F', '%2F' + VICTIM + '%2F']) {
      const res = await app.inject({
        method: 'POST', url: `/v1/alerts/${encoded}/resolve`,
        headers: authAs(STRANGER), payload: { keyword: 'guess' },
      });
      assert.notEqual(res.statusCode, 200,
        `${encoded} must not resolve another account's alert`);
      assert.notEqual(res.statusCode, 500);
    }
    // And hers is untouched.
    const still = await db.collection('active_alerts').doc(VICTIM).get();
    assert.equal((still.data() as { status: string }).status, 'active');
  });

  itest('the task-runner routes answer safely and do not invite a retry', async () => {
    // The worker treats a 500 as transient and retries to `abandoned`. A
    // malformed id must look like "nothing to do", exactly as a valid id for a
    // nonexistent alert does.
    for (const alertId of ['.', '..', 'a/b', '/victim', '__proto__', 'a'.repeat(1501)]) {
      for (const route of ['safety-check', 'expiry']) {
        const res = await app.inject({
          method: 'POST', url: `/internal/tasks/${route}`,
          headers: { 'x-task-secret': TASK_SECRET, 'content-type': 'application/json' },
          payload: JSON.stringify({ alertId }),
        });
        assert.notEqual(res.statusCode, 500,
          `${route} with ${JSON.stringify(alertId)} must not be a server error`);
        if (res.statusCode === 200) {
          assert.deepEqual(res.json(), { handled: false },
            'and must report that it did nothing');
        }
      }
    }
  });

  itest('a genuine Firestore failure is NOT swallowed as not-found', async () => {
    // The guard checks the id's SHAPE only. A real backend failure must still
    // propagate, or an outage would look like a missing alert: a responder
    // told to stand down, and nothing paged.
    //
    // Driven with a failing stub rather than an unreachable Firestore. This
    // file's own header records why: the Firestore client retries an
    // unreachable host for long enough to time the whole runner out, and the
    // open channel then keeps the process alive past its teardown. A stub
    // exercises the same code path with no network and no retry storm.
    const boom = new Error('UNAVAILABLE: backend unreachable');
    const failing = {
      collection: () => ({
        doc: () => ({ get: async () => { throw boom; } }),
      }),
    } as unknown as Firestore;

    const repo = new FirestoreAlertRepository(failing, ACTIVE_WINDOW);
    // A WELL-FORMED id, so the guard passes and the fetch is actually made.
    await assert.rejects(() => repo.findById(VICTIM), (e: unknown) => e === boom,
      'the original failure must propagate, not become null');

    // And the guard still short-circuits a malformed id without touching it.
    assert.equal(await repo.findById('a/b'), null);
  });
});
