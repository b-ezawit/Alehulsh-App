import type { VerifiedIdentifierSource } from '../../auth/VerifiedIdentifierSource.js';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../errors.js';
import type { Logger } from '../../logger.js';
import type { UserRecord, UserRepository } from '../types.js';

/** Interim. Replaced by Postgres at C-04 (M-05). */
export class FirestoreUserRepository implements UserRepository {
  async compareAndSetSafetyKeyword(uid: string, expectedHash: string | null, hash: string): Promise<void> {
    if (!hash) throw new AppError('invalid_request');
    await this.db.runTransaction(async tx => {
      const ref = this.db.collection('users').doc(uid);
      const [user, alert] = await Promise.all([
        tx.get(ref), tx.get(this.db.collection('active_alerts').doc(uid)),
      ]);
      if (!user.exists) throw new AppError('not_found');
      const legacy=user.get('catName');
      if(!user.get('safetyKeywordHash')&&typeof legacy==='string'&&legacy.trim())throw new AppError('conflict');
      if (['active', 'escalated'].includes(alert.get('status')) ||
          (user.get('safetyKeywordHash') ?? null) !== expectedHash) throw new AppError('conflict');
      tx.update(ref, { safetyKeywordHash: hash, mustSetKeyword: false, catName: FieldValue.delete() });
    });
  }
  /**
   * @param logger optional only so existing call sites keep compiling; pass
   *   one. Without it an ambiguous identifier is refused silently, and silence
   *   is the half of this defect that made it survive.
   */
  constructor(
    private readonly db: Firestore,
    private readonly logger?: Logger,
    private readonly identifiers?: VerifiedIdentifierSource,
  ) {}

  async findByUid(uid: string): Promise<UserRecord | null> {
    const snap = await this.db.collection('users').doc(uid).get();
    if (!snap.exists) return null;
    const d = snap.data() ?? {};
    // Only these two fields are read. The rest of the profile — phone, address,
    // contacts — has no business in this process.
    return {
      uid,
      ...(!d['safetyKeywordHash']&&typeof d['catName']==='string'&&d['catName'].trim()?{legacyKeywordMigrationRequired:true}:{}),
      safetyKeywordHash: typeof d['safetyKeywordHash'] === 'string' ? d['safetyKeywordHash'] : null,
      mustSetKeyword: d['mustSetKeyword'] === true,
    };
  }

  async findUidByIdentifierHash(hash: string): Promise<string | null> {
    if (!hash || !this.identifiers) {
      this.logger?.warn('identifier ownership verification unavailable; contact matching refused');
      return null;
    }
    const verified = new Set<string>();
    for (const field of ['phoneHash', 'emailHash']) {
      // Bound corrupted legacy data without choosing an arbitrary winner.
      // Clients are already forbidden to create or modify these hash fields.
      const snap = await this.db.collection('users').where(field, '==', hash).limit(100).get();
      if (snap.size >= 100) {
        this.logger?.error('identifier candidate limit reached; contact matching refused');
        return null;
      }
      const matches = await Promise.all(snap.docs.map(async doc =>
        await this.identifiers!.proves(doc.id, hash) ? doc.id : null));
      for (const uid of matches) if (uid) verified.add(uid);
    }
    if (verified.size > 1) {
      this.logger?.error('verified identifier is ambiguous; contact matching refused');
      return null;
    }
    return [...verified][0] ?? null;
  }

  async setSafetyKeywordHash(uid: string, hash: string): Promise<void> {
    // merge, so this cannot clobber a profile it never read. The legacy
    // plaintext field is removed in the same write — P1-11 leaves no path
    // that sets a hash and leaves the cleartext beside it.
    await this.db.collection('users').doc(uid).set({
      safetyKeywordHash: hash,
      mustSetKeyword: false,
      catName: FieldValue.delete(),
    }, { merge: true });
  }

  async deleteByUid(uid: string): Promise<number> {
    const ref = this.db.collection('users').doc(uid);
    if (!(await ref.get()).exists) return 0;
    await ref.delete();
    return 1;
  }
}
