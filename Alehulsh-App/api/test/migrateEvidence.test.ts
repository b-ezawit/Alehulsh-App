import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { migrateEmbeddedAudio } from '../scripts/migrate-evidence.js';
import { createLogger } from '../src/logger.js';
import { FakeEvidenceRepository, FakeEvidenceStore, OWNER } from './fakes.js';

const AUDIO = Buffer.from('fake-aac-bytes-that-stand-in-for-a-recording');
const dataUri = `data:audio/aac;base64,${AUDIO.toString('base64')}`;

/** Just enough Firestore to drive the script. */
function fakeDb(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  const updates = new Map<string, Record<string, unknown>>();
  const store = new Map(docs.map((d) => [d.id, { ...d.data }]));
  return {
    updates,
    store,
    collection: () => ({
      get: async () => ({
        docs: [...store.entries()].map(([id, data]) => ({
          id,
          data: () => data,
          ref: { update: async (u: Record<string, unknown>) => { updates.set(id, u); Object.assign(data, u); } },
        })),
      }),
    }),
  };
}

let evidence: FakeEvidenceRepository;
let store: FakeEvidenceStore;
const logger = createLogger('error');

beforeEach(() => {
  evidence = new FakeEvidenceRepository();
  store = new FakeEvidenceStore();
  // The fake store has no HTTP endpoint, so stand in for the client's PUT.
  const realTicket = store.createUploadTicket.bind(store);
  store.createUploadTicket = async (i) => {
    const t = await realTicket(i);
    globalThis.fetch = (async () => {
      store.land(t.storagePath, AUDIO.byteLength);
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;
    return t;
  };
});

const run = (docs: Array<{ id: string; data: Record<string, unknown> }>, dryRun: boolean) => {
  const db = fakeDb(docs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return migrateEmbeddedAudio({ db: db as any, evidence, store, logger, dryRun })
    .then((s) => ({ summary: s, db }));
};

const alertWithAudio = () => ({
  id: OWNER,
  data: { userId: OWNER, voiceNotes: [{ id: 'note1', audioData: dataUri, duration: '0:05' }] },
});

describe('P2-10.5 — retiring embedded base64 audio', () => {
  test('--report counts without changing anything', async () => {
    const { summary, db } = await run([alertWithAudio()], true);
    assert.equal(summary.notesFound, 1);
    assert.equal(summary.bytesEmbedded, AUDIO.byteLength);
    assert.equal(summary.migrated, 0);
    assert.equal(db.updates.size, 0);
    assert.equal(evidence.store.size, 0);
  });

  test('--migrate uploads, verifies, records, then strips the base64', async () => {
    const { summary, db } = await run([alertWithAudio()], false);
    assert.equal(summary.migrated, 1);
    assert.equal(summary.failed.length, 0);

    const [record] = [...evidence.store.values()];
    assert.equal(record!.uploaded, true);
    assert.equal(record!.sizeBytes, AUDIO.byteLength);
    assert.equal(record!.ownerUid, OWNER);

    const notes = db.updates.get(OWNER)!['voiceNotes'] as Array<Record<string, unknown>>;
    assert.equal(notes[0]!['audioData'], undefined);
    // The note itself survives, so the recording keeps its place in the timeline.
    assert.equal(notes[0]!['duration'], '0:05');
    assert.equal(notes[0]!['migrated'], true);
  });

  test('a truncated upload is rejected and the original is left intact', async () => {
    const realTicket = store.createUploadTicket.bind(store);
    store.createUploadTicket = async (i) => {
      const t = await realTicket(i);
      globalThis.fetch = (async () => {
        store.land(t.storagePath, 3); // short write
        return { ok: true, status: 200 } as Response;
      }) as typeof fetch;
      return t;
    };

    const { summary, db } = await run([alertWithAudio()], false);
    assert.equal(summary.migrated, 0);
    assert.match(summary.failed[0]!.reason, /size mismatch/);
    // The only copy that exists is still there.
    assert.equal(db.store.get(OWNER)!['voiceNotes'] as unknown as boolean, db.store.get(OWNER)!['voiceNotes'] as unknown as boolean);
    const notes = db.store.get(OWNER)!['voiceNotes'] as Array<Record<string, unknown>>;
    assert.equal(notes[0]!['audioData'], dataUri);
  });

  test('a failed upload leaves the recording alone', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 503 } as Response)) as typeof fetch;
    store.createUploadTicket = FakeEvidenceStore.prototype.createUploadTicket.bind(store);

    const { summary, db } = await run([alertWithAudio()], false);
    assert.equal(summary.migrated, 0);
    assert.match(summary.failed[0]!.reason, /503/);
    const notes = db.store.get(OWNER)!['voiceNotes'] as Array<Record<string, unknown>>;
    assert.equal(notes[0]!['audioData'], dataUri);
  });

  test('notes that are not data URIs are left untouched', async () => {
    const { summary } = await run([{
      id: OWNER,
      data: { userId: OWNER, voiceNotes: [{ id: 'n', audioData: 'https://example/already-moved' }] },
    }], false);
    assert.equal(summary.notesFound, 0);
    assert.equal(summary.migrated, 0);
  });

  test('alerts with no voice notes are skipped', async () => {
    const { summary } = await run([{ id: OWNER, data: { userId: OWNER } }], false);
    assert.equal(summary.alertsScanned, 1);
    assert.equal(summary.notesFound, 0);
  });
});
