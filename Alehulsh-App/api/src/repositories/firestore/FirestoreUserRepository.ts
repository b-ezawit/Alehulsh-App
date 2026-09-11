import type { Firestore } from 'firebase-admin/firestore';
import type { UserRecord, UserRepository } from '../types.js';

/** Interim. Replaced by Postgres at C-04 (M-05). */
export class FirestoreUserRepository implements UserRepository {
  constructor(private readonly db: Firestore) {}

  async findByUid(uid: string): Promise<UserRecord | null> {
    const snap = await this.db.collection('users').doc(uid).get();
    if (!snap.exists) return null;
    const d = snap.data() ?? {};
    // Only these two fields are read. The rest of the profile — phone, address,
    // contacts — has no business in this process.
    return {
      uid,
      safetyKeywordHash: typeof d['safetyKeywordHash'] === 'string' ? d['safetyKeywordHash'] : null,
      mustSetKeyword: d['mustSetKeyword'] === true,
    };
  }

  async findUidByIdentifierHash(hash: string): Promise<string | null> {
    // Two single-field queries rather than an OR, which Firestore charges for
    // as two reads anyway and which keeps the index simple.
    for (const field of ['phoneHash', 'emailHash']) {
      const snap = await this.db.collection('users').where(field, '==', hash).limit(1).get();
      const doc = snap.docs[0];
      if (doc) return doc.id;
    }
    return null;
  }

  async deleteByUid(uid: string): Promise<number> {
    const ref = this.db.collection('users').doc(uid);
    if (!(await ref.get()).exists) return 0;
    await ref.delete();
    return 1;
  }
}
