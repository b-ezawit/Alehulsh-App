import type { EvidenceRecord, EvidenceRepository } from '../repositories/types.js';
import { assertPublication, type EvidenceStore } from '../evidence/EvidenceStore.js';

export async function finalizeEvidence(record: EvidenceRecord, store: EvidenceStore, repo: EvidenceRepository, expectedSha256?: string) {
  if (record.uploaded && record.sha256 && record.storagePath.includes('/published/')) {
    if (expectedSha256 && record.sha256 !== expectedSha256) {
      throw new Error('published bytes differ from original evidence');
    }
    return record;
  }
  const publication = await store.publish(record.storagePath, record.contentType);
  assertPublication(record.storagePath, publication);
  if (expectedSha256 && publication.sha256 !== expectedSha256) throw new Error('published bytes differ from original evidence');
  let winner: EvidenceRecord;
  try { winner = await repo.markPublished(record.id, record.storagePath, publication); }
  catch (error) {
    // Do not delete on an ambiguous commit: a response can be lost after the
    // database has published this very key. Retain the private candidate until
    // a later read can establish whether it is referenced.
    throw error;
  }
  if (winner.storagePath !== publication.storagePath) {
    try { await store.remove(publication.storagePath); } catch {/* Private orphan; owner-prefix erasure still reaches it. */ }
  }
  return winner;
}
