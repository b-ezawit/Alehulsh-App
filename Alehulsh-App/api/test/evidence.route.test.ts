import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, type Deps } from '../src/server.js';
import { InMemoryTaskQueue } from '../src/queue/TaskQueue.js';
import { InMemorySlidingWindowLimiter } from '../src/rate/RateLimiter.js';
import { createLogger } from '../src/logger.js';
import { evidenceDeletableStores } from '../src/routes/evidence.js';
import { AccountDeleter } from '../src/services/AccountDeleter.js';
import {
  FakeAlertRepository, FakeUserRepository, FakeInboxRepository, FakeAcceptanceRepository,
  FakeLocationRevealRepository, FakeEvidenceRepository, FakeEvidenceStore,
  fakeVerifier, authAs, OWNER, STRANGER, testConfig,
} from './fakes.js';

const ALERT = OWNER;
let alerts: FakeAlertRepository;
let evidence: FakeEvidenceRepository;
let evidenceStore: FakeEvidenceStore;
let app: ReturnType<typeof buildServer>;

beforeEach(() => {
  alerts = new FakeAlertRepository();
  evidence = new FakeEvidenceRepository();
  evidenceStore = new FakeEvidenceStore();
  const deps: Deps = {
    config: testConfig, logger: createLogger('error'), tokenVerifier: fakeVerifier,
    alerts, users: new FakeUserRepository(),
    inbox: new FakeInboxRepository(), acceptances: new FakeAcceptanceRepository(),
    reveals: new FakeLocationRevealRepository(),
    evidence, evidenceStore,
    queue: new InMemoryTaskQueue(), limiter: new InMemorySlidingWindowLimiter(),
  };
  app = buildServer(deps);
  alerts.seed({ id: ALERT, ownerId: OWNER, status: 'active' });
});

const ticket = (uid: string, contentType = 'audio/aac', durationMs?: number) =>
  app.inject({
    method: 'POST', url: `/v1/alerts/${ALERT}/evidence`, headers: authAs(uid),
    payload: durationMs === undefined ? { contentType } : { contentType, durationMs },
  });

const complete = (uid: string, id: string) =>
  app.inject({ method: 'POST', url: `/v1/evidence/${id}/complete`, headers: authAs(uid), payload: {} });

const list = (uid: string) =>
  app.inject({ method: 'GET', url: `/v1/alerts/${ALERT}/evidence`, headers: authAs(uid) });

describe('P2-10.3 — the document holds a path, never bytes', () => {
  test('an upload ticket creates a record with no audio in it', async () => {
    const res = await ticket(OWNER);
    assert.equal(res.statusCode, 201);
    const { evidenceId } = res.json();
    const record = await evidence.findById(evidenceId);
    assert.ok(record);
    assert.equal(record!.uploaded, false);
    assert.ok(record!.storagePath.startsWith(`evidence/${OWNER}/${ALERT}/`));
    // Nothing resembling audio data anywhere in the stored record.
    assert.equal(JSON.stringify(record).includes('base64'), false);
    assert.equal(JSON.stringify(record).includes('data:audio'), false);
  });

  test('the client does not choose where the object goes', async () => {
    // No path or filename field is accepted at all — attempting to name one is
    // rejected rather than ignored, so an attempt to overwrite someone else's
    // recording is a visible 400, not a silent no-op.
    const res = await app.inject({
      method: 'POST', url: `/v1/alerts/${ALERT}/evidence`, headers: authAs(OWNER),
      payload: { contentType: 'audio/aac', storagePath: `evidence/${STRANGER}/x/y` },
    });
    assert.equal(res.statusCode, 400);
  });

  test('a recording longer than the old 90-second ceiling is fine', async () => {
    // Ten minutes. Under the base64-in-Firestore design this was the case that
    // failed the write and lost the evidence silently.
    const res = await ticket(OWNER, 'audio/aac', 10 * 60 * 1000);
    assert.equal(res.statusCode, 201);
    const record = await evidence.findById(res.json().evidenceId);
    assert.equal(record!.durationMs, 600_000);
  });

  test('only known audio types are accepted', async () => {
    const res = await ticket(OWNER, 'application/x-msdownload');
    assert.equal(res.statusCode, 400);
  });
});

