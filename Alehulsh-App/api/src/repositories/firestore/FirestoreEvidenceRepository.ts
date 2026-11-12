import { assertPublication, type PublishedEvidence } from '../../evidence/EvidenceStore.js';
import { AppError } from '../../errors.js';
import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import type { EvidenceKind, EvidenceRecord, EvidenceRepository } from '../types.js';

/** Interim. Replaced by Postgres at C-04 (M-05). */
const COLLECTION = 'evidence';

interface EvidenceDoc {
  alertId: string;
  alertKey?: string;
  kind?: EvidenceKind;
  ownerUid: string;
  storagePath: string;
  contentType: string;
  sizeBytes: number | null;
  durationMs: number | null;
  createdAt: Timestamp;
  uploaded: boolean;
  sha256?: string;
}

const toRecord = (id: string, d: EvidenceDoc): EvidenceRecord => ({
  id,
  ...(d.sha256 ? { sha256: d.sha256 } : {}),
  alertId: d.alertId,
  alertKey: d.alertKey ?? d.alertId,
  // Unknown means we cannot prove she chose to share it, so it is automatic.
  // Defaulting the other way would expose recordings nobody consented to.
  kind: d.kind === 'deliberate' ? 'deliberate' : 'automatic',
  ownerUid: d.ownerUid,
  storagePath: d.storagePath,
  contentType: d.contentType,
  sizeBytes: d.sizeBytes ?? null,
  durationMs: d.durationMs ?? null,
  createdAt: d.createdAt.toDate(),
  uploaded: d.uploaded === true,
});

export class FirestoreEvidenceRepository implements EvidenceRepository {
  constructor(private readonly db: Firestore) { }

  async create(r: EvidenceRecord): Promise<EvidenceRecord> {
    const doc: EvidenceDoc = {
      alertId: r.alertId,
      alertKey: r.alertKey,
      kind: r.kind,
      ownerUid: r.ownerUid,
      storagePath: r.storagePath,
      contentType: r.contentType,
      sizeBytes: r.sizeBytes,
      durationMs: r.durationMs,
      createdAt: Timestamp.fromDate(r.createdAt),
      uploaded: r.uploaded,
    };
    return this.db.runTransaction(async tx => {
      const ref = this.db.collection(COLLECTION).doc(r.id);
      const existing = await tx.get(ref);
      if (existing.exists) {
        const stored = toRecord(r.id, existing.data() as EvidenceDoc);
        const originalPath = stored.storagePath.split('/published/')[0];
        if (stored.ownerUid !== r.ownerUid || stored.alertId !== r.alertId ||
          stored.alertKey !== r.alertKey || originalPath !== r.storagePath ||
          stored.contentType !== r.contentType || stored.kind !== r.kind ||
          stored.durationMs !== r.durationMs) throw new AppError('conflict');
        return stored;
      }
      if (r.uploaded || r.sha256) throw new AppError('invalid_request');
      const [source, rows] = await Promise.all([
        tx.get(this.db.collection('active_alerts').doc(r.alertId)),
        tx.get(this.db.collection(COLLECTION).where('alertKey', '==', r.alertKey).limit(20)),
      ]);
      const current = source.data();
      if (!current || current['alertKey'] !== r.alertKey || current['userId'] !== r.ownerUid ||
          !['active', 'escalated'].includes(current['status']) ||
          !(current['expiresAtTimestamp'] instanceof Timestamp) || current['expiresAtTimestamp'].toMillis() <= Date.now()) {
        throw new AppError('alert_closed');
      }
      if (rows.size >= 20) throw new AppError('rate_limited');
      // All concurrent new IDs contend on the existing source document. No
      // separate lock records or new retention/erasure policy is introduced.
      tx.update(source.ref, { evidenceAdmissionVersion: (Number(source.get('evidenceAdmissionVersion')) || 0) + 1 });
      tx.create(ref, doc);
      return r;
    });
  }

  async findById(id: string): Promise<EvidenceRecord | null> {
    const snap = await this.db.collection(COLLECTION).doc(id).get();
    return snap.exists ? toRecord(id, snap.data() as EvidenceDoc) : null;
  }

  async listForAlert(alertId: string): Promise<EvidenceRecord[]> {
    const snap = await this.db.collection(COLLECTION)
      .where('alertId', '==', alertId).orderBy('createdAt', 'asc').get();
    return snap.docs.map((d) => toRecord(d.id, d.data() as EvidenceDoc));
  }

  async listForOwner(ownerUid: string): Promise<EvidenceRecord[]> {
    const snap = await this.db.collection(COLLECTION)
      .where('ownerUid', '==', ownerUid).orderBy('createdAt', 'asc').get();
    return snap.docs.map((d) => toRecord(d.id, d.data() as EvidenceDoc));
  }

  async markPublished(id: string, source: string, publication: PublishedEvidence): Promise<EvidenceRecord> {
    assertPublication(source, publication);
    return this.db.runTransaction(async tx => {
      const ref = this.db.collection(COLLECTION).doc(id), snap = await tx.get(ref);
      if (!snap.exists) throw new AppError('not_found');
      const current = snap.data() as EvidenceDoc;
      if (current.uploaded && current.sha256) {
        if (current.sha256 !== publication.sha256 || current.sizeBytes !== publication.sizeBytes) throw new AppError('conflict');
        return toRecord(id, current);
      }
      if (current.storagePath !== source) throw new AppError('conflict');
      const patch = { storagePath: publication.storagePath, sha256: publication.sha256, sizeBytes: publication.sizeBytes, uploaded: true };
      tx.update(ref, patch); return toRecord(id, { ...current, ...patch });
    });
  }

  async markUploaded(id: string, sizeBytes: number | null): Promise<EvidenceRecord> {
    throw new Error('immutable publication required; size-only finalization is disabled');
  }

  async deleteAllForOwner(ownerUid: string): Promise<number> {
    const snap = await this.db.collection(COLLECTION).where('ownerUid', '==', ownerUid).get();
    if (snap.empty) return 0;
    let removed = 0;
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = this.db.batch();
      for (const d of snap.docs.slice(i, i + 400)) batch.delete(d.ref);
      await batch.commit();
      removed += Math.min(400, snap.docs.length - i);
    }
    return removed;
  }
}
