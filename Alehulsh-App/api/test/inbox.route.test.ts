import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import type { AlertProjection, InboxRepository } from '../src/repositories/types.js';
import {
  makeDeps, FakeInboxRepository, authAs, OWNER, STRANGER,
} from './fakes.js';

/** A third recipient, local to this file: `fakes.ts` exports only two. */
const RESPONDER = 'carol_uid';

/**
 * GET /v1/me/inbox — recipient isolation and the response contract.
 *
 * No network, no database: the fake inbox has the same contract as the
 * Firestore one (newest first, bounded), and the real end-to-end path over the
 * emulator is covered in composition.integration.test.ts.
 */
let inbox: FakeInboxRepository;
let app: ReturnType<typeof buildServer>;

function projection(over: Partial<AlertProjection> = {}): AlertProjection {
  return {
    alertId: 'alert-1',
    displayName: 'Hana',
    fuzzedLat: 9.0125,
    fuzzedLng: 38.7636,
    fuzzedPrecision: 'exact',
    isUrgent: false,
    status: 'active',
    createdAt: new Date('2026-10-21T08:00:00.000Z'),
    hasVoiceNote: false,
    reportedDelayMs: null,
    audience: 'contact',
    ...over,
  };
}


/**
 * The fake with one method replaced.
 *
 * Spreading the instance would drop its prototype methods, so every call is
 * delegated explicitly.
 */
function inboxWith(
  base: FakeInboxRepository,
  override: Partial<InboxRepository>,
): InboxRepository {
  return {
    put: (uid, p) => base.put(uid, p),
    remove: (uid, id) => base.remove(uid, id),
    listRecipients: (id) => base.listRecipients(id),
    get: (uid, id) => base.get(uid, id),
    listForRecipient: (uid, limit) => base.listForRecipient(uid, limit),
    ...override,
  };
}

const inboxFor = (uid: string, query = '') =>
  app.inject({ method: 'GET', url: `/v1/me/inbox${query}`, headers: authAs(uid) });

beforeEach(() => {
  inbox = new FakeInboxRepository();
  app = buildServer(makeDeps({ inbox }));
});

describe('she can read her own inbox', () => {
  test('a projection written for her is returned', async () => {
    await inbox.put(OWNER, projection());

    const res = await inboxFor(OWNER);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.count, 1);
    assert.equal(body.items[0].alertId, 'alert-1');
    assert.equal(body.items[0].audience, 'contact');
  });

  test('a contact receives the true position, labelled exact', async () => {
    // The tiering is decided at write time; this asserts the read does not
    // degrade or mislabel it.
    await inbox.put(OWNER, projection({ fuzzedPrecision: 'exact' }));
    const item = (await inboxFor(OWNER)).json().items[0];

    assert.equal(item.latitude, 9.0125);
    assert.equal(item.longitude, 38.7636);
    assert.equal(item.precision, 'exact');
  });

  test('a responder receives the fuzzed cell centre, labelled as such', async () => {
    await inbox.put(RESPONDER, projection({
      audience: 'responder', fuzzedLat: 9.01, fuzzedLng: 38.76,
      fuzzedPrecision: 'geohash7',
    }));
    const item = (await inboxFor(RESPONDER)).json().items[0];

    assert.equal(item.precision, 'geohash7');
    assert.equal(item.audience, 'responder');
  });

  test('an empty inbox is 200 with no items, not 404', async () => {
    const res = await inboxFor(OWNER);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { items: [], count: 0, limit: 25, truncated: false });
  });

  test('newest first', async () => {
    await inbox.put(OWNER, projection({ alertId: 'old', createdAt: new Date('2026-10-20T00:00:00Z') }));
    await inbox.put(OWNER, projection({ alertId: 'new', createdAt: new Date('2026-10-21T00:00:00Z') }));

    const ids = (await inboxFor(OWNER)).json().items.map((i: { alertId: string }) => i.alertId);
    assert.deepEqual(ids, ['new', 'old']);
  });
});

describe('isolation — one recipient cannot reach another', () => {
  test('a different authenticated recipient sees nothing of hers', async () => {
    await inbox.put(OWNER, projection());

    const res = await inboxFor(STRANGER);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().count, 0, 'another account must not read her inbox');
  });

  test('each recipient sees only her own copy of the SAME alert', async () => {
    // Both were sent alert-1, with different audiences. Neither may see the
    // other's view of it.
    await inbox.put(OWNER, projection({ audience: 'contact', fuzzedPrecision: 'exact' }));
    await inbox.put(RESPONDER, projection({ audience: 'responder', fuzzedPrecision: 'geohash7' }));

    assert.equal((await inboxFor(OWNER)).json().items[0].precision, 'exact');
    assert.equal((await inboxFor(RESPONDER)).json().items[0].precision, 'geohash7');
    assert.equal((await inboxFor(OWNER)).json().count, 1);
  });

  test('knowing another recipient uid buys nothing — it is not an input', async () => {
    await inbox.put(OWNER, projection());

    // `additionalProperties: false`: the parameter is REFUSED, not ignored, so
    // a client cannot believe it worked.
    for (const q of [`?uid=${OWNER}`, `?recipient=${OWNER}`, `?recipientUid=${OWNER}`]) {
      const res = await inboxFor(STRANGER, q);
      assert.equal(res.statusCode, 400, `query ${q} must be rejected`);
    }
  });

  test('knowing an alert id buys nothing — it is not an input either', async () => {
    await inbox.put(OWNER, projection({ alertId: 'secret-alert' }));
    const res = await inboxFor(STRANGER, '?alertId=secret-alert');
    assert.equal(res.statusCode, 400);
  });
});

