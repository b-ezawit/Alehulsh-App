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
}
