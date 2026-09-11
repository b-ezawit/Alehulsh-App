import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import type { LocationRevealAttempt, LocationRevealRepository } from '../types.js';

/**
 * Interim. Replaced by Postgres at C-04 (M-05), where M-05.4 makes the audit
 * table append-only in the database itself.
 *
 * HONEST LIMITATION: "append-only" here is a property of this class and of the
 * security rules, not of the datastore. The admin credential this process
 * holds can rewrite any document. Firestore cannot express an immutable
 * collection against a privileged caller, so until M-05.4 the guarantee is
 * only as strong as the service-account key. Do not describe this trail as
 * tamper-proof; it is tamper-evident to anyone outside the server.
 */
const COLLECTION = 'location_reveals';

interface AttemptDoc {
  alertId: string;
  responderUid: string;
  at: Timestamp;
  claimedLat: number;
  claimedLng: number;
  distanceM: number | null;
  granted: boolean;
  deniedReason?: LocationRevealAttempt['deniedReason'];
}

const toAttempt = (d: AttemptDoc): LocationRevealAttempt => {
  const a: LocationRevealAttempt = {
    alertId: d.alertId,
    responderUid: d.responderUid,
    at: d.at.toDate(),
    claimedLat: d.claimedLat,
    claimedLng: d.claimedLng,
    distanceM: d.distanceM ?? null,
    granted: d.granted === true,
  };
  if (d.deniedReason) a.deniedReason = d.deniedReason;
  return a;
};

export class FirestoreLocationRevealRepository implements LocationRevealRepository {
  constructor(private readonly db: Firestore) {}

  async append(a: LocationRevealAttempt): Promise<void> {
    const doc: AttemptDoc = {
      alertId: a.alertId,
      responderUid: a.responderUid,
      at: Timestamp.fromDate(a.at),
      claimedLat: a.claimedLat,
      claimedLng: a.claimedLng,
      distanceM: a.distanceM,
      granted: a.granted,
      ...(a.deniedReason ? { deniedReason: a.deniedReason } : {}),
    };
    // An auto id, never a deterministic one. A predictable id would let a
    // second write for the same responder and instant overwrite the first,
    // which is the one thing an append-only log must not allow.
    await this.db.collection(COLLECTION).add(doc);
  }

  async countSince(alertId: string, responderUid: string, since: Date): Promise<number> {
    const snap = await this.db.collection(COLLECTION)
      .where('alertId', '==', alertId)
      .where('responderUid', '==', responderUid)
      .where('at', '>=', Timestamp.fromDate(since))
      .count().get();
    // Aggregation query: one read regardless of how many attempts there are,
    // which matters because this runs on every reveal request.
    return snap.data().count;
  }

  async listForAlert(alertId: string): Promise<LocationRevealAttempt[]> {
    const snap = await this.db.collection(COLLECTION)
      .where('alertId', '==', alertId).orderBy('at', 'asc').get();
    return snap.docs.map((d) => toAttempt(d.data() as AttemptDoc));
  }

  async deleteAllForResponder(responderUid: string): Promise<number> {
    const snap = await this.db.collection(COLLECTION)
      .where('responderUid', '==', responderUid).get();
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