describe('authorization', () => {
  test('a stranger cannot request a ticket on someone else alert', async () => {
    const res = await ticket(STRANGER);
    assert.equal(res.statusCode, 404);
    assert.equal(evidenceStore.ticketCalls, 0);
  });

  test('a stranger cannot list someone else evidence', async () => {
    await ticket(OWNER);
    const res = await list(STRANGER);
    assert.equal(res.statusCode, 404);
  });

  test('a stranger cannot complete someone else upload', async () => {
    const { evidenceId } = (await ticket(OWNER)).json();
    const record = await evidence.findById(evidenceId);
    evidenceStore.land(record!.storagePath);
    const res = await complete(STRANGER, evidenceId);
    assert.equal(res.statusCode, 404);
    assert.equal((await evidence.findById(evidenceId))!.uploaded, false);
  });

  test('unauthenticated is rejected before the body is even validated', async () => {
    // 401, never 400. Auth is an onRequest hook, so it runs ahead of body
    // parsing and schema validation: an anonymous caller gets turned away
    // rather than told what was wrong with a request we would not have
    // processed. The second URL below deliberately sends a body the complete
    // route would reject, to prove auth wins the race.
    for (const url of [`/v1/alerts/${ALERT}/evidence`, `/v1/evidence/x/complete`]) {
      const res = await app.inject({ method: 'POST', url, payload: { contentType: 'audio/aac' } });
      assert.equal(res.statusCode, 401);
    }
    assert.equal((await app.inject({ method: 'GET', url: `/v1/alerts/${ALERT}/evidence` })).statusCode, 401);
  });

  test('a closed alert accepts no new evidence', async () => {
    alerts.seed({ id: ALERT, ownerId: OWNER, status: 'resolved' });
    const res = await ticket(OWNER);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'alert_closed');
  });

  test('an escalated alert still accepts evidence — recording keeps running', async () => {
    alerts.seed({ id: ALERT, ownerId: OWNER, status: 'escalated' });
    assert.equal((await ticket(OWNER)).statusCode, 201);
  });
});

describe('a failed upload is visible, not silent', () => {
  test('completing before the object lands is refused', async () => {
    const { evidenceId } = (await ticket(OWNER)).json();
    // The client claims success but nothing reached the bucket.
    const res = await complete(OWNER, evidenceId);
    assert.equal(res.statusCode, 404);
    assert.equal((await evidence.findById(evidenceId))!.uploaded, false);
  });

  test('an unfinished item is listed as not uploaded and carries no URL', async () => {
    await ticket(OWNER);
    const [item] = (await list(OWNER)).json().evidence;
    assert.equal(item.uploaded, false);
    assert.equal(item.url, undefined);
  });

  test('size comes from the bucket, not from the client', async () => {
    const { evidenceId } = (await ticket(OWNER)).json();
    const record = await evidence.findById(evidenceId);
    evidenceStore.land(record!.storagePath, 4242);
    await complete(OWNER, evidenceId);
    assert.equal((await evidence.findById(evidenceId))!.sizeBytes, 4242);
  });
});

describe('P2-10.4 — playback is short-lived and never public', () => {
  test('an uploaded item gets a URL that expires', async () => {
    const { evidenceId } = (await ticket(OWNER)).json();
    const record = await evidence.findById(evidenceId);
    evidenceStore.land(record!.storagePath);
    await complete(OWNER, evidenceId);

    const [item] = (await list(OWNER)).json().evidence;
    assert.equal(item.uploaded, true);
    assert.ok(item.url);
    assert.ok(new Date(item.urlExpiresAt).getTime() > Date.now());
    // Minutes, not hours. A leaked URL must not be a standing grant.
    assert.ok(new Date(item.urlExpiresAt).getTime() - Date.now() <= 10 * 60 * 1000);
  });

  test('the internal storage path is never returned to the client', async () => {
    const { evidenceId } = (await ticket(OWNER)).json();
    const record = await evidence.findById(evidenceId);
    evidenceStore.land(record!.storagePath);
    await complete(OWNER, evidenceId);
    const body = JSON.stringify((await list(OWNER)).json());
    assert.equal(body.includes('storagePath'), false);
    assert.equal(body.includes(`evidence/${OWNER}/`), false);
  });
});

describe('abuse', () => {
  test('evidence per alert is capped', async () => {
    for (let i = 0; i < 20; i++) assert.equal((await ticket(OWNER)).statusCode, 201);
    const over = await ticket(OWNER);
    assert.equal(over.statusCode, 429);
  });
});

describe('deletion reaches both the rows and the objects — C-16', () => {
  test('objects go before rows, and both go', async () => {
    const { evidenceId } = (await ticket(OWNER)).json();
    const record = await evidence.findById(evidenceId);
    evidenceStore.land(record!.storagePath);
    await complete(OWNER, evidenceId);

    const stores = evidenceDeletableStores(evidence, evidenceStore);
    // Objects first: an orphaned row pointing at nothing is recoverable, an
    // orphaned recording of her voice is not.
    assert.deepEqual(stores.map((s) => s.name), ['evidence_objects', 'evidence_records']);

    const receipt = await new AccountDeleter(stores, createLogger('error')).deleteAccount(OWNER);
    assert.equal(receipt.complete, true);
    assert.equal(receipt.purged.evidence_objects, 1);
    assert.equal(receipt.purged.evidence_records, 1);
    assert.equal(evidenceStore.objects.size, 0);
    assert.equal(evidence.store.size, 0);
  });
});
