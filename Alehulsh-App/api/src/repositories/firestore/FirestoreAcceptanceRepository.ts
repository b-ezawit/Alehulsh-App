import { AppError } from '../../errors.js';
import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp,FieldValue } from 'firebase-admin/firestore';
import type { Acceptance, AcceptanceRepository } from '../types.js';

/**
 * Interim. Replaced by Postgres at C-04 (M-05).
 *
 * Layout: alert_acceptances/{alertKey}/responders/{responderUid}.
 * Legacy slot-keyed rows are preserved but never authorize a new incident.
 *
 * One document per acceptance rather than an array on the alert. CRIT-04 was
 * exactly that array: a writer who can append can also overwrite, so a single
 * write permission covered both "I am helping" and "delete her evidence".
 * Separate documents make impersonation a different permission from existence.
 */
const ROOT = 'alert_acceptances';
const SUB = 'responders';

interface AcceptanceDoc {
  alertKey: string;
  alertId: string;
  responderUid: string;
  acceptedAt: Timestamp;
  audience: 'responder' | 'contact';
}

const toAcceptance = (d: AcceptanceDoc): Acceptance => ({
  alertId: d.alertId,
  alertKey: d.alertKey,
  responderUid: d.responderUid,
  acceptedAt: d.acceptedAt.toDate(),
  audience: d.audience,
});

export class FirestoreAcceptanceRepository implements AcceptanceRepository {
  async withdraw(alertId:string,uid:string,key:string):Promise<void>{
    const ref=this.ref(key,uid);
    await this.db.runTransaction(async tx=>{
      const row=await tx.get(ref);
      if(row.exists&&row.get('alertId')===alertId&&row.get('alertKey')===key&&row.get('responderUid')===uid&&row.get('withdrawnAt')===undefined)
        tx.update(ref,{withdrawnAt:FieldValue.serverTimestamp()});
    });
  }
  constructor(private readonly db: Firestore) { }

  private ref(alertId: string, responderUid: string) {
    return this.db.collection(ROOT).doc(alertId).collection(SUB).doc(responderUid);
  }

  async record(a: Acceptance): Promise<{ acceptance: Acceptance; created: boolean; }> {
    return this.db.runTransaction(async tx => {
      const source = await tx.get(this.db.collection('active_alerts').doc(a.alertId));
      const key: unknown = source.get('alertKey');
      const expiry: unknown = source.get('expiresAtTimestamp');
      if (!source.exists || typeof key !== 'string' || !key ||
        !['active', 'escalated'].includes(source.get('status')) ||
        !(expiry instanceof Timestamp) || expiry.toMillis() <= Date.now()) throw new AppError('alert_closed');
      if (a.alertKey !== undefined && a.alertKey !== key) throw new AppError('conflict');
      const projection = await tx.get(this.db.collection('inbox').doc(a.responderUid).collection('alerts').doc(a.alertId));
      if (projection.get('alertKey') !== key) throw new AppError('not_found');
      const audience = projection.get('audience');
      if (!['responder', 'contact'].includes(audience)) throw new AppError('not_found');
      const ref = this.ref(key, a.responderUid), snap = await tx.get(ref);
      if (snap.exists) {
        const reactivated=snap.get('withdrawnAt')!==undefined;
        if(reactivated)tx.update(ref,{withdrawnAt:FieldValue.delete()});
        return { acceptance: toAcceptance(snap.data() as AcceptanceDoc), created: reactivated };
      }
      const doc: AcceptanceDoc = {
        alertId: a.alertId, alertKey: key, responderUid: a.responderUid,
        acceptedAt: Timestamp.fromDate(a.acceptedAt), audience
      };
      tx.create(ref, doc);
      return { acceptance: toAcceptance(doc), created: true };
    });
  }

  async findFor(alertId: string, responderUid: string): Promise<Acceptance | null> {
    return this.db.runTransaction(async tx => {
      const [source, projection] = await Promise.all([
        tx.get(this.db.collection('active_alerts').doc(alertId)),
        tx.get(this.db.collection('inbox').doc(responderUid).collection('alerts').doc(alertId)),
      ]);
      const key: unknown = source.get('alertKey'), expiry: unknown = source.get('expiresAtTimestamp');
      if (typeof key !== 'string' || !key || projection.get('alertKey') !== key ||
        !['active', 'escalated'].includes(source.get('status')) ||
        !(expiry instanceof Timestamp) || expiry.toMillis() <= Date.now()) return null;
      const snap = await tx.get(this.ref(key, responderUid));
      return snap.exists && snap.get('alertKey') === key &&snap.get('withdrawnAt')===undefined ? toAcceptance(snap.data() as AcceptanceDoc) : null;
    });
  }

  async listForAlert(alertId: string): Promise<Acceptance[]> {
    const source = await this.db.collection('active_alerts').doc(alertId).get();
    const key: unknown = source.get('alertKey');
    if (typeof key !== 'string' || !key) return [];
    const snap = await this.db.collection(ROOT).doc(key).collection(SUB).get();
    return snap.docs.filter(d=>d.get('withdrawnAt')===undefined).map(d => toAcceptance(d.data() as AcceptanceDoc));
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
