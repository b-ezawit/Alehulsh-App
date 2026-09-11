import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import type { VersionTelemetryRepository } from '../types.js';

/** Interim. Replaced at C-04 (M-05). */
const COLLECTION = 'client_versions';

/**
 * One document per account, overwritten — not an append log.
 *
 * We need "what is everyone on now", not "where has she been". A history of
 * which app version an account ran on which day is a behavioural trail with no
 * purpose here, so it is not kept.
 */
export class FirestoreVersionTelemetryRepository implements VersionTelemetryRepository {
  constructor(private readonly db: Firestore) {}

  async record(uid: string, platform: 'android' | 'ios', version: string, at: Date): Promise<void> {
    await this.db.collection(COLLECTION).doc(uid).set({
      platform, version, lastSeenAt: Timestamp.fromDate(at),
    });
  }

  async distribution(): Promise<Record<string, number>> {
    const snap = await this.db.collection(COLLECTION).get();
    const out: Record<string, number> = {};
    for (const d of snap.docs) {
      const v = d.data()['version'];
      if (typeof v !== 'string') continue;
      out[v] = (out[v] ?? 0) + 1;
    }
    return out;
  }

  async deleteForUid(uid: string): Promise<number> {
    const ref = this.db.collection(COLLECTION).doc(uid);
    if (!(await ref.get()).exists) return 0;
    await ref.delete();
    return 1;
  }
}
