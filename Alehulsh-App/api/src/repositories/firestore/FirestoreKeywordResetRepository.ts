import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import type { KeywordReset, KeywordResetRepository } from '../types.js';

/** Interim. Replaced at C-04 (M-05). One document per user, keyed by uid. */
const COLLECTION = 'keyword_resets';

interface ResetDoc {
  uid: string;
  requestedAt: Timestamp;
  eligibleAt: Timestamp;
  status: KeywordReset['status'];
  cancelledAt?: Timestamp;
  cancelledReason?: KeywordReset['cancelledReason'];
}

const toReset = (d: ResetDoc): KeywordReset => {
  const r: KeywordReset = {
    uid: d.uid,
    requestedAt: d.requestedAt.toDate(),
    eligibleAt: d.eligibleAt.toDate(),
    status: d.status,
  };
  if (d.cancelledAt) r.cancelledAt = d.cancelledAt.toDate();
  if (d.cancelledReason) r.cancelledReason = d.cancelledReason;
  return r;
};

export class FirestoreKeywordResetRepository implements KeywordResetRepository {
  constructor(private readonly db: Firestore) {}

  async findPending(uid: string): Promise<KeywordReset | null> {
    const snap = await this.db.collection(COLLECTION).doc(uid).get();
    if (!snap.exists) return null;
    const r = toReset(snap.data() as ResetDoc);
    return r.status === 'pending' ? r : null;
  }

  async create(reset: KeywordReset): Promise<KeywordReset> {
    const doc: ResetDoc = {
      uid: reset.uid,
      requestedAt: Timestamp.fromDate(reset.requestedAt),
      eligibleAt: Timestamp.fromDate(reset.eligibleAt),
      status: reset.status,
    };
    await this.db.collection(COLLECTION).doc(reset.uid).set(doc);
    return reset;
  }

  async update(uid: string, fields: Partial<KeywordReset>): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (fields.status) patch['status'] = fields.status;
    if (fields.cancelledAt) patch['cancelledAt'] = Timestamp.fromDate(fields.cancelledAt);
    if (fields.cancelledReason) patch['cancelledReason'] = fields.cancelledReason;
    if (Object.keys(patch).length === 0) return;
    await this.db.collection(COLLECTION).doc(uid).set(patch, { merge: true });
  }

  async deleteForUid(uid: string): Promise<number> {
    const ref = this.db.collection(COLLECTION).doc(uid);
    if (!(await ref.get()).exists) return 0;
    await ref.delete();
    return 1;
  }
}
