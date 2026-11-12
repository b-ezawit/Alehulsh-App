import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../errors.js';
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
  constructor(private readonly db: Firestore) { }

  async findPending(uid: string): Promise<KeywordReset | null> {
    const snap = await this.db.collection(COLLECTION).doc(uid).get();
    if (!snap.exists) return null;
    const r = toReset(snap.data() as ResetDoc);
    return r.status === 'pending' ? r : null;
  }

  async create(reset: KeywordReset): Promise<KeywordReset> {
    if (reset.status !== 'pending') throw new AppError('invalid_request');
    const canonical = { ...reset, eligibleAt: new Date(reset.requestedAt.getTime() + 72 * 60 * 60 * 1000) };
    const doc: ResetDoc = {
      uid: reset.uid,
      requestedAt: Timestamp.fromDate(reset.requestedAt),
      eligibleAt: Timestamp.fromDate(canonical.eligibleAt),
      status: reset.status,
    };
    return this.db.runTransaction(async tx => {
      const ref = this.db.collection(COLLECTION).doc(reset.uid);
      const [alert, existing] = await Promise.all([
        tx.get(this.db.collection('active_alerts').doc(reset.uid)), tx.get(ref),
      ]);
      if (['active', 'escalated'].includes(alert.get('status'))) throw new AppError('conflict');
      if (existing.get('status') === 'pending') return toReset(existing.data() as ResetDoc);
      tx.set(ref, doc);
      return canonical;
    });
  }

  async update(uid: string, fields: Partial<KeywordReset>): Promise<void> {
    if (fields.status === 'confirmed') throw new AppError('conflict', 'atomic confirmation required');
    const patch: Record<string, unknown> = {};
    if (fields.status) patch['status'] = fields.status;
    if (fields.cancelledAt) patch['cancelledAt'] = Timestamp.fromDate(fields.cancelledAt);
    if (fields.cancelledReason) patch['cancelledReason'] = fields.cancelledReason;
    if (Object.keys(patch).length === 0) return;
    if (!['cancelled', 'voided_by_alert'].includes(fields.status ?? '')) {
      throw new AppError('invalid_request');
    }
    await this.db.runTransaction(async tx => {
      const ref = this.db.collection(COLLECTION).doc(uid);
      const current = await tx.get(ref);
      if (current.get('status') === 'pending') tx.update(ref, patch);
    });
  }

  async confirm(uid: string, requestedAt: Date, hash: string, now: Date): Promise<void> {
    if (!hash) throw new AppError('invalid_request');
    await this.db.runTransaction(async tx => {
      const resetRef = this.db.collection(COLLECTION).doc(uid);
      const userRef = this.db.collection('users').doc(uid);
      const [alert, pending, user] = await Promise.all([
        tx.get(this.db.collection('active_alerts').doc(uid)), tx.get(resetRef), tx.get(userRef),
      ]);
      if (['active', 'escalated'].includes(alert.get('status'))) throw new AppError('conflict');
      if (!user.exists || pending.get('status') !== 'pending') throw new AppError('not_found');
      if (pending.get('requestedAt').toMillis() !== requestedAt.getTime() ||
        pending.get('eligibleAt').toMillis() > now.getTime()) throw new AppError('conflict');
      tx.update(userRef, {
        safetyKeywordHash: hash, mustSetKeyword: false, catName: FieldValue.delete(),
      });
      tx.update(resetRef, { status: 'confirmed' });
    });
  }

  async deleteForUid(uid: string): Promise<number> {
    const ref = this.db.collection(COLLECTION).doc(uid);
    if (!(await ref.get()).exists) return 0;
    await ref.delete();
    return 1;
  }
}
