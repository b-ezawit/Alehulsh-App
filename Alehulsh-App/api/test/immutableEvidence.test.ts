import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { R2ImmutablePublisher, type PublicationBucket } from '../src/evidence/R2ImmutablePublisher.js';
import { FirebaseStorageEvidenceStore, type BucketLike } from '../src/evidence/FirebaseStorageEvidenceStore.js';
import { finalizeEvidence } from '../src/services/finalizeEvidence.js';
import { FakeEvidenceRepository, FakeEvidenceStore } from './fakes.js';
import type { EvidenceRecord } from '../src/repositories/types.js';

const source = 'evidence/owner/incident/note';
const contentType = 'audio/aac';
const bytes = new TextEncoder().encode('original evidence');
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function bucket() {
  const values = new Map<string, Uint8Array>([[source, bytes.slice()]]);
  const deleted: string[] = []; let mismatch = false, collision = false;
  const api: PublicationBucket = {
    async get(key) {
      const data = values.get(key)?.slice(); if (!data) return null;
      return { size: data.length + (mismatch ? 1 : 0), httpMetadata: { contentType }, body: new ReadableStream({ start(c) { c.enqueue(data); c.close(); } }) };
    },
    async put(key, body, options) {
      assert.equal(options.onlyIf.etagDoesNotMatch, '*'); if (collision || values.has(key)) return null;
      const reader = body.getReader(); const parts: Uint8Array[] = []; for (; ;) { const p = await reader.read(); if (p.done) break; parts.push(p.value); }
      const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const p of parts) { joined.set(p, offset); offset += p.length; }
      values.set(key, joined); return { key };
    },
    async delete(key) { deleted.push(key); values.delete(key); },
  };
  return { api, values, deleted, setMismatch() { mismatch = true; }, setCollision() { collision = true; } };
}
describe('immutable evidence snapshots', () => {
  test('a later PUT to staging cannot change published bytes or their digest', async () => {
    const b = bucket(), publisher = new R2ImmutablePublisher(b.api);
    const result = await publisher.publish(source, contentType);
    b.values.set(source, new TextEncoder().encode('overwritten upload URL'));
    assert.deepEqual(b.values.get(result.storagePath), bytes); assert.equal(result.sha256, digest(bytes));
    assert.equal(result.sizeBytes, bytes.length); assert.match(result.storagePath, /\/published\/[a-f0-9-]{36}$/);
  });
  test('a truncated stream cannot publish metadata', async () => {
    const b = bucket(); b.setMismatch(); await assert.rejects(new R2ImmutablePublisher(b.api).publish(source, contentType));
    assert.equal(b.values.size, 1);
  });
  test('conditional creation failure never deletes an existing destination', async () => {
    const b = bucket(); b.setCollision(); await assert.rejects(new R2ImmutablePublisher(b.api).publish(source, contentType));
    assert.equal(b.deleted.length, 0);
  });
  test('source absence and unsupported staging paths fail closed', async () => {
    const b = bucket(), p = new R2ImmutablePublisher(b.api);
    await assert.rejects(p.publish('evidence/owner/incident/absent', contentType));
    await assert.rejects(p.publish(source + '/published/already', contentType));
    await assert.rejects(p.publish(source, 'video/mp4'));
  });
  test('Firebase publication pins the source generation before copying', async () => {
    const objects = new Map<string, Uint8Array>([[source, bytes]]); let generationPinned = false;
    const file = (key: string, opts?: { generation?: string | number; }) => ({
      async getMetadata() { return [{ size: bytes.length, generation: '1', contentType }] as [{ size: number; generation: string; contentType: string; }]; },
      async copy(destination: string, options: { preconditionOpts: { ifGenerationMatch: 0; }; }) {
        generationPinned = opts?.generation === '1'; assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
        objects.set(source, new TextEncoder().encode('new generation'));
        objects.set(destination, bytes.slice());
      },
      createReadStream() { return Readable.from([objects.get(key)!]); },
      async getSignedUrl() { return ['unused'] as [string]; }, async exists() { return [true] as [boolean]; }, async delete() { },
    });
    const store = new FirebaseStorageEvidenceStore({ file, getFiles: async () => [[]] } as BucketLike);
    const result = await store.publish(source, contentType);
    assert.equal(generationPinned, true); assert.equal(result.sha256, digest(bytes));
    assert.deepEqual(objects.get(result.storagePath), bytes); assert.notDeepEqual(objects.get(source), bytes);
  });
  test('a lost metadata commit never causes deletion of possibly referenced bytes', async () => {
    const repo = new FakeEvidenceRepository(), store = new FakeEvidenceStore();
    const record: EvidenceRecord = {
      id: 'id', alertId: 'incident', alertKey: 'key', kind: 'deliberate', ownerUid: 'owner',
      storagePath: source, contentType, sizeBytes: null, durationMs: null, createdAt: new Date(), uploaded: false
    };
    await repo.create(record); store.land(source, bytes);
    const commit = repo.markPublished.bind(repo);
    repo.markPublished = async (...args) => { await commit(...args); throw Error('response lost after commit'); };
    await assert.rejects(finalizeEvidence(record, store, repo), /response lost/);
    const referenced = repo.store.get(record.id)!; assert.ok(store.objects.has(referenced.storagePath));
    assert.equal((await finalizeEvidence(referenced, store, repo)).storagePath, referenced.storagePath);
  });
  test('migration cannot discard original evidence after a checksum mismatch', async () => {
    const repo = new FakeEvidenceRepository(), store = new FakeEvidenceStore();
    const record: EvidenceRecord = {
      id: 'id', alertId: 'incident', alertKey: 'key', kind: 'deliberate', ownerUid: 'owner',
      storagePath: source, contentType, sizeBytes: null, durationMs: null, createdAt: new Date(), uploaded: false
    };
    await repo.create(record); store.land(source, bytes);
    await assert.rejects(finalizeEvidence(record, store, repo, 'f'.repeat(64)), /differ from original/);
    assert.equal(repo.store.get(record.id)?.uploaded, false);
    const published = await finalizeEvidence(record, store, repo);
    await assert.rejects(finalizeEvidence(published, store, repo, 'f'.repeat(64)), /differ from original/);
  });
});