describe('authentication', () => {
  test('no token is 401', async () => {
    await inbox.put(OWNER, projection());
    const res = await app.inject({ method: 'GET', url: '/v1/me/inbox' });
    assert.equal(res.statusCode, 401);
  });

  test('a malformed authorization header is 401', async () => {
    for (const header of ['', 'Bearer', 'Bearer   ', 'Basic abc', 'token-without-scheme']) {
      const res = await app.inject({
        method: 'GET', url: '/v1/me/inbox', headers: { authorization: header },
      });
      assert.equal(res.statusCode, 401, `header ${JSON.stringify(header)} must be refused`);
    }
  });

  test('an unverifiable token is 401 and reads no inbox', async () => {
    let reads = 0;
    const counting = inboxWith(inbox, {
      listForRecipient: async (uid: string, limit: number) => {
        reads += 1;
        return inbox.listForRecipient(uid, limit);
      },
    });
    app = buildServer(makeDeps({ inbox: counting }));

    const res = await app.inject({
      method: 'GET', url: '/v1/me/inbox',
      headers: { authorization: 'Bearer not-a-valid-token' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(reads, 0, 'an unauthenticated request must not reach storage');
  });
});

describe('pagination is bounded', () => {
  async function seed(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await inbox.put(OWNER, projection({
        alertId: `a${i}`,
        createdAt: new Date(Date.UTC(2026, 9, 21, 0, 0, i)),
      }));
    }
  }

  test('the default page is bounded even with more waiting', async () => {
    await seed(40);
    const body = (await inboxFor(OWNER)).json();
    assert.equal(body.count, 25);
    assert.equal(body.limit, 25);
    assert.equal(body.truncated, true, 'a full page must say more may remain');
  });

  test('an explicit limit is honoured and reported', async () => {
    await seed(10);
    const body = (await inboxFor(OWNER, '?limit=3')).json();
    assert.equal(body.count, 3);
    assert.equal(body.limit, 3);
    assert.equal(body.truncated, true);
  });

  test('a partial page is not reported as truncated', async () => {
    await seed(2);
    const body = (await inboxFor(OWNER, '?limit=10')).json();
    assert.equal(body.count, 2);
    assert.equal(body.truncated, false);
  });

  test('the response carries no total — a page must not count what it withheld', async () => {
    await seed(40);
    const body = (await inboxFor(OWNER)).json();
    assert.deepEqual(Object.keys(body).sort(), ['count', 'items', 'limit', 'truncated']);
    assert.equal(body.count, body.items.length);
  });

  test('malformed pagination is refused, not silently defaulted', async () => {
    await seed(5);
    for (const bad of ['?limit=0', '?limit=-1', '?limit=abc', '?limit=2.5', '?limit=101', '?limit=']) {
      const res = await inboxFor(OWNER, bad);
      assert.equal(res.statusCode, 400, `${bad} must be refused`);
    }
  });

  test('the maximum is enforced at the schema, not by clamping', async () => {
    await seed(5);
    assert.equal((await inboxFor(OWNER, '?limit=100')).statusCode, 200);
    assert.equal((await inboxFor(OWNER, '?limit=1000')).statusCode, 400);
  });

  test('repeating the same bounded request returns the same page', async () => {
    // Determinism for a fixed inbox. Stability ACROSS writes is not claimed:
    // there is no cursor, because `createdAt` alone is not a total order.
    await seed(10);
    const first = (await inboxFor(OWNER, '?limit=4')).json();
    const again = (await inboxFor(OWNER, '?limit=4')).json();
    assert.deepEqual(again, first);
  });
});

describe('failures are safe and quiet', () => {
  test('a storage failure is a 500 that leaks nothing', async () => {
    const broken = inboxWith(inbox, {
      listForRecipient: async () => {
        throw new Error(
          'connect ECONNREFUSED 10.0.0.5:5432 password=hunter2 token=sk-live-9 at 9.0125,38.7636',
        );
      },
    });
    app = buildServer(makeDeps({ inbox: broken }));

    const res = await inboxFor(OWNER);
    assert.equal(res.statusCode, 500);
    const raw = res.body;
    for (const secret of [
      'hunter2', 'sk-live-9', 'ECONNREFUSED', '10.0.0.5', '9.0125', '38.7636', 'password',
    ]) {
      assert.ok(!raw.includes(secret), `the 500 body leaked ${secret}`);
    }
  });

  test('an unmapped or blank identity yields an empty inbox, never someone else’s', async () => {
    // The fake mirrors the Firestore guard: a uid that cannot be a document
    // path is an empty inbox rather than a thrown request or a wider read.
    await inbox.put(OWNER, projection());
    for (const uid of ['', '   ', '../' + OWNER, '__proto__']) {
      const items = await inbox.listForRecipient(uid, 25);
      assert.deepEqual(items, [], `uid ${JSON.stringify(uid)} must read nothing`);
    }
  });

  test('no response field exposes anything outside the projection', async () => {
    await inbox.put(OWNER, projection({ hasVoiceNote: true }));
    const item = (await inboxFor(OWNER)).json().items[0];

    assert.deepEqual(Object.keys(item).sort(), [
      'alertId', 'audience', 'createdAt', 'displayName', 'expiresAt', 'hasAcknowledged', 'hasVoiceNote',
      'isUrgent', 'key', 'latitude', 'longitude', 'precision', 'reportedDelayMs', 'status',
    ]);
    // hasVoiceNote says a recording exists; nothing links to it.
    assert.equal(item.hasVoiceNote, true);
    const raw = JSON.stringify(item);
    for (const forbidden of ['phone', 'email', 'keyword', 'audioUrl', 'r2Key', 'voiceNotes', 'ownerId']) {
      assert.ok(!raw.toLowerCase().includes(forbidden.toLowerCase()), `item exposed ${forbidden}`);
    }
  });
});
