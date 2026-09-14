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
}

const toRecord = (id: string, d: EvidenceDoc): EvidenceRecord => ({
  id,
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
  constructor(private readonly db: Firestore) {}

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
    await this.db.collection(COLLECTION).doc(r.id).set(doc);
    return r;
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

  async markUploaded(id: string, sizeBytes: number | null): Promise<EvidenceRecord> {
    const ref = this.db.collection(COLLECTION).doc(id);
    await ref.update({ uploaded: true, sizeBytes });
    const snap = await ref.get();
    return toRecord(id, snap.data() as EvidenceDoc);
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
