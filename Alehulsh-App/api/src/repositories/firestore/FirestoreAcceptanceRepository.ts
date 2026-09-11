import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import type { Acceptance, AcceptanceRepository } from '../types.js';

/**
 * Interim. Replaced by Postgres at C-04 (M-05).
 *
 * Layout: alert_acceptances/{alertId}/responders/{responderUid}.
 *
 * One document per acceptance rather than an array on the alert. CRIT-04 was
 * exactly that array: a writer who can append can also overwrite, so a single
 * write permission covered both "I am helping" and "delete her evidence".
 * Separate documents make impersonation a different permission from existence.
 */
const ROOT = 'alert_acceptances';
const SUB = 'responders';

interface AcceptanceDoc {
  alertId: string;
  responderUid: string;
  acceptedAt: Timestamp;
  audience: 'responder' | 'contact';
}

const toAcceptance = (d: AcceptanceDoc): Acceptance => ({
  alertId: d.alertId,
  responderUid: d.responderUid,
  acceptedAt: d.acceptedAt.toDate(),
  audience: d.audience,
});

export class FirestoreAcceptanceRepository implements AcceptanceRepository {
  constructor(private readonly db: Firestore) {}

  private ref(alertId: string, responderUid: string) {
    return this.db.collection(ROOT).doc(alertId).collection(SUB).doc(responderUid);
  }

  async record(a: Acceptance): Promise<{ acceptance: Acceptance; created: boolean }> {
    const ref = this.ref(a.alertId, a.responderUid);
    const doc: AcceptanceDoc = {
      alertId: a.alertId,
      responderUid: a.responderUid,
      acceptedAt: Timestamp.fromDate(a.acceptedAt),
      audience: a.audience,
    };

    // A transaction, not create-and-catch: two devices accepting at once must
    // not both count as first. The stored timestamp is the audit record of
    // when they actually answered, so a replay must never move it.
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        return { acceptance: toAcceptance(snap.data() as AcceptanceDoc), created: false };
      }
      tx.set(ref, doc);
      return { acceptance: a, created: true };
    });
  }

  async findFor(alertId: string, responderUid: string): Promise<Acceptance | null> {
    const snap = await this.ref(alertId, responderUid).get();
    return snap.exists ? toAcceptance(snap.data() as AcceptanceDoc) : null;
  }

  async listForAlert(alertId: string): Promise<Acceptance[]> {
    const snap = await this.db.collection(ROOT).doc(alertId).collection(SUB).get();
    return snap.docs.map((d) => toAcceptance(d.data() as AcceptanceDoc));
  }

  async deleteAllForResponder(responderUid: string): Promise<number> {
    // Collection-group query — needs the `responders` group index on
    // responderUid. Deletion must reach every alert they ever answered.
    const snap = await this.db.collectionGroup(SUB)
      .where('responderUid', '==', responderUid).get();
    if (snap.empty) return 0;

    // Firestore caps a batch at 500 writes. Chunked rather than assumed small:
    // a busy responder over months is exactly the account most worth deleting
    // correctly.
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
